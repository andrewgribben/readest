import type { PairedAudiobook } from '@/types/book';
import type { AudiobookProgressHooks } from './AudiobookController';

/** The pairing clock is file-relative; streamed pairings use one virtual file. */
export const pairedListeningPosition = (
  association: PairedAudiobook,
  audioHref: string,
  seconds: number,
): { position: number; duration: number } | null => {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  let offset = 0;
  const duration = association.files.reduce((sum, file) => sum + file.duration, 0);
  for (const file of association.files) {
    if (file.path === audioHref) {
      return { position: Math.min(offset + seconds, offset + file.duration), duration };
    }
    offset += file.duration;
  }
  return null;
};

/** Owned by the audio controller, so reader unmount cannot stop checkpoints. */
export class PairedListeningReporter {
  #timer: ReturnType<typeof setInterval>;
  #closed = false;
  #started = false;
  #hasCheckpoint = false;
  #lastPosition: number | null = null;
  #lastCapturedAt = 0;
  constructor(
    private playing: () => boolean,
    private position: () => number | null,
    private hooks: AudiobookProgressHooks & { onStart?: (position: number) => void },
  ) {
    this.#timer = setInterval(() => {
      if (this.playing()) {
        this.#hasCheckpoint = true;
        this.#report(this.hooks.onTick);
      }
    }, 15_000);
  }
  #report(callback?: (position: number, capturedAt?: number) => void) {
    if (this.#closed) return;
    const position = this.position();
    if (position === null || !Number.isFinite(position)) return;
    this.#lastPosition = position;
    this.#lastCapturedAt = Date.now();
    callback?.(position, this.#lastCapturedAt);
  }
  pause() {
    if (!this.#hasCheckpoint && !this.playing()) return;
    this.#hasCheckpoint = true;
    this.#report(this.hooks.onPause);
  }
  start() {
    if (this.#started || !this.playing() || this.position() === null) return;
    this.#started = true;
    this.#hasCheckpoint = true;
    this.#report((position) => this.hooks.onStart?.(position));
  }
  seek(position?: number) {
    this.#hasCheckpoint = true;
    if (position === undefined) this.#report(this.hooks.onSeek);
    else if (!this.#closed && Number.isFinite(position)) {
      this.#lastPosition = position;
      this.#lastCapturedAt = Date.now();
      this.hooks.onSeek?.(position, this.#lastCapturedAt);
    }
  }
  close() {
    if (this.#closed) return;
    const current = this.position();
    const position = current ?? this.#lastPosition;
    const capturedAt = current === null ? this.#lastCapturedAt : Date.now();
    this.#closed = true;
    clearInterval(this.#timer);
    if (this.#hasCheckpoint && position !== null) this.hooks.onEnd?.(position, capturedAt);
  }
}
