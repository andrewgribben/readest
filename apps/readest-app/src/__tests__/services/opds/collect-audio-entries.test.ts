import { describe, it, expect } from 'vitest';
import { collectNewAudioEntries, getAcquisitionLink } from '@/services/opds/feedChecker';
import type { OPDSFeed, OPDSPublication } from '@/types/opds';

const audioPub = (id: string, title: string): OPDSPublication =>
  ({
    metadata: { title, id, author: [{ name: 'Author' }] },
    links: [
      {
        rel: 'http://opds-spec.org/acquisition',
        href: `/api/v1/opds/${id}/download?fileId=1`,
        type: 'audio/mpeg',
        title: 'MP3',
      },
      {
        rel: 'http://opds-spec.org/acquisition',
        href: `/api/v1/opds/${id}/download?fileId=2`,
        type: 'audio/mpeg',
        title: 'MP3',
      },
    ],
    images: [],
  }) as unknown as OPDSPublication;

const epubPub = (id: string, title: string): OPDSPublication =>
  ({
    metadata: { title, id },
    links: [
      {
        rel: 'http://opds-spec.org/acquisition',
        href: `/api/v1/opds/${id}/download?fileId=9`,
        type: 'application/epub+zip',
        title: 'EPUB',
      },
    ],
    images: [],
  }) as unknown as OPDSPublication;

describe('collectNewAudioEntries', () => {
  it('collects multi-track audio publications and skips ebooks', () => {
    const feed = {
      publications: [audioPub('15959', 'Warbreaker'), epubPub('41', "Abaddon's Gate")],
    } as OPDSFeed;

    const items = collectNewAudioEntries(feed, new Set(), 'https://orbit.example/opds');
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Warbreaker');
    expect(items[0]!.tracks).toHaveLength(2);
    expect(items[0]!.author).toBe('Author');
  });

  it('does not offer audio links as ebook acquisitions', () => {
    expect(getAcquisitionLink(audioPub('15959', 'Warbreaker'))).toBeUndefined();
    expect(getAcquisitionLink(epubPub('41', "Abaddon's Gate"))?.type).toBe('application/epub+zip');
  });
});
