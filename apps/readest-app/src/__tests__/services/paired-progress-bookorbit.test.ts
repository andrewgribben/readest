import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBookOrbitPlaybackSeconds } from '@/services/audiobook/pairedProgressBookOrbit';
import type { PairedAudiobook } from '@/types/book';

const mocks = vi.hoisted(() => ({
  getPlaybackState: vi.fn(),
}));
vi.mock('@/services/bookorbit/createClient', () => ({
  createBookOrbitClient: () => ({
    getManifest: async () => ({}),
    getPlaybackState: mocks.getPlaybackState,
  }),
}));
vi.mock('@/services/bookorbit/manifest', () => ({
  manifestTracks: () => [{ startOffset: 0, duration: 10000 }],
  manifestAssetIds: () => ['audio'],
  globalFromAssetPosition: (
    _tracks: unknown,
    _ids: unknown,
    _asset: unknown,
    milliseconds: number,
  ) => milliseconds / 1000,
}));
vi.mock('@/services/audiobook/pairedProgressMap', () => ({
  pairedAudioDiffThresholdSec: () => 100,
}));

const association = { source: { kind: 'bookorbit', bookId: 1 } } as PairedAudiobook;

describe('BookOrbit paired playback timestamp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses capturedAt from the actual playback-state response', async () => {
    const capturedAt = '2026-10-02T12:53:16.363Z';
    mocks.getPlaybackState.mockResolvedValue({ assetId: 'audio', positionMs: 2375, capturedAt });
    const position = await fetchBookOrbitPlaybackSeconds(association, 6564);
    expect(position?.updatedAt).toBe(Date.parse(capturedAt));
    expect(position?.seconds).toBe(2.375);
  });

  it.each([
    undefined,
    'invalid',
  ])('does not invent a fresh timestamp for %s', async (capturedAt) => {
    mocks.getPlaybackState.mockResolvedValue({ assetId: 'audio', positionMs: 2375, capturedAt });
    const position = await fetchBookOrbitPlaybackSeconds(association, 6564);
    expect(position?.updatedAt).toBe(0);
  });
});
