import { describe, expect, it, vi } from 'vitest';
import { ensureOpdsAudiobookStub, opdsAudiobookStubIdentity } from '@/services/opds/audiobookStub';

vi.mock('@/services/opds/cover', () => ({ applyOPDSCover: vi.fn() }));

const bookorbit = { serverUrl: 'https://orbit.example', password: 'pw' };
const tracks = [
  { href: 'https://orbit.example/api/v1/opds/30556/download?fileId=1', mimeType: 'audio/mp4' },
];

describe('opdsAudiobookStubIdentity', () => {
  it('predicts the hash the stub is created with, so the catalog can show its state', async () => {
    const identity = opdsAudiobookStubIdentity({
      catalogId: 'c1',
      title: 'Skyward',
      author: 'Sanderson',
      tracks,
      bookorbit,
    });
    const { book } = await ensureOpdsAudiobookStub({
      appService: {} as never,
      library: [],
      catalogId: 'c1',
      title: 'Skyward',
      author: 'Sanderson',
      tracks,
      catalog: {},
      bookorbit,
    });
    expect(identity).toMatchObject({ native: true, filePath: 'bookorbit://30556' });
    expect(book.hash).toBe(identity.hash);
    expect(book.format).toBe('BOOKORBIT');
  });

  it('falls back to the generic OPDS identity off the BookOrbit host', () => {
    const identity = opdsAudiobookStubIdentity({
      catalogId: 'c1',
      title: 'T',
      author: 'A',
      tracks: [{ href: 'https://other.example/a.mp3', mimeType: 'audio/mpeg' }],
      bookorbit,
    });
    expect(identity.native).toBe(false);
  });
});
