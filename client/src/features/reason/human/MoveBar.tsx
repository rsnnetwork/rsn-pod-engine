// client/src/features/reason/human/MoveBar.tsx
// The bar that stays at the bottom of the profile: one useful move, then Save and Pass.
import { primaryActionFor, type PersonBrief } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { NEXT_MOVE, PRIMARY_LABEL, STATE_LABEL } from './labels';

// A disabled button also looks unavailable, so while a Save or Pass is on its way the buttons show
// progress too (the same look as the Human Card's buttons).
const BUSY = 'cursor-progress motion-safe:animate-pulse motion-reduce:opacity-60';
const SIDE_BUTTON = 'grid min-h-[48px] min-w-[48px] place-items-center rounded-[11px] border border-reason-line bg-white text-[18px]';

interface Props {
  brief: PersonBrief;
  busy: boolean;
  onPrimary: () => void;
  onToggleSave: () => void;
  onTogglePass: () => void;
}

export default function MoveBar({ brief, busy, onPrimary, onToggleSave, onTogglePass }: Props) {
  const r = brief.relationship;
  const action = primaryActionFor(r.state);
  const inert = action === 'requested' || action === 'declined';
  return (
    <footer
      aria-busy={busy || undefined}
      className="fixed inset-x-0 bottom-0 z-[96] border-t border-reason-line bg-white/95 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur-lg"
    >
      <div className="mx-auto flex w-full items-center justify-between gap-3.5 px-[11px] pt-[9px] pb-[calc(9px+env(safe-area-inset-bottom))] md:w-[min(1240px,calc(100%-44px))] md:px-0 md:pt-3 md:pb-[calc(12px+env(safe-area-inset-bottom))]">
        <div className="hidden min-w-0 md:block">
          <b className="block text-[13px]">{STATE_LABEL[r.state]}</b>
          <span className="text-[11px] text-[#646a77]">{r.passed ? 'You passed on this person for now.' : NEXT_MOVE[r.state]}</span>
        </div>
        <div className="grid w-full grid-cols-[1fr_48px_48px] gap-2 md:flex md:w-auto">
          <button
            type="button"
            onClick={onPrimary}
            disabled={inert || busy}
            className={cn('min-h-[48px] rounded-[11px] px-5 text-[14px] font-bold',
              inert ? 'bg-[#f5f6f7] text-[#646a77]' : 'bg-reason-red text-white shadow-[0_7px_18px_rgba(222,50,46,.18)] enabled:hover:bg-reason-red-hover',
              busy && !inert && BUSY)}
          >
            {PRIMARY_LABEL[action]}
          </button>
          <button
            type="button"
            onClick={onToggleSave}
            disabled={busy}
            aria-pressed={r.saved}
            aria-label={r.saved ? 'Remove from saved' : 'Save'}
            className={cn(SIDE_BUTTON, busy && BUSY)}
          >
            {r.saved ? '★' : '☆'}
          </button>
          <button
            type="button"
            onClick={onTogglePass}
            disabled={busy}
            aria-pressed={r.passed}
            aria-label={r.passed ? 'Undo pass' : 'Pass: not relevant right now'}
            className={cn(SIDE_BUTTON, busy && BUSY)}
          >
            {r.passed ? '↺' : '×'}
          </button>
        </div>
      </div>
    </footer>
  );
}
