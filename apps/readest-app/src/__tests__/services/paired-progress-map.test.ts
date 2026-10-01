import { describe, expect, it } from 'vitest';

import type { AudiobookTextChapter } from '@/services/audiobook/mapping';
import {
  audioDurationFromAssociation,
  audioSecondsToEbookTarget,
  buildMappedChapterClips,
  decidePairedProgressPrompt,
  ebookProgressToAudioSeconds,
  formatAudioClock,
  formatAudioPositionPreview,
  pairedAudioDiffThresholdSec,
} from '@/services/audiobook/pairedProgressMap';
import type { PairedAudiobook } from '@/types/book';

const chapters: AudiobookTextChapter[] = [
  { id: 'c1', label: 'Chapter 1', href: 'c1.xhtml', cfi: 'epubcfi(/6/2)' },
  { id: 'c2', label: 'Chapter 2', href: 'c2.xhtml', cfi: 'epubcfi(/6/4)' },
  { id: 'c3', label: 'Chapter 3', href: 'c3.xhtml', cfi: 'epubcfi(/6/6)' },
];

const association: PairedAudiobook = {
  version: 1,
  files: [{ id: 'f', name: 'book.m4b', path: 'hash/audiobook/book.m4b', duration: 300 }],
  chapters: [
    { id: 'a1', fileId: 'f', label: 'One', start: 0, end: 100 },
    { id: 'a2', fileId: 'f', label: 'Two', start: 100, end: 200 },
    { id: 'a3', fileId: 'f', label: 'Three', start: 200, end: 300 },
  ],
  mappings: [
    { ebookChapterId: 'c1.xhtml', audioChapterId: 'a1' },
    { ebookChapterId: 'c2.xhtml', audioChapterId: 'a2' },
    { ebookChapterId: 'c3.xhtml', audioChapterId: 'a3' },
  ],
  createdAt: 1,
};

describe('buildMappedChapterClips', () => {
  it('maps each ebook chapter to its audio clipBegin', () => {
    expect(buildMappedChapterClips(association, chapters)).toEqual([
      expect.objectContaining({ ebookChapterId: 'c1.xhtml', clipBegin: 0, clipEnd: 100 }),
      expect.objectContaining({ ebookChapterId: 'c2.xhtml', clipBegin: 100, clipEnd: 200 }),
      expect.objectContaining({ ebookChapterId: 'c3.xhtml', clipBegin: 200, clipEnd: 300 }),
    ]);
  });

  it('returns empty when there are no mappings', () => {
    expect(buildMappedChapterClips({ ...association, mappings: [] }, chapters)).toEqual([]);
  });
});

describe('ebookProgressToAudioSeconds', () => {
  it('uses page-fraction fallback when location is absent', () => {
    // progress [2,6] → fraction 1/3 → second mapped chapter (clipBegin 100)
    expect(ebookProgressToAudioSeconds(association, chapters, { progress: [2, 6] })).toBe(100);
  });

  it('returns null when nothing is mapped', () => {
    expect(
      ebookProgressToAudioSeconds({ ...association, mappings: [] }, chapters, {
        progress: [1, 3],
      }),
    ).toBeNull();
  });
});

describe('audioSecondsToEbookTarget', () => {
  it('lands on the chapter that owns the listening position', () => {
    expect(audioSecondsToEbookTarget(association, chapters, 150)).toMatchObject({
      ebookChapterId: 'c2.xhtml',
      label: 'Chapter 2',
      clipBegin: 100,
    });
  });

  it('clamps past the end to the last mapped chapter', () => {
    expect(audioSecondsToEbookTarget(association, chapters, 999)?.ebookChapterId).toBe('c3.xhtml');
  });
});

describe('decidePairedProgressPrompt', () => {
  it('prompts when the peer is newer and far enough away', () => {
    expect(
      decidePairedProgressPrompt({
        localUpdatedAt: 1,
        peerUpdatedAt: 2,
        localAudioSeconds: 10,
        peerAudioSeconds: 120,
        durationSec: 300,
      }).shouldPrompt,
    ).toBe(true);
  });

  it('does not prompt when positions are within the threshold', () => {
    expect(
      decidePairedProgressPrompt({
        localUpdatedAt: 1,
        peerUpdatedAt: 2,
        localAudioSeconds: 100,
        peerAudioSeconds: 110,
        durationSec: 300,
      }).shouldPrompt,
    ).toBe(false);
  });

  it('does not prompt when the local side is newer', () => {
    expect(
      decidePairedProgressPrompt({
        localUpdatedAt: 5,
        peerUpdatedAt: 2,
        localAudioSeconds: 10,
        peerAudioSeconds: 200,
        durationSec: 300,
      }).shouldPrompt,
    ).toBe(false);
  });

  it('treats a fresher BookOrbit server position as peer-newer', () => {
    expect(
      decidePairedProgressPrompt({
        localUpdatedAt: 5,
        peerUpdatedAt: 2,
        localAudioSeconds: 10,
        peerAudioSeconds: 200,
        durationSec: 300,
        peerIsServerFresher: true,
      }).shouldPrompt,
    ).toBe(true);
  });
});

describe('helpers', () => {
  it('formats clocks and previews', () => {
    expect(formatAudioClock(125)).toBe('2:05');
    expect(formatAudioPositionPreview(125, 300, 'Chapter 2')).toBe('Chapter 2 (2:05, 41.67%)');
    expect(audioDurationFromAssociation(association)).toBe(300);
    expect(pairedAudioDiffThresholdSec(300)).toBe(30);
    expect(pairedAudioDiffThresholdSec(10_000)).toBe(100);
  });
});
