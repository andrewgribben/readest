import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';

const openOPDSDb = (appService: AppService) => appService.openDatabase('opds', 'opds.db', 'Data');

/** Remote-file identity for deciding whether an Update library must re-download. */
export interface OPDSSourceFingerprint {
  etag?: string;
  lastModified?: string;
  contentLength?: number;
}

export interface OPDSSourceMappingRow {
  bookHash: string;
  fingerprint: OPDSSourceFingerprint;
}

export const fingerprintFromHeaders = (
  headers: Record<string, string> | Headers | null | undefined,
): OPDSSourceFingerprint => {
  if (!headers) return {};
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower && value) return value;
    }
    return undefined;
  };
  const etag = get('etag')?.trim();
  const lastModified = get('last-modified')?.trim();
  const lengthRaw = get('content-length')?.trim();
  const contentLength = lengthRaw && /^\d+$/.test(lengthRaw) ? Number(lengthRaw) : undefined;
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
  };
};

export const fingerprintHasSignal = (fp: OPDSSourceFingerprint): boolean =>
  !!fp.etag || !!fp.lastModified || fp.contentLength !== undefined;

/**
 * True when the stored and remote fingerprints agree the file is unchanged.
 * Prefers ETag; otherwise requires both Last-Modified and Content-Length.
 * Returns false when equality cannot be confirmed (caller should re-check).
 */
export const fingerprintsMatch = (
  stored: OPDSSourceFingerprint,
  remote: OPDSSourceFingerprint,
): boolean => {
  if (stored.etag && remote.etag) return stored.etag === remote.etag;
  if (
    stored.lastModified &&
    remote.lastModified &&
    stored.contentLength !== undefined &&
    remote.contentLength !== undefined
  ) {
    return (
      stored.lastModified === remote.lastModified && stored.contentLength === remote.contentLength
    );
  }
  return false;
};

export const upsertOPDSSourceMapping = async (
  appService: AppService,
  input: {
    catalogId: string;
    sourceUrl: string;
    bookHash: string;
    fingerprint?: OPDSSourceFingerprint;
  },
): Promise<void> => {
  if (!input.catalogId || !input.sourceUrl || !input.bookHash) return;

  const db = await openOPDSDb(appService);
  try {
    await db.execute(
      `
        INSERT INTO opds_source_mappings (
          catalog_id, source_url, book_hash, etag, last_modified, content_length
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(catalog_id, source_url)
        DO UPDATE SET
          book_hash = excluded.book_hash,
          etag = COALESCE(excluded.etag, opds_source_mappings.etag),
          last_modified = COALESCE(excluded.last_modified, opds_source_mappings.last_modified),
          content_length = COALESCE(excluded.content_length, opds_source_mappings.content_length)
      `,
      [
        input.catalogId,
        input.sourceUrl,
        input.bookHash,
        input.fingerprint?.etag ?? null,
        input.fingerprint?.lastModified ?? null,
        input.fingerprint?.contentLength ?? null,
      ],
    );
  } finally {
    await db.close();
  }
};

export const findOPDSSourceMapping = async (
  appService: AppService,
  input: { catalogId: string; sourceUrls: string[]; library: Book[] },
): Promise<{ book: Book; mapping: OPDSSourceMappingRow } | null> => {
  const sourceUrls = Array.from(new Set(input.sourceUrls.filter(Boolean)));
  if (!input.catalogId || sourceUrls.length === 0 || input.library.length === 0) return null;

  const db = await openOPDSDb(appService);
  try {
    const rows = await db.select<{
      book_hash: string;
      etag: string | null;
      last_modified: string | null;
      content_length: number | null;
    }>(
      `
        SELECT book_hash, etag, last_modified, content_length
        FROM opds_source_mappings
        WHERE catalog_id = ?
          AND source_url IN (${sourceUrls.map(() => '?').join(', ')})
      `,
      [input.catalogId, ...sourceUrls],
    );
    for (const row of rows) {
      const book = input.library.find((entry) => entry.hash === row.book_hash && !entry.deletedAt);
      if (!book) continue;
      return {
        book,
        mapping: {
          bookHash: row.book_hash,
          fingerprint: {
            ...(row.etag ? { etag: row.etag } : {}),
            ...(row.last_modified ? { lastModified: row.last_modified } : {}),
            ...(row.content_length != null ? { contentLength: row.content_length } : {}),
          },
        },
      };
    }
    return null;
  } finally {
    await db.close();
  }
};

export const findBookByOPDSSources = async (
  appService: AppService,
  input: { catalogId: string; sourceUrls: string[]; library: Book[] },
): Promise<Book | null> => {
  const hit = await findOPDSSourceMapping(appService, input);
  return hit?.book ?? null;
};
