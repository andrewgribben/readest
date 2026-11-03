import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REL, type OPDSPublication } from '@/types/opds';
import { PublicationView } from '@/app/opds/components/PublicationView';
import { DropdownProvider } from '@/context/DropdownContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useTransferStore } from '@/store/transferStore';
import type { Book } from '@/types/book';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/components/CachedImage', () => ({ CachedImage: () => <div /> }));

const audiobook: OPDSPublication = {
  metadata: { title: 'Skyward', author: [{ name: 'Sanderson', links: [] }] },
  links: [
    {
      rel: `${REL.ACQ}/open-access`,
      href: '/api/v1/opds/30556/download?fileId=1',
      type: 'audio/mp4',
      title: 'M4B',
    },
  ],
  images: [],
};

const stub = (extra: Partial<Book> = {}): Book =>
  ({
    hash: 'audio-hash',
    format: 'BOOKORBIT',
    filePath: 'bookorbit://30556',
    title: 'Skyward',
    author: 'Sanderson',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as Book;

const renderView = (onDownloadAudio = vi.fn()) =>
  render(
    <DropdownProvider>
      <PublicationView
        publication={audiobook}
        baseURL='https://orbit.example/api/v1/opds'
        resolveURL={(href, base) => new URL(href, base).toString()}
        onDownload={vi.fn(async () => null)}
        onPlayAudio={vi.fn()}
        onDownloadAudio={onDownloadAudio}
        getAudioBookHash={() => 'audio-hash'}
        onNavigate={vi.fn()}
        onGenerateCachedImageUrl={vi.fn(async (url: string) => url)}
      />
    </DropdownProvider>,
  );

describe('PublicationView audiobook download', () => {
  afterEach(() => {
    cleanup();
    useLibraryStore.setState({ library: [] });
    useTransferStore.setState({ transfers: {} });
  });

  it('offers Download next to Play and hands over the tracks', () => {
    const onDownloadAudio = vi.fn();
    renderView(onDownloadAudio);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownloadAudio).toHaveBeenCalledWith(
      [expect.objectContaining({ href: '/api/v1/opds/30556/download?fileId=1' })],
      'Skyward',
      'Sanderson',
    );
  });

  it('shows progress while the download runs', () => {
    renderView();
    act(() => {
      useTransferStore.getState().addTransfer('audio-hash', 'Skyward', 'download', 1);
    });
    const id = Object.keys(useTransferStore.getState().transfers)[0]!;
    act(() => {
      useTransferStore.setState((state) => ({
        transfers: {
          ...state.transfers,
          [id]: { ...state.transfers[id]!, status: 'in_progress', progress: 42 },
        },
      }));
    });
    const button = screen.getByRole('button', { name: 'Downloading 42%' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows Downloaded once the copy is on the device', () => {
    useLibraryStore.setState({ library: [stub({ opdsDownloadedAt: 1 })] });
    renderView();
    const button = screen.getByRole('button', { name: 'Downloaded' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('hides Download where offline copies are unsupported', () => {
    render(
      <DropdownProvider>
        <PublicationView
          publication={audiobook}
          baseURL='https://orbit.example/api/v1/opds'
          resolveURL={(href, base) => new URL(href, base).toString()}
          onDownload={vi.fn(async () => null)}
          onPlayAudio={vi.fn()}
          onNavigate={vi.fn()}
          onGenerateCachedImageUrl={vi.fn(async (url: string) => url)}
        />
      </DropdownProvider>,
    );
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
