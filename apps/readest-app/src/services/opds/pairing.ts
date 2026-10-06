// Pairing an ebook with an audiobook that entered the library from an OPDS
// catalog (#6224): either a generic `OPDSAUDIO` stub or a BookOrbit-native
// `BOOKORBIT` stub created when the user played the entry.
//
// Mirrors the Audiobookshelf wizard path (`absPairing.ts`): list library stubs
// whose upstream is still configured, expand them into one virtual file on a
// global timeline, and hand the track list to the association so Read Aloud
// can stream without re-fetching the feed.

import type { StreamedPairingSource } from '@/services/audiobook/absPairing';
import {
  isBookOrbitAudioFilePath,
  parseBookOrbitAudioFilePath,
} from '@/services/bookorbit/audiobookId';
import { createBookOrbitClient } from '@/services/bookorbit/createClient';
import { buildBookOrbitPairing } from '@/services/bookorbit/pairing';
import { useSettingsStore } from '@/store/settingsStore';
import type { ABSTrack } from '@/types/audiobookshelf';
import type { AudiobookChapter, Book, PairedAudiobookOpdsSource } from '@/types/book';
import { getBaseFilename } from '@/utils/path';
import {
  buildOpdsAudioTracks,
  makeOpdsAudioFilePath,
  parseOpdsAudioFilePath,
  type OpdsAudiobookData,
} from './audiobook';
import {
  buildOpdsAudioUrl,
  opdsAudioBlocker,
  probeAudioDurations,
  resolveOpdsAudioAuth,
} from './audioStream';

export const OPDS_PAIRED_FILE_ID = 'opds';

const findLiveCatalog = (catalogId: string) => {
  const catalog = useSettingsStore
    .getState()
    .settings.opdsCatalogs?.find((entry) => entry.id === catalogId);
  return catalog && !catalog.deletedAt ? catalog : undefined;
};

/** True when the OPDS / BookOrbit stub still has a configured upstream. */
export const isOpdsAudiobookOrphaned = (book: Book): boolean => {
  if (book.format === 'BOOKORBIT' || isBookOrbitAudioFilePath(book.filePath)) {
    const { bookorbit } = useSettingsStore.getState().settings;
    return !bookorbit?.serverUrl || !bookorbit.password;
  }
  const data = parseOpdsAudioFilePath(book.filePath);
  if (!data) return true;
  return !findLiveCatalog(data.catalogId);
};

/**
 * Library audiobooks from OPDS catalogs that can be paired: live `OPDSAUDIO`
 * and `BOOKORBIT` stubs whose catalog / BookOrbit credentials are still set.
 */
export const listPairableOpdsBooks = (library: Book[]): Book[] =>
  library
    .filter(
      (book) =>
        !book.deletedAt &&
        (book.format === 'OPDSAUDIO' || book.format === 'BOOKORBIT') &&
        !isOpdsAudiobookOrphaned(book),
    )
    .sort((a, b) => a.title.localeCompare(b.title));

export const buildOpdsPairingSource = (
  data: OpdsAudiobookData,
  tracks: ABSTrack[],
): StreamedPairingSource => {
  if (!tracks.length) throw new Error('This audiobook has no audio tracks.');
  const duration = Math.max(...tracks.map((track) => track.startOffset + track.duration));
  const title = data.title.trim() || undefined;
  const chapters: AudiobookChapter[] = tracks.map((track, index) => {
    const linkTitle = data.tracks[index]?.title?.trim();
    const label = track.title?.trim()
      ? getBaseFilename(track.title)
      : linkTitle
        ? getBaseFilename(linkTitle)
        : `Track ${index + 1}`;
    return {
      id: `${OPDS_PAIRED_FILE_ID}:track:${track.index}`,
      fileId: OPDS_PAIRED_FILE_ID,
      label,
      start: track.startOffset,
      end: track.startOffset + track.duration,
    };
  });

  const source: PairedAudiobookOpdsSource = {
    kind: 'opds',
    catalogId: data.catalogId,
    tracks: tracks.map((track) => ({
      index: track.index,
      startOffset: track.startOffset,
      duration: track.duration,
      contentUrl: track.contentUrl,
      mimeType: track.mimeType,
      ...(track.title ? { title: track.title } : {}),
    })),
  };

  return {
    ...(title ? { title } : {}),
    files: [
      {
        id: OPDS_PAIRED_FILE_ID,
        name: title ?? 'audiobook',
        path: makeOpdsAudioFilePath(data),
        duration,
      },
    ],
    chapters,
    source,
  };
};

const loadBookOrbitPairingSource = async (book: Book): Promise<StreamedPairingSource> => {
  const bookId = parseBookOrbitAudioFilePath(book.filePath);
  const client = createBookOrbitClient();
  if (bookId == null || !client) throw new Error('BookOrbit server not found');
  const manifest = await client.getManifest(bookId);
  // Empty ebook chapter list: the wizard builds mappings after the user picks
  // an anchor. Auto-pair uses the same builder with a real TOC.
  const pairing = buildBookOrbitPairing(manifest, []);
  if (!pairing.source || pairing.source.kind !== 'bookorbit') {
    throw new Error('Failed to load the audiobook.');
  }
  return {
    ...(pairing.title ? { title: pairing.title } : {}),
    ...(pairing.narrator ? { narrator: pairing.narrator } : {}),
    files: pairing.files,
    chapters: pairing.chapters,
    source: pairing.source,
  };
};

const loadGenericOpdsPairingSource = async (book: Book): Promise<StreamedPairingSource> => {
  const data = parseOpdsAudioFilePath(book.filePath);
  if (!data || data.tracks.length === 0) throw new Error('OPDS audiobook not found');
  if (!findLiveCatalog(data.catalogId)) throw new Error('OPDS catalog not found');

  const first = data.tracks[0]!;
  const auth = await resolveOpdsAudioAuth(data.catalogId, first.href);
  if (opdsAudioBlocker(first.href, auth) === 'web-auth') {
    throw new Error('This catalog needs credentials that cannot be used in the browser.');
  }

  const playUrls = data.tracks.map((track) => buildOpdsAudioUrl(track.href));
  const durations = await probeAudioDurations(
    playUrls,
    data.tracks.map((track) => ({ href: track.href, auth })),
  );
  const tracks = buildOpdsAudioTracks(data.tracks, durations);
  if (tracks.length === 0) throw new Error('No playable audio chapters were found.');
  // Dropping a track whose duration could not be read would shift later
  // chapters; refuse an incomplete timeline the same way the player does.
  if (tracks.length !== data.tracks.length) {
    throw new Error('Could not read the duration of every audio track.');
  }

  return buildOpdsPairingSource(data, tracks);
};

/** Fetches chapters/tracks behind a library OPDS or BookOrbit audiobook. */
export const loadOpdsPairingSource = async (book: Book): Promise<StreamedPairingSource> => {
  if (book.format === 'BOOKORBIT' || isBookOrbitAudioFilePath(book.filePath)) {
    return loadBookOrbitPairingSource(book);
  }
  return loadGenericOpdsPairingSource(book);
};
