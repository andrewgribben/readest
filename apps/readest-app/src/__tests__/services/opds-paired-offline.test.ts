import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book, PairedAudiobook } from '@/types/book';
import type { AppService } from '@/types/system';
import { makeOpdsAudioFilePath } from '@/services/opds/audiobook';
const h = vi.hoisted(() => ({ library: [] as Book[], manifest: vi.fn() }));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ library: h.library }) },
}));
vi.mock('@/services/opds/offline', () => ({ loadOpdsOfflineManifest: h.manifest }));
import {
  preferDownloadedOpdsNarration,
  resolveDownloadedOpdsPairing,
} from '@/services/opds/pairedOffline';

describe('downloaded OPDS paired playback', () => {
  const tracks = [
    { index: 0, startOffset: 0, duration: 100, contentUrl: '/remote/a', mimeType: 'audio/mpeg' },
    { index: 1, startOffset: 100, duration: 200, contentUrl: '/remote/b', mimeType: 'audio/mpeg' },
  ];
  const pair: PairedAudiobook = {
    version: 1,
    chapters: [],
    mappings: [],
    createdAt: 1,
    files: [{ id: 'bookorbit', name: 'Audio', path: 'bookorbit://7', duration: 300 }],
    source: { kind: 'bookorbit', bookId: 7, tracks },
  };
  const app = {
    exists: vi.fn(),
    resolveFilePath: vi.fn(async (path: string) => `/local/${path}`),
    readFile: vi.fn(async () => new Uint8Array([1, 2]).buffer),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    app.exists.mockResolvedValue(true);
    h.library = [{ hash: 'audio', filePath: 'bookorbit://7', opdsDownloadedAt: 1 } as Book];
    h.manifest.mockResolvedValue({
      kind: 'bookorbit',
      duration: 300,
      tracks: tracks.map((track, i) => ({ ...track, contentUrl: `audio/opds-offline/${i}.mp3` })),
    });
  });
  it('loads local tracks without calling the streaming loader and keeps global offsets', async () => {
    const stream = { resolveTracks: vi.fn(), loadTrack: vi.fn() };
    const source = preferDownloadedOpdsNarration(app as unknown as AppService, pair, stream);
    expect(await source.resolveTracks!('bookorbit://7')).toEqual([
      { url: '/local/audio/opds-offline/0.mp3', startOffset: 0, duration: 100 },
      { url: '/local/audio/opds-offline/1.mp3', startOffset: 100, duration: 200 },
    ]);
    const blob = await source.loadTrack!('/local/audio/opds-offline/1.mp3');
    expect(blob.type).toBe('audio/mpeg');
    expect(app.readFile).toHaveBeenCalledWith('/local/audio/opds-offline/1.mp3', 'None', 'binary');
    expect(stream.resolveTracks).not.toHaveBeenCalled();
    expect(stream.loadTrack).not.toHaveBeenCalled();
    expect(pair.source?.kind).toBe('bookorbit');
  });
  it('uses the generic OPDS download as well', async () => {
    const path = makeOpdsAudioFilePath({
      catalogId: 'catalog',
      title: 'Audio',
      author: '',
      tracks: [{ href: 'https://catalog/a.mp3', mimeType: 'audio/mpeg' }],
    });
    const opdsPair = {
      ...pair,
      files: [{ ...pair.files[0]!, path }],
      source: { kind: 'opds', catalogId: 'catalog', tracks },
    } as PairedAudiobook;
    h.library[0]!.filePath = path;
    expect(
      (await resolveDownloadedOpdsPairing(app as unknown as AppService, opdsPair))?.tracks,
    ).toHaveLength(2);
  });
  it.each([
    'missing manifest',
    'missing file',
    'different timeline',
    'removed download',
  ])('falls back to streaming for %s', async (reason) => {
    if (reason === 'missing manifest') h.manifest.mockResolvedValue(null);
    if (reason === 'missing file') app.exists.mockResolvedValue(false);
    if (reason === 'different timeline')
      h.manifest.mockResolvedValue({ tracks: [{ ...tracks[0], duration: 999 }] });
    if (reason === 'removed download') h.library[0]!.opdsDownloadedAt = undefined;
    const stream = {
      resolveTracks: vi.fn(async () => [
        { url: 'https://remote/a', startOffset: 0, duration: 300 },
      ]),
      loadTrack: vi.fn(async () => new Blob()),
    };
    const source = preferDownloadedOpdsNarration(app as unknown as AppService, pair, stream);
    await source.resolveTracks!('bookorbit://7');
    await source.loadTrack!('https://remote/a');
    expect(stream.resolveTracks).toHaveBeenCalled();
    expect(stream.loadTrack).toHaveBeenCalled();
  });
});
