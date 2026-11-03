import type { BookOrbitClient, BookOrbitPlaybackState } from './client';
import type { ABSTrack } from '@/types/audiobookshelf';
import type { AudiobookProgressHooks } from '@/services/audiobook/AudiobookController';
import { assetPositionFromGlobal } from './manifest';
import { withTimeout } from './timeout';
import { eventDispatcher } from '@/utils/event';
import { stubTranslation as _ } from '@/utils/misc';

/** A write that has not answered by now is abandoned; the next tick tries again. */
export const BOOKORBIT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The positions this device recently tried to write, per BookOrbit book.
 *
 * A write that timed out may still have landed. When the next write is then
 * rejected for a stale revision, the server is holding *our* position, not
 * another device's, and the right move is to adopt its revision and carry on.
 * Module-level so a reopened session still recognises the previous one's.
 */
const recentWrites = new Map<number, { assetId: string; positionMs: number }[]>();
const RECENT_WRITE_LIMIT = 8;

const rememberWrite = (bookId: number, at: { assetId: string; positionMs: number }): void => {
  const list = recentWrites.get(bookId) ?? [];
  list.push(at);
  if (list.length > RECENT_WRITE_LIMIT) list.shift();
  recentWrites.set(bookId, list);
};

/** Whether the server's state is one this device wrote. */
export const isOwnBookOrbitWrite = (bookId: number, state: BookOrbitPlaybackState): boolean =>
  !!state.assetId &&
  (recentWrites.get(bookId) ?? []).some(
    (write) => write.assetId === state.assetId && write.positionMs === state.positionMs,
  );

/** The usual `onDiverged`: tell the user, who picks a side on the next open. */
export const notifyBookOrbitDiverged = (): void => {
  eventDispatcher.dispatch('toast', {
    message: _(
      'Your listening position changed on another device. Reopen the book to choose where to continue.',
    ),
    type: 'info',
    timeout: 6000,
  });
};

/** Test hook. */
export const clearBookOrbitWriteHistory = (): void => recentWrites.clear();

export interface BookOrbitProgressOptions {
  /**
   * Another device moved the position after this session read it. Pushing
   * stops (overwriting their listening would lose it); the owner tells the
   * user, who chooses on the next open.
   */
  onDiverged?: () => void;
  requestTimeoutMs?: number;
}

/** Shared by standalone and paired playback; preserves revision checks and final queued writes. */
export const bookOrbitProgressHooks = (
  client: BookOrbitClient,
  bookId: number,
  tracks: ABSTrack[],
  assetIds: string[],
  manifestRevision: string,
  initialRevision: number,
  saveProgress: (position: number, force: boolean) => void,
  options: BookOrbitProgressOptions = {},
): AudiobookProgressHooks => {
  const timeoutMs = options.requestTimeoutMs ?? BOOKORBIT_REQUEST_TIMEOUT_MS;
  let baseRevision = initialRevision;
  // Push the position back so BookOrbit's own player (and anything else
  // reading it) resumes where Readest left off. `baseRevision` is the server's
  // concurrency check: it rejects a write based on a position someone else has
  // already superseded.
  let pushInFlight = false;
  // Set once another device has moved the position: from then on this session
  // only saves locally.
  let diverged = false;
  // The position that arrived while a write was in flight. Dropping it is fine
  // for a tick (another follows shortly) but not for the pause or end that
  // stops playback: nothing comes after it, so the server would keep a
  // position from seconds earlier.
  let queuedPosition: { position: number; capturedAt: number } | null = null;

  /** Work out why a write failed, without ever overwriting someone else's position. */
  const reconcileAfterFailure = async (): Promise<void> => {
    let state: BookOrbitPlaybackState | null;
    try {
      state = await withTimeout((signal) => client.getPlaybackState(bookId, signal), timeoutMs);
    } catch {
      // Offline or still hung: keep the revision and try again on the next tick.
      return;
    }
    const revision = state?.revision;
    if (revision === undefined || revision === baseRevision) return;
    if (state && isOwnBookOrbitWrite(bookId, state)) {
      // An earlier write of ours landed after we gave up on it.
      baseRevision = revision;
      return;
    }
    diverged = true;
    queuedPosition = null;
    options.onDiverged?.();
  };

  const pushPosition = async (positionSec: number, capturedAt = Date.now()): Promise<void> => {
    if (diverged) return;
    if (pushInFlight) {
      queuedPosition = { position: positionSec, capturedAt };
      return;
    }
    const at = assetPositionFromGlobal(tracks, assetIds, positionSec);
    if (!at) return;
    pushInFlight = true;
    rememberWrite(bookId, at);
    try {
      const written = await withTimeout(
        (signal) =>
          client.putPlaybackState(
            bookId,
            {
              ...at,
              capturedAt: new Date(capturedAt).toISOString(),
              operationId: crypto.randomUUID(),
              baseRevision,
              manifestRevision: manifestRevision,
            },
            signal,
          ),
        timeoutMs,
      );
      baseRevision = (written as { revision?: number })?.revision ?? baseRevision + 1;
    } catch {
      await reconcileAfterFailure();
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
