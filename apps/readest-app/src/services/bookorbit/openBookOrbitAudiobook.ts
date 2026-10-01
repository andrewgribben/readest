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
import { loadOpdsOfflineManifest } from '@/services/opds/offline';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { TTSMediaBridgeMeta } from '@/services/tts/ttsMediaBridge';
import { useLibraryStore } from '@/store/libraryStore';
import type { ABSTrack } from '@/types/audiobookshelf';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getOSPlatform, uniqueId } from '@/utils/misc';
import { parseBookOrbitAudioFilePath } from './audiobookId';
import { createBookOrbitClient } from './createClient';
import { openBookOrbitMediaProxy } from './mediaProxy';
import {
  assetPositionFromGlobal,
  globalFromAssetPosition,
  manifestAssetIds,
  manifestChapters,
  manifestTracks,
} from './manifest';

export interface BookOrbitAudiobookSession {
  bookKey: string;
  controller: AudiobookController;
}

/** Matches the ABS syncer: keep the row live in the store, write to disk rarely. */
const PERSIST_THROTTLE_MS = 15000;

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

const makeProgressSaver = (appService: AppService, bookHash: string, duration: number) => {
  let lastPersistAt = 0;
  return (positionSec: number, force: boolean): void => {
    const { library, setLibrary } = useLibraryStore.getState();
    const idx = library.findIndex((b) => b.hash === bookHash);
    if (idx === -1) return;
    const now = Date.now();
    const progress: [number, number] = [Math.round(positionSec), Math.round(duration)];
    const newLibrary = library.slice();
    newLibrary[idx] = { ...library[idx]!, progress, updatedAt: now };
    setLibrary(newLibrary);
    if (force || now - lastPersistAt >= PERSIST_THROTTLE_MS) {
      lastPersistAt = now;
      Promise.resolve(appService.saveLibraryBooks(newLibrary)).catch(console.warn);
    }
  };
};

/**
 * Where to resume. The server's position wins when it has one: BookOrbit's own
 * player writes there too, and sharing it is the point of using this API. A
 * book parked at its end replays from the start, the same rule the OPDS path
 * uses -- resuming past the last track ends the session the instant it opens.
 */
const resolveStartAt = (serverPositionSec: number, book: Book, duration: number): number => {
  const local = book.progress?.[0] ?? 0;
  const position = serverPositionSec > 0 ? serverPositionSec : local;
  if (position <= 0) return 0;
  return duration > 0 && position >= duration - 1 ? 0 : position;
};

export const openBookOrbitAudiobookSession = async (input: {
  appService: AppService;
  book: Book;
}): Promise<BookOrbitAudiobookSession | null> => {
  const { appService, book } = input;
  const bookId = parseBookOrbitAudioFilePath(book.filePath);
  if (bookId === null) return null;

  const existing = ttsSessionManager.getSessionByHash(book.hash);
  if (existing && existing.controller.kind === 'audiobook' && !existing.controller.terminated) {
    return { bookKey: existing.bookKey, controller: existing.controller as AudiobookController };
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
  let serverPositionSec = 0;
  let baseRevision = 0;
  if (client && assetIds.length > 0) {
    try {
      const state = await client.getPlaybackState(bookId);
      if (state?.assetId) {
        // The stored position is an offset *within one asset*, not into the
        // book, so it has to be placed on the timeline before it means anything.
        serverPositionSec =
          globalFromAssetPosition(tracks, assetIds, state.assetId, state.positionMs ?? 0) ?? 0;
      }
      baseRevision = state?.revision ?? 0;
    } catch {
      serverPositionSec = 0;
    }
  }

  // Push the position back so BookOrbit's own player (and anything else
  // reading it) resumes where Readest left off. `baseRevision` is the server's
  // concurrency check: it rejects a write based on a position someone else has
  // already superseded, and we re-read rather than clobbering theirs.
  let pushInFlight = false;
  // The position that arrived while a write was in flight. Dropping it is fine
  // for a tick (another follows a second later) but not for the pause or end
  // that stops playback: nothing comes after it, so the server would keep a
  // position from seconds earlier.
  let queuedPosition: number | null = null;
  const pushPosition = async (positionSec: number): Promise<void> => {
    if (!client || assetIds.length === 0) return;
    if (pushInFlight) {
      queuedPosition = positionSec;
      return;
    }
    const at = assetPositionFromGlobal(tracks, assetIds, positionSec);
    if (!at) return;
    pushInFlight = true;
    try {
      const written = await client.putPlaybackState(bookId, {
        ...at,
        capturedAt: new Date().toISOString(),
        operationId: crypto.randomUUID(),
        baseRevision,
        manifestRevision,
      });
      baseRevision = (written as { revision?: number })?.revision ?? baseRevision + 1;
    } catch {
      // A rejected write means someone else moved the position; take theirs.
      try {
        baseRevision = (await client.getPlaybackState(bookId))?.revision ?? baseRevision;
      } catch {
        // Offline: keep the local position and try again on the next tick.
      }
    } finally {
      pushInFlight = false;
    }
    if (queuedPosition !== null) {
      const next = queuedPosition;
      queuedPosition = null;
      await pushPosition(next);
    }
  };

  recordDuration(appService, book.hash, totalDuration);
  const saveProgress = makeProgressSaver(appService, book.hash, totalDuration);

  const source: AudiobookSource = {
    itemId: String(bookId),
    title,
    author,
    tracks,
    chapters,
    resolveUrl,
    startAt: resolveStartAt(serverPositionSec, book, totalDuration),
  };

  const controller = new AudiobookController(source, clock, {
    onTick: (position) => {
      saveProgress(position, false);
      void pushPosition(position);
    },
    onSeek: (position) => saveProgress(position, false),
    onPause: (position) => {
      saveProgress(position, true);
      void pushPosition(position);
    },
    onEnd: (position) => {
      saveProgress(position, true);
      void pushPosition(position);
    },
  });

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

  return { bookKey, controller };
};
