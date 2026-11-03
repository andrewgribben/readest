import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { saveSysSettings } from '@/helpers/settings';
import { getCoverFilename } from '@/utils/book';
import { joinScannedPath } from '@/utils/path';
import { coalesceAsync } from '@/utils/coalesceAsync';
import { setCoverWallpaper } from '@/utils/bridge';
import { selectRecentShelfBooks } from '@/app/library/utils/libraryUtils';
import { resolveBooksDir } from '@/services/widget/bookshelfWidget';

export type CoverWallpaperOutcome = 'set' | 'no-cover' | 'failed';

/**
 * Set a book's cover as the Android wallpaper: sharp on the lock screen,
 * blurred on the home screen. The system crops it to fill each screen.
 */
export const applyCoverWallpaper = async (
  appService: AppService,
  book: Book,
): Promise<CoverWallpaperOutcome> => {
  if (!appService.isAndroidApp) return 'failed';
  const coverFile = getCoverFilename(book);
  if (!(await appService.exists(coverFile, 'Books'))) return 'no-cover';
  const coverPath = joinScannedPath(await resolveBooksDir(appService), coverFile);
  try {
    const res = await setCoverWallpaper({ coverPath, home: true, lock: true });
    if (res.home || res.lock) return 'set';
    console.warn('Cover wallpaper was not set', res.error);
  } catch (err) {
    console.warn('Failed to set cover wallpaper', err);
  }
  return 'failed';
};

// The book most recently opened in the reader or player. The library's
// recency order only catches up once progress is saved, so the open routes
// note it directly.
let openedBookHash: string | undefined;

export const noteCoverWallpaperBook = (hash: string | undefined) => {
  if (hash) openedBookHash = hash;
};

/** The book "follow current book" should show: the one just opened, else the latest on the shelf. */
export const currentWallpaperBook = (library: Book[]): Book | undefined => {
  const opened = openedBookHash
    ? library.find((book) => book.hash === openedBookHash && !book.deletedAt)
    : undefined;
  return opened ?? selectRecentShelfBooks(library, 1)[0];
};

const followCurrentBookImpl = async (
  appService: AppService,
  envConfig: EnvConfigType,
): Promise<void> => {
  if (!appService.isAndroidApp) return;
  const { settings } = useSettingsStore.getState();
  if (!settings.coverWallpaperFollow) return;
  const book = currentWallpaperBook(useLibraryStore.getState().library);
  // Only a change of book re-applies, so a cover set by hand stays until the
  // next book is opened.
  if (!book || book.hash === settings.coverWallpaperFollowedHash) return;
  const outcome = await applyCoverWallpaper(appService, book);
  // A book without a cover counts as followed too: retrying it on every
  // background would never succeed.
  if (outcome !== 'failed') {
    await saveSysSettings(envConfig, 'coverWallpaperFollowedHash', book.hash);
  }
};

/**
 * With "follow current book" on, set the current book's cover as the
 * wallpaper if it changed. Run when the app goes to the background: a new
 * wallpaper recolours the system theme, which shouldn't happen mid-read.
 */
export const followCurrentBookWallpaper = coalesceAsync(followCurrentBookImpl);
