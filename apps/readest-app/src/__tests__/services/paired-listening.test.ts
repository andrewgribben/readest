import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PairedListeningReporter,
  pairedListeningPosition,
} from '@/services/audiobook/pairedListeningReporter';
import type { PairedAudiobook } from '@/types/book';

describe('paired listening checkpoints', () => {
  afterEach(() => vi.useRealTimers());
  it('does not save a prepared clock when playback was cancelled before starting', () => {
    vi.useFakeTimers();
    const hooks = { onPause: vi.fn(), onEnd: vi.fn() };
    const reporter = new PairedListeningReporter(
      () => false,
      () => 90,
      hooks,
    );
    reporter.pause();
    reporter.close();
    expect(hooks.onPause).not.toHaveBeenCalled();
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });
  it('saves the recording clock, including preceding files, not the ebook section clock', () => {
    const pair = {
      files: [
        { path: 'first', duration: 100 },
        { path: 'second', duration: 200 },
      ],
    } as PairedAudiobook;
    expect(pairedListeningPosition(pair, 'second', 42)).toEqual({ position: 142, duration: 300 });
    expect(pairedListeningPosition(pair, 'missing', 42)).toBeNull();
  });
  it('ticks only while playing and flushes pause, seek and shutdown at the actual position', () => {
    vi.useFakeTimers();
    let position = 12;
    let playing = false;
    const hooks = {
      onStart: vi.fn(),
      onTick: vi.fn(),
      onPause: vi.fn(),
      onSeek: vi.fn(),
      onEnd: vi.fn(),
    };
    const reporter = new PairedListeningReporter(
      () => playing,
      () => position,
      hooks,
    );
    vi.advanceTimersByTime(15_000);
    expect(hooks.onTick).not.toHaveBeenCalled();
    playing = true;
    reporter.start();
    reporter.start();
    expect(hooks.onStart).toHaveBeenCalledExactlyOnceWith(12);
    vi.advanceTimersByTime(15_000);
    expect(hooks.onTick).toHaveBeenCalledWith(12, expect.any(Number));
    position = 19;
    reporter.pause();
    expect(hooks.onPause).toHaveBeenCalledWith(19, expect.any(Number));
    position = 8;
    reporter.seek();
    expect(hooks.onSeek).toHaveBeenCalledWith(8, expect.any(Number));
    reporter.close();
    reporter.close();
    expect(hooks.onEnd).toHaveBeenCalledExactlyOnceWith(8, expect.any(Number));
    vi.advanceTimersByTime(30_000);
    expect(hooks.onTick).toHaveBeenCalledTimes(1);
  });
  it('does not write an uninitialised clock as zero', () => {
    vi.useFakeTimers();
    const hooks = { onTick: vi.fn(), onPause: vi.fn(), onEnd: vi.fn() };
    const reporter = new PairedListeningReporter(
      () => true,
      () => null,
      hooks,
    );
    vi.advanceTimersByTime(15_000);
    reporter.pause();
    reporter.close();
    expect(hooks.onTick).not.toHaveBeenCalled();
    expect(hooks.onPause).not.toHaveBeenCalled();
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });
  it('retains capture time when a recording clock disappears before teardown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let position: number | null = 40;
    const hooks = { onPause: vi.fn(), onEnd: vi.fn() };
    const reporter = new PairedListeningReporter(
      () => false,
      () => position,
      hooks,
    );
    reporter.seek();
    reporter.pause();
    position = null;
    vi.advanceTimersByTime(10_000);
    reporter.close();
    expect(hooks.onEnd).toHaveBeenCalledExactlyOnceWith(40, 100_000);
  });
});
