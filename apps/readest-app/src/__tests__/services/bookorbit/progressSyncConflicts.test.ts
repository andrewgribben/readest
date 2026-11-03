import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bookOrbitProgressHooks,
  clearBookOrbitWriteHistory,
  isOwnBookOrbitWrite,
} from '@/services/bookorbit/progressSync';
import type { BookOrbitClient } from '@/services/bookorbit/client';
import type { ABSTrack } from '@/types/audiobookshelf';

const tracks: ABSTrack[] = [
  { index: 0, startOffset: 0, duration: 100, contentUrl: '/a', mimeType: 'audio/mpeg' },
  { index: 1, startOffset: 100, duration: 100, contentUrl: '/b', mimeType: 'audio/mpeg' },
];

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => clearBookOrbitWriteHistory());
afterEach(() => vi.useRealTimers());

describe('bookOrbitProgressHooks', () => {
  it('abandons a hung write so later positions still reach the server', async () => {
    vi.useFakeTimers();
    const client = {
      putPlaybackState: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue({ revision: 2 }),
      // Still at the revision we based the write on: nothing moved.
      getPlaybackState: vi.fn().mockResolvedValue({ assetId: 'a', positionMs: 0, revision: 1 }),
    };
    const hooks = bookOrbitProgressHooks(
      client as unknown as BookOrbitClient,
      7,
      tracks,
      ['a', 'b'],
      'm',
      1,
      vi.fn(),
      { requestTimeoutMs: 1000 },
    );
    hooks.onTick!(10, 1000);
    await flush();
    await vi.advanceTimersByTimeAsync(1001);
    hooks.onTick!(20, 2000);
    await flush();
    expect(client.putPlaybackState).toHaveBeenCalledTimes(2);
    expect(client.putPlaybackState).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ positionMs: 20000, baseRevision: 1 }),
      expect.anything(),
    );
  });

  it('stops pushing instead of overwriting a position another device wrote', async () => {
    const onDiverged = vi.fn();
    const client = {
      putPlaybackState: vi.fn().mockRejectedValue(new Error('409')),
      getPlaybackState: vi
        .fn()
        .mockResolvedValue({ assetId: 'b', positionMs: 90_000, revision: 5 }),
    };
    const hooks = bookOrbitProgressHooks(
      client as unknown as BookOrbitClient,
      7,
      tracks,
      ['a', 'b'],
      'm',
      1,
      vi.fn(),
      { onDiverged },
    );
    hooks.onTick!(10, 1000);
    await vi.waitFor(() => expect(onDiverged).toHaveBeenCalledTimes(1));
    hooks.onTick!(20, 2000);
    hooks.onPause!(25, 3000);
    await flush();
    expect(client.putPlaybackState).toHaveBeenCalledTimes(1);
  });

  it('adopts the revision when the server holds a write of ours that landed late', async () => {
    const onDiverged = vi.fn();
    const client = {
      putPlaybackState: vi
        .fn()
        .mockRejectedValueOnce(new Error('409'))
        .mockResolvedValue({ revision: 4 }),
      // Our 10 s write landed (revision 3) after the client gave up on it.
      getPlaybackState: vi
        .fn()
        .mockResolvedValue({ assetId: 'a', positionMs: 10_000, revision: 3 }),
    };
    const hooks = bookOrbitProgressHooks(
      client as unknown as BookOrbitClient,
      7,
      tracks,
      ['a', 'b'],
      'm',
      1,
      vi.fn(),
      { onDiverged },
    );
    hooks.onTick!(10, 1000);
    await vi.waitFor(() => expect(client.getPlaybackState).toHaveBeenCalled());
    await flush();
    hooks.onTick!(30, 2000);
    await vi.waitFor(() => expect(client.putPlaybackState).toHaveBeenCalledTimes(2));
    expect(client.putPlaybackState).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ positionMs: 30000, baseRevision: 3 }),
      expect.anything(),
    );
    expect(onDiverged).not.toHaveBeenCalled();
    expect(isOwnBookOrbitWrite(7, { assetId: 'a', positionMs: 30000 })).toBe(true);
  });

  it('keeps pushing after an offline failure', async () => {
    const onDiverged = vi.fn();
    const client = {
      putPlaybackState: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ revision: 2 }),
      getPlaybackState: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const hooks = bookOrbitProgressHooks(
      client as unknown as BookOrbitClient,
      7,
      tracks,
      ['a', 'b'],
      'm',
      1,
      vi.fn(),
      { onDiverged },
    );
    hooks.onTick!(10, 1000);
    await vi.waitFor(() => expect(client.getPlaybackState).toHaveBeenCalled());
    await flush();
    hooks.onTick!(20, 2000);
    await vi.waitFor(() => expect(client.putPlaybackState).toHaveBeenCalledTimes(2));
    expect(onDiverged).not.toHaveBeenCalled();
  });
});
