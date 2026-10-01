import { describe, expect, it, vi } from 'vitest';

import {
  associationMatchesAudiobook,
  findPairedAudiobookStub,
  findPairedEbook,
} from '@/services/audiobook/pairedProgressLookup';
import { makeAbsFilePath } from '@/utils/audiobook';
import { makeBookOrbitAudioFilePath } from '@/services/bookorbit/audiobookId';
import type { Book, BookConfig, PairedAudiobook } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

const makeOpdsPath = (catalogId: string, hrefs: string[]): string =>
  `opdsaudio://${encodeURIComponent(
    JSON.stringify({
      catalogId,
      title: 'opds',
      author: '',
      tracks: hrefs.map((href) => ({ href, mimeType: 'audio/mpeg' })),
    }),
  )}`;

const ebook = (hash: string): Book =>
  ({
    hash,
    title: hash,
    author: '',
    format: 'EPUB',
    createdAt: 1,
    updatedAt: 1,
  }) as Book;

const absStub = (serverId: string, itemId: string): Book =>
  ({
    hash: `abs-${itemId}`,
    title: itemId,
    author: '',
    format: 'ABS',
    filePath: makeAbsFilePath(serverId, itemId),
    createdAt: 1,
    updatedAt: 10,
    progress: [50, 300],
  }) as Book;

const bookOrbitStub = (bookId: number): Book =>
  ({
    hash: `bo-${bookId}`,
    title: 'bo',
    author: '',
    format: 'BOOKORBIT',
    filePath: makeBookOrbitAudioFilePath(bookId),
    createdAt: 1,
    updatedAt: 10,
    progress: [80, 400],
  }) as Book;

const opdsStub = (): Book =>
  ({
    hash: 'opds-1',
    title: 'opds',
    author: '',
    format: 'OPDSAUDIO',
    filePath: makeOpdsPath('cat-1', ['https://example.com/a.mp3', 'https://example.com/b.mp3']),
    createdAt: 1,
    updatedAt: 10,
    progress: [20, 200],
  }) as Book;

const absAssociation = (serverId: string, itemId: string): PairedAudiobook => ({
  version: 1,
  files: [{ id: 'abs', name: 'audio', path: makeAbsFilePath(serverId, itemId), duration: 300 }],
  chapters: [{ id: 'a1', fileId: 'abs', label: 'One', start: 0, end: 300 }],
  mappings: [{ ebookChapterId: 'c1.xhtml', audioChapterId: 'a1' }],
  createdAt: 1,
  source: {
    kind: 'audiobookshelf',
    serverId,
    itemId,
    tracks: [{ index: 0, startOffset: 0, duration: 300, contentUrl: '/t' }],
  },
});

const bookOrbitAssociation = (bookId: number): PairedAudiobook => ({
  version: 1,
  files: [
    { id: 'bookorbit', name: 'audio', path: makeBookOrbitAudioFilePath(bookId), duration: 400 },
  ],
  chapters: [{ id: 'a1', fileId: 'bookorbit', label: 'One', start: 0, end: 400 }],
  mappings: [{ ebookChapterId: 'c1.xhtml', audioChapterId: 'a1' }],
  createdAt: 1,
  source: {
    kind: 'bookorbit',
    bookId,
    tracks: [{ index: 0, startOffset: 0, duration: 400, contentUrl: '/t' }],
  },
});

const opdsAssociation = (): PairedAudiobook => ({
  version: 1,
  files: [{ id: 'opds', name: 'audio', path: 'opds', duration: 200 }],
  chapters: [{ id: 'a1', fileId: 'opds', label: 'One', start: 0, end: 200 }],
  mappings: [{ ebookChapterId: 'c1.xhtml', audioChapterId: 'a1' }],
  createdAt: 1,
  source: {
    kind: 'opds',
    catalogId: 'cat-1',
    tracks: [
      {
        index: 0,
        startOffset: 0,
        duration: 100,
        contentUrl: 'https://example.com/a.mp3',
        mimeType: 'audio/mpeg',
      },
      {
        index: 1,
        startOffset: 100,
        duration: 100,
        contentUrl: 'https://example.com/b.mp3',
        mimeType: 'audio/mpeg',
      },
    ],
  },
});

describe('associationMatchesAudiobook', () => {
  it('matches ABS, BookOrbit, and OPDS stubs', () => {
    expect(associationMatchesAudiobook(absAssociation('s', 'i'), absStub('s', 'i'))).toBe(true);
    expect(associationMatchesAudiobook(absAssociation('s', 'i'), absStub('s', 'other'))).toBe(
      false,
    );
    expect(associationMatchesAudiobook(bookOrbitAssociation(9), bookOrbitStub(9))).toBe(true);
    expect(associationMatchesAudiobook(bookOrbitAssociation(9), bookOrbitStub(8))).toBe(false);
    expect(associationMatchesAudiobook(opdsAssociation(), opdsStub())).toBe(true);
  });

  it('matches local file pairings by path', () => {
    const local: PairedAudiobook = {
      version: 1,
      files: [{ id: 'f', name: 'a.m4b', path: '/books/a.m4b', duration: 10 }],
      chapters: [{ id: 'a1', fileId: 'f', label: 'One', start: 0, end: 10 }],
      mappings: [{ ebookChapterId: 'c1', audioChapterId: 'a1' }],
      createdAt: 1,
    };
    expect(
      associationMatchesAudiobook(local, {
        ...ebook('audio'),
        filePath: '/books/a.m4b',
      } as Book),
    ).toBe(true);
  });
});

describe('findPairedAudiobookStub', () => {
  it('finds the matching stub in the library', () => {
    const library = [ebook('e1'), absStub('s', 'i'), bookOrbitStub(9), opdsStub()];
    expect(findPairedAudiobookStub(library, absAssociation('s', 'i'))?.hash).toBe('abs-i');
    expect(findPairedAudiobookStub(library, bookOrbitAssociation(9))?.hash).toBe('bo-9');
    expect(findPairedAudiobookStub(library, opdsAssociation())?.hash).toBe('opds-1');
    expect(findPairedAudiobookStub(library, null)).toBeNull();
  });
});

describe('findPairedEbook', () => {
  it('loads ebook configs until it finds the pairing for the stub', async () => {
    const paired = ebook('paired');
    const other = ebook('other');
    const stub = absStub('s', 'i');
    const loadBookConfig = vi.fn(async (book: Book): Promise<BookConfig> => {
      if (book.hash === 'paired') {
        return {
          audiobook: absAssociation('s', 'i'),
          updatedAt: 20,
          progress: [2, 10],
          location: 'epubcfi(/6/4)',
        };
      }
      return { updatedAt: 1 };
    });

    const match = await findPairedEbook(
      [other, paired, stub],
      stub,
      loadBookConfig,
      {} as SystemSettings,
    );
    expect(match?.ebook.hash).toBe('paired');
    expect(match?.association.source).toMatchObject({ kind: 'audiobookshelf', itemId: 'i' });
    expect(loadBookConfig).toHaveBeenCalled();
  });

  it('returns null when no ebook pairs to the stub', async () => {
    const match = await findPairedEbook(
      [ebook('e'), absStub('s', 'other')],
      absStub('s', 'i'),
      async () => ({ updatedAt: 1 }),
      {} as SystemSettings,
    );
    expect(match).toBeNull();
  });
});
