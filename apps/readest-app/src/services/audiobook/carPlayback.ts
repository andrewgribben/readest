import type { AppService } from '@/types/system';
import type { Book, PairedAudiobook } from '@/types/book';
import { useSettingsStore } from '@/store/settingsStore';
import { pairedAudiobookEntry } from './pairedProgressPersistence';
import { selectListeningCheckpoint } from './startPosition';
import { loadOpdsOfflineManifest } from '@/services/opds/offline';
import { loadAbsOfflineManifest } from '@/services/audiobookshelf/offline';
import { resolveDownloadedOpdsPairing } from '@/services/opds/pairedOffline';
import { makeAudiobookProgressSaver } from './progressPersistence';
import { getConfigFilename } from '@/utils/book';
import { getIndexFromCfi } from '@/utils/cfi';
import { invoke } from '@tauri-apps/api/core';

export const getActiveCarRecording = async (): Promise<{
  hash: string;
  position: number;
} | null> => {
  try {
    const state = await invoke<{ recordedBookHash?: string; recordedPositionMs?: number }>(
      'plugin:native-tts|playout_position',
    );
    return state?.recordedBookHash && Number.isFinite(state.recordedPositionMs)
      ? { hash: state.recordedBookHash, position: state.recordedPositionMs! / 1000 }
      : null;
  } catch {
    return null;
  }
};

export interface CarRecordedAudio {
  audioHash: string;
  tracks: { path: string; startOffset: number; duration: number }[];
  journalPath: string;
  ebookConfigPath: string | null;
  listening: number | null;
  reading: number | null;
  capturedAt: number;
}

export const carListeningJournal = (hash: string) => `${hash}/car-listening.json`;

/** Native playback uses a separate journal so a stale WebView cannot erase it. */
export const importCarListeningCheckpoint = async (appService: AppService, book: Book) => {
  try {
    const journal = JSON.parse(
      (await appService.readFile(carListeningJournal(book.hash), 'Books', 'text')) as string,
    );
    if (journal.audioHash !== book.hash) return null;
    const checkpoint = selectListeningCheckpoint(
      [journal],
      book.duration ?? book.progress?.[1] ?? journal.duration,
    );
    if (checkpoint && checkpoint.updatedAt > book.updatedAt) {
      makeAudiobookProgressSaver(appService, book.hash, checkpoint.duration)(
        checkpoint.position,
        true,
        checkpoint.updatedAt,
      );
    }
    return checkpoint;
  } catch {
    return null;
  }
};

const readingEstimate = async (
  appService: AppService,
  book: Book,
  association: PairedAudiobook,
  cfi?: string,
) => {
  if (!cfi) return null;
  const [{ DocumentLoader }, CFI, { loadPairedAudiobookSection }, { MediaOverlayTTS }] =
    await Promise.all([
      import('@/libs/document'),
      import('foliate-js/epubcfi.js'),
      import('@/services/tts/pairedAudiobook'),
      import('@/services/tts/mediaOverlay/MediaOverlayTTS'),
    ]);
  const { file } = await appService.loadBookContent(book);
  const { book: document } = await new DocumentLoader(file).open();
  try {
    const index = getIndexFromCfi(cfi);
    const section = index === null ? null : document.sections[index];
    if (!section?.createDocument || index === null) return null;
    const doc = await section.createDocument();
    const narration = loadPairedAudiobookSection(document, association, index, doc, 'en');
    if (!narration) return null;
    const parsed = CFI.parse(cfi);
    const local = Array.isArray(parsed)
      ? parsed.slice(1)
      : { ...parsed, parent: parsed.parent.slice(1) };
    const range = CFI.toRange(doc, local);
    if (!range) return null;
    const tts = new MediaOverlayTTS(doc, narration, () => {});
    tts.from(range);
    const start = tts.getStartAudioPosition();
    if (!start) return null;
    let offset = 0;
    for (const audioFile of association.files) {
      if (audioFile.path === start.audioHref) return offset + start.seconds;
      offset += audioFile.duration;
    }
    return null;
  } finally {
    await document.destroy?.();
    await (file as File & { close?: () => Promise<void> }).close?.();
  }
};

export const resolveCarRecordedAudio = async (
  appService: AppService,
  book: Book,
): Promise<CarRecordedAudio | null> => {
  const config = await appService.loadBookConfig(book, useSettingsStore.getState().settings);
  const association = config.audiobook;
  const entry = association ? pairedAudiobookEntry(association, false) : book;
  let tracks: CarRecordedAudio['tracks'] = [];
  if (association) {
    if (association.source?.kind === 'opds' || association.source?.kind === 'bookorbit') {
      const downloaded = await resolveDownloadedOpdsPairing(appService, association);
      if (downloaded)
        tracks = downloaded.tracks.map((track) => ({
          path: track.url,
          startOffset: track.startOffset,
          duration: track.duration,
        }));
    } else if (!association.source) {
      let offset = 0;
      for (const file of association.files) {
        if (!(await appService.exists(file.path, 'Books'))) return null;
        tracks.push({
          path: await appService.resolveFilePath(file.path, 'Books'),
          startOffset: offset,
          duration: file.duration,
        });
        offset += file.duration;
      }
    }
  }
  if (!tracks.length && entry) {
    const offline = entry.opdsDownloadedAt
      ? await loadOpdsOfflineManifest(appService, entry.hash)
      : entry.absDownloadedAt
        ? await loadAbsOfflineManifest(appService, entry.hash)
        : null;
    if (offline) {
      for (const track of offline.tracks) {
        if (!(await appService.exists(track.contentUrl, 'Books'))) return null;
        tracks.push({
          path: await appService.resolveFilePath(track.contentUrl, 'Books'),
          startOffset: track.startOffset,
          duration: track.duration,
        });
      }
    }
  }
  if (!tracks.length || !entry) return null;
  const duration = tracks.reduce((sum, track) => sum + track.duration, 0);
  const journal = await importCarListeningCheckpoint(appService, entry);
  const checkpoint = selectListeningCheckpoint(
    [
      association?.listeningProgress,
      journal,
      entry.progress
        ? { position: entry.progress[0], duration: entry.progress[1], updatedAt: entry.updatedAt }
        : null,
    ],
    duration,
  );
  return {
    audioHash: entry.hash,
    tracks,
    journalPath: await appService.resolveFilePath(carListeningJournal(entry.hash), 'Books'),
    ebookConfigPath: association
      ? await appService.resolveFilePath(getConfigFilename(book), 'Books')
      : null,
    listening: checkpoint?.position ?? null,
    reading: association
      ? await readingEstimate(appService, book, association, config.location).catch(() => null)
      : null,
    capturedAt: checkpoint?.updatedAt ?? 0,
  };
};
