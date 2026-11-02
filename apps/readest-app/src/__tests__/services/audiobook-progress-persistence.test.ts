import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAudiobookProgressSaver } from '@/services/audiobook/progressPersistence';
import { useLibraryStore } from '@/store/libraryStore';
import type { Book } from '@/types/book';

describe('shared audiobook progress persistence', () => {
  afterEach(() => vi.useRealTimers());
  it('preserves concurrent library edits and force-saves a pause inside the throttle window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    useLibraryStore.getState().setLibrary([{ hash: 'audio', title: 'Original' } as Book]);
    const saveLibraryBooks = vi.fn().mockResolvedValue(undefined);
    const save = makeAudiobookProgressSaver({ saveLibraryBooks }, 'audio', 200);
    save(10.6, false);
    useLibraryStore
      .getState()
      .setLibrary([{ ...useLibraryStore.getState().library[0]!, title: 'Edited' }]);
    vi.advanceTimersByTime(1000);
    save(12, false);
    expect(saveLibraryBooks).toHaveBeenCalledTimes(1);
    save(13.2, true);
    expect(saveLibraryBooks).toHaveBeenCalledTimes(2);
    expect(useLibraryStore.getState().library[0]).toMatchObject({
      title: 'Edited',
      progress: [13, 200],
      updatedAt: 101_000,
    });
  });
});
