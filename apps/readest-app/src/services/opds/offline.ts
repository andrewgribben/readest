// Offline copies of OPDS / BookOrbit audiobooks.
//
// Mirrors Audiobookshelf offline downloads (#6256): tracks land in
// `Books/<hash>/opds-offline/` next to a manifest written last, so the
// manifest's presence means the download finished. Files are streamed to
// `<file>.part` and renamed into place so a half-written file is never
// mistaken for a finished one, and a retry skips every file that already
// landed.

import { rename } from '@tauri-apps/plugin-fs';
import { downloadFile } from '@/libs/storage';
import {
  isBookOrbitAudioFilePath,
  parseBookOrbitAudioFilePath,
} from '@/services/bookorbit/audiobookId';
import { createBookOrbitClient } from '@/services/bookorbit/createClient';
import { manifestChapters, manifestTracks } from '@/services/bookorbit/manifest';
import type { ABSChapter, ABSTrack } from '@/types/audiobookshelf';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getOpdsOfflineDir } from '@/utils/audiobook';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { makeSafeFilename } from '@/utils/misc';
import type { ProgressHandler } from '@/utils/transfer';
import { buildOpdsAudioTracks, parseOpdsAudioFilePath, type OpdsAudiobookData } from './audiobook';
import {
  buildOpdsAudioUrl,
  opdsAudioBlocker,
  probeAudioDurations,
  resolveOpdsAudioAuth,
  type OpdsAudioAuth,
} from './audioStream';

export interface OpdsOfflineManifest {
  kind: 'opds' | 'bookorbit';
  duration: number;
  chapters: ABSChapter[];
  /** Each track's `contentUrl` is its file path relative to the Books dir. */
  tracks: ABSTrack[];
}

interface OfflineFile {
  /** Absolute or server-relative URL to fetch. */
  url: string;
  /** Destination relative to the Books dir. */
  path: string;
  /** Suggested byte length for progress; 0 when unknown. */
  size: number;
  headers?: Record<string, string>;
  title?: string;
  mimeType: string;
  /** Global timeline fields filled after download for OPDS; known for BookOrbit. */
  startOffset: number;
  duration: number;
  index: number;
}

const getManifestPath = (bookHash: string): string =>
  `${getOpdsOfflineDir(bookHash)}/manifest.json`;

export const loadOpdsOfflineManifest = async (
  appService: AppService,
  bookHash: string,
): Promise<OpdsOfflineManifest | null> => {
  try {
    const text = await appService.readFile(getManifestPath(bookHash), 'Books', 'text');
    const data = JSON.parse(text as string) as OpdsOfflineManifest;
    if (!data || (data.kind !== 'opds' && data.kind !== 'bookorbit')) return null;
    if (!Array.isArray(data.tracks) || data.tracks.length === 0) return null;
    return data;
  } catch {
    return null;
  }
};

const trackHeaders = (auth: OpdsAudioAuth): Record<string, string> => ({
  ...(auth.authHeader ? { Authorization: auth.authHeader } : {}),
  ...auth.customHeaders,
});

const planOpdsFiles = async (data: OpdsAudiobookData, bookHash: string): Promise<OfflineFile[]> => {
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
  if (tracks.length === 0) throw new Error('Nothing to download');
  if (tracks.length !== data.tracks.length) {
    throw new Error('Could not read the duration of every audio track.');
  }

  const headers = trackHeaders(auth);
  return tracks.map((track, i) => {
    const link = data.tracks[i]!;
    return {
      url: buildOpdsAudioUrl(link.href),
      path: `${getOpdsOfflineDir(bookHash)}/${i + 1}-${makeSafeFilename(link.title ?? `track-${i + 1}`)}`,
      size: 0,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(link.title ? { title: link.title } : {}),
      mimeType: link.mimeType,
      startOffset: track.startOffset,
      duration: track.duration,
      index: track.index,
    };
  });
};

const downloadFiles = async (
  appService: AppService,
  bookHash: string,
  files: OfflineFile[],
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
  onUnauthorized?: () => Promise<Record<string, string> | undefined>,
): Promise<void> => {
  await appService.createDir(getOpdsOfflineDir(bookHash), 'Books', true);
  const totalBytes = files.reduce((sum, file) => sum + Math.max(file.size, 1), 0);
  let doneBytes = 0;

  for (const file of files) {
    if (signal?.aborted) throw new Error('Download cancelled');
    if (!(await appService.exists(file.path, 'Books'))) {
      const dst = await appService.resolveFilePath(file.path, 'Books');
      let headers = file.headers;
      const fetchFile = () =>
        downloadFile({
          appService,
          dst: `${dst}.part`,
          cfp: '',
          url: file.url,
          headers,
          skipSslVerification: true,
          onProgress: (p) =>
            onProgress?.({
              progress: doneBytes + p.progress,
              total: Math.max(totalBytes, doneBytes + p.total),
              transferSpeed: p.transferSpeed,
            }),
        });
      try {
        await fetchFile();
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (!onUnauthorized || !message.includes('status code 401')) throw error;
        headers = await onUnauthorized();
        await fetchFile();
      }
      await rename(`${dst}.part`, dst);
    }
    doneBytes += Math.max(file.size, 1);
  }
};

export const downloadOpdsForOffline = async (
  appService: AppService,
  book: Book,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<void> => {
  const isBookOrbit = book.format === 'BOOKORBIT' || isBookOrbitAudioFilePath(book.filePath);

  if (isBookOrbit) {
    const bookId = parseBookOrbitAudioFilePath(book.filePath);
    const client = createBookOrbitClient();
    if (bookId == null || !client) throw new Error('BookOrbit server not found');
    const manifest = await client.getManifest(bookId);
    const tracks = manifestTracks(manifest);
    const chapters = manifestChapters(manifest);
    if (tracks.length === 0) throw new Error('Nothing to download');

    await client.refreshAccessToken();
    const files: OfflineFile[] = tracks.map((track, i) => {
      const asset = [...manifest.assets].sort((a, b) => a.sequence - b.sequence)[i];
      return {
        url: `${client.serverUrl}${track.contentUrl}`,
        path: `${getOpdsOfflineDir(book.hash)}/${i + 1}-${makeSafeFilename(
          asset?.assetId ?? track.title ?? `track-${i + 1}`,
        )}`,
        size: asset?.sizeBytes ?? 0,
        headers: {
          Authorization: `Bearer ${client.accessToken}`,
          ...normalizeCustomHeaders(client.server.customHeaders),
        },
        mimeType: track.mimeType,
        startOffset: track.startOffset,
        duration: track.duration,
        index: track.index,
        ...(track.title ? { title: track.title } : {}),
      };
    });

    await downloadFiles(appService, book.hash, files, onProgress, signal, async () => {
      const refreshed = createBookOrbitClient();
      if (!refreshed) throw new Error('BookOrbit server not found');
      await refreshed.refreshAccessToken();
      return {
        Authorization: `Bearer ${refreshed.accessToken}`,
        ...normalizeCustomHeaders(refreshed.server.customHeaders),
      };
    });
    if (signal?.aborted) throw new Error('Download cancelled');

    const offline: OpdsOfflineManifest = {
      kind: 'bookorbit',
      duration: tracks.reduce((sum, track) => sum + track.duration, 0),
      chapters,
      tracks: tracks.map((track, i) => ({ ...track, contentUrl: files[i]!.path })),
    };
    await appService.writeFile(getManifestPath(book.hash), 'Books', JSON.stringify(offline));
    return;
  }

  const data = parseOpdsAudioFilePath(book.filePath);
  if (!data || data.tracks.length === 0) throw new Error('OPDS audiobook not found');
  const files = await planOpdsFiles(data, book.hash);
  await downloadFiles(appService, book.hash, files, onProgress, signal);
  if (signal?.aborted) throw new Error('Download cancelled');

  const offline: OpdsOfflineManifest = {
    kind: 'opds',
    duration: Math.max(...files.map((file) => file.startOffset + file.duration)),
    chapters: [],
    tracks: files.map((file) => ({
      index: file.index,
      startOffset: file.startOffset,
      duration: file.duration,
      contentUrl: file.path,
      mimeType: file.mimeType,
      ...(file.title ? { title: file.title } : {}),
    })),
  };
  await appService.writeFile(getManifestPath(book.hash), 'Books', JSON.stringify(offline));
};
