/** Audio estimates need a time tolerance, not 1% of a many-hour recording. */
export const AUDIO_POSITION_CHOICE_THRESHOLD_SEC = 30;
export interface ListeningCheckpoint {
  position: number;
  duration: number;
  updatedAt: number;
}
export const selectListeningCheckpoint = (
  candidates: (ListeningCheckpoint | null | undefined)[],
  duration: number,
): ListeningCheckpoint | null =>
  candidates
    .filter(
      (candidate): candidate is ListeningCheckpoint =>
        !!candidate &&
        Number.isFinite(candidate.position) &&
        candidate.position >= 0 &&
        candidate.position <= duration &&
        Number.isFinite(candidate.updatedAt) &&
        Math.abs(candidate.duration - duration) <= 1,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;

export const needsAudioPositionChoice = (listening: number, reading: number): boolean =>
  Math.abs(listening - reading) > AUDIO_POSITION_CHOICE_THRESHOLD_SEC;
