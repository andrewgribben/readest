import { create } from 'zustand';

export interface AudioPositionChoice {
  id: number;
  bookHash: string;
  listening: number;
  reading: number;
}
export type AudioPositionSelection = 'listening' | 'reading' | null;
let nextId = 0;
let resolvePending: ((selection: AudioPositionSelection) => void) | undefined;
export const useAudioPositionChoiceStore = create<{
  pending: AudioPositionChoice | null;
  request: (choice: Omit<AudioPositionChoice, 'id'>) => Promise<AudioPositionSelection>;
  resolve: (id: number, selection: AudioPositionSelection) => void;
}>((set, get) => ({
  pending: null,
  request: (choice) => {
    resolvePending?.(null);
    const id = ++nextId;
    return new Promise((resolve) => {
      resolvePending = resolve;
      set({ pending: { ...choice, id } });
    });
  },
  resolve: (id, selection) => {
    if (get().pending?.id !== id) return;
    const resolve = resolvePending;
    resolvePending = undefined;
    set({ pending: null });
    resolve?.(selection);
  },
}));
