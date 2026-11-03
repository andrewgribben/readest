import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import {
  followCurrentBookWallpaper,
  noteCoverWallpaperBook,
} from '@/services/wallpaper/coverWallpaper';

/**
 * "Follow current book" for the cover wallpaper (Android). Remembers the book
 * this route has open and applies its cover when the app goes to the
 * background, so the system recolour from a new wallpaper never lands while
 * reading. Mounted on the library, reader and player routes.
 */
export function useCoverWallpaperFollow(openBookHash?: string) {
  const { appService, envConfig } = useEnv();
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);

  useEffect(() => {
    noteCoverWallpaperBook(openBookHash);
  }, [openBookHash]);

  useEffect(() => {
    if (!appService?.isAndroidApp || !libraryLoaded) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void followCurrentBookWallpaper(appService, envConfig);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [appService, envConfig, libraryLoaded]);
}
