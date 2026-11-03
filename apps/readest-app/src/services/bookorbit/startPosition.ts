// Where a BookOrbit audiobook should resume when this device and the server
// disagree.
//
// BookOrbit's own player (and any other device) writes the shared position, so
// a server position that moved while Readest was closed is the normal case,
// not an edge case. Silently preferring either side loses someone's listening:
// local-first ignored the server entirely, server-first would throw away
// offline listening that never got pushed. A real disagreement is the user's
// call; anything within a small tolerance is just the push lag between them.
import { AUDIO_POSITION_CHOICE_THRESHOLD_SEC } from '@/services/audiobook/startPosition';

export interface BookOrbitStartInput {
  /** Global seconds, or null when the server has no usable position. */
  server: number | null;
  /** Global seconds from this device (0 when never played here). */
  local: number;
  duration: number;
}

export type BookOrbitStart =
  | { kind: 'resolved'; position: number; source: 'server' | 'local' }
  | { kind: 'ask'; server: number; local: number };

/**
 * A book parked at its end replays from the start, the same rule the OPDS path
 * uses: resuming past the last track ends the session the instant it opens.
 */
export const clampStartPosition = (position: number, duration: number): number => {
  if (!Number.isFinite(position) || position <= 0) return 0;
  return duration > 0 && position >= duration - 1 ? 0 : position;
};

export const resolveBookOrbitStart = ({
  server,
  local,
  duration,
}: BookOrbitStartInput): BookOrbitStart => {
  const hasServer = server !== null && Number.isFinite(server) && server > 0;
  const hasLocal = Number.isFinite(local) && local > 0;
  if (!hasServer) {
    return { kind: 'resolved', position: clampStartPosition(local, duration), source: 'local' };
  }
  if (!hasLocal || Math.abs(server - local) <= AUDIO_POSITION_CHOICE_THRESHOLD_SEC) {
    return { kind: 'resolved', position: clampStartPosition(server, duration), source: 'server' };
  }
  return { kind: 'ask', server, local };
};
