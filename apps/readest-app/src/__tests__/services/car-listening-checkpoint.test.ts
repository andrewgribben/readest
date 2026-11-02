import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
const state = vi.hoisted(() => ({ library: [] as Book[] }));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({
      library: state.library,
      setLibrary: (library: Book[]) => {
        state.library = library;
      },
    }),
  },
}));
vi.mock('@/services/audiobook/pairedProgressPersistence', () => ({
  pairedAudiobookEntry: vi.fn(),
}));
vi.mock('@/services/opds/offline', () => ({ loadOpdsOfflineManifest: vi.fn() }));
vi.mock('@/services/audiobookshelf/offline', () => ({ loadAbsOfflineManifest: vi.fn() }));
vi.mock('@/services/opds/pairedOffline', () => ({ resolveDownloadedOpdsPairing: vi.fn() }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
import { importCarListeningCheckpoint } from '@/services/audiobook/carPlayback';

describe('native car checkpoint reconciliation', () => {
  beforeEach(() => {
    state.library = [
      {
        hash: 'audio',
        title: 'Audio',
        author: '',
        format: 'BOOKORBIT',
        createdAt: 1,
        updatedAt: 100,
        progress: [80, 1000],
      },
    ];
  });
  const app = (checkpoint: object) =>
    ({
      readFile: vi.fn().mockResolvedValue(JSON.stringify(checkpoint)),
      saveLibraryBooks: vi.fn().mockResolvedValue(undefined),
    }) as unknown as AppService;
  it('imports a newer checkpoint even when listening moved backwards', async () => {
    const service = app({ audioHash: 'audio', position: 40, duration: 1000, updatedAt: 200 });
    await importCarListeningCheckpoint(service, state.library[0]!);
    expect(state.library[0]?.progress).toEqual([40, 1000]);
    expect(state.library[0]?.updatedAt).toBe(200);
  });
  it('does not overwrite newer phone progress with an older native journal', async () => {
    const service = app({ audioHash: 'audio', position: 20, duration: 1000, updatedAt: 50 });
    await importCarListeningCheckpoint(service, state.library[0]!);
    expect(service.saveLibraryBooks).not.toHaveBeenCalled();
    expect(state.library[0]?.progress).toEqual([80, 1000]);
  });
  it('rejects a checkpoint for another recording', async () => {
    const service = app({ audioHash: 'other', position: 40, duration: 1000, updatedAt: 200 });
    expect(await importCarListeningCheckpoint(service, state.library[0]!)).toBeNull();
    expect(service.saveLibraryBooks).not.toHaveBeenCalled();
  });
});
