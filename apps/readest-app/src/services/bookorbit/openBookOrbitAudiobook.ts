// Opens a playback session for a BookOrbit audiobook (#6224).
//
// Everything the generic OPDS path has to work for, the manifest supplies in
// one request: ordered tracks, real durations, real chapters. Nothing is
// downloaded to build the timeline, and only the track being played is
// fetched.
//
// Where the loopback media proxy is available the tracks stream through it:
// it is a real origin, so `Range` works and only the part being listened to is
// fetched. BookOrbit's own URL cannot be given to a media element at all
// (`Cross-Origin-Resource-Policy: same-origin`), so elsewhere -- the web build,
// iOS -- BlobAudioClock fetches one whole track at a time through the client
// and releases the previous one. See ./mediaProxy.
import { convertFileSrc } from '@tauri-apps/api/core';
import { BlobAudioClock, HtmlAudioClock } from '@/services/audiobook/AudiobookClock';
import { AudiobookController } from '@/services/audiobook/AudiobookController';
import type { AudiobookSource } from '@/services/audiobook/AudiobookController';
import { NativeAudiobookClock } from '@/services/audiobook/NativeAudiobookClock';
import { isTauriAppPlatform } from '@/services/environment';
import { loadOpdsOfflineManifest, saveOpdsOfflineManifest } from '@/services/opds/offline';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { TTSMediaBridgeMeta } from '@/services/tts/ttsMediaBridge';
import { useLibraryStore } from '@/store/libraryStore';
import type { ABSTrack } from '@/types/audiobookshelf';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getOSPlatform, uniqueId } from '@/utils/misc';
import {
  bookOrbitProgressHooks,
  isOwnBookOrbitWrite,
  notifyBookOrbitDiverged,
} from './progressSync';
import type { BookOrbitClient, BookOrbitPlaybackState } from './client';
import type { BookOrbitManifest } from './manifest';
import { AUDIO_POSITION_CHOICE_THRESHOLD_SEC } from '@/services/audiobook/startPosition';
import { clampStartPosition, resolveBookOrbitStart } from './startPosition';
import { withTimeout } from './timeout';
import { makeAudiobookProgressSaver } from '@/services/audiobook/progressPersistence';
import { parseBookOrbitAudioFilePath } from './audiobookId';
import { createBookOrbitClient } from './createClient';
import { openBookOrbitMediaProxy } from './mediaProxy';
import {
  globalFromAssetPosition,
  manifestAssetIds,
  manifestChapters,
  manifestTracks,
  matchingAssetIds,
} from './manifest';

export interface BookOrbitAudiobookSession {
  bookKey: string;
  controller: AudiobookController;
}

/**
 * Asks the user which of two positions to resume from. 'server' and 'local'
 * pick a side; null (dismissed) keeps this device's position.
 */
export type ChooseBookOrbitStart = (choice: {
  bookHash: string;
  server: number;
  local: number;
}) => Promise<'server' | 'local' | null>;

/**
 * Opening must not wait long on a server it may not reach: an offline copy
 * plays without it, and the local position is a fine fallback.
 */
const SERVER_READ_TIMEOUT_MS = 5_000;

const readServerState = async (
  client: BookOrbitClient,
  bookId: number,
): Promise<BookOrbitPlaybackState | null> => {
  try {
    return await withTimeout(
      (signal) => client.getPlaybackState(bookId, signal),
      SERVER_READ_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
};

const readServerManifest = async (
  client: BookOrbitClient,
  bookId: number,
): Promise<BookOrbitManifest | null> => {
  try {
    return await withTimeout(
      (signal) => client.getManifest(bookId, signal),
      SERVER_READ_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
};

/** Matches the ABS syncer: keep the row live in the store, write to disk rarely. */

const isIOSTauri = (): boolean => isTauriAppPlatform() && getOSPlatform() === 'ios';
const isAndroidTauri = (): boolean => isTauriAppPlatform() && getOSPlatform() === 'android';
const isLinuxTauri = (): boolean => isTauriAppPlatform() && getOSPlatform() === 'linux';

const offlineLocalClock = (
  appService: AppService,
  tracks: ABSTrack[],
): {
  clock: BlobAudioClock | HtmlAudioClock | NativeAudiobookClock;
  resolveUrl: (path: string) => string;
} => {
  const nativeClock = isIOSTauri() || isAndroidTauri();
  const blobClock = !nativeClock && isLinuxTauri();
  return {
    resolveUrl: (path: string) => (nativeClock || blobClock ? path : convertFileSrc(path)),
    clock: nativeClock
      ? new NativeAudiobookClock()
      : blobClock
        ? new BlobAudioClock(async (path) => {
            const bytes = await appService.readFile(path, 'None', 'binary');
            const mimeType = tracks.find((track) => track.contentUrl === path)?.mimeType;
            return new Blob([bytes], { type: mimeType });
          })
        : new HtmlAudioClock(),
  };
};

/**
 * Record the book's length on its library row.
 *
 * The shelf reads `book.duration` (see BookItem), not `progress[1]`. A
 * streaming stub is created before its tracks are known, so without this the
 * row has no length: unplayed it showed nothing, and once playback wrote a
 * position it rendered "-0:00" while the player showed the real remaining
 * time.
 */
const recordDuration = (appService: AppService, bookHash: string, duration: number): void => {
  const { library, setLibrary } = useLibraryStore.getState();
  const idx = library.findIndex((b) => b.hash === bookHash);
  if (idx === -1 || library[idx]!.duration === duration) return;
  const newLibrary = library.slice();
  newLibrary[idx] = { ...library[idx]!, duration };
  setLibrary(newLibrary);
  Promise.resolve(appService.saveLibraryBooks(newLibrary)).catch(console.warn);
};

/**
 * A session left running (paused) in the background was set up against the
 * server position at the time. If another device has moved it since, that
 * session can neither resume from the new position nor push without
 * overwriting it, so it is closed and the book reopened from scratch, which
 * reads the server again and asks.
 */
const liveSessionIsStale = async (
  controller: AudiobookController,
  bookId: number,
  tracks: ABSTrack[] | null,
  assetIds: string[] | null,
): Promise<boolean> => {
  if (controller.state === 'playing' || !tracks || !assetIds?.length) return false;
  const client = createBookOrbitClient();
  if (!client) return false;
  const state = await readServerState(client, bookId);
  if (!state?.assetId || isOwnBookOrbitWrite(bookId, state)) return false;
  const server = globalFromAssetPosition(tracks, assetIds, state.assetId, state.positionMs ?? 0);
  const current = controller.getPlaybackInfo()?.position;
  if (server === null || current === undefined) return false;
  return Math.abs(server - current) > AUDIO_POSITION_CHOICE_THRESHOLD_SEC;
};

const liveSessions = new Map<string, { tracks: ABSTrack[]; assetIds: string[] }>();

export const openBookOrbitAudiobookSession = async (input: {
  appService: AppService;
  book: Book;
  /** Without it a disagreement keeps this device's position. */
  chooseStart?: ChooseBookOrbitStart;
}): Promise<BookOrbitAudiobookSession | null> => {
  const { appService } = input;
  let { book } = input;
  const journal = await (
    await import('@/services/audiobook/carPlayback')
  ).importCarListeningCheckpoint(appService, book);
  if (journal && journal.updatedAt > book.updatedAt) {
    book = {
      ...book,
      progress: [journal.position, journal.duration],
      updatedAt: journal.updatedAt,
    };
  }
  const bookId = parseBookOrbitAudioFilePath(book.filePath);
  if (bookId === null) return null;

  const existing = ttsSessionManager.getSessionByHash(book.hash);
  if (existing && existing.controller.kind === 'audiobook' && !existing.controller.terminated) {
    const controller = existing.controller as AudiobookController;
    const timeline = liveSessions.get(existing.bookKey);
    if (
      !(await liveSessionIsStale(
        controller,
        bookId,
        timeline?.tracks ?? null,
        timeline?.assetIds ?? null,
      ))
    ) {
      return { bookKey: existing.bookKey, controller };
    }
    liveSessions.delete(existing.bookKey);
    await ttsSessionManager.stopBook(book.hash, 'user');
    book = useLibraryStore.getState().getBookByHash(book.hash) ?? book;
  }

  const client = createBookOrbitClient();
  const offline = book.opdsDownloadedAt
    ? await loadOpdsOfflineManifest(appService, book.hash)
    : null;

  // Streaming still needs the client; an offline copy can play without it.
  if (!offline && !client) return null;

  let tracks: ABSTrack[];
  let chapters: AudiobookSource['chapters'];
  let title: string;
  let author: string;
  let totalDuration: number;
  let assetIds: string[] = [];
  let manifestRevision = '';
  let clock: BlobAudioClock | HtmlAudioClock | NativeAudiobookClock;
  let resolveUrl: (path: string) => string;

  if (offline) {
    tracks = await Promise.all(
      offline.tracks.map(async (track) => ({
        ...track,
        contentUrl: await appService.resolveFilePath(track.contentUrl, 'Books'),
      })),
    );
    chapters = offline.chapters;
    title = book.title;
    author = book.author;
    totalDuration = offline.duration;
    ({ clock, resolveUrl } = offlineLocalClock(appService, tracks));
    if (offline.assetIds?.length === tracks.length) {
      assetIds = offline.assetIds;
      manifestRevision = offline.manifestRevision ?? '';
    } else if (client) {
      // Downloaded before asset ids were recorded: without them the book can
      // neither read nor share its position. Borrow them from the server only
      // if its files still line up with the ones on disk.
      const manifest = await readServerManifest(client, bookId);
      const matched = manifest ? matchingAssetIds(manifest, offline.tracks) : null;
      if (manifest && matched) {
        assetIds = matched;
        manifestRevision = manifest.revision;
        void saveOpdsOfflineManifest(appService, book.hash, {
          ...offline,
          assetIds,
          manifestRevision,
        }).catch(console.warn);
      }
    }
  } else {
    const manifest = await client!.getManifest(bookId);
    tracks = manifestTracks(manifest);
    chapters = manifestChapters(manifest);
    assetIds = manifestAssetIds(manifest);
    if (tracks.length === 0) return null;
    totalDuration = tracks.reduce((sum, track) => sum + track.duration, 0);
    title = manifest.book.title || book.title;
    author = manifest.book.authors.join(' & ') || book.author;
    manifestRevision = manifest.revision;

    const mimeByUrl = new Map(tracks.map((track) => [track.contentUrl, track.mimeType]));
    const streamUrl = await openBookOrbitMediaProxy(client!);
    resolveUrl = (contentPath: string) => streamUrl?.(contentPath) ?? contentPath;
    clock = streamUrl
      ? new HtmlAudioClock()
      : new BlobAudioClock(async (contentPath) => {
          const res = await client!.fetchAsset(contentPath);
          if (!res.ok) throw new Error(`BookOrbit asset fetch failed: ${res.status}`);
          return new Blob([await res.arrayBuffer()], {
            type: mimeByUrl.get(contentPath) ?? 'audio/mpeg',
          });
        });
  }

  if (tracks.length === 0) return null;

  // Best effort: a server without a stored position, or an unreachable one,
  // just means we fall back to the local progress.
  let serverPositionSec: number | null = null;
  let baseRevision = 0;
  if (client && assetIds.length > 0) {
    const state = await readServerState(client, bookId);
    if (state?.assetId) {
      // The stored position is an offset *within one asset*, not into the
      // book, so it has to be placed on the timeline before it means anything.
      serverPositionSec = globalFromAssetPosition(
        tracks,
        assetIds,
        state.assetId,
        state.positionMs ?? 0,
      );
    }
    baseRevision = state?.revision ?? 0;
  }

  const localPositionSec = book.progress?.[0] ?? 0;
  const start = resolveBookOrbitStart({
    server: serverPositionSec,
    local: localPositionSec,
    duration: totalDuration,
  });
  let startAt: number;
  if (start.kind === 'resolved') {
    startAt = start.position;
  } else {
    const choice = input.chooseStart
      ? await input.chooseStart({ bookHash: book.hash, server: start.server, local: start.local })
      : null;
    startAt = clampStartPosition(choice === 'server' ? start.server : start.local, totalDuration);
  }

  recordDuration(appService, book.hash, totalDuration);
  const saveProgress = makeAudiobookProgressSaver(appService, book.hash, totalDuration);

  const source: AudiobookSource = {
    itemId: String(bookId),
    title,
    author,
    tracks,
    chapters,
    resolveUrl,
    startAt,
  };

  const controller = new AudiobookController(
    source,
    clock,
    client && assetIds.length > 0
      ? bookOrbitProgressHooks(
          client,
          bookId,
          tracks,
          assetIds,
          manifestRevision,
          baseRevision,
          saveProgress,
          { onDiverged: notifyBookOrbitDiverged },
        )
      : {
          onTick: (position) => saveProgress(position, false),
          onSeek: (position) => saveProgress(position, false),
          onPause: (position) => saveProgress(position, true),
          onEnd: (position) => saveProgress(position, true),
        },
  );

  const bookKey = `${book.hash}-${uniqueId()}`;
  const meta: TTSMediaBridgeMeta = {
    bookKey,
    title: source.title,
    author: source.author,
    coverImageUrl: book.coverImageUrl ?? null,
    metadataMode: 'chapter',
    ownsAudioFocus: false,
    getSectionLabel: () => controller.getCurrentChapter()?.title,
  };
  ttsSessionManager.claim(bookKey, controller, meta);
  if (assetIds.length > 0) liveSessions.set(bookKey, { tracks, assetIds });

  return { bookKey, controller };
};
