import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';

const setCoverWallpaper = vi.fn();
vi.mock('@/utils/bridge', () => ({
  setCoverWallpaper: (...a: unknown[]) => setCoverWallpaper(...a),
}));
const saveSysSettings = vi.fn(async (_env: unknown, key: string, value: unknown) => {
  const { useSettingsStore } = await import('@/store/settingsStore');
  const { settings } = useSettingsStore.getState();
  useSettingsStore.setState({ settings: { ...settings, [key]: value } });
});
vi.mock('@/helpers/settings', () => ({
  saveSysSettings: (...a: [unknown, string, unknown]) => saveSysSettings(...a),
}));

import {
  applyCoverWallpaper,
  currentWallpaperBook,
  followCurrentBookWallpaper,
  noteCoverWallpaperBook,
} from '@/services/wallpaper/coverWallpaper';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { SystemSettings } from '@/types/settings';

const book = (hash: string, updatedAt: number): Book =>
  ({
    hash,
    format: 'EPUB',
    title: hash,
    author: '',
    createdAt: 0,
    updatedAt,
    progress: [1, 10],
    readingStatus: 'reading',
  }) as Book;

const appService = (hasCover = true) =>
  ({
    isAndroidApp: true,
    exists: vi.fn(async () => hasCover),
    resolveFilePath: vi.fn(async () => '/data/Books'),
  }) as unknown as AppService;

const env = {} as never;

const setSettings = (extra: Partial<SystemSettings>) =>
  useSettingsStore.setState({ settings: { ...extra } as SystemSettings });

describe('cover wallpaper', () => {
  beforeEach(() => {
    setCoverWallpaper.mockReset().mockResolvedValue({ home: true, lock: true });
    saveSysSettings.mockClear();
    useLibraryStore.setState({ library: [book('old', 1), book('new', 2)] });
    setSettings({ coverWallpaperFollow: true });
  });

  it('sends the cover file with both screens', async () => {
    expect(await applyCoverWallpaper(appService(), book('a', 1))).toBe('set');
    expect(setCoverWallpaper).toHaveBeenCalledWith({
      coverPath: expect.stringMatching(/a[\\/]cover\.png$/),
      home: true,
      lock: true,
    });
  });

  it('reports a missing cover without calling native', async () => {
    expect(await applyCoverWallpaper(appService(false), book('a', 1))).toBe('no-cover');
    expect(setCoverWallpaper).not.toHaveBeenCalled();
  });

  it('prefers the book just opened over the shelf order', () => {
    const library = useLibraryStore.getState().library;
    noteCoverWallpaperBook('old');
    expect(currentWallpaperBook(library)?.hash).toBe('old');
  });

  it('follows a change of book once, then leaves the wallpaper alone', async () => {
    noteCoverWallpaperBook('new');
    await followCurrentBookWallpaper(appService(), env);
    expect(setCoverWallpaper).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings.coverWallpaperFollowedHash).toBe('new');

    await followCurrentBookWallpaper(appService(), env);
    expect(setCoverWallpaper).toHaveBeenCalledTimes(1);
  });

  it('does nothing while following is off', async () => {
    setSettings({ coverWallpaperFollow: false });
    noteCoverWallpaperBook('new');
    await followCurrentBookWallpaper(appService(), env);
    expect(setCoverWallpaper).not.toHaveBeenCalled();
  });

  it('retries next time when native fails', async () => {
    setCoverWallpaper.mockResolvedValue({ home: false, lock: false, error: 'nope' });
    noteCoverWallpaperBook('new');
    await followCurrentBookWallpaper(appService(), env);
    expect(useSettingsStore.getState().settings.coverWallpaperFollowedHash).toBeUndefined();
  });
});
