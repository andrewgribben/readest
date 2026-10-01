// Chapter-level bridge between ebook reading progress and audiobook listening
// position for a Continuum pairing. Used when opening either side from the
// library — not the live TTS read-along path, which needs section DOM.

import { CFI, type TOCItem } from '@/libs/document';
import {
  collectAudiobookTextChapters,
  type AudiobookTextChapter,
} from '@/services/audiobook/mapping';
import type { PairedAudiobook } from '@/types/book';

export interface MappedChapterClip {
  ebookChapterId: string;
  label: string;
  cfi?: string;
  clipBegin: number;
  clipEnd: number;
  audioChapterId: string;
}

export interface EbookProgressInput {
  location?: string;
  /** 1-based `[current, total]` page numbers from BookConfig.progress. */
  progress?: [number, number];
}

export interface EbookSyncTarget {
  ebookChapterId: string;
  label: string;
  cfi?: string;
  /** 0–1 fraction along mapped chapter order, for goToFraction fallback. */
  fraction: number;
  clipBegin: number;
  clipEnd: number;
}

/** Minimum |Δseconds| before the sync prompt is worth showing. */
export const pairedAudioDiffThresholdSec = (durationSec: number): number =>
  Math.max(30, durationSec * 0.01);

/** Equivalent ~1% jump on the ebook side when comparing fractions. */
export const PAIRED_EBOOK_FRACTION_DIFF_THRESHOLD = 0.01;

const mappedAudioSpans = (
  association: PairedAudiobook,
): Map<string, { start: number; end: number }> => {
  const mapped = new Set(association.mappings.map((mapping) => mapping.audioChapterId));
  const spans = new Map<string, { start: number; end: number }>();
  const ownerByFile = new Map<string, { start: number; end: number }>();
  for (const chapter of association.chapters) {
    if (mapped.has(chapter.id)) {
      const span = { start: chapter.start, end: chapter.end };
      spans.set(chapter.id, span);
      ownerByFile.set(chapter.fileId, span);
      continue;
    }
    const owner = ownerByFile.get(chapter.fileId);
    if (owner) owner.end = Math.max(owner.end, chapter.end);
  }
  return spans;
};

/**
 * Mapped ebook TOC chapters with the audio clip each owns, in reading order.
 * Same equal-slice rules as live paired narration when several TOC entries
 * share one audio chapter.
 */
export const buildMappedChapterClips = (
  association: PairedAudiobook,
  ebookChapters: AudiobookTextChapter[],
): MappedChapterClip[] => {
  if (!association.mappings.length || ebookChapters.length === 0) return [];

  const chapterById = new Map(association.chapters.map((chapter) => [chapter.id, chapter]));
  const spans = mappedAudioSpans(association);
  const mappingByEbook = new Map(
    association.mappings.map((mapping) => [mapping.ebookChapterId, mapping.audioChapterId]),
  );

  const candidates: {
    chapter: AudiobookTextChapter;
    audioChapterId: string;
    orderIndex: number;
  }[] = [];

  for (const [orderIndex, chapter] of ebookChapters.entries()) {
    const audioChapterId = mappingByEbook.get(chapter.href);
    if (!audioChapterId || !chapterById.has(audioChapterId) || !spans.has(audioChapterId)) {
      continue;
    }
    candidates.push({ chapter, audioChapterId, orderIndex });
  }

  const clips: MappedChapterClip[] = [];
  for (let index = 0; index < candidates.length; ) {
    const first = candidates[index]!;
    let end = index + 1;
    while (
      end < candidates.length &&
      candidates[end]!.audioChapterId === first.audioChapterId &&
      candidates[end]!.orderIndex === candidates[end - 1]!.orderIndex + 1
    ) {
      end += 1;
    }

    const run = candidates.slice(index, end);
    const span = spans.get(first.audioChapterId)!;
    const duration = span.end - span.start;
    for (const [runIndex, candidate] of run.entries()) {
      const clipBegin = span.start + (duration * runIndex) / run.length;
      const clipEnd = span.start + (duration * (runIndex + 1)) / run.length;
      clips.push({
        ebookChapterId: candidate.chapter.href,
        label: candidate.chapter.label,
        ...(candidate.chapter.cfi ? { cfi: candidate.chapter.cfi } : {}),
        clipBegin,
        clipEnd,
        audioChapterId: candidate.audioChapterId,
      });
    }
    index = end;
  }
  return clips;
};

export const ebookChaptersFromToc = (toc: TOCItem[] | undefined): AudiobookTextChapter[] =>
  collectAudiobookTextChapters(toc ?? []);

const clipIndexForPageProgress = (
  clips: MappedChapterClip[],
  progress: [number, number],
): number => {
  const [current, total] = progress;
  if (!(total > 0) || clips.length === 0) return 0;
  const fraction = Math.min(1, Math.max(0, current / total));
  if (fraction >= 1) return clips.length - 1;
  return Math.min(clips.length - 1, Math.floor(fraction * clips.length));
};

const clipForLocation = (
  clips: MappedChapterClip[],
  location: string,
): MappedChapterClip | null => {
  let best: MappedChapterClip | null = null;
  for (const clip of clips) {
    if (!clip.cfi) continue;
    try {
      if (CFI.compare(clip.cfi, location) <= 0) best = clip;
    } catch {
      // Malformed CFIs are skipped; page-fraction fallback handles the rest.
    }
  }
  return best;
};

/** Map saved ebook progress to a global audiobook timeline position. */
export const ebookProgressToAudioSeconds = (
  association: PairedAudiobook,
  ebookChapters: AudiobookTextChapter[],
  ebook: EbookProgressInput,
): number | null => {
  const clips = buildMappedChapterClips(association, ebookChapters);
  if (clips.length === 0) return null;

  if (ebook.location) {
    const byCfi = clipForLocation(clips, ebook.location);
    if (byCfi) return byCfi.clipBegin;
  }
  if (ebook.progress) {
    return clips[clipIndexForPageProgress(clips, ebook.progress)]!.clipBegin;
  }
  return null;
};

/** Map a global audiobook position to the paired ebook chapter to open. */
export const audioSecondsToEbookTarget = (
  association: PairedAudiobook,
  ebookChapters: AudiobookTextChapter[],
  seconds: number,
): EbookSyncTarget | null => {
  const clips = buildMappedChapterClips(association, ebookChapters);
  if (clips.length === 0) return null;

  const clamped = Math.max(0, seconds);
  let index = 0;
  for (const [i, clip] of clips.entries()) {
    if (clip.clipBegin <= clamped) index = i;
    if (clip.clipBegin <= clamped && clamped < clip.clipEnd) {
      index = i;
      break;
    }
  }
  const clip = clips[index]!;
  const fraction = clips.length <= 1 ? 0 : index / (clips.length - 1);
  return {
    ebookChapterId: clip.ebookChapterId,
    label: clip.label,
    ...(clip.cfi ? { cfi: clip.cfi } : {}),
    fraction,
    clipBegin: clip.clipBegin,
    clipEnd: clip.clipEnd,
  };
};

export const audioDurationFromAssociation = (association: PairedAudiobook): number => {
  if (association.chapters.length === 0) {
    return association.files.reduce((sum, file) => sum + (file.duration || 0), 0);
  }
  return Math.max(...association.chapters.map((chapter) => chapter.end), 0);
};

export const formatAudioClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
};

export const formatAudioPositionPreview = (
  seconds: number,
  durationSec: number,
  label?: string,
): string => {
  const clock = formatAudioClock(seconds);
  const pct =
    durationSec > 0 ? ((Math.min(seconds, durationSec) / durationSec) * 100).toFixed(2) : '0.00';
  const trimmed = label?.trim();
  return trimmed ? `${trimmed} (${clock}, ${pct}%)` : `${clock} (${pct}%)`;
};

export const formatEbookChapterPreview = (label: string | undefined, fraction: number): string => {
  const pct = (Math.min(1, Math.max(0, fraction)) * 100).toFixed(2);
  const trimmed = label?.trim();
  return trimmed ? `${trimmed} (${pct}%)` : `${pct}%`;
};

export interface PairedProgressPromptDecision {
  shouldPrompt: boolean;
  /** Absolute difference in audio seconds between the two sides. */
  deltaSec: number;
}

/**
 * Whether to offer a sync choice: peer is fresher and the mapped positions
 * differ by more than the chapter-level threshold.
 */
export const decidePairedProgressPrompt = (input: {
  localUpdatedAt: number;
  peerUpdatedAt: number;
  localAudioSeconds: number;
  peerAudioSeconds: number;
  durationSec: number;
  /** BookOrbit server position ahead of the library stub with a stale stamp. */
  peerIsServerFresher?: boolean;
}): PairedProgressPromptDecision => {
  const deltaSec = Math.abs(input.localAudioSeconds - input.peerAudioSeconds);
  const threshold = pairedAudioDiffThresholdSec(input.durationSec);
  const peerNewer = !!input.peerIsServerFresher || input.peerUpdatedAt > input.localUpdatedAt;
  return {
    shouldPrompt: peerNewer && deltaSec > threshold,
    deltaSec,
  };
};
