import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PairedAudiobookOpdsSource } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useSettingsStore } from '@/store/settingsStore';

vi.mock('@/services/opds/audioStream', () => ({
  buildOpdsAudioUrl: (href: string) => href,
  canStreamOpdsAudio: (auth: { hasCredentials: boolean }) => !auth.hasCredentials,
  fetchOpdsAudioBlob: vi.fn(),
  opdsAudioBlocker: () => null,
  resolveOpdsAudioAuth: vi.fn(async (_catalogId: string, _href: string) => ({
    authHeader: null,
    customHeaders: {},
    hasCredentials: false,
    origin: 'https://opds.example',
  })),
}));

const { opdsNarrationTracks, loadOpdsTrack } = await import('@/services/opds/narration');
const audioStream = await import('@/services/opds/audioStream');

const source: PairedAudiobookOpdsSource = {
  kind: 'opds',
  catalogId: 'catalog-1',
  tracks: [
    {
      index: 0,
      startOffset: 0,
      duration: 100,
      contentUrl: 'https://opds.example/a.mp3',
      mimeType: 'audio/mpeg',
    },
    {
      index: 1,
      startOffset: 100,
      duration: 200,
      contentUrl: 'https://opds.example/b.mp3',
      mimeType: 'audio/mpeg',
    },
  ],
};

describe('opdsNarrationTracks', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SYSTEM_SETTINGS,
        opdsCatalogs: [{ id: 'catalog-1', name: 'Home', url: 'https://opds.example/catalog' }],
      } as SystemSettings,
    });
    vi.mocked(audioStream.resolveOpdsAudioAuth).mockResolvedValue({
      authHeader: null,
      customHeaders: {},
      hasCredentials: false,
      origin: 'https://opds.example',
    });
  });

  afterEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
    vi.clearAllMocks();
  });

  it('returns streamable acquisition URLs for open catalogs', async () => {
    await expect(opdsNarrationTracks(source)).resolves.toEqual([
      { url: 'https://opds.example/a.mp3', startOffset: 0, duration: 100 },
      { url: 'https://opds.example/b.mp3', startOffset: 100, duration: 200 },
    ]);
  });

  it('rewrites authenticated tracks to opds-track ids for blob playback', async () => {
    vi.mocked(audioStream.resolveOpdsAudioAuth).mockResolvedValue({
      authHeader: 'Basic abc',
      customHeaders: {},
      hasCredentials: true,
      origin: 'https://opds.example',
    });

    await expect(opdsNarrationTracks(source)).resolves.toEqual([
      { url: 'opds-track:0', startOffset: 0, duration: 100 },
      { url: 'opds-track:1', startOffset: 100, duration: 200 },
    ]);
  });
});

describe('loadOpdsTrack', () => {
  beforeEach(() => {
    vi.mocked(audioStream.resolveOpdsAudioAuth).mockResolvedValue({
      authHeader: 'Basic abc',
      customHeaders: {},
      hasCredentials: true,
      origin: 'https://opds.example',
    });
    vi.mocked(audioStream.fetchOpdsAudioBlob).mockResolvedValue(new Blob(['audio']));
  });

  it('resolves an opds-track id back to the acquisition href', async () => {
    await loadOpdsTrack(source, 'opds-track:1');
    expect(audioStream.fetchOpdsAudioBlob).toHaveBeenCalledWith(
      'https://opds.example/b.mp3',
      expect.objectContaining({ hasCredentials: true }),
      'audio/mpeg',
    );
  });
});
