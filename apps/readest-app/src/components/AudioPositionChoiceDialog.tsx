'use client';
import Dialog from '@/components/Dialog';
import { useAudioPositionChoiceStore } from '@/store/audioPositionChoiceStore';
import { useTranslation } from '@/hooks/useTranslation';

const timestamp = (seconds: number) => {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
export default function AudioPositionChoiceDialog() {
  const _ = useTranslation();
  const { pending, resolve } = useAudioPositionChoiceStore();
  if (!pending) return null;
  return (
    <Dialog isOpen title={_('Choose playback position')} onClose={() => resolve(pending.id, null)}>
      <div className='flex flex-col gap-4 p-4'>
        <p>{_('Your audiobook and ebook are at different positions.')}</p>
        <button className='btn btn-contrast' onClick={() => resolve(pending.id, 'listening')}>
          {_('Resume audiobook')} · {timestamp(pending.listening)}
        </button>
        <button className='btn eink-bordered' onClick={() => resolve(pending.id, 'reading')}>
          {_('Start from ebook')} · {_('Approximately')} {timestamp(pending.reading)}
        </button>
      </div>
    </Dialog>
  );
}
