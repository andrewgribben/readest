import type { NarrationAudioSource } from '@/services/tts/mediaOverlay/MediaOverlayClient';
import type { NarrationTrack } from '@/services/tts/mediaOverlay/MultiTrackNarrationClock';
import { makeBookOrbitAudioFilePath } from '@/services/bookorbit/audiobookId';
import { useLibraryStore } from '@/store/libraryStore';
import type { PairedAudiobook } from '@/types/book';
import type { AppService } from '@/types/system';
import { md5 } from '@/utils/md5';
import { opdsAudioIdentity, parseOpdsAudioFilePath } from './audiobook';
import { loadOpdsOfflineManifest } from './offline';

type TrackSource = Required<Pick<NarrationAudioSource, 'resolveTracks' | 'loadTrack'>>;

/** Keep the provider identity and mappings; only replace the media being loaded. */
export const resolveDownloadedOpdsPairing = async (
  appService: AppService,
  pairing: PairedAudiobook,
): Promise<{ tracks: NarrationTrack[]; loadTrack: TrackSource['loadTrack'] } | null> => {
  const source = pairing.source;
  if (source?.kind !== 'bookorbit' && source?.kind !== 'opds') return null;
  const path =
    source.kind === 'bookorbit'
      ? makeBookOrbitAudioFilePath(source.bookId)
      : pairing.files[0]?.path;
  const data = parseOpdsAudioFilePath(path);
  const hash = data ? md5(opdsAudioIdentity(data.catalogId, data.tracks)) : undefined;
  const book = useLibraryStore
    .getState()
    .library.find(
      (entry) => !entry.deletedAt && (entry.filePath === path || (hash && entry.hash === hash)),
    );
  if (!book?.opdsDownloadedAt) return null;
  try {
    const manifest = await loadOpdsOfflineManifest(appService, book.hash);
    if (!manifest || manifest.tracks.length !== source.tracks.length) return null;
    // An updated recording must not silently reuse an older download's timeline.
    if (
      manifest.tracks.some(
        (track, i) =>
          Math.abs(track.startOffset - source.tracks[i]!.startOffset) > 0.05 ||
          Math.abs(track.duration - source.tracks[i]!.duration) > 0.05,
      )
    )
      return null;
    const present = await Promise.all(
      manifest.tracks.map((track) => appService.exists(track.contentUrl, 'Books')),
    );
    if (present.some((exists) => !exists)) return null;
    const paths = await Promise.all(
      manifest.tracks.map((track) => appService.resolveFilePath(track.contentUrl, 'Books')),
    );
    return {
      tracks: manifest.tracks.map((track, i) => ({
        url: paths[i]!,
        startOffset: track.startOffset,
        duration: track.duration,
      })),
      loadTrack: async (path) => {
        const bytes = await appService.readFile(path, 'None', 'binary');
        const mimeType = manifest.tracks[paths.indexOf(path)]?.mimeType;
        return new Blob([bytes], { type: mimeType });
      },
    };
  } catch {
    return null;
  }
};

export const preferDownloadedOpdsNarration = (
  appService: AppService,
  pairing: PairedAudiobook,
  streaming: TrackSource,
): TrackSource => {
  let downloaded: Awaited<ReturnType<typeof resolveDownloadedOpdsPairing>> = null;
  return {
    resolveTracks: async (href) => {
      downloaded = await resolveDownloadedOpdsPairing(appService, pairing);
      return downloaded?.tracks ?? streaming.resolveTracks(href);
    },
    loadTrack: (path) => (downloaded ? downloaded.loadTrack(path) : streaming.loadTrack(path)),
  };
};
