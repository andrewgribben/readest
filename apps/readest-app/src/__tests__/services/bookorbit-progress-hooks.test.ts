import { expect, it, vi } from 'vitest';
import { bookOrbitProgressHooks } from '@/services/bookorbit/progressSync';
import type { BookOrbitClient } from '@/services/bookorbit/client';

it('shares asset conversion and retains the final pause capture time while a tick upload is in flight', async () => {
  let finish!: (value: { revision: number }) => void;
  const client = {
    putPlaybackState: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ revision: 3 }),
    getPlaybackState: vi.fn(),
  };
  const save = vi.fn();
  const hooks = bookOrbitProgressHooks(
    client as unknown as BookOrbitClient,
    7,
    [
      { index: 0, startOffset: 0, duration: 100, contentUrl: '/a', mimeType: 'audio/mpeg' },
      { index: 1, startOffset: 100, duration: 100, contentUrl: '/b', mimeType: 'audio/mpeg' },
    ],
    ['a', 'b'],
    'manifest',
    1,
    save,
  );
  hooks.onTick!(110, 1000);
  hooks.onPause!(125, 2000);
  expect(save).toHaveBeenLastCalledWith(125, true);
  finish({ revision: 2 });
  await vi.waitFor(() => expect(client.putPlaybackState).toHaveBeenCalledTimes(2));
  expect(client.putPlaybackState).toHaveBeenLastCalledWith(
    7,
    expect.objectContaining({
      assetId: 'b',
      positionMs: 25000,
      capturedAt: new Date(2000).toISOString(),
      baseRevision: 2,
    }),
  );
});
