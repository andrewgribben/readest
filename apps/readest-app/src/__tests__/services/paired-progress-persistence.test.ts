import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book, BookConfig, PairedAudiobook } from '@/types/book';
import type { AppService } from '@/types/system';
const state = vi.hoisted(() => ({
  library: [] as Book[],
  config: {} as BookConfig,
  client: { getManifest: vi.fn(), getPlaybackState: vi.fn(), putPlaybackState: vi.fn() },
}));
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
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: {
    getState: () => ({
      getConfig: () => state.config,
      getBookData: () => ({ book: { hash: 'ebook' } }),
      setConfig: (_key: string, patch: Partial<BookConfig>) => {
        state.config = { ...state.config, ...patch };
      },
    }),
  },
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
vi.mock('@/store/absServerStore', () => ({ findABSServerById: () => null }));
vi.mock('@/services/audiobookshelf/createClient', () => ({ createAbsClient: vi.fn() }));
vi.mock('@/services/bookorbit/createClient', () => ({ createBookOrbitClient: () => state.client }));
import { createPairedProgressHooks } from '@/services/audiobook/pairedProgressPersistence';
import { buildOpdsPairingSource } from '@/services/opds/pairing';
import { makeOpdsAudioFilePath } from '@/services/opds/audiobook';

describe('paired recording persistence', () => {
  const pair = {
    version: 1,
    createdAt: 1,
    title: 'Audio',
    files: [{ id: 'recording', name: 'Audio', path: 'bookorbit://7', duration: 300 }],
    source: { kind: 'bookorbit', bookId: 7, tracks: [] },
    mappings: [],
    chapters: [],
  } as PairedAudiobook;
  beforeEach(() => {
    vi.clearAllMocks();
    state.library = [
      { hash: 'audio', filePath: 'bookorbit://7', format: 'BOOKORBIT', title: 'Audio' } as Book,
    ];
    state.config = { location: 'ebook-page', updatedAt: 123, audiobook: pair } as BookConfig;
  });
  it('writes the standalone entry and paired checkpoint without changing ebook progress, even offline', async () => {
    state.client.getManifest.mockRejectedValueOnce(new Error('offline'));
    const app = {
      saveLibraryBooks: vi.fn().mockResolvedValue(undefined),
      saveBookConfig: vi.fn().mockResolvedValue(undefined),
    };
    const hooks = createPairedProgressHooks(app as unknown as AppService, 'ebook-key', pair);
    hooks.onTick!(42);
    hooks.onPause!(49);
    expect(state.library).toHaveLength(1);
    expect(state.library[0]!.progress).toEqual([49, 300]);
    expect(state.config).toMatchObject({
      location: 'ebook-page',
      updatedAt: 123,
      audiobook: { listeningProgress: { position: 49, duration: 300 } },
    });
    expect(app.saveBookConfig).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(state.client.getManifest).toHaveBeenCalledTimes(1));
    await Promise.resolve();
  });
  it('does not put an old recording checkpoint into a replacement pairing', () => {
    state.client.getManifest.mockRejectedValueOnce(new Error('offline'));
    const app = {
      saveLibraryBooks: vi.fn().mockResolvedValue(undefined),
      saveBookConfig: vi.fn().mockResolvedValue(undefined),
    };
    const hooks = createPairedProgressHooks(app as unknown as AppService, 'ebook-key', pair);
    state.config = { ...state.config, audiobook: { ...pair, createdAt: 2 } };
    hooks.onPause!(90);
    expect(state.config.audiobook?.listeningProgress).toBeUndefined();
    expect(app.saveBookConfig).not.toHaveBeenCalled();
  });
  it('saves generic OPDS listening into its existing standalone library entry', () => {
    const data = {
      catalogId: 'catalog',
      title: 'Audio',
      author: 'Author',
      tracks: [{ href: 'https://catalog.example/audio.mp3', mimeType: 'audio/mpeg' }],
    };
    const source = buildOpdsPairingSource(data, [
      {
        index: 0,
        startOffset: 0,
        duration: 300,
        contentUrl: data.tracks[0]!.href,
        mimeType: 'audio/mpeg',
      },
    ]);
    const opdsPair: PairedAudiobook = { ...pair, ...source };
    state.library = [
      { hash: 'opds-audio', filePath: makeOpdsAudioFilePath(data), format: 'OPDSAUDIO' } as Book,
    ];
    state.config = { ...state.config, audiobook: opdsPair };
    const app = {
      saveLibraryBooks: vi.fn().mockResolvedValue(undefined),
      saveBookConfig: vi.fn().mockResolvedValue(undefined),
    };
    createPairedProgressHooks(app as unknown as AppService, 'ebook-key', opdsPair).onPause!(87);
    expect(state.library).toHaveLength(1);
    expect(state.library[0]).toMatchObject({ hash: 'opds-audio', progress: [87, 300] });
    expect(app.saveLibraryBooks).toHaveBeenCalledWith(state.library);
    expect(state.client.getManifest).not.toHaveBeenCalled();
  });
});
