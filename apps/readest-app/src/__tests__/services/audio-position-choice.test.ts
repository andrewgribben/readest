import { describe, expect, it } from 'vitest';
import { useAudioPositionChoiceStore } from '@/store/audioPositionChoiceStore';

describe('audio choice ownership', () => {
  it('cancels a replaced request and ignores its stale response', async () => {
    const store = useAudioPositionChoiceStore.getState();
    const first = store.request({ bookHash: 'first', listening: 10, reading: 100 });
    const firstId = useAudioPositionChoiceStore.getState().pending!.id;
    const second = store.request({ bookHash: 'second', listening: 20, reading: 200 });
    const secondId = useAudioPositionChoiceStore.getState().pending!.id;
    expect(await first).toBeNull();
    store.resolve(firstId, 'reading');
    expect(useAudioPositionChoiceStore.getState().pending?.id).toBe(secondId);
    store.resolve(secondId, 'listening');
    store.resolve(secondId, 'reading');
    expect(await second).toBe('listening');
  });
});
