// The OPDS half of read-along narration.
//
// A paired OPDS audiobook has no local file: its tracks are the acquisition
// hrefs from the catalog entry. Unauthenticated catalogs stream those URLs
// straight into the media element; authenticated catalogs need a native fetch
// (the element cannot send Authorization), so `loadOpdsTrack` mirrors the
// player path in `audioStream.ts`.
//
// Authenticated track URLs are rewritten to `opds-track:<index>` so
// MediaOverlayClient's `^https?:` streamable check fails and BlobAudioClock
// + loadTrack are used — leaving a real https href here would make the
// element try (and fail) to fetch without credentials.

import type { NarrationTrack } from '@/services/tts/mediaOverlay/MultiTrackNarrationClock';
import type { PairedAudiobookOpdsSource } from '@/types/book';
import {
  buildOpdsAudioUrl,
  canStreamOpdsAudio,
  fetchOpdsAudioBlob,
  opdsAudioBlocker,
  resolveOpdsAudioAuth,
  type OpdsAudioAuth,
} from './audioStream';

const TRACK_SCHEME = 'opds-track:';

const locateTrack = (tracks: NarrationTrack[], globalSec: number): NarrationTrack | null => {
  if (!tracks.length) return null;
  const sorted = [...tracks].sort((a, b) => a.startOffset - b.startOffset);
  return (
    [...sorted].reverse().find((candidate) => candidate.startOffset <= globalSec) ?? sorted[0]!
  );
};

/**
 * Resolve catalog credentials once for a pairing. Returns null when the
 * catalog row is gone (unpaired upstream).
 */
export const resolveOpdsNarrationAuth = async (
  source: PairedAudiobookOpdsSource,
): Promise<OpdsAudioAuth | null> => {
  const first = source.tracks[0];
  if (!first) return null;
  try {
    return await resolveOpdsAudioAuth(source.catalogId, first.contentUrl);
  } catch {
    return null;
  }
};

/**
 * The pairing's tracks on the narration timeline. Null when the catalog is
 * gone or web+auth makes playback impossible.
 */
export const opdsNarrationTracks = async (
  source: PairedAudiobookOpdsSource,
): Promise<NarrationTrack[] | null> => {
  const auth = await resolveOpdsNarrationAuth(source);
  if (!auth) return null;
  const first = source.tracks[0];
  if (!first) return null;
  if (opdsAudioBlocker(first.contentUrl, auth) === 'web-auth') return null;

  const streamable = canStreamOpdsAudio(auth);
  return source.tracks.map((track) => ({
    url: streamable ? buildOpdsAudioUrl(track.contentUrl) : `${TRACK_SCHEME}${track.index}`,
    startOffset: track.startOffset,
    duration: track.duration,
  }));
};

export const loadOpdsTrack = async (
  source: PairedAudiobookOpdsSource,
  contentPath: string,
): Promise<Blob> => {
  const auth = await resolveOpdsNarrationAuth(source);
  if (!auth) throw new Error('OPDS catalog not found');

  let track = source.tracks.find((candidate) => candidate.contentUrl === contentPath);
  if (!track && contentPath.startsWith(TRACK_SCHEME)) {
    const index = Number(contentPath.slice(TRACK_SCHEME.length));
    track = source.tracks.find((candidate) => candidate.index === index);
  }
  if (!track) {
    track = source.tracks.find(
      (candidate) => buildOpdsAudioUrl(candidate.contentUrl) === contentPath,
    );
  }
  if (!track) throw new Error('OPDS track not found');
  return fetchOpdsAudioBlob(track.contentUrl, auth, track.mimeType);
};

/**
 * The file holding a global position, for previewing a chapter from its start.
 * Only streamable (unauthenticated) catalogs return a clip URL — authenticated
 * catalogs need a blob fetch the wizard preview does not stage here.
 */
export const opdsPreviewClip = async (
  source: PairedAudiobookOpdsSource,
  globalSec: number,
): Promise<{ url: string; start: number; duration: number } | null> => {
  const auth = await resolveOpdsNarrationAuth(source);
  if (!auth || !canStreamOpdsAudio(auth)) return null;
  const tracks = await opdsNarrationTracks(source);
  if (!tracks?.length) return null;
  const track = locateTrack(tracks, globalSec);
  if (!track) return null;
  return {
    url: track.url,
    start: Math.max(0, Math.min(globalSec - track.startOffset, track.duration)),
    duration: track.duration,
  };
};
