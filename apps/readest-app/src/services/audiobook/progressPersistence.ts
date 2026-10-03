import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import { useLibraryStore } from '@/store/libraryStore';

/** Shared local audiobook checkpoint writer. Pause/end bypass disk throttling. */
export const makeAudiobookProgressSaver = (
  appService: Pick<AppService, 'saveLibraryBooks'>,
  bookHash: string,
  duration: number,
  throttleMs = 15_000,
  onSaved?: (timestamp: number) => void,
) => {
  let lastPersistAt = 0;
  return (position: number, force: boolean, capturedAt = Date.now()): void => {
    const { library, setLibrary } = useLibraryStore.getState();
    const index = library.findIndex((book) => book.hash === bookHash);
    const now = Date.now();
    onSaved?.(capturedAt);
    if (index < 0) return;
    const progress: [number, number] = [Math.round(position), Math.round(duration)];
    const updated = library.slice();
    updated[index] = { ...library[index]!, progress, updatedAt: capturedAt } as Book;
    setLibrary(updated);
    if (force || now - lastPersistAt >= throttleMs) {
      lastPersistAt = now;
      Promise.resolve(appService.saveLibraryBooks(updated)).catch(console.warn);
    }
  };
};
