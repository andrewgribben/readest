import { describe, expect, it } from 'vitest';
import {
  selectListeningCheckpoint,
  needsAudioPositionChoice,
} from '@/services/audiobook/startPosition';

describe('paired startup position', () => {
  it('uses the latest checkpoint, including backward listening', () => {
    expect(
      selectListeningCheckpoint(
        [
          { position: 200, duration: 1000, updatedAt: 10 },
          { position: 100, duration: 1000, updatedAt: 20 },
        ],
        1000,
      )?.position,
    ).toBe(100);
  });
  it('rejects invalid or incompatible checkpoints, while retaining zero', () => {
    expect(
      selectListeningCheckpoint(
        [
          { position: NaN, duration: 1000, updatedAt: 30 },
          { position: 100, duration: 900, updatedAt: 40 },
          { position: 0, duration: 1000, updatedAt: 10 },
        ],
        1000,
      )?.position,
    ).toBe(0);
  });
  it('prompts only for differences exceeding thirty seconds in either direction', () => {
    expect(needsAudioPositionChoice(100, 130)).toBe(false);
    expect(needsAudioPositionChoice(100, 131)).toBe(true);
    expect(needsAudioPositionChoice(100, 69)).toBe(true);
  });
});
