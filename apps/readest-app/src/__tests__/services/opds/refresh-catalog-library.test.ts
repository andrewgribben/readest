import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Book } from '@/types/book';
import type { OPDSCatalog } from '@/types/opds';
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import { useOPDSProgressStore, type OPDSCatalogProgress } from '@/store/opdsProgressStore';

const {
  checkFeedForAllItemsMock,
  findOPDSSourceMappingMock,
  probeAcquisitionFingerprintMock,
  downloadAcquisitionFileMock,
  applyOPDSMetadataMock,
  applyOPDSCoverMock,
  upsertOPDSSourceMappingMock,
  loadSubscriptionStateMock,
  saveSubscriptionStateMock,
  partialMD5Mock,
} = vi.hoisted(() => ({
  checkFeedForAllItemsMock: vi.fn(),
  findOPDSSourceMappingMock: vi.fn(),
  probeAcquisitionFingerprintMock: vi.fn(),
  downloadAcquisitionFileMock: vi.fn(),
  applyOPDSMetadataMock: vi.fn(),
  applyOPDSCoverMock: vi.fn(),
  upsertOPDSSourceMappingMock: vi.fn(),
  loadSubscriptionStateMock: vi.fn(),
  saveSubscriptionStateMock: vi.fn(),
  partialMD5Mock: vi.fn(),
}));

vi.mock('@/services/opds/feedChecker', () => ({
  checkFeedForAllItems: checkFeedForAllItemsMock,
}));
vi.mock('@/services/opds/sourceMap', async () => {
  const actual = await vi.importActual<typeof import('@/services/opds/sourceMap')>(
    '@/services/opds/sourceMap',
  );
  return {
    ...actual,
    findOPDSSourceMapping: findOPDSSourceMappingMock,
    upsertOPDSSourceMapping: upsertOPDSSourceMappingMock,
  };
});
vi.mock('@/services/opds/acquisitionDownload', () => ({
  probeAcquisitionFingerprint: probeAcquisitionFingerprintMock,
  downloadAcquisitionFile: downloadAcquisitionFileMock,
}));
vi.mock('@/services/opds/metadata', () => ({
  applyOPDSMetadata: applyOPDSMetadataMock,
  getOPDSBookMetadata: () => ({}),
}));
vi.mock('@/services/opds/cover', () => ({
  applyOPDSCover: applyOPDSCoverMock,
  getOPDSCoverHref: () => undefined,
}));
vi.mock('@/services/opds/subscriptionState', () => ({
  loadSubscriptionState: loadSubscriptionStateMock,
  saveSubscriptionState: saveSubscriptionStateMock,
}));
vi.mock('@/utils/md5', () => ({
  partialMD5: partialMD5Mock,
  md5: (s: string) => s,
}));
vi.mock('@/app/opds/utils/opdsUtils', () => ({
  resolveURL: (href: string, base: string) => {
    try {
      return new URL(href, base).href;
    } catch {
      return href;
    }
  },
}));
vi.mock('@/utils/customHeaders', () => ({
  normalizeCustomHeaders: (h: unknown) => h ?? {},
}));
vi.mock('@/utils/supabase', () => ({
  supabase: {},
  createSupabaseClient: () => ({}),
  createSupabaseAdminClient: () => ({}),
}));

import { refreshCatalogLibrary } from '@/services/opds/refreshCatalogLibrary';

const catalog = {
  id: 'cat-1',
  name: 'Test',
  url: 'https://example.com/opds',
} as OPDSCatalog;

const book = {
  hash: 'hash-1',
  title: 'Old Title',
  author: 'Old',
  format: 'EPUB',
  updatedAt: 1,
  createdAt: 1,
} as Book;

const item = {
  entryId: 'entry-1',
  title: 'New Title',
  acquisitionHref: '/download/1.epub',
  mimeType: 'application/epub+zip',
  baseURL: 'https://example.com/opds',
  metadata: { title: 'New Title', author: 'New Author' },
};

beforeEach(() => {
  vi.clearAllMocks();
  book.hash = 'hash-1';
  book.metadataUpdatedAt = undefined;
  checkFeedForAllItemsMock.mockResolvedValue([item]);
  loadSubscriptionStateMock.mockResolvedValue({
    catalogId: 'cat-1',
    lastCheckedAt: 0,
    knownEntryIds: ['entry-1'],
    failedEntries: [],
  });
  saveSubscriptionStateMock.mockResolvedValue(undefined);
  applyOPDSMetadataMock.mockImplementation((b: Book) => {
    b.metadataUpdatedAt = Date.now();
    b.updatedAt = Date.now();
  });
  applyOPDSCoverMock.mockResolvedValue(false);
  findOPDSSourceMappingMock.mockResolvedValue({
    book,
    mapping: {
      bookHash: 'hash-1',
      fingerprint: { etag: '"v1"', contentLength: 100, lastModified: 'a' },
    },
  });
});

describe('refreshCatalogLibrary', () => {
  it('does not transfer an unchanged book on a size-only server when its saved feed revision matches', async () => {
    checkFeedForAllItemsMock.mockResolvedValueOnce([{ ...item, updated: '2026-10-01T12:00:00Z' }]);
    findOPDSSourceMappingMock.mockResolvedValueOnce({
      book,
      mapping: {
        bookHash: book.hash,
        fingerprint: { contentLength: 100, entryUpdated: '2026-10-01T12:00:00Z' },
      },
    });
    probeAcquisitionFingerprintMock.mockResolvedValueOnce({ contentLength: 100 });
    const result = await refreshCatalogLibrary({
      catalog,
      library: [book],
      appService: {} as AppService,
    });
    expect(result.failed).toBe(0);
    expect(result.redownloaded).toBe(0);
    expect(downloadAcquisitionFileMock).not.toHaveBeenCalled();
  });

  it('establishes a missing feed revision with one content check and skips the next unchanged update', async () => {
    checkFeedForAllItemsMock.mockResolvedValue([{ ...item, updated: '2026-10-01T12:00:00Z' }]);
    findOPDSSourceMappingMock.mockResolvedValue({
      book,
      mapping: { bookHash: book.hash, fingerprint: { contentLength: 100 } },
    });
    probeAcquisitionFingerprintMock.mockResolvedValue({ contentLength: 100 });
    downloadAcquisitionFileMock.mockResolvedValue({
      filePath: '/cache/book.epub',
      fingerprint: { contentLength: 100 },
    });
    partialMD5Mock.mockResolvedValue(book.hash);
    const service = {
      openFile: async () => new File([], 'book.epub'),
      deleteFile: async () => {},
    } as unknown as AppService;
    await refreshCatalogLibrary({ catalog, library: [book], appService: service });
    const saved = upsertOPDSSourceMappingMock.mock.calls[0]![1];
    expect(saved.fingerprint).toEqual({ contentLength: 100, entryUpdated: '2026-10-01T12:00:00Z' });
    findOPDSSourceMappingMock.mockResolvedValue({
      book,
      mapping: { bookHash: book.hash, fingerprint: saved.fingerprint },
    });
    await refreshCatalogLibrary({ catalog, library: [book], appService: service });
    expect(downloadAcquisitionFileMock).toHaveBeenCalledTimes(1);
  });

  it('checks content when the feed revision advances even if size is unchanged', async () => {
    checkFeedForAllItemsMock.mockResolvedValueOnce([{ ...item, updated: '2026-10-02T12:00:00Z' }]);
    findOPDSSourceMappingMock.mockResolvedValueOnce({
      book,
      mapping: {
        bookHash: book.hash,
        fingerprint: { contentLength: 100, entryUpdated: '2026-10-01T12:00:00Z' },
      },
    });
    probeAcquisitionFingerprintMock.mockResolvedValueOnce({ contentLength: 100 });
    downloadAcquisitionFileMock.mockResolvedValueOnce({
      filePath: '/cache/book.epub',
      fingerprint: { contentLength: 100 },
    });
    partialMD5Mock.mockResolvedValueOnce(book.hash);
    const result = await refreshCatalogLibrary({
      catalog,
      library: [book],
      appService: {
        openFile: async () => new File([], 'book.epub'),
        deleteFile: async () => {},
      } as unknown as AppService,
    });
    expect(result.failed).toBe(0);
    expect(downloadAcquisitionFileMock).toHaveBeenCalledTimes(1);
    expect(upsertOPDSSourceMappingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fingerprint: { contentLength: 100, entryUpdated: '2026-10-02T12:00:00Z' },
      }),
    );
  });

  it('reports bytes separately from catalog checks and clears progress after the update', async () => {
    useOPDSProgressStore.setState({ catalogs: {} });
    const snapshots: OPDSCatalogProgress[] = [];
    const unsubscribe = useOPDSProgressStore.subscribe((state) => {
      if (state.catalogs['cat-1']) snapshots.push(state.catalogs['cat-1']!);
    });
    probeAcquisitionFingerprintMock.mockResolvedValue({ etag: '"v2"' });
    downloadAcquisitionFileMock.mockImplementationOnce(
      async (
        _service: AppService,
        _catalog: OPDSCatalog,
        _item: unknown,
        onProgress?: ProgressHandler,
      ) => {
        expect(onProgress).toBeTypeOf('function');
        onProgress?.({ progress: 37, total: 100, transferSpeed: 0 });
        return { filePath: '/cache/book.epub', fingerprint: { etag: '"v2"' } };
      },
    );
    partialMD5Mock.mockResolvedValue('changed-hash');
    try {
      const result = await refreshCatalogLibrary({
        catalog,
        library: [book],
        appService: {
          openFile: async () => new File([], 'book.epub'),
          importBook: async () => ({ ...book, hash: 'changed-hash' }),
        } as unknown as AppService,
      });
      expect(result.redownloaded).toBe(1);
    } finally {
      unsubscribe();
    }
    expect(
      snapshots.some((snapshot) => snapshot.toCheck === 1 && snapshot.active[0]?.percent === 37),
    ).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.checked === 1 && snapshot.completed === 1)).toBe(
      true,
    );
    expect(useOPDSProgressStore.getState().catalogs['cat-1']).toBeUndefined();
  });

  it('clears active state even when feed discovery rejects', async () => {
    useOPDSProgressStore.setState({ catalogs: {} });
    checkFeedForAllItemsMock.mockImplementationOnce(async () => {
      expect(useOPDSProgressStore.getState().catalogs['cat-1']?.mode).toBe('update-library');
      throw new Error('Feed offline');
    });
    await expect(
      refreshCatalogLibrary({ catalog, library: [book], appService: {} as AppService }),
    ).rejects.toThrow('Feed offline');
    expect(useOPDSProgressStore.getState().catalogs['cat-1']).toBeUndefined();
  });
  it('skips re-download when fingerprints match and still applies metadata', async () => {
    probeAcquisitionFingerprintMock.mockResolvedValue({
      etag: '"v1"',
      contentLength: 100,
      lastModified: 'a',
    });

    const result = await refreshCatalogLibrary({
      catalog,
      appService: {
        loadLibraryBooks: async () => [book],
        saveLibraryBooks: async () => {},
        openFile: async () => new File([], 'x'),
        deleteFile: async () => {},
        importBook: vi.fn(),
      } as unknown as AppService,
      library: [book],
    });

    expect(result.metadataUpdated).toBe(1);
    expect(result.redownloaded).toBe(0);
    expect(downloadAcquisitionFileMock).not.toHaveBeenCalled();
    expect(applyOPDSMetadataMock).toHaveBeenCalled();
  });

  it('skips unmapped feed entries', async () => {
    findOPDSSourceMappingMock.mockResolvedValue(null);
    probeAcquisitionFingerprintMock.mockResolvedValue(null);

    const result = await refreshCatalogLibrary({
      catalog,
      appService: {} as AppService,
      library: [book],
    });

    expect(result.skippedUnmapped).toBe(1);
    expect(downloadAcquisitionFileMock).not.toHaveBeenCalled();
  });

  it('re-downloads when fingerprint differs and hash changed', async () => {
    probeAcquisitionFingerprintMock.mockResolvedValue({ etag: '"v2"' });
    downloadAcquisitionFileMock.mockResolvedValue({
      filePath: '/tmp/book.epub',
      fingerprint: { etag: '"v2"' },
      responseHeaders: {},
    });
    partialMD5Mock.mockResolvedValue('hash-2');
    const importBook = vi.fn(async () => {
      book.hash = 'hash-2';
      return book;
    });

    const result = await refreshCatalogLibrary({
      catalog,
      appService: {
        openFile: async () => new File([], 'x'),
        deleteFile: async () => {},
        importBook,
      } as unknown as AppService,
      library: [book],
    });

    expect(result.redownloaded).toBe(1);
    expect(importBook).toHaveBeenCalled();
    expect(upsertOPDSSourceMappingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bookHash: 'hash-2', fingerprint: { etag: '"v2"' } }),
    );
  });

  it('does not re-import when downloaded bytes match the existing hash', async () => {
    probeAcquisitionFingerprintMock.mockResolvedValue({ etag: '"v2"' });
    downloadAcquisitionFileMock.mockResolvedValue({
      filePath: '/tmp/book.epub',
      fingerprint: { etag: '"v2"' },
      responseHeaders: {},
    });
    partialMD5Mock.mockResolvedValue('hash-1');
    const importBook = vi.fn();

    const result = await refreshCatalogLibrary({
      catalog,
      appService: {
        openFile: async () => new File([], 'x'),
        deleteFile: async () => {},
        importBook,
      } as unknown as AppService,
      library: [book],
    });

    expect(result.redownloaded).toBe(0);
    expect(result.metadataUpdated).toBe(1);
    expect(importBook).not.toHaveBeenCalled();
    expect(upsertOPDSSourceMappingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bookHash: 'hash-1', fingerprint: { etag: '"v2"' } }),
    );
  });
});
