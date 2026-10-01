// High-level helpers that wire lookup + chapter mapping into the prompt the
// player and reader show when paired ebook/audio positions diverge.

import { DocumentLoader } from '@/libs/document';
import type { AudiobookTextChapter } from '@/services/audiobook/mapping';
import type { Book, BookConfig, PairedAudiobook } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import {
  audioDurationFromAssociation,
  audioSecondsToEbookTarget,
  decidePairedProgressPrompt,
  ebookChaptersFromToc,
  ebookProgressToAudioSeconds,
  formatAudioPositionPreview,
  formatEbookChapterPreview,
  type EbookSyncTarget,
} from './pairedProgressMap';
import { fetchBookOrbitPlaybackSeconds } from './pairedProgressBookOrbit';
import {
  findPairedAudiobookStub,
  findPairedEbook,
  resolvePairedAudiobookPosition,
  type LoadBookConfigFn,
  type PairedEbookMatch,
} from './pairedProgressLookup';

export interface PairedSyncOffer {
  localPreview: string;
  peerPreview: string;
  peerAudioSeconds: number;
  localAudioSeconds: number;
  ebookTarget?: EbookSyncTarget;
  association: PairedAudiobook;
  ebook: Book;
  ebookConfig: BookConfig;
  audiobookStub: Book | null;
}

/** Load flattened TOC chapters for an ebook already on disk. */
export const loadEbookTextChapters = async (
  appService: Pick<AppService, 'loadBookContent' | 'resolveNativeBookFilePath'>,
  book: Book,
): Promise<AudiobookTextChapter[]> => {
  const [content, nativeFilePath] = await Promise.all([
    appService.loadBookContent(book),
    appService.resolveNativeBookFilePath(book),
  ]);
  const bookDoc = (
    await new DocumentLoader(content.file, {
      nativeFilePath: nativeFilePath ?? undefined,
    }).open()
  ).book;
  try {
    return ebookChaptersFromToc(bookDoc.toc);
  } finally {
    bookDoc.destroy?.();
  }
};

/**
 * When opening an audiobook: offer to seek to the paired ebook's latest read
 * position when that read is newer and maps far enough away.
 */
export const evaluateAudiobookOpenSync = async (input: {
  library: Book[];
  audiobook: Book;
  /** Resolved player start position (includes BookOrbit server preference). */
  startAtSec: number;
  loadBookConfig: LoadBookConfigFn;
  settings: SystemSettings;
  appService: Pick<AppService, 'loadBookContent' | 'resolveNativeBookFilePath'>;
  /** Optional preloaded chapters (tests). */
  ebookChapters?: AudiobookTextChapter[];
}): Promise<PairedSyncOffer | null> => {
  const match: PairedEbookMatch | null = await findPairedEbook(
    input.library,
    input.audiobook,
    input.loadBookConfig,
    input.settings,
  );
  if (!match) return null;

  const chapters =
    input.ebookChapters ?? (await loadEbookTextChapters(input.appService, match.ebook));
  const peerAudioSeconds = ebookProgressToAudioSeconds(match.association, chapters, {
    location: match.config.location,
    progress: match.config.progress,
  });
  if (peerAudioSeconds === null) return null;

  const durationSec =
    input.audiobook.progress?.[1] && input.audiobook.progress[1] > 0
      ? input.audiobook.progress[1]
      : audioDurationFromAssociation(match.association);

  const decision = decidePairedProgressPrompt({
    localUpdatedAt: input.audiobook.updatedAt ?? 0,
    peerUpdatedAt: match.config.updatedAt ?? 0,
    localAudioSeconds: input.startAtSec,
    peerAudioSeconds,
    durationSec,
  });
  if (!decision.shouldPrompt) return null;

  const ebookTarget = audioSecondsToEbookTarget(match.association, chapters, peerAudioSeconds);
  const localTarget = audioSecondsToEbookTarget(match.association, chapters, input.startAtSec);

  return {
    localPreview: formatAudioPositionPreview(input.startAtSec, durationSec, localTarget?.label),
    peerPreview: formatEbookChapterPreview(
      ebookTarget?.label,
      ebookTarget?.fraction ?? (durationSec > 0 ? peerAudioSeconds / durationSec : 0),
    ),
    peerAudioSeconds,
    localAudioSeconds: input.startAtSec,
    ebookTarget: ebookTarget ?? undefined,
    association: match.association,
    ebook: match.ebook,
    ebookConfig: match.config,
    audiobookStub: input.audiobook,
  };
};

/**
 * When opening an ebook: offer to jump to the chapter matching the paired
 * audiobook's latest listen when that listen is newer.
 */
export const evaluateEbookOpenSync = async (input: {
  library: Book[];
  ebook: Book;
  config: BookConfig;
  ebookChapters: AudiobookTextChapter[];
  /** Current ebook position as audio seconds (from location/progress). */
  localAudioSeconds: number | null;
}): Promise<PairedSyncOffer | null> => {
  const association = input.config.audiobook;
  if (!association?.mappings.length) return null;

  const stub = findPairedAudiobookStub(input.library, association);
  const resolved = await resolvePairedAudiobookPosition(
    stub,
    association,
    fetchBookOrbitPlaybackSeconds,
  );
  if (!resolved) return null;

  const localAudioSeconds =
    input.localAudioSeconds ??
    ebookProgressToAudioSeconds(association, input.ebookChapters, {
      location: input.config.location,
      progress: input.config.progress,
    });
  if (localAudioSeconds === null) return null;

  const durationSec =
    stub?.progress?.[1] && stub.progress[1] > 0
      ? stub.progress[1]
      : audioDurationFromAssociation(association);

  const decision = decidePairedProgressPrompt({
    localUpdatedAt: input.config.updatedAt ?? 0,
    peerUpdatedAt: resolved.updatedAt,
    localAudioSeconds,
    peerAudioSeconds: resolved.seconds,
    durationSec,
    peerIsServerFresher: resolved.serverFresher,
  });
  if (!decision.shouldPrompt) return null;

  const ebookTarget = audioSecondsToEbookTarget(association, input.ebookChapters, resolved.seconds);
  if (!ebookTarget) return null;

  const localTarget = audioSecondsToEbookTarget(
    association,
    input.ebookChapters,
    localAudioSeconds,
  );

  return {
    localPreview: formatEbookChapterPreview(
      localTarget?.label,
      localTarget?.fraction ?? (durationSec > 0 ? localAudioSeconds / durationSec : 0),
    ),
    peerPreview: formatAudioPositionPreview(resolved.seconds, durationSec, ebookTarget.label),
    peerAudioSeconds: resolved.seconds,
    localAudioSeconds,
    ebookTarget,
    association,
    ebook: input.ebook,
    ebookConfig: input.config,
    audiobookStub: stub,
  };
};
