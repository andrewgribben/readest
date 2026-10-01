import clsx from 'clsx';
import React from 'react';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { SectionTitle } from '@/components/settings/primitives';

export type PairedProgressSyncDirection = 'audiobook' | 'ebook';

export interface PairedProgressSyncDetails {
  direction: PairedProgressSyncDirection;
  localPreview: string;
  peerPreview: string;
}

interface PairedProgressSyncResolverProps {
  details: PairedProgressSyncDetails | null;
  onKeepLocal: () => void;
  onApplyPeer: () => void;
  onClose: () => void;
}

const PairedProgressSyncResolver: React.FC<PairedProgressSyncResolverProps> = ({
  details,
  onKeepLocal,
  onApplyPeer,
  onClose,
}) => {
  const _ = useTranslation();

  if (!details) return null;

  const isAudiobook = details.direction === 'audiobook';
  const localLabel = isAudiobook ? _('Continue listening') : _('Continue reading');
  const peerLabel = isAudiobook ? _('Sync to latest read') : _('Sync to latest listen');
  const message = isAudiobook
    ? _("Listening progress differs from the paired ebook's latest read position.")
    : _("Reading progress differs from the paired audiobook's latest listen position.");

  return (
    <Dialog isOpen={true} onClose={onClose} title={_('Sync Position')}>
      <p className='text-base-content/70 mb-5 mt-1 px-1 text-center text-sm leading-relaxed'>
        {message}
      </p>
      <div className='flex flex-col gap-2.5'>
        <button
          type='button'
          onClick={onKeepLocal}
          className={clsx(
            'eink-bordered group',
            'flex w-full items-start gap-3 rounded-xl text-left',
            'border-base-200 bg-base-100 border px-4 py-3.5',
            'transition-colors duration-150',
            'hover:border-base-300 hover:bg-base-200/60',
            'active:bg-base-200/80',
            'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
          )}
        >
          <div className='flex min-w-0 flex-1 flex-col gap-1'>
            <SectionTitle as='span' className='text-base-content/55! ps-0!'>
              {localLabel}
            </SectionTitle>
            <span className='line-clamp-2 text-sm font-medium leading-snug'>
              {details.localPreview}
            </span>
          </div>
        </button>
        <button
          type='button'
          onClick={onApplyPeer}
          className={clsx(
            'btn btn-primary group',
            'h-auto min-h-0 w-full justify-start gap-3',
            'rounded-xl border-0 px-4 py-3.5 text-left font-normal normal-case',
            'focus-visible:ring-primary/40 focus-visible:outline-hidden focus-visible:ring-2',
          )}
        >
          <div className='flex min-w-0 flex-1 flex-col items-start gap-1'>
            <SectionTitle as='span' className='ps-0! text-current! opacity-75'>
              {peerLabel}
            </SectionTitle>
            <span className='line-clamp-2 text-sm font-medium leading-snug'>
              {details.peerPreview}
            </span>
          </div>
        </button>
      </div>
    </Dialog>
  );
};

export default PairedProgressSyncResolver;
