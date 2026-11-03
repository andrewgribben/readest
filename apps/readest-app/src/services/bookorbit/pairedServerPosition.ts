// The BookOrbit server's listening position for a paired audiobook, in the
// same checkpoint shape as the device's own, so it can compete with them on
// recency instead of being ignored.
//
// The pairing already carries each track's server path, which names its asset,
// so no manifest fetch is needed to place the server's in-asset offset on the
// book's timeline.
import type { ListeningCheckpoint } from '@/services/audiobook/startPosition';
import type { PairedAudiobookBookOrbitSource } from '@/types/book';
import { createBookOrbitClient } from './createClient';
import { isOwnBookOrbitWrite } from './progressSync';
import { withTimeout } from './timeout';

const ASSET_IN_PATH = /\/assets\/([^/]+)\/content(?:[?#]|$)/;

export const pairedTrackAssetId = (contentUrl: string): string | null => {
  const raw = ASSET_IN_PATH.exec(contentUrl)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/** Opening the reader must not hang on an unreachable server. */
const READ_TIMEOUT_MS = 5_000;

export const fetchPairedServerCheckpoint = async (
  source: PairedAudiobookBookOrbitSource,
): Promise<ListeningCheckpoint | null> => {
  const client = createBookOrbitClient();
  if (!client) return null;
  let state;
  try {
    state = await withTimeout(
      (signal) => client.getPlaybackState(source.bookId, signal),
      READ_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  if (!state?.assetId) return null;
  // Our own write coming back is not news, and its server timestamp would let
  // it outrank listening this device has done since.
  if (isOwnBookOrbitWrite(source.bookId, state)) return null;
  const track = source.tracks.find((t) => pairedTrackAssetId(t.contentUrl) === state.assetId);
  if (!track) return null;
  const updatedAt = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  if (!Number.isFinite(updatedAt)) return null;
  const duration = source.tracks.reduce((sum, t) => sum + t.duration, 0);
  const position = track.startOffset + Math.min((state.positionMs ?? 0) / 1000, track.duration);
  return { position, duration, updatedAt };
};
