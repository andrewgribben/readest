import { describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { OPDSCatalog } from '@/types/opds';
import { downloadFile } from '@/libs/storage';
import { downloadAcquisitionFile } from '@/services/opds/acquisitionDownload';

vi.mock('@/libs/storage', () => ({ downloadFile: vi.fn() }));
vi.mock('@/utils/misc', () => ({
  uniqueId: () => 'download',
  stubTranslation: (text: string) => text,
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/app/opds/utils/opdsReq', () => ({
  needsProxy: () => false,
  getProxiedURL: (url: string) => url,
  probeAuth: async () => null,
  probeFilename: async () => null,
  withOriginSuppressed: (headers: Record<string, string>) => headers,
}));

describe('downloadAcquisitionFile revision capture', () => {
  it('captures the feed revision alongside size-only download headers for Auto-download', async () => {
    vi.mocked(downloadFile).mockResolvedValueOnce({ 'content-length': '100' });
    const result = await downloadAcquisitionFile(
      { resolveFilePath: async () => '/cache/book.epub' } as unknown as AppService,
      { id: 'catalog', url: 'https://example.com/opds' } as OPDSCatalog,
      {
        acquisitionHref: '/book.epub',
        baseURL: 'https://example.com/opds',
        mimeType: 'application/epub+zip',
        title: 'Book',
        updated: '2026-10-01T12:00:00Z',
      },
    );
    expect(result.fingerprint).toEqual({
      contentLength: 100,
      entryUpdated: '2026-10-01T12:00:00Z',
    });
  });
});
