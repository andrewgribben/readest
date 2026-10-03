import type { AudiobookProgressHooks } from './AudiobookController';
import type { AppService } from '@/types/system';
import type { Book, PairedAudiobook } from '@/types/book';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { findABSServerById } from '@/store/absServerStore';
import { createAbsClient } from '@/services/audiobookshelf/createClient';
import { AbsProgressSyncer, writeLocalLastPlayedAt } from '@/services/audiobookshelf/progressSync';
import { createBookOrbitClient } from '@/services/bookorbit/createClient';
import { makeBookOrbitAudioFilePath } from '@/services/bookorbit/audiobookId';
import { manifestTracks, manifestAssetIds } from '@/services/bookorbit/manifest';
import { bookOrbitProgressHooks } from '@/services/bookorbit/progressSync';
import { makeAbsFilePath } from '@/utils/audiobook';
import { md5 } from '@/utils/md5';
import { makeAudiobookProgressSaver } from './progressPersistence';

/** Resolve the same library identity used by the standalone provider opener. */
export const pairedAudiobookEntry = (association: PairedAudiobook, create = true): Book | null => {
  const source = association.source;
  const path =
    source?.kind === 'audiobookshelf'
      ? makeAbsFilePath(source.serverId, source.itemId)
      : source?.kind === 'bookorbit'
        ? makeBookOrbitAudioFilePath(source.bookId)
        : null;
  const { library, setLibrary } = useLibraryStore.getState();
  const existing = library.find(
    (book) =>
      !book.deletedAt &&
      (path
        ? book.filePath === path
        : association.files.some((file) => file.path === book.filePath)),
  );
  if (existing || !path || !create) return existing ?? null;
  const now = Date.now();
  const entry: Book = {
    hash: md5(path),
    filePath: path,
    format: source?.kind === 'audiobookshelf' ? 'ABS' : 'BOOKORBIT',
    title: association.title ?? '',
    author: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    duration: association.files.reduce((sum, file) => sum + file.duration, 0),
  };
  setLibrary([...library, entry]);
  return entry;
};

/** No provider read can select or overwrite the paired player's starting position. */
export const createPairedProgressHooks = (
  appService: AppService,
  bookKey: string,
  association: PairedAudiobook,
): AudiobookProgressHooks & { onStart: (position: number) => void } => {
  const duration = association.files.reduce((sum, file) => sum + file.duration, 0);
  let entry: Book | null | undefined;
  let saveLibrary: ReturnType<typeof makeAudiobookProgressSaver> | undefined;
  let lastPersistAt = 0;
  let remote: Promise<AudiobookProgressHooks | null> | undefined;
  const save = (position: number, force: boolean, capturedAt: number) => {
    entry ??= pairedAudiobookEntry(association);
    if (entry) {
      saveLibrary ??= makeAudiobookProgressSaver(
        appService,
        entry.hash,
        duration,
        association.source?.kind === 'audiobookshelf' ? 10_000 : 15_000,
        association.source?.kind === 'audiobookshelf'
          ? (time) => writeLocalLastPlayedAt(entry!.hash, time)
          : undefined,
      );
      saveLibrary(position, force, capturedAt);
    }
    const store = useBookDataStore.getState();
    const config = store.getConfig(bookKey);
    if (!config?.audiobook || config.audiobook.createdAt !== association.createdAt) return;
    const now = Date.now();
    const audiobook = {
      ...config.audiobook,
      listeningProgress: { position, duration, updatedAt: capturedAt },
    };
    store.setConfig(bookKey, { audiobook });
    if (force || now - lastPersistAt >= 15_000) {
      lastPersistAt = now;
      const book = store.getBookData(bookKey)?.book;
      if (book)
        void appService
          .saveBookConfig(book, { ...config, audiobook }, useSettingsStore.getState().settings)
          .catch(console.warn);
    }
  };
  const initialiseRemote = async (position: number): Promise<AudiobookProgressHooks | null> => {
    const source = association.source;
    if (source?.kind === 'audiobookshelf') {
      const server = findABSServerById(source.serverId);
      if (!server || !entry) return null;
      const syncer = new AbsProgressSyncer({
        client: createAbsClient(appService, server),
        itemId: source.itemId,
        bookHash: entry.hash,
        duration,
        appService,
        cacheLocally: false,
      });
      await syncer.beginReporting(position);
      return syncer.hooks();
    }
    if (source?.kind === 'bookorbit') {
      const client = createBookOrbitClient();
      if (!client) return null;
      const manifest = await client.getManifest(source.bookId);
      const state = await client.getPlaybackState(source.bookId);
      return bookOrbitProgressHooks(
        client,
        source.bookId,
        manifestTracks(manifest),
        manifestAssetIds(manifest),
        manifest.revision,
        state?.revision ?? 0,
        () => {},
      );
    }
    return null;
  };
  const report = (
    kind: 'onTick' | 'onPause' | 'onSeek' | 'onEnd',
    position: number,
    capturedAt = Date.now(),
  ) => {
    save(position, kind === 'onPause' || kind === 'onEnd', capturedAt);
    remote ??= initialiseRemote(position).catch((error) => {
      console.warn('Paired audiobook progress reporting unavailable:', error);
      remote = undefined;
      return null;
    });
    void remote.then((hooks) => hooks?.[kind]?.(position, capturedAt)).catch(console.warn);
  };
  return {
    onStart: (position) => {
      entry ??= pairedAudiobookEntry(association);
      remote ??= initialiseRemote(position).catch((error) => {
        console.warn('Paired audiobook progress reporting unavailable:', error);
        remote = undefined;
        return null;
      });
    },
    onTick: (position, capturedAt) => report('onTick', position, capturedAt),
    onPause: (position, capturedAt) => report('onPause', position, capturedAt),
    onSeek: (position, capturedAt) => report('onSeek', position, capturedAt),
    onEnd: (position, capturedAt) => report('onEnd', position, capturedAt),
  };
};
