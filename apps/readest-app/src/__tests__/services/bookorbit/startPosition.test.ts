import { describe, expect, it } from 'vitest';
import { clampStartPosition, resolveBookOrbitStart } from '@/services/bookorbit/startPosition';
import { matchingAssetIds } from '@/services/bookorbit/manifest';
import type { BookOrbitManifest } from '@/services/bookorbit/manifest';
import { pairedTrackAssetId } from '@/services/bookorbit/pairedServerPosition';

describe('resolveBookOrbitStart', () => {
  const duration = 10_000;

  it('uses the local position when the server has none', () => {
    expect(resolveBookOrbitStart({ server: null, local: 500, duration })).toEqual({
      kind: 'resolved',
      position: 500,
      source: 'local',
    });
  });

  it('uses the server position when this device never played the book', () => {
    expect(resolveBookOrbitStart({ server: 800, local: 0, duration })).toEqual({
      kind: 'resolved',
      position: 800,
      source: 'server',
    });
  });

  it('treats push lag as agreement and takes the server position', () => {
    expect(resolveBookOrbitStart({ server: 820, local: 800, duration })).toMatchObject({
      kind: 'resolved',
      position: 820,
    });
  });

  it('asks when the positions really differ, in either direction', () => {
    expect(resolveBookOrbitStart({ server: 900, local: 800, duration })).toEqual({
      kind: 'ask',
      server: 900,
      local: 800,
    });
    expect(resolveBookOrbitStart({ server: 700, local: 800, duration }).kind).toBe('ask');
  });

  it('replays a finished book from the start', () => {
    expect(clampStartPosition(9_999.5, duration)).toBe(0);
    expect(resolveBookOrbitStart({ server: null, local: 9_999.5, duration })).toMatchObject({
      position: 0,
    });
  });
});

describe('matchingAssetIds', () => {
  const manifest = {
    schema: 'bookorbit.audiobook-manifest',
    schemaVersion: 2,
    revision: 'r1',
    book: { id: 1, title: 't', authors: [], narrators: [] },
    assets: [
      { assetId: 'b', sequence: 2, format: 'mp3', durationMs: 200_000, sizeBytes: 1, etag: '' },
      { assetId: 'a', sequence: 1, format: 'mp3', durationMs: 100_000, sizeBytes: 1, etag: '' },
    ],
    chapters: [],
  } as BookOrbitManifest;
  const track = (index: number, startOffset: number, duration: number) => ({
    index,
    startOffset,
    duration,
    contentUrl: `x/${index}`,
    mimeType: 'audio/mpeg',
  });

  it('returns the ids in track order when the files still line up', () => {
    expect(matchingAssetIds(manifest, [track(0, 0, 100), track(1, 100, 200)])).toEqual(['a', 'b']);
  });

  it('refuses when a track count or length changed', () => {
    expect(matchingAssetIds(manifest, [track(0, 0, 100)])).toBeNull();
    expect(matchingAssetIds(manifest, [track(0, 0, 100), track(1, 100, 150)])).toBeNull();
  });
});

describe('pairedTrackAssetId', () => {
  it('reads the asset id from a pairing track path', () => {
    expect(pairedTrackAssetId('/api/v1/audiobooks/30556/assets/aud_960fa733/content')).toBe(
      'aud_960fa733',
    );
    expect(pairedTrackAssetId('/api/v1/audiobooks/1/assets/a%2Fb/content')).toBe('a/b');
    expect(pairedTrackAssetId('/somewhere/else')).toBeNull();
  });
});
