import { beforeEach, describe, expect, it } from 'vitest';
import { useOPDSProgressStore } from '@/store/opdsProgressStore';

beforeEach(() => useOPDSProgressStore.setState({ catalogs: {} }));

describe('catalog transfer progress', () => {
  it('keeps concurrent files and catalogs separate and counts failures separately', () => {
    const progress = useOPDSProgressStore.getState();
    expect(progress.begin('one', 'auto-download')).toBe(true);
    expect(progress.begin('two', 'update-library')).toBe(true);
    expect(progress.begin('one', 'update-library')).toBe(false);
    progress.patch('one', { total: 3, phase: 'processing' });
    progress.fileProgress('one', 'a', 'First', { progress: 25, total: 100 });
    progress.fileProgress('one', 'b', 'Second', { progress: 3, total: 0 });
    expect(useOPDSProgressStore.getState().catalogs['one']?.active).toEqual([
      { id: 'a', title: 'First', percent: 25 },
      { id: 'b', title: 'Second', percent: null },
    ]);
    progress.completeFile('one', 'a', false);
    progress.completeFile('one', 'b', true);
    expect(useOPDSProgressStore.getState().catalogs['one']).toMatchObject({
      completed: 1,
      failed: 1,
      active: [],
    });
    expect(useOPDSProgressStore.getState().catalogs['two']).toMatchObject({
      completed: 0,
      failed: 0,
    });
    progress.finish('one');
    expect(useOPDSProgressStore.getState().catalogs['one']).toBeUndefined();
    expect(useOPDSProgressStore.getState().catalogs['two']).toBeDefined();
  });

  it('clamps reported percentages and ignores callbacks after completion', () => {
    const progress = useOPDSProgressStore.getState();
    progress.begin('one', 'auto-download');
    progress.fileProgress('one', 'a', 'First', { progress: 200, total: 100 });
    expect(useOPDSProgressStore.getState().catalogs['one']?.active[0]?.percent).toBe(100);
    progress.finish('one');
    progress.fileProgress('one', 'a', 'First', { progress: 50, total: 100 });
    expect(useOPDSProgressStore.getState().catalogs['one']).toBeUndefined();
  });
});
