import { describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/document', () => ({
  DocumentLoader: class {
    async open() {
      return { book: { toc: [], destroy: () => {} } };
    }
  },
  CFI: { compare: () => 0 },
}));

vi.mock('@/services/audiobook/pairedProgressBookOrbit', () => ({
  fetchBookOrbitPlaybackSeconds: async () => null,
}));

import type { AudiobookTextChapter } from '@/services/audiobook/mapping';
import {
  evaluateAudiobookOpenSync,
  evaluateEbookOpenSync,
} from '@/services/audiobook/pairedProgressSync';
import { makeAbsFilePath } from '@/utils/audiobook';
import type { Book, BookConfig, PairedAudiobook } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { AppService } from '@/types/system';

const chapters: AudiobookTextChapter[] = [
  { id: 'c1', label: 'Chapter 1', href: 'c1.xhtml' },
  { id: 'c2', label: 'Chapter 2', href: 'c2.xhtml' },
  { id: 'c3', label: 'Chapter 3', href: 'c3.xhtml' },
];

const association: PairedAudiobook = {
  version: 1,
  files: [
    {
      id: 'abs',
      name: 'audio',
      path: makeAbsFilePath('s', 'i'),
      duration: 300,
    },
  ],
  chapters: [
    { id: 'a1', fileId: 'abs', label: 'One', start: 0, end: 100 },
    { id: 'a2', fileId: 'abs', label: 'Two', start: 100, end: 200 },
    { id: 'a3', fileId: 'abs', label: 'Three', start: 200, end: 300 },
  ],
  mappings: [
    { ebookChapterId: 'c1.xhtml', audioChapterId: 'a1' },
    { ebookChapterId: 'c2.xhtml', audioChapterId: 'a2' },
    { ebookChapterId: 'c3.xhtml', audioChapterId: 'a3' },
  ],
  createdAt: 1,
  source: {
    kind: 'audiobookshelf',
    serverId: 's',
    itemId: 'i',
    tracks: [{ index: 0, startOffset: 0, duration: 300, contentUrl: '/t' }],
  },
};

const ebookBook = {
  hash: 'ebook',
  title: 'Ebook',
  author: '',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
} as Book;

const audiobook = {
  hash: 'audio',
  title: 'Audio',
  author: '',
  format: 'ABS',
  filePath: makeAbsFilePath('s', 'i'),
  createdAt: 1,
  updatedAt: 5,
  progress: [10, 300],
} as Book;

const ebookConfig = (updatedAt: number, progress: [number, number]): BookConfig => ({
  audiobook: association,
  updatedAt,
  progress,
});

describe('evaluateAudiobookOpenSync', () => {
  it('offers sync when the ebook read is newer and far from startAt', async () => {
    const offer = await evaluateAudiobookOpenSync({
      library: [ebookBook, audiobook],
      audiobook,
      startAtSec: 10,
      loadBookConfig: async () => ebookConfig(20, [3, 3]),
      settings: {} as SystemSettings,
      appService: {
        loadBookContent: async () =>
          ({ file: new File([], 'x.epub'), book: ebookBook }) as Awaited<
            ReturnType<AppService['loadBookContent']>
          >,
        resolveNativeBookFilePath: async () => null,
      },
      ebookChapters: chapters,
    });
    expect(offer).not.toBeNull();
    expect(offer!.peerAudioSeconds).toBe(200);
    expect(offer!.localPreview).toContain('0:10');
  });

  it('returns null when the audiobook listen is newer', async () => {
    const offer = await evaluateAudiobookOpenSync({
      library: [ebookBook, audiobook],
      audiobook: { ...audiobook, updatedAt: 50 },
      startAtSec: 10,
      loadBookConfig: async () => ebookConfig(20, [3, 3]),
      settings: {} as SystemSettings,
      appService: {
        loadBookContent: async () =>
          ({ file: new File([], 'x.epub'), book: ebookBook }) as Awaited<
            ReturnType<AppService['loadBookContent']>
          >,
        resolveNativeBookFilePath: async () => null,
      },
      ebookChapters: chapters,
    });
    expect(offer).toBeNull();
  });
});

describe('evaluateEbookOpenSync', () => {
  it('offers sync when the audiobook listen is newer and far from the read position', async () => {
    const offer = await evaluateEbookOpenSync({
      library: [ebookBook, { ...audiobook, updatedAt: 50, progress: [200, 300] }],
      ebook: ebookBook,
      config: ebookConfig(10, [1, 3]),
      ebookChapters: chapters,
      localAudioSeconds: 0,
    });
    expect(offer).not.toBeNull();
    expect(offer!.ebookTarget?.ebookChapterId).toBe('c3.xhtml');
    expect(offer!.peerPreview).toContain('3:20');
  });

  it('returns null when unpaired', async () => {
    const offer = await evaluateEbookOpenSync({
      library: [ebookBook, audiobook],
      ebook: ebookBook,
      config: { updatedAt: 10 },
      ebookChapters: chapters,
      localAudioSeconds: 0,
    });
    expect(offer).toBeNull();
  });
});
