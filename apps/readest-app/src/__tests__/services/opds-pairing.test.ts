import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeAbsFilePath } from '@/utils/audiobook';
import { makeBookOrbitAudioFilePath } from '@/services/bookorbit/audiobookId';
import {
  buildOpdsAudioTracks,
  makeOpdsAudioFilePath,
  type OpdsAudiobookData,
} from '@/services/opds/audiobook';
import {
  buildOpdsPairingSource,
  listPairableOpdsBooks,
  OPDS_PAIRED_FILE_ID,
} from '@/services/opds/pairing';
import { useSettingsStore } from '@/store/settingsStore';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';

const catalogId = 'catalog-1';

const opdsData = (overrides: Partial<OpdsAudiobookData> = {}): OpdsAudiobookData => ({
  catalogId,
  title: 'Sherlock Holmes',
  author: 'Doyle',
  tracks: [
    { href: 'https://opds.example/a.mp3', mimeType: 'audio/mpeg', title: '01-intro.mp3' },
    { href: 'https://opds.example/b.mp3', mimeType: 'audio/mpeg', title: '02-chapter.mp3' },
  ],
  ...overrides,
});

const makeBook = (overrides: Partial<Book>): Book => ({
  hash: 'h',
  format: 'OPDSAUDIO',
  filePath: makeOpdsAudioFilePath(opdsData()),
  title: 'Book',
  author: 'Author',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('listPairableOpdsBooks', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SYSTEM_SETTINGS,
        opdsCatalogs: [
          {
            id: catalogId,
            name: 'Home OPDS',
            url: 'https://opds.example/catalog',
          },
        ],
        bookorbit: {
          ...DEFAULT_SYSTEM_SETTINGS.bookorbit!,
          serverUrl: 'https://bookorbit.example',
          password: 'secret',
        },
      } as SystemSettings,
    });
  });

  afterEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
  });

  it('keeps live OPDS and BookOrbit audiobooks, sorted by title', () => {
    const library = [
      makeBook({ hash: 'z', title: 'Zulu', format: 'OPDSAUDIO' }),
      makeBook({
        hash: 'abs',
        title: 'ABS Book',
        format: 'ABS',
        filePath: makeAbsFilePath('srv', 'item'),
      }),
      makeBook({ hash: 'gone', title: 'Deleted', deletedAt: 1 }),
      makeBook({
        hash: 'orphan',
        title: 'Orphan OPDS',
        filePath: makeOpdsAudioFilePath(opdsData({ catalogId: 'missing' })),
      }),
      makeBook({
        hash: 'bo',
        title: 'Alpha BookOrbit',
        format: 'BOOKORBIT',
        filePath: makeBookOrbitAudioFilePath(8),
      }),
      makeBook({ hash: 'a', title: 'Alpha OPDS' }),
    ];

    expect(listPairableOpdsBooks(library).map((book) => book.hash)).toEqual(['bo', 'a', 'z']);
  });

  it('drops BookOrbit stubs when BookOrbit is not configured', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        bookorbit: {
          ...DEFAULT_SYSTEM_SETTINGS.bookorbit!,
          serverUrl: '',
          password: '',
        },
      } as SystemSettings,
    });

    const library = [
      makeBook({
        hash: 'bo',
        format: 'BOOKORBIT',
        filePath: makeBookOrbitAudioFilePath(8),
      }),
      makeBook({ hash: 'opds' }),
    ];

    expect(listPairableOpdsBooks(library).map((book) => book.hash)).toEqual(['opds']);
  });
});

describe('buildOpdsPairingSource', () => {
  it('builds one virtual file with one chapter per track', () => {
    const data = opdsData();
    const tracks = buildOpdsAudioTracks(data.tracks, [100, 200]);
    const source = buildOpdsPairingSource(data, tracks);

    expect(source.title).toBe('Sherlock Holmes');
    expect(source.files).toEqual([
      {
        id: OPDS_PAIRED_FILE_ID,
        name: 'Sherlock Holmes',
        path: makeOpdsAudioFilePath(data),
        duration: 300,
      },
    ]);
    expect(source.chapters).toEqual([
      {
        id: `${OPDS_PAIRED_FILE_ID}:track:0`,
        fileId: OPDS_PAIRED_FILE_ID,
        label: '01-intro',
        start: 0,
        end: 100,
      },
      {
        id: `${OPDS_PAIRED_FILE_ID}:track:1`,
        fileId: OPDS_PAIRED_FILE_ID,
        label: '02-chapter',
        start: 100,
        end: 300,
      },
    ]);
    expect(source.source).toEqual({
      kind: 'opds',
      catalogId,
      tracks: [
        {
          index: 0,
          startOffset: 0,
          duration: 100,
          contentUrl: 'https://opds.example/a.mp3',
          mimeType: 'audio/mpeg',
          title: '01-intro.mp3',
        },
        {
          index: 1,
          startOffset: 100,
          duration: 200,
          contentUrl: 'https://opds.example/b.mp3',
          mimeType: 'audio/mpeg',
          title: '02-chapter.mp3',
        },
      ],
    });
  });

  it('rejects an empty track list', () => {
    expect(() => buildOpdsPairingSource(opdsData(), [])).toThrow(/no audio tracks/i);
  });
});
