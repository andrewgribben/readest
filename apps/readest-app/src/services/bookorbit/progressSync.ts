import type { BookOrbitClient } from './client';
import type { ABSTrack } from '@/types/audiobookshelf';
import type { AudiobookProgressHooks } from '@/services/audiobook/AudiobookController';
import { assetPositionFromGlobal } from './manifest';

/** Shared by standalone and paired playback; preserves revision checks and final queued writes. */
export const bookOrbitProgressHooks = (
  client: BookOrbitClient,
  bookId: number,
  tracks: ABSTrack[],
  assetIds: string[],
  manifestRevision: string,
  initialRevision: number,
  saveProgress: (position: number, force: boolean) => void,
): AudiobookProgressHooks => {
  let baseRevision = initialRevision;
  // Push the position back so BookOrbit's own player (and anything else
  // reading it) resumes where Readest left off. `baseRevision` is the server's
  // concurrency check: it rejects a write based on a position someone else has
  // already superseded, and we re-read rather than clobbering theirs.
  let pushInFlight = false;
  // The position that arrived while a write was in flight. Dropping it is fine
  // for a tick (another follows a second later) but not for the pause or end
  // that stops playback: nothing comes after it, so the server would keep a
  // position from seconds earlier.
  let queuedPosition: { position: number; capturedAt: number } | null = null;
  const pushPosition = async (positionSec: number, capturedAt = Date.now()): Promise<void> => {
    if (pushInFlight) {
      queuedPosition = { position: positionSec, capturedAt };
      return;
    }
    const at = assetPositionFromGlobal(tracks, assetIds, positionSec);
    if (!at) return;
    pushInFlight = true;
    try {
      const written = await client.putPlaybackState(bookId, {
        ...at,
        capturedAt: new Date(capturedAt).toISOString(),
        operationId: crypto.randomUUID(),
        baseRevision,
        manifestRevision: manifestRevision,
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
      await pushPosition(next.position, next.capturedAt);
    }
  };

  return {
    onTick: (position, capturedAt) => {
      saveProgress(position, false);
      void pushPosition(position, capturedAt);
    },
    onSeek: (position) => saveProgress(position, false),
    onPause: (position, capturedAt) => {
      saveProgress(position, true);
      void pushPosition(position, capturedAt);
    },
    onEnd: (position, capturedAt) => {
      saveProgress(position, true);
      void pushPosition(position, capturedAt);
    },
  };
};
