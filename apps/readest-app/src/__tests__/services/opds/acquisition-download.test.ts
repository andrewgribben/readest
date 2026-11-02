import { describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { OPDSCatalog } from '@/types/opds';
import { downloadFile } from '@/libs/storage';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  downloadAcquisitionFile,
  probeAcquisitionFingerprint,
} from '@/services/opds/acquisitionDownload';

vi.mock('@/libs/storage', () => ({ downloadFile: vi.fn() }));
vi.mock('@/utils/misc', () => ({
  uniqueId: () => 'download',
  stubTranslation: (text: string) => text,
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
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

  it('skips TLS verification by default (catalogs allow self-signed certs unless opted out)', async () => {
    vi.mocked(downloadFile).mockResolvedValueOnce({});
    await downloadAcquisitionFile(
      { resolveFilePath: async () => '/cache/book.epub' } as unknown as AppService,
      { id: 'catalog', url: 'https://example.com/opds' } as OPDSCatalog,
      {
        acquisitionHref: '/book.epub',
        baseURL: 'https://example.com/opds',
        mimeType: 'application/epub+zip',
        title: 'Book',
      },
    );
    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ skipSslVerification: true }),
    );
  });

  it('does not skip TLS verification when the catalog opts out of self-signed certs', async () => {
    vi.mocked(downloadFile).mockResolvedValueOnce({});
    await downloadAcquisitionFile(
      { resolveFilePath: async () => '/cache/book.epub' } as unknown as AppService,
      {
        id: 'catalog',
        url: 'https://example.com/opds',
        allowSelfSignedCert: false,
      } as OPDSCatalog,
      {
        acquisitionHref: '/book.epub',
        baseURL: 'https://example.com/opds',
        mimeType: 'application/epub+zip',
        title: 'Book',
      },
    );
    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ skipSslVerification: false }),
    );
  });

  it('does not skip TLS verification for an acquisition link on another origin', async () => {
    vi.mocked(downloadFile).mockResolvedValueOnce({});
    await downloadAcquisitionFile(
      { resolveFilePath: async () => '/cache/book.epub' } as unknown as AppService,
      { id: 'catalog', url: 'https://example.com/opds' } as OPDSCatalog,
      {
        acquisitionHref: 'https://other.example.com/book.epub',
        baseURL: 'https://example.com/opds',
        mimeType: 'application/epub+zip',
        title: 'Book',
      },
    );
    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ skipSslVerification: false }),
    );
  });
});

describe('probeAcquisitionFingerprint TLS opt-in', () => {
  it('passes the self-signed cert override only when the catalog allows it', async () => {
    vi.mocked(tauriFetch).mockResolvedValue({
      ok: true,
      headers: { get: () => null },
    } as unknown as Response);

    await probeAcquisitionFingerprint('/book.epub', 'https://example.com/opds', {
      id: 'catalog',
      url: 'https://example.com/opds',
    } as OPDSCatalog);
    expect(vi.mocked(tauriFetch).mock.calls[0]![1]).toMatchObject({
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    });

    vi.mocked(tauriFetch).mockClear();
    await probeAcquisitionFingerprint('/book.epub', 'https://example.com/opds', {
      id: 'catalog',
      url: 'https://example.com/opds',
      allowSelfSignedCert: false,
    } as OPDSCatalog);
    expect(vi.mocked(tauriFetch).mock.calls[0]![1]).not.toHaveProperty('danger');
  });
});
