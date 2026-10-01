// Explicit "Update library" for one OPDS catalog: refresh feed metadata/covers
// for already-linked books, and re-download the ebook only when the remote
// file fingerprint (or content hash) says it changed.

import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { OPDSCatalog } from '@/types/opds';
import { resolveURL } from '@/app/opds/utils/opdsUtils';
import { partialMD5 } from '@/utils/md5';
import { applyOPDSCover } from './cover';
import { applyOPDSMetadata } from './metadata';
import { checkFeedForAllItems } from './feedChecker';
import { downloadAcquisitionFile, probeAcquisitionFingerprint } from './acquisitionDownload';
import {
  findOPDSSourceMapping,
  fingerprintsMatch,
  fingerprintHasSignal,
  upsertOPDSSourceMapping,
  type OPDSSourceFingerprint,
} from './sourceMap';
import { loadSubscriptionState, saveSubscriptionState } from './subscriptionState';
import type { PendingItem } from './types';
import { normalizeCustomHeaders } from '@/utils/customHeaders';

export interface RefreshCatalogProgress {
  current: number;
  total: number;
  title: string;
}

export interface RefreshCatalogResult {
  metadataUpdated: number;
  redownloaded: number;
  unchanged: number;
  skippedUnmapped: number;
  failed: number;
}

const catalogIdsFor = (catalog: OPDSCatalog): string[] => [
  ...new Set([catalog.contentId, catalog.id].filter(Boolean) as string[]),
];

const findMappedBook = async (
  appService: AppService,
  catalog: OPDSCatalog,
  sourceUrl: string,
  library: Book[],
) => {
  for (const catalogId of catalogIdsFor(catalog)) {
    const hit = await findOPDSSourceMapping(appService, {
      catalogId,
      sourceUrls: [sourceUrl],
      library,
    });
    if (hit) return { ...hit, catalogId };
  }
  return null;
};

const applyFeedMetadataAndCover = async (
  appService: AppService,
  catalog: OPDSCatalog,
  book: Book,
  item: PendingItem,
): Promise<boolean> => {
  let changed = false;
  if (item.metadata && Object.keys(item.metadata).length) {
    const before = book.metadataUpdatedAt;
    applyOPDSMetadata(book, item.metadata);
    if (book.metadataUpdatedAt !== before) changed = true;
  }
  if (item.coverHref) {
    try {
      const applied = await applyOPDSCover({
        appService,
        book,
        coverUrl: resolveURL(item.coverHref, item.baseURL),
        username: catalog.username ?? '',
        password: catalog.password ?? '',
        customHeaders: normalizeCustomHeaders(catalog.customHeaders),
      });
      if (applied) {
        book.coverUpdatedAt = Date.now();
        book.updatedAt = Date.now();
        changed = true;
      }
    } catch (error) {
      console.warn(`[OPDS] update library: cover failed for "${item.title}":`, error);
    }
  }
  return changed;
};

const shouldAttemptRedownload = (
  stored: OPDSSourceFingerprint,
  remote: OPDSSourceFingerprint | null,
): boolean => {
  // No stored signal yet — need a download (or hash compare) to establish one.
  if (!fingerprintHasSignal(stored)) return true;
  // HEAD failed: download and compare content hash.
  if (!remote || !fingerprintHasSignal(remote)) return true;
  return !fingerprintsMatch(stored, remote);
};

/**
 * Refresh one catalog's already-synced books. Does not delete books, does not
 * import unmapped feed entries, and does not clear Auto-download known ids.
 */
export const refreshCatalogLibrary = async (input: {
  catalog: OPDSCatalog;
  appService: AppService;
  library: Book[];
  onProgress?: (progress: RefreshCatalogProgress) => void;
  onLibraryDirty?: (books: Book[]) => Promise<void>;
}): Promise<RefreshCatalogResult> => {
  const { catalog, appService, onProgress, onLibraryDirty } = input;
  const library = input.library;
  const result: RefreshCatalogResult = {
    metadataUpdated: 0,
    redownloaded: 0,
    unchanged: 0,
    skippedUnmapped: 0,
    failed: 0,
  };

  const items = await checkFeedForAllItems(catalog);
  const total = items.length;
  let dirty = false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    onProgress?.({ current: index + 1, total, title: item.title });
    const sourceUrl = resolveURL(item.acquisitionHref, item.baseURL);

    try {
      const mapped = await findMappedBook(appService, catalog, sourceUrl, library);
      if (!mapped) {
        result.skippedUnmapped += 1;
        continue;
      }

      const { book, mapping, catalogId } = mapped;
      const metaChanged = await applyFeedMetadataAndCover(appService, catalog, book, item);

      const remoteFp = await probeAcquisitionFingerprint(
        item.acquisitionHref,
        item.baseURL,
        catalog,
      );

      if (!shouldAttemptRedownload(mapping.fingerprint, remoteFp)) {
        if (metaChanged) {
          result.metadataUpdated += 1;
          dirty = true;
        } else {
          result.unchanged += 1;
        }
        continue;
      }

      const downloaded = await downloadAcquisitionFile(appService, catalog, item);
      const file = await appService.openFile(downloaded.filePath, 'None');
      let fileHash: string;
      try {
        fileHash = await partialMD5(file);
      } finally {
        // ClosableFile from native paths may expose close(); ignore if absent.
        await (file as { close?: () => Promise<void> }).close?.();
      }

      const fingerprint = fingerprintHasSignal(downloaded.fingerprint)
        ? downloaded.fingerprint
        : (remoteFp ?? {});

      if (fileHash === book.hash) {
        // Bytes unchanged (Calibre re-export with same content, or false probe).
        await upsertOPDSSourceMapping(appService, {
          catalogId,
          sourceUrl,
          bookHash: book.hash,
          fingerprint,
        });
        if (metaChanged) {
          result.metadataUpdated += 1;
          dirty = true;
        } else {
          result.unchanged += 1;
        }
        try {
          await appService.deleteFile(downloaded.filePath, 'None');
        } catch {
          // best effort
        }
        continue;
      }

      const previousHash = book.hash;
      const imported = await appService.importBook(downloaded.filePath, library);
      if (!imported) throw new Error(`importBook returned null for ${item.title}`);

      // Catalog metadata wins again after file-derived metadata from import.
      if (item.metadata) applyOPDSMetadata(imported, item.metadata);
      if (item.coverHref) {
        try {
          const applied = await applyOPDSCover({
            appService,
            book: imported,
            coverUrl: resolveURL(item.coverHref, item.baseURL),
            username: catalog.username ?? '',
            password: catalog.password ?? '',
            customHeaders: normalizeCustomHeaders(catalog.customHeaders),
          });
          if (applied) {
            imported.coverUpdatedAt = Date.now();
            imported.updatedAt = Date.now();
          }
        } catch {
          // best effort
        }
      }

      await upsertOPDSSourceMapping(appService, {
        catalogId,
        sourceUrl,
        bookHash: imported.hash,
        fingerprint,
      });
      // If the import remapped to a different library row under another
      // catalog key, keep both keys pointing at the live hash.
      if (imported.hash !== previousHash) {
        for (const id of catalogIdsFor(catalog)) {
          if (id === catalogId) continue;
          await upsertOPDSSourceMapping(appService, {
            catalogId: id,
            sourceUrl,
            bookHash: imported.hash,
            fingerprint,
          });
        }
      }

      result.redownloaded += 1;
      dirty = true;
    } catch (error) {
      console.warn(`[OPDS] update library failed for "${item.title}":`, error);
      result.failed += 1;
    }

    if (dirty && (index + 1) % 10 === 0) {
      await onLibraryDirty?.(library);
      dirty = false;
    }
  }

  if (dirty) await onLibraryDirty?.(library);

  try {
    const state = await loadSubscriptionState(appService, catalog.id);
    state.lastCheckedAt = Date.now();
    await saveSubscriptionState(appService, state);
  } catch {
    // best effort
  }

  return result;
};
