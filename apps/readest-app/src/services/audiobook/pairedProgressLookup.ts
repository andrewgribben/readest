// Resolve the other half of a Continuum pairing from a library audiobook stub
// or from an ebook association. Pairing metadata lives only on the ebook
// config; stubs are matched by streamed source ids or local file paths.
//
// OPDS stub identity is parsed here rather than via `services/opds/audiobook`
// so this module stays free of the document/OPDS fetch graph (and of supabase
// side effects that graph pulls into unit tests).

import { parseBookOrbitAudioFilePath } from '@/services/bookorbit/audiobookId';
import type { Book, BookConfig, PairedAudiobook } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { isAudiobook, parseAbsFilePath } from '@/utils/audiobook';

const OPDS_AUDIO_SCHEME = 'opdsaudio://';

/** Catalog id + ordered track hrefs packed into an `opdsaudio://` filePath. */
const parseOpdsStubIdentity = (
  filePath: string | undefined,
): { catalogId: string; hrefs: string[] } | null => {
  if (!filePath?.startsWith(OPDS_AUDIO_SCHEME)) return null;
  try {
    const data: unknown = JSON.parse(decodeURIComponent(filePath.slice(OPDS_AUDIO_SCHEME.length)));
    if (!data || typeof data !== 'object') return null;
    const record = data as { catalogId?: unknown; tracks?: unknown };
    if (typeof record.catalogId !== 'string' || !Array.isArray(record.tracks)) return null;
    const hrefs: string[] = [];
    for (const track of record.tracks) {
      if (!track || typeof track !== 'object') return null;
      const href = (track as { href?: unknown }).href;
      if (typeof href !== 'string') return null;
      hrefs.push(href);
    }
    return { catalogId: record.catalogId, hrefs };
  } catch {
    return null;
  }
};

export interface PairedEbookMatch {
  ebook: Book;
  config: BookConfig;
  association: PairedAudiobook;
}

export type LoadBookConfigFn = (book: Book, settings: SystemSettings) => Promise<BookConfig>;

/** True when this association is the Continuum pairing for the audiobook stub. */
export const associationMatchesAudiobook = (
  association: PairedAudiobook,
  audiobook: Book,
): boolean => {
  const source = association.source;
  if (source?.kind === 'audiobookshelf') {
    const parsed = parseAbsFilePath(audiobook.filePath);
    return !!parsed && parsed.serverId === source.serverId && parsed.itemId === source.itemId;
  }
  if (source?.kind === 'bookorbit') {
    const bookId = parseBookOrbitAudioFilePath(audiobook.filePath);
    return bookId !== null && bookId === source.bookId;
  }
  if (source?.kind === 'opds') {
    const data = parseOpdsStubIdentity(audiobook.filePath);
    if (!data || data.catalogId !== source.catalogId) return false;
    if (source.tracks.length !== data.hrefs.length) return false;
    return source.tracks.every((track, index) => track.contentUrl === data.hrefs[index]);
  }
  // Local imported recording: match when a paired file path equals the stub.
  return association.files.some((file) => !!audiobook.filePath && file.path === audiobook.filePath);
};

/**
 * Find the ebook whose device-local pairing points at this audiobook stub.
 * Scans non-audiobook library rows and loads configs until one matches.
 */
export const findPairedEbook = async (
  library: Book[],
  audiobook: Book,
  loadBookConfig: LoadBookConfigFn,
  settings: SystemSettings,
): Promise<PairedEbookMatch | null> => {
  if (!isAudiobook(audiobook) || audiobook.deletedAt) return null;

  for (const book of library) {
    if (book.deletedAt || isAudiobook(book) || book.hash === audiobook.hash) continue;
    let config: BookConfig;
    try {
      config = await loadBookConfig(book, settings);
    } catch {
      continue;
    }
    const association = config.audiobook;
    if (!association?.mappings.length) continue;
    if (!associationMatchesAudiobook(association, audiobook)) continue;
    return { ebook: book, config, association };
  }
  return null;
};

/** Library audiobook stub that matches a pairing association, if one exists. */
export const findPairedAudiobookStub = (
  library: Book[],
  association: PairedAudiobook | undefined | null,
): Book | null => {
  if (!association?.mappings.length) return null;
  const match = library.find(
    (book) =>
      !book.deletedAt &&
      isAudiobook(book) &&
      book.absMediaType !== 'podcast' &&
      associationMatchesAudiobook(association, book),
  );
  return match ?? null;
};

export interface ResolvedAudiobookPosition {
  seconds: number;
  updatedAt: number;
  /** Server playback differed from the library stub enough to treat as fresher. */
  serverFresher: boolean;
}

/**
 * Listening position for the paired stub. BookOrbit may also read server
 * playback state via {@link fetchBookOrbitPlaybackSeconds}.
 */
export const resolvePairedAudiobookPosition = async (
  stub: Book | null,
  association: PairedAudiobook,
  fetchBookOrbit: typeof import('./pairedProgressBookOrbit').fetchBookOrbitPlaybackSeconds,
): Promise<ResolvedAudiobookPosition | null> => {
  const localSeconds = stub?.progress?.[0] ?? 0;
  const localUpdatedAt = stub?.updatedAt ?? 0;

  if (association.source?.kind === 'bookorbit') {
    const server = await fetchBookOrbit(association, localSeconds);
    if (server) {
      return {
        seconds: server.seconds,
        updatedAt: server.serverFresherThanLocal
          ? Math.max(server.updatedAt, localUpdatedAt)
          : localUpdatedAt || server.updatedAt,
        serverFresher: server.serverFresherThanLocal,
      };
    }
  }

  if (!stub) return null;

  return {
    seconds: localSeconds,
    updatedAt: localUpdatedAt,
    serverFresher: false,
  };
};
