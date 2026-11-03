import { beforeEach, describe, expect, it, vi } from 'vitest';

// A downloaded BookOrbit audiobook used to ignore the server entirely: the
// offline copy carried no asset ids, so the shared position was never read and
// never written. These cover the open path that decides where to resume.
const h = vi.hoisted(() => ({
  startAt: -1,
  hooksGiven: false,
  offline: null as Record<string, unknown> | null,
  saved: null as Record<string, unknown> | null,
  state: null as Record<string, unknown> | null,
  manifestCalls: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/services/audiobook/carPlayback', () => ({
  importCarListeningCheckpoint: async () => null,
}));
vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: { getSessionByHash: () => null, claim: () => {} },
}));
vi.mock('@/services/audiobook/AudiobookClock', () => ({
  HtmlAudioClock: class {},
  BlobAudioClock: class {},
}));
vi.mock('@/services/audiobook/NativeAudiobookClock', () => ({ NativeAudiobookClock: class {} }));
vi.mock('@/services/audiobook/AudiobookController', () => ({
  AudiobookController: class {
    kind = 'audiobook';
    terminated = false;
    constructor(source: { startAt: number }, _clock: unknown, hooks: unknown) {
      h.startAt = source.startAt;
      h.hooksGiven = !!hooks;
    }
    getCurrentChapter() {
      return null;
    }
  },
}));
vi.mock('@/services/audiobook/progressPersistence', () => ({
  makeAudiobookProgressSaver: () => () => {},
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ library: [], setLibrary: () => {} }) },
}));
vi.mock('@/services/opds/offline', () => ({
  loadOpdsOfflineManifest: async () => h.offline,
  saveOpdsOfflineManifest: async (_a: unknown, _h: string, m: Record<string, unknown>) => {
    h.saved = m;
  },
}));
const manifest = {
  schema: 'bookorbit.audiobook-manifest',
  schemaVersion: 2,
  revision: 'rev-1',
  book: { id: 9, title: 'T', authors: ['A'], narrators: [] },
  assets: [
    { assetId: 'a0', sequence: 1, format: 'mp3', durationMs: 1_000_000, sizeBytes: 1, etag: '' },
    { assetId: 'a1', sequence: 2, format: 'mp3', durationMs: 1_000_000, sizeBytes: 1, etag: '' },
  ],
  chapters: [],
};
vi.mock('@/services/bookorbit/createClient', () => ({
  createBookOrbitClient: () => ({
    getManifest: async () => {
      h.manifestCalls++;
      return manifest;
    },
    getPlaybackState: async () => h.state,
    putPlaybackState: async () => ({ revision: 2 }),
  }),
}));

const { openBookOrbitAudiobookSession } = await import(
  '@/services/bookorbit/openBookOrbitAudiobook'
);

const offlineTracks = [
  { index: 0, startOffset: 0, duration: 1000, contentUrl: 'x/1', mimeType: 'audio/mpeg' },
  { index: 1, startOffset: 1000, duration: 1000, contentUrl: 'x/2', mimeType: 'audio/mpeg' },
];

const book = (local: number) =>
  ({
    hash: 'bh',
    format: 'BOOKORBIT',
    title: 'T',
    author: 'A',
    filePath: 'bookorbit://9',
    opdsDownloadedAt: 1,
    progress: [local, 2000],
    createdAt: 1,
    updatedAt: 1,
  }) as never;

const appService = {
  resolveFilePath: async (p: string) => p,
  saveLibraryBooks: async () => {},
} as never;

beforeEach(() => {
  h.startAt = -1;
  h.saved = null;
  h.manifestCalls = 0;
  h.offline = { kind: 'bookorbit', duration: 2000, chapters: [], tracks: offlineTracks };
  // Server: 300 s into the second asset = 1300 s on the book's timeline.
  h.state = { assetId: 'a1', positionMs: 300_000, revision: 4 };
});

describe('openBookOrbitAudiobookSession (downloaded)', () => {
  it('backfills asset ids on an older download and asks when the server moved on', async () => {
    const chooseStart = vi.fn().mockResolvedValue('server');
    await openBookOrbitAudiobookSession({ appService, book: book(500), chooseStart });

    expect(h.manifestCalls).toBe(1);
    expect(h.saved).toMatchObject({ assetIds: ['a0', 'a1'], manifestRevision: 'rev-1' });
    expect(chooseStart).toHaveBeenCalledWith({ bookHash: 'bh', server: 1300, local: 500 });
    expect(h.startAt).toBe(1300);
  });

  it('keeps this device position when the user picks it', async () => {
    const chooseStart = vi.fn().mockResolvedValue('local');
    await openBookOrbitAudiobookSession({ appService, book: book(500), chooseStart });
    expect(h.startAt).toBe(500);
  });

  it('uses stored ids without a manifest fetch, and follows the server inside the tolerance', async () => {
    h.offline = { ...h.offline!, assetIds: ['a0', 'a1'], manifestRevision: 'rev-1' };
    const chooseStart = vi.fn();
    await openBookOrbitAudiobookSession({ appService, book: book(1290), chooseStart });
    expect(h.manifestCalls).toBe(0);
    expect(chooseStart).not.toHaveBeenCalled();
    expect(h.startAt).toBe(1300);
  });

  it('falls back to the local position when the server is unreachable', async () => {
    h.offline = { ...h.offline!, assetIds: ['a0', 'a1'], manifestRevision: 'rev-1' };
    h.state = null;
    await openBookOrbitAudiobookSession({ appService, book: book(500) });
    expect(h.startAt).toBe(500);
  });
});
