import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBookOrbitAudioFilePath } from '@/services/bookorbit/audiobookId';
import { MANIFEST_SCHEMA, SUPPORTED_SCHEMA_VERSION } from '@/services/bookorbit/manifest';
import {
  buildOpdsAudioTracks,
  makeOpdsAudioFilePath,
  type OpdsAudiobookData,
} from '@/services/opds/audiobook';
import { downloadOpdsForOffline, loadOpdsOfflineManifest } from '@/services/opds/offline';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { getOpdsOfflineDir } from '@/utils/audiobook';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';

const {
  downloadFileMock,
  renameMock,
  probeAudioDurationsMock,
  resolveOpdsAudioAuthMock,
  getManifestMock,
  refreshAccessTokenMock,
} = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
  renameMock: vi.fn(),
  probeAudioDurationsMock: vi.fn(),
  resolveOpdsAudioAuthMock: vi.fn(),
  getManifestMock: vi.fn(),
  refreshAccessTokenMock: vi.fn(),
}));

vi.mock('@/libs/storage', () => ({ downloadFile: downloadFileMock }));
vi.mock('@tauri-apps/plugin-fs', () => ({ rename: renameMock }));
vi.mock('@/services/opds/audioStream', async () => {
  const actual = await vi.importActual<typeof import('@/services/opds/audioStream')>(
    '@/services/opds/audioStream',
  );
  return {
    ...actual,
    probeAudioDurations: probeAudioDurationsMock,
    resolveOpdsAudioAuth: resolveOpdsAudioAuthMock,
    opdsAudioBlocker: () => null,
    buildOpdsAudioUrl: (href: string) => href,
  };
});
vi.mock('@/services/bookorbit/createClient', () => ({
  createBookOrbitClient: () => ({
    getManifest: getManifestMock,
    refreshAccessToken: refreshAccessTokenMock,
    serverUrl: 'https://bookorbit.example',
    accessToken: 'tok',
    server: { customHeaders: {} },
  }),
}));

const catalogId = 'catalog-1';
const opdsData = (): OpdsAudiobookData => ({
  catalogId,
  title: 'Sherlock',
  author: 'Doyle',
  tracks: [
    { href: 'https://opds.example/a.mp3', mimeType: 'audio/mpeg', title: '01.mp3' },
    { href: 'https://opds.example/b.mp3', mimeType: 'audio/mpeg', title: '02.mp3' },
  ],
});

const makeService = () => {
  const files = new Map<string, string>();
  const service = {
    createDir: vi.fn(async () => undefined),
    exists: vi.fn(async (path: string) => files.has(path)),
    resolveFilePath: vi.fn(async (path: string) => `/books/${path}`),
    writeFile: vi.fn(async (path: string, _base: string, content: string) => {
      files.set(path, content);
    }),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content == null) throw new Error('missing');
      return content;
    }),
  } as unknown as AppService;
  return { service, files };
};

describe('downloadOpdsForOffline — OPDSAUDIO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SYSTEM_SETTINGS,
        opdsCatalogs: [{ id: catalogId, name: 'Home', url: 'https://opds.example/catalog' }],
      } as SystemSettings,
    });
    resolveOpdsAudioAuthMock.mockResolvedValue({
      authHeader: null,
      customHeaders: {},
      hasCredentials: false,
      origin: 'https://opds.example',
    });
    probeAudioDurationsMock.mockResolvedValue([100, 200]);
    downloadFileMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);
  });

  it('downloads each track and writes a manifest last', async () => {
    const { service, files } = makeService();
    const book = {
      hash: 'bookhash',
      format: 'OPDSAUDIO',
      title: 'Sherlock',
      author: 'Doyle',
      filePath: makeOpdsAudioFilePath(opdsData()),
      createdAt: 1,
      updatedAt: 1,
    } as Book;

    await downloadOpdsForOffline(service, book);

    expect(downloadFileMock).toHaveBeenCalledTimes(2);
    expect(downloadFileMock.mock.calls[0]![0].url).toBe('https://opds.example/a.mp3');
    const dir = getOpdsOfflineDir('bookhash');
    expect(files.has(`${dir}/manifest.json`)).toBe(true);
    const manifest = JSON.parse(files.get(`${dir}/manifest.json`)!);
    expect(manifest.kind).toBe('opds');
    expect(manifest.tracks).toHaveLength(2);
    expect(manifest.tracks[0].contentUrl.startsWith(`${dir}/`)).toBe(true);
  });

  it('skips tracks that already exist on disk', async () => {
    const { service, files } = makeService();
    const data = opdsData();
    const tracks = buildOpdsAudioTracks(data.tracks, [100, 200]);
    const dir = getOpdsOfflineDir('bookhash');
    files.set(`${dir}/1-01.mp3`, 'already');
    const book = {
      hash: 'bookhash',
      format: 'OPDSAUDIO',
      title: 'Sherlock',
      author: 'Doyle',
      filePath: makeOpdsAudioFilePath(data),
      createdAt: 1,
      updatedAt: 1,
    } as Book;

    // exists returns true for the first planned path after makeSafeFilename
    (service.exists as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) =>
      path.includes('/1-'),
    );

    await downloadOpdsForOffline(service, book);

    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(tracks).toHaveLength(2);
  });
});

describe('downloadOpdsForOffline — BOOKORBIT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshAccessTokenMock.mockResolvedValue(undefined);
    getManifestMock.mockResolvedValue({
      schema: MANIFEST_SCHEMA,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      revision: 'f'.repeat(64),
      book: { id: 8, title: 'Sherlock', authors: ['Doyle'], narrators: [] },
      assets: [
        {
          assetId: 'aud_0',
          sequence: 0,
          format: 'mp3',
          durationMs: 100_000,
          sizeBytes: 50,
          etag: 'a',
        },
        {
          assetId: 'aud_1',
          sequence: 1,
          format: 'mp3',
          durationMs: 200_000,
          sizeBytes: 80,
          etag: 'b',
        },
      ],
      chapters: [
        {
          id: 'ch_a',
          title: 'One',
          assetId: 'aud_0',
          sequence: 0,
          startMs: 0,
          endMs: 100_000,
          assetOffsetMs: 0,
        },
      ],
    });
    downloadFileMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);
  });

  it('downloads BookOrbit assets through the audiobook API', async () => {
    const { service, files } = makeService();
    const book = {
      hash: 'bohash',
      format: 'BOOKORBIT',
      title: 'Sherlock',
      author: 'Doyle',
      filePath: makeBookOrbitAudioFilePath(8),
      createdAt: 1,
      updatedAt: 1,
    } as Book;

    await downloadOpdsForOffline(service, book);

    expect(getManifestMock).toHaveBeenCalledWith(8);
    expect(downloadFileMock).toHaveBeenCalledTimes(2);
    expect(downloadFileMock.mock.calls[0]![0].url).toContain(
      '/api/v1/audiobooks/8/assets/aud_0/content',
    );
    const manifest = JSON.parse(files.get(`${getOpdsOfflineDir('bohash')}/manifest.json`)!);
    expect(manifest.kind).toBe('bookorbit');
    expect(manifest.chapters).toHaveLength(1);
  });
});

describe('loadOpdsOfflineManifest', () => {
  it('returns null for missing or invalid manifests', async () => {
    const { service, files } = makeService();
    expect(await loadOpdsOfflineManifest(service, 'missing')).toBeNull();
    files.set(`${getOpdsOfflineDir('bad')}/manifest.json`, '{not json');
    expect(await loadOpdsOfflineManifest(service, 'bad')).toBeNull();
  });
});
