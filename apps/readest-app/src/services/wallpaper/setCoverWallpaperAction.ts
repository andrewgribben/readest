import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { TranslationFunc } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { applyCoverWallpaper } from './coverWallpaper';

/** The "Set Cover as Wallpaper" action: apply, then say how it went. */
export const setCoverWallpaperWithToast = async (
  appService: AppService,
  book: Book,
  _: TranslationFunc,
): Promise<void> => {
  const outcome = await applyCoverWallpaper(appService, book);
  if (outcome === 'set') {
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Wallpaper set') });
  } else if (outcome === 'no-cover') {
    eventDispatcher.dispatch('toast', { type: 'warning', message: _('This book has no cover') });
  } else {
    eventDispatcher.dispatch('toast', { type: 'error', message: _('Failed to set wallpaper') });
  }
};
