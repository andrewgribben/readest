import { useCallback, useEffect, useRef, useState } from 'react';
import type { PairedProgressSyncDetails } from '@/components/PairedProgressSyncResolver';
import {
  ebookChaptersFromToc,
  ebookProgressToAudioSeconds,
} from '@/services/audiobook/pairedProgressMap';
import {
  evaluateEbookOpenSync,
  type PairedSyncOffer,
} from '@/services/audiobook/pairedProgressSync';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';

/**
 * When opening a paired ebook, offer to jump to the chapter matching the
 * audiobook's latest listen — the reverse of the player-side sync prompt.
 *
 * Waits until KOSync / BookOrbit reading-progress conflicts are settled so
 * dialogs do not stack.
 */
export const usePairedAudiobookProgressSync = (
  bookKey: string,
  options: { readingProgressConflict: boolean },
) => {
  const progress = useBookProgress(bookKey);
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getConfig = useBookDataStore((s) => s.getConfig);
  const getView = useReaderStore((s) => s.getView);

  const [syncDetails, setSyncDetails] = useState<PairedProgressSyncDetails | null>(null);
  const offerRef = useRef<PairedSyncOffer | null>(null);
  const evalRef = useRef<{ bookKey: string; promise: Promise<PairedSyncOffer | null> } | null>(
    null,
  );

  useEffect(() => {
    evalRef.current = null;
    offerRef.current = null;
    setSyncDetails(null);
  }, [bookKey]);

  useEffect(() => {
    if (options.readingProgressConflict) return;
    if (!progress?.location) return;

    const bookData = getBookData(bookKey);
    const config = getConfig(bookKey);
    const book = bookData?.book;
    const bookDoc = bookData?.bookDoc;
    if (!book || !config?.audiobook?.mappings.length || !bookDoc) return;
    if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;

    if (evalRef.current?.bookKey !== bookKey) {
      const association = config.audiobook;
      const chapters = ebookChaptersFromToc(bookDoc.toc);
      const location = progress.location ?? config.location;
      const pageProgress = config.progress;
      evalRef.current = {
        bookKey,
        promise: (async (): Promise<PairedSyncOffer | null> => {
          try {
            const localAudioSeconds = ebookProgressToAudioSeconds(association, chapters, {
              location,
              progress: pageProgress,
            });
            return await evaluateEbookOpenSync({
              library: useLibraryStore.getState().library,
              ebook: book,
              config,
              ebookChapters: chapters,
              localAudioSeconds,
            });
          } catch (error) {
            console.warn('[PairedProgress] ebook open sync check failed:', error);
            return null;
          }
        })(),
      };
    }

    let cancelled = false;
    void evalRef.current.promise.then((offer) => {
      if (cancelled || !offer) return;
      offerRef.current = offer;
      setSyncDetails({
        direction: 'ebook',
        localPreview: offer.localPreview,
        peerPreview: offer.peerPreview,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [bookKey, progress, options.readingProgressConflict, getBookData, getConfig]);

  const resolveKeepLocal = useCallback(() => {
    offerRef.current = null;
    setSyncDetails(null);
  }, []);

  const resolveApplyPeer = useCallback(() => {
    const offer = offerRef.current;
    const view = getView(bookKey);
    offerRef.current = null;
    setSyncDetails(null);
    if (!offer?.ebookTarget || !view) return;
    if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;

    const { cfi, fraction } = offer.ebookTarget;
    if (cfi) {
      try {
        view.goTo(cfi);
        return;
      } catch (error) {
        console.warn('[PairedProgress] goTo(cfi) failed, falling back to fraction:', error);
      }
    }
    view.goToFraction(fraction);
  }, [bookKey, getView]);

  return {
    syncDetails,
    resolveKeepLocal,
    resolveApplyPeer,
  };
};
