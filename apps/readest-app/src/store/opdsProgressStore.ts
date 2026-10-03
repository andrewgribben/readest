import { create } from 'zustand';
import type { ProgressPayload } from '@/utils/transfer';

export interface OPDSCatalogProgress {
  mode: 'auto-download' | 'update-library';
  phase: 'discovering' | 'processing';
  total: number;
  completed: number;
  failed: number;
  checked: number;
  toCheck: number;
  active: Array<{ id: string; title: string; percent: number | null }>;
}

interface OPDSProgressState {
  catalogs: Record<string, OPDSCatalogProgress | undefined>;
  begin: (id: string, mode: OPDSCatalogProgress['mode']) => boolean;
  patch: (id: string, patch: Partial<OPDSCatalogProgress>) => void;
  fileProgress: (
    id: string,
    fileId: string,
    title: string,
    progress: Pick<ProgressPayload, 'progress' | 'total'>,
  ) => void;
  completeFile: (id: string, fileId: string, failed: boolean) => void;
  finish: (id: string) => void;
}

// Transient display state: never persisted or synced to another device.
export const useOPDSProgressStore = create<OPDSProgressState>((set, get) => ({
  catalogs: {},
  begin: (id, mode) => {
    if (get().catalogs[id]) return false;
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [id]: {
          mode,
          phase: 'discovering',
          total: 0,
          completed: 0,
          failed: 0,
          checked: 0,
          toCheck: 0,
          active: [],
        },
      },
    }));
    return true;
  },
  patch: (id, patch) =>
    set((state) => {
      const current = state.catalogs[id];
      return current ? { catalogs: { ...state.catalogs, [id]: { ...current, ...patch } } } : state;
    }),
  fileProgress: (id, fileId, title, progress) => {
    const current = get().catalogs[id];
    if (!current) return;
    const value = progress.total > 0 ? (progress.progress / progress.total) * 100 : Number.NaN;
    const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : null;
    const next = { id: fileId, title, percent };
    const active = current.active.some((file) => file.id === fileId)
      ? current.active.map((file) => (file.id === fileId ? next : file))
      : [...current.active, next];
    get().patch(id, { active });
  },
  completeFile: (id, fileId, failed) => {
    const current = get().catalogs[id];
    if (!current) return;
    get().patch(id, {
      active: current.active.filter((file) => file.id !== fileId),
      completed: current.completed + (failed ? 0 : 1),
      failed: current.failed + (failed ? 1 : 0),
    });
  },
  finish: (id) =>
    set((state) => {
      const catalogs = { ...state.catalogs };
      delete catalogs[id];
      return { catalogs };
    }),
}));
