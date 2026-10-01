// Read-only BookOrbit playback-state lookup for the ebook-open sync prompt.

import { createBookOrbitClient } from '@/services/bookorbit/createClient';
import {
  globalFromAssetPosition,
  manifestAssetIds,
  manifestTracks,
} from '@/services/bookorbit/manifest';
import type { PairedAudiobook } from '@/types/book';
import { pairedAudioDiffThresholdSec } from './pairedProgressMap';

export interface BookOrbitPlaybackPosition {
  seconds: number;
  updatedAt: number;
  serverFresherThanLocal: boolean;
}

/**
 * Server listening position for a BookOrbit pairing, or null when unavailable.
 * Does not write playback state.
 */
export const fetchBookOrbitPlaybackSeconds = async (
  association: PairedAudiobook,
  localSeconds: number,
): Promise<BookOrbitPlaybackPosition | null> => {
  const source = association.source;
  if (source?.kind !== 'bookorbit') return null;

  const client = createBookOrbitClient();
  if (!client) return null;

  try {
    const manifest = await client.getManifest(source.bookId);
    const tracks = manifestTracks(manifest);
    const assetIds = manifestAssetIds(manifest);
    const state = await client.getPlaybackState(source.bookId);
    let serverSeconds = 0;
    if (state?.assetId) {
      serverSeconds =
        globalFromAssetPosition(tracks, assetIds, state.assetId, state.positionMs ?? 0) ?? 0;
    }
    if (!(serverSeconds > 0)) return null;

    const duration = Math.max(...tracks.map((track) => track.startOffset + track.duration), 0);
    const serverFresherThanLocal =
      Math.abs(serverSeconds - localSeconds) > pairedAudioDiffThresholdSec(duration);
    const parsed = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
    return {
      seconds: serverSeconds,
      updatedAt: serverFresherThanLocal ? (Number.isFinite(parsed) ? parsed : Date.now()) : 0,
      serverFresherThanLocal,
    };
  } catch {
    return null;
  }
};
