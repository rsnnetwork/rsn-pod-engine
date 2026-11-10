// The board's toolbar (spec 06): "Auto generate | Edit | Lock | Publish". Auto generate fills every round that has
// not started with the matching rules (locked meetings and seats stay). Edit turns editing on and off (off, a tap on
// someone shows their meetings and nothing can be moved by accident). Lock locks every meeting of the round on screen
// (Unlock when they all are). Publish opens the preview and the versions. Four words, 44px each; a 2 x 2 grid on a
// phone, a row with dividers from 640px.
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BOARD_COPY } from './board-model';

interface Props {
  canGenerate: boolean;
  editing: boolean;
  /** 'lock' when some meeting of the round is unlocked, 'unlock' when all are, null when there is nothing to lock. */
  lockAction: 'lock' | 'unlock' | null;
  busy: boolean;
  onGenerate: () => void;
  onToggleEdit: () => void;
  onToggleLock: () => void;
  onPublish: () => void;
}

const ITEM = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[#dfe5e8] bg-white px-3 text-[14px] font-semibold text-[#3d4a55] transition-colors hover:text-[#12293a] disabled:opacity-50 sm:rounded-none sm:border-0 sm:bg-transparent sm:px-3.5';

export default function BoardToolbar({ canGenerate, editing, lockAction, busy, onGenerate, onToggleEdit, onToggleLock, onPublish }: Props) {
  return (
    <div role="toolbar" aria-label="Board actions" className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-0 sm:divide-x sm:divide-[#c9d1d6]">
      <button type="button" className={ITEM} onClick={onGenerate} disabled={!canGenerate || busy}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {BOARD_COPY.autoGenerate}
      </button>
      <button
        type="button"
        className={cn(ITEM, editing && 'text-[#1d6b5c] underline decoration-2 underline-offset-4')}
        aria-pressed={editing}
        onClick={onToggleEdit}
      >
        {BOARD_COPY.edit}
      </button>
      <button type="button" className={ITEM} onClick={onToggleLock} disabled={lockAction === null || busy}>
        {lockAction === 'unlock' ? BOARD_COPY.unlock : BOARD_COPY.lock}
      </button>
      <button type="button" className={cn(ITEM, 'text-[#1d6b5c]')} onClick={onPublish}>
        {BOARD_COPY.publish}
      </button>
    </div>
  );
}
