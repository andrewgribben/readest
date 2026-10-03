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
import { BlobAudioClock, HtmlAudioClock } from '@/services/audiobook/AudiobookClock';
import { AudiobookController } from '@/services/audiobook/AudiobookController';
import type { AudiobookSource } from '@/services/audiobook/AudiobookController';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { TTSMediaBridgeMeta } from '@/services/tts/ttsMediaBridge';
import { useLibraryStore } from '@/store/libraryStore';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { uniqueId } from '@/utils/misc';
import { bookOrbitProgressHooks } from './progressSync';
import { makeAudiobookProgressSaver } from '@/services/audiobook/progressPersistence';
import { parseBookOrbitAudioFilePath } from './audiobookId';
import { createBookOrbitClient } from './createClient';
import { openBookOrbitMediaProxy } from './mediaProxy';
import {
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
  if (!client) return null;

  const manifest = await client.getManifest(bookId);
  const tracks = manifestTracks(manifest);
  const chapters = manifestChapters(manifest);
  const assetIds = manifestAssetIds(manifest);
  if (tracks.length === 0) return null;

  const totalDuration = tracks.reduce((sum, track) => sum + track.duration, 0);

  // Best effort: a server without a stored position, or an unreachable one,
  // just means we fall back to the local progress.
  let serverPositionSec = 0;
  let baseRevision = 0;
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

  const mimeByUrl = new Map(tracks.map((track) => [track.contentUrl, track.mimeType]));
  const streamUrl = await openBookOrbitMediaProxy(client);
  recordDuration(appService, book.hash, totalDuration);
  const saveProgress = makeAudiobookProgressSaver(appService, book.hash, totalDuration);

  const source: AudiobookSource = {
    itemId: String(bookId),
    title: manifest.book.title || book.title,
    author: manifest.book.authors.join(' & ') || book.author,
    tracks,
    chapters,
    // A streamable loopback URL where the proxy is available; otherwise the
    // content path, which the blob loader below fetches.
    resolveUrl: (contentPath: string) => streamUrl?.(contentPath) ?? contentPath,
    startAt: resolveStartAt(serverPositionSec, book, totalDuration),
  };

  const clock = streamUrl
    ? new HtmlAudioClock()
    : new BlobAudioClock(async (contentPath) => {
        const res = await client.fetchAsset(contentPath);
        if (!res.ok) throw new Error(`BookOrbit asset fetch failed: ${res.status}`);
        return new Blob([await res.arrayBuffer()], {
          type: mimeByUrl.get(contentPath) ?? 'audio/mpeg',
        });
      });

  const controller = new AudiobookController(
    source,
    clock,
    bookOrbitProgressHooks(
      client,
      bookId,
      tracks,
      assetIds,
      manifest.revision,
      baseRevision,
      saveProgress,
    ),
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

  return { bookKey, controller };
};
