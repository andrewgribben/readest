import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePairedAudiobookProgressSync } from '@/app/reader/hooks/usePairedAudiobookProgressSync';

const mocks = vi.hoisted(() => ({
  progress: { location: 'chapter-one' },
  evaluate: vi.fn(),
  goTo: vi.fn(),
  goToFraction: vi.fn(),
  setState: vi.fn(),
  getBookData: () => ({ book: { hash: 'ebook' }, bookDoc: { toc: [] } }),
  getConfig: () => ({ audiobook: { mappings: [{}] } }),
}));

vi.mock('@/store/readerProgressStore', () => ({ useBookProgress: () => mocks.progress }));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: Object.assign((select: (state: typeof mocks) => unknown) => select(mocks), {
    setState: mocks.setState,
  }),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ library: [] }) },
}));
vi.mock('@/store/readerStore', () => {
  const state = {
    getView: () => ({ goTo: mocks.goTo, goToFraction: mocks.goToFraction }),
    getViewState: () => ({}),
  };
  return {
    useReaderStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/services/audiobook/pairedProgressMap', () => ({
  ebookChaptersFromToc: () => [],
  ebookProgressToAudioSeconds: () => 10,
}));
vi.mock('@/services/audiobook/pairedProgressSync', () => ({
  evaluateEbookOpenSync: mocks.evaluate,
}));

describe('paired audiobook prompt while reading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.progress = { location: 'chapter-one' };
    mocks.evaluate.mockResolvedValue({
      localPreview: 'Chapter one',
      peerPreview: 'Chapter two',
      peerAudioSeconds: 12.345,
      ebookTarget: { cfi: 'chapter-two', fraction: 0.5 },
    });
  });
  afterEach(cleanup);

  it.each([
    'keep',
    'apply',
  ] as const)('does not reopen after choosing %s and turning pages', async (choice) => {
    const { result, rerender } = renderHook(() =>
      usePairedAudiobookProgressSync('ebook', { readingProgressConflict: false }),
    );
    await waitFor(() => expect(result.current.syncDetails).not.toBeNull());
    act(() => {
      if (choice === 'apply') result.current.resolveApplyPeer();
      else result.current.resolveKeepLocal();
    });
    expect(result.current.syncDetails).toBeNull();
    if (choice === 'apply') {
      expect(mocks.goTo).toHaveBeenCalledWith('chapter-two');
      const update = mocks.setState.mock.calls[0]![0];
      const next = update({ booksData: { ebook: { id: 'ebook' } } });
      expect(next.booksData.ebook.pairedAudiobookResumePosition).toBe(12.345);
    } else {
      expect(mocks.setState).not.toHaveBeenCalled();
    }

    for (const location of ['chapter-three', 'chapter-four']) {
      mocks.progress = { location };
      await act(async () => rerender());
      expect(result.current.syncDetails).toBeNull();
    }
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });

  it('offers sync again when a different book opens', async () => {
    const { result, rerender } = renderHook(
      ({ bookKey }) => usePairedAudiobookProgressSync(bookKey, { readingProgressConflict: false }),
      { initialProps: { bookKey: 'ebook' } },
    );
    await waitFor(() => expect(result.current.syncDetails).not.toBeNull());
    act(() => result.current.resolveKeepLocal());
    rerender({ bookKey: 'another-ebook' });
    await waitFor(() => expect(result.current.syncDetails).not.toBeNull());
    expect(mocks.evaluate).toHaveBeenCalledTimes(2);
  });
});
