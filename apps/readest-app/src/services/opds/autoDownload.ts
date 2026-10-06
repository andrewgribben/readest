import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { OPDSCatalog } from '@/types/opds';
import { resolveURL } from '@/app/opds/utils/opdsUtils';
import type { BookOrbitSettings } from '@/types/settings';
import { ensureOpdsAudiobookStub } from './audiobookStub';
import { applyOPDSCover } from './cover';
import { applyOPDSMetadata } from './metadata';
import { checkFeedForNewItems } from './feedChecker';
import {
  loadSubscriptionState,
  saveSubscriptionState,
  pruneKnownEntryIds,
} from './subscriptionState';
import { findBookByOPDSSources, upsertOPDSSourceMapping } from './sourceMap';
import { downloadAcquisitionFile } from './acquisitionDownload';
import {
  isRetryEligible,
  DOWNLOAD_CONCURRENCY,
  MAX_RETRY_ATTEMPTS,
  PERSIST_BATCH_SIZE,
} from './types';
import type {
  PendingAudioItem,
  PendingItem,
  SyncResult,
  OPDSSubscriptionState,
  FailedEntry,
} from './types';
import { runWithConcurrency } from '@/utils/concurrency';
import { useOPDSProgressStore } from '@/store/opdsProgressStore';

/**
 * Download a single item and import it into the library.
 */
async function downloadAndImport(
  item: PendingItem,
  catalog: OPDSCatalog,
  appService: AppService,
  books: Book[],
): Promise<{ book: Book; downloaded: boolean }> {
  const url = resolveURL(item.acquisitionHref, item.baseURL);
  // Identity gate (#5859): if this OPDS source already maps to a book still in
  // the library, it is already imported. Re-importing it would mint a NEW
  // book_hash for a re-packaged-but-identical file (calibre/CWA rewrites the
  // EPUB on each ingest, so the bytes — and thus partialMD5 — differ while the
  // content does not), stranding the reading position across hashes. Reuse the
  // existing book instead of re-downloading. A genuinely new edition changes
  // the feed entry id (or the acquisition URL), so it still imports normally.
  //
  // Look up under BOTH catalog keys: `contentId` is backfilled at a later save,
  // so a source imported before the backfill is mapped under `id` while later
  // syncs key on `contentId` — matching only one would miss the mapping and
  // re-import anyway.
  const catalogIds = [...new Set([catalog.contentId, catalog.id].filter(Boolean) as string[])];
  let existing: Book | null = null;
  for (const catalogId of catalogIds) {
    existing = await findBookByOPDSSources(appService, {
      catalogId,
      sourceUrls: [url],
      library: books,
    });
    if (existing) break;
  }
  if (existing) {
    console.log(`[OPDS] "${item.title}" already imported for this source — skipping re-download`);
    return { book: existing, downloaded: false };
  }

  useOPDSProgressStore
    .getState()
    .fileProgress(catalog.id, item.entryId, item.title, { progress: 0, total: 0 });
  const { filePath: dstFilePath, fingerprint } = await downloadAcquisitionFile(
    appService,
    catalog,
    item,
    (progress) =>
      useOPDSProgressStore.getState().fileProgress(catalog.id, item.entryId, item.title, progress),
  );

  const book = await appService.importBook(dstFilePath, books);
  if (!book) throw new Error(`importBook returned null for ${item.title}`);
  // The catalog's curated metadata wins over the file's embedded record
  // (#5270). Retry items rebuilt from FailedEntry carry none and skip.
  if (item.metadata) {
    applyOPDSMetadata(book, item.metadata);
  }
  // The catalog's own artwork wins over the one embedded in the file (#5270).
  // Best effort: a failure here must not fail an otherwise good import.
  if (item.coverHref) {
    try {
      await applyOPDSCover({
        appService,
        book,
        coverUrl: resolveURL(item.coverHref, item.baseURL),
        username: catalog.username ?? '',
        password: catalog.password ?? '',
        customHeaders: catalog.customHeaders,
      });
    } catch (error) {
      console.warn(`[OPDS] failed to apply the feed cover for "${item.title}":`, error);
    }
  }
  try {
    await upsertOPDSSourceMapping(appService, {
      catalogId: catalog.contentId || catalog.id,
      sourceUrl: url,
      bookHash: book.hash,
      fingerprint,
    });
  } catch (error) {
    console.error('OPDS sync: failed to update source map:', error);
  }
  console.log(`[OPDS] imported "${item.title}"`);
  return { book, downloaded: true };
}

/** Materialize a streaming audiobook stub (no file download). */
async function stubAudiobook(
  item: PendingAudioItem,
  catalog: OPDSCatalog,
  appService: AppService,
  books: Book[],
  bookorbit?: Pick<BookOrbitSettings, 'serverUrl' | 'password'>,
): Promise<{ book: Book; created: boolean }> {
  const tracks = item.tracks.map((track) => ({
    ...track,
    href: resolveURL(track.href, item.baseURL),
  }));
  const { book, created } = await ensureOpdsAudiobookStub({
    appService,
    library: books,
    catalogId: catalog.contentId || catalog.id,
    title: item.title,
    author: item.author,
    tracks,
    coverUrl: item.coverHref ? resolveURL(item.coverHref, item.baseURL) : undefined,
    catalog,
    bookorbit,
  });
  if (created) {
    books.unshift(book);
    console.log(`[OPDS] stubbed audiobook "${item.title}"`);
  }
  return { book, created };
}

/**
 * Sync a single catalog: discover new items, retry failed, download, update state.
 *
 * A failure inside the download loop is returned rather than thrown so the
 * books earlier batches already committed are still reported: their entries
 * are in knownEntryIds now, so no later sync would rediscover them and the
 * caller would never get to queue them for cloud upload. The caller rethrows
 * `error` once it has taken `newBooks`.
 */
async function syncCatalog(
  catalog: OPDSCatalog,
  appService: AppService,
  books: Book[],
  onBooksImported?: (newBooks: Book[]) => Promise<void>,
  bookorbit?: Pick<BookOrbitSettings, 'serverUrl' | 'password'>,
): Promise<{ newBooks: Book[]; state: OPDSSubscriptionState; error?: unknown }> {
  const state = await loadSubscriptionState(appService, catalog.id);

  // Discovery: ebooks to download and audiobooks to stub (never import audio).
  const discovery = await checkFeedForNewItems(catalog, state);
  const pendingItems = discovery.ebooks;
  const pendingAudio = discovery.audiobooks;
  const audioEntryIds = new Set(pendingAudio.map((item) => item.entryId));

  // Drop legacy ebook-import failures for titles that are actually audiobooks.
  // Older builds retried those as importBook and permanently skipped them.
  const ebookFailedEntries = state.failedEntries.filter((fe) => !audioEntryIds.has(fe.entryId));

  // Failed entries still in their backoff window must not be re-attempted
  // until they become retry-eligible. They naturally reappear in
  // pendingItems (still in feed, not yet in knownEntryIds), so we have to
  // filter them out here. Without this, every sync would re-download the
  // same in-backoff entry and append a second copy to failedEntries —
  // surfacing as duplicate-key warnings in the failed-downloads dialog.
  const inBackoffIds = new Set(
    ebookFailedEntries.filter((fe) => !isRetryEligible(fe)).map((fe) => fe.entryId),
  );
  const eligiblePendingItems = pendingItems.filter((p) => !inBackoffIds.has(p.entryId));

  // Collect retry-eligible failed entries as PendingItems (ebooks only).
  const retryItems: PendingItem[] = ebookFailedEntries.filter(isRetryEligible).map((fe) => ({
    entryId: fe.entryId,
    title: fe.title,
    acquisitionHref: fe.href,
    mimeType: 'application/octet-stream',
    baseURL: catalog.url,
  }));

  // Dedupe: a retry-eligible failed entry can also reappear in pendingItems
  // (because the entry isn't in knownEntryIds yet). Prefer the pending copy
  // since it carries the freshly-discovered MIME type from the feed.
  const seenIds = new Set<string>();
  const allItems: PendingItem[] = [];
  for (const item of [...eligiblePendingItems, ...retryItems]) {
    if (seenIds.has(item.entryId) || audioEntryIds.has(item.entryId)) continue;
    seenIds.add(item.entryId);
    allItems.push(item);
  }

  const newBooks: Book[] = [];
  const updatedFailedEntries: FailedEntry[] = [
    ...ebookFailedEntries.filter((fe) => !isRetryEligible(fe)),
  ];
  const priorAttempts = new Map(ebookFailedEntries.map((fe) => [fe.entryId, fe.attempts]));
  useOPDSProgressStore
    .getState()
    .patch(catalog.id, { phase: 'processing', total: allItems.length });

  if (allItems.length === 0 && pendingAudio.length === 0) {
    state.failedEntries = updatedFailedEntries;
    state.lastCheckedAt = Date.now();
    await saveSubscriptionState(appService, state);
    return { newBooks: [], state };
  }

  try {
    // Audiobook stubs first: no network download of media, just library rows
    // so they show on the Audiobooks shelf like ABS sync.
    if (pendingAudio.length > 0) {
      const audioBooks: Book[] = [];
      const audioKnownIds: string[] = [];
      for (const item of pendingAudio) {
        try {
          const { book, created } = await stubAudiobook(
            item,
            catalog,
            appService,
            books,
            bookorbit,
          );
          audioKnownIds.push(item.entryId);
          if (created) audioBooks.push(book);
        } catch (error) {
          console.error(`[OPDS] failed to stub audiobook "${item.title}":`, error);
        }
      }
      if (audioBooks.length > 0) {
        await onBooksImported?.(audioBooks);
        newBooks.push(...audioBooks);
      }
      state.knownEntryIds = pruneKnownEntryIds([...state.knownEntryIds, ...audioKnownIds]);
      state.failedEntries = updatedFailedEntries;
      state.lastCheckedAt = Date.now();
      await saveSubscriptionState(appService, state);
    }

    // Acquisition: download ebooks with bounded concurrency, in batches.
    //
    // Progress is persisted after every batch rather than once at the end. A
    // first sync of a large catalog runs for minutes and is a prime target for
    // Android's low-memory killer; with a single end-of-run write, a kill at
    // item N discarded all N imports and the next run restarted from zero, so
    // the sync could never converge however often it was retried. Batching
    // bounds that loss to one batch and lets successive runs make progress.
    for (let offset = 0; offset < allItems.length; offset += PERSIST_BATCH_SIZE) {
      const batch = allItems.slice(offset, offset + PERSIST_BATCH_SIZE);
      const downloadResults = await runWithConcurrency(
        batch,
        DOWNLOAD_CONCURRENCY,
        async (item) => {
          const progress = useOPDSProgressStore.getState();
          try {
            const imported = await downloadAndImport(item, catalog, appService, books);
            if (imported.downloaded) progress.completeFile(catalog.id, item.entryId, false);
            else {
              const total = useOPDSProgressStore.getState().catalogs[catalog.id]?.total ?? 0;
              progress.patch(catalog.id, { total: Math.max(0, total - 1) });
            }
            return imported.book;
          } catch (error) {
            progress.completeFile(catalog.id, item.entryId, true);
            throw error;
          }
        },
      );

      const batchBooks: Book[] = [];
      const newKnownIds: string[] = [];

      for (const outcome of downloadResults) {
        const item = outcome.item;
        if ('result' in outcome) {
          batchBooks.push(outcome.result);
          newKnownIds.push(item.entryId);
        } else {
          const attempts = (priorAttempts.get(item.entryId) ?? 0) + 1;

          if (attempts >= MAX_RETRY_ATTEMPTS) {
            newKnownIds.push(item.entryId);
            console.error(
              `OPDS sync: permanently skipping "${item.title}" after ${attempts} failed attempts`,
            );
          } else {
            updatedFailedEntries.push({
              entryId: item.entryId,
              href: item.acquisitionHref,
              title: item.title,
              attempts,
              lastAttemptAt: Date.now(),
            });
          }
        }
      }

      // Persist the imported books BEFORE recording their entries as known: an
      // entry in knownEntryIds is never downloaded again, so a kill between the
      // two writes would otherwise lose the library rows for good while the
      // marker survives (#5658). In the reverse order a kill merely costs a
      // redundant re-download — imports are idempotent. A failed persist aborts
      // the catalog run, leaving this batch's entries unknown for the next sync.
      if (batchBooks.length > 0) {
        await onBooksImported?.(batchBooks);
        newBooks.push(...batchBooks);
      }

      state.knownEntryIds = pruneKnownEntryIds([...state.knownEntryIds, ...newKnownIds]);
      state.failedEntries = updatedFailedEntries;
      state.lastCheckedAt = Date.now();
      await saveSubscriptionState(appService, state);
    }
  } catch (error) {
    return { newBooks, state, error };
  }

  return { newBooks, state };
}

/**
 * Sync all OPDS catalogs that have autoDownload enabled.
 *
 * Catalogs are processed sequentially: the per-catalog pool already runs
 * DOWNLOAD_CONCURRENCY parallel downloads, and a parallel fan-out across
 * catalogs would multiply that (N × DOWNLOAD_CONCURRENCY) and hammer
 * cellular connections. One failure does not block the others — each
 * catalog's errors are isolated and surfaced in the result.
 */
export async function syncSubscribedCatalogs(
  catalogs: OPDSCatalog[],
  appService: AppService,
  books: Book[],
  onBooksImported?: (newBooks: Book[]) => Promise<void>,
  bookorbit?: Pick<BookOrbitSettings, 'serverUrl' | 'password'>,
): Promise<SyncResult> {
  const eligible = catalogs.filter((c) => c.autoDownload && !c.disabled);
  if (eligible.length === 0) {
    return { newBooks: [], totalNewBooks: 0, errors: [] };
  }

  const allNewBooks: Book[] = [];
  const errors: SyncResult['errors'] = [];

  for (const catalog of eligible) {
    if (!useOPDSProgressStore.getState().begin(catalog.id, 'auto-download')) continue;
    try {
      const { newBooks, error } = await syncCatalog(
        catalog,
        appService,
        books,
        onBooksImported,
        bookorbit,
      );
      // Take the books committed before the failure, then let the existing
      // error path run — those batches are already on disk and marked known.
      allNewBooks.push(...newBooks);
      if (error) throw error;
    } catch (reason) {
      console.error(`OPDS sync: catalog "${catalog.name}" failed:`, reason);
      errors.push({
        catalogId: catalog.id,
        catalogName: catalog.name,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      try {
        const state = await loadSubscriptionState(appService, catalog.id);
        state.lastCheckedAt = Date.now();
        await saveSubscriptionState(appService, state);
      } catch {
        // Best effort
      }
    } finally {
      useOPDSProgressStore.getState().finish(catalog.id);
    }
  }

  return {
    newBooks: allNewBooks,
    totalNewBooks: allNewBooks.length,
    errors,
  };
}
