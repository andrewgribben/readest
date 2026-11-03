// Create / reuse a library row for an OPDS (or BookOrbit) audiobook.
//
// Shared by Play-from-catalog and Auto-download: ABS sync materializes stubs
// for every audiobook, and OPDS audio should land on the Audiobooks shelf the
// same way instead of only appearing after the user taps Play.

import { md5 } from '@/utils/md5';
import {
  makeBookOrbitAudioFilePath,
  matchBookOrbitAudiobook,
} from '@/services/bookorbit/audiobookId';
import type { Book } from '@/types/book';
import type { OPDSCatalog } from '@/types/opds';
import type { BookOrbitSettings } from '@/types/settings';
import type { AppService } from '@/types/system';
import { allowsSelfSignedCertAt, type SelfSignedCertOption } from '@/utils/tls';
import { applyOPDSCover } from './cover';
import { makeOpdsAudioFilePath, opdsAudioIdentity, type OpdsAudioTrackLink } from './audiobook';

export interface EnsureOpdsAudiobookStubInput {
  appService: AppService;
  library: Book[];
  catalogId: string;
  title: string;
  author: string;
  /** Absolute track URLs (already resolved against the feed base). */
  tracks: OpdsAudioTrackLink[];
  coverUrl?: string;
  catalog: Pick<OPDSCatalog, 'username' | 'password' | 'customHeaders'>;
  /** Self-signed cert opt-in owner for the cover fetch, e.g. the catalog. */
  certOwner?: SelfSignedCertOption & { url?: string };
  bookorbit?: Pick<BookOrbitSettings, 'serverUrl' | 'password'>;
}

export interface EnsureOpdsAudiobookStubResult {
  book: Book;
  /** True when a new library row was created. */
  created: boolean;
}

/**
 * The library identity a catalog audiobook gets, without creating anything:
 * lets the catalog show whether it is already on the shelf or downloaded.
 */
export const opdsAudiobookStubIdentity = (
  input: Pick<
    EnsureOpdsAudiobookStubInput,
    'catalogId' | 'title' | 'author' | 'tracks' | 'bookorbit'
  >,
): { hash: string; filePath: string; native: boolean } => {
  const { catalogId, title, author, tracks, bookorbit } = input;
  const native = matchBookOrbitAudiobook(
    tracks.map((track) => track.href),
    bookorbit ?? { serverUrl: '', password: '' },
  );
  const filePath = native
    ? makeBookOrbitAudioFilePath(native.bookId)
    : makeOpdsAudioFilePath({ catalogId, title, author, tracks });
  const hash = md5(native ? filePath : opdsAudioIdentity(catalogId, tracks));
  return { hash, filePath, native: !!native };
};

/**
 * Ensure the library has an OPDSAUDIO or BOOKORBIT stub for these tracks.
 * Idempotent on identity hash; applies the feed cover when creating a row.
 */
export const ensureOpdsAudiobookStub = async (
  input: EnsureOpdsAudiobookStubInput,
): Promise<EnsureOpdsAudiobookStubResult> => {
  const { appService, library, title, author, coverUrl, catalog } = input;

  const { hash, filePath, native } = opdsAudiobookStubIdentity(input);
  const existing = library.find((book) => book.hash === hash && !book.deletedAt);
  if (existing) return { book: existing, created: false };

  const now = Date.now();
  const stub: Book = {
    hash,
    format: native ? 'BOOKORBIT' : 'OPDSAUDIO',
    filePath,
    title,
    author,
    sourceTitle: title,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  if (coverUrl) {
    try {
      await applyOPDSCover({
        appService,
        book: stub,
        coverUrl,
        username: catalog.username ?? '',
        password: catalog.password ?? '',
        customHeaders: catalog.customHeaders,
        allowSelfSignedCert: allowsSelfSignedCertAt(input.certOwner ?? {}, coverUrl),
      });
    } catch (error) {
      console.warn(`[OPDS] failed to apply the feed cover for "${title}":`, error);
    }
  }

  return { book: stub, created: true };
};
