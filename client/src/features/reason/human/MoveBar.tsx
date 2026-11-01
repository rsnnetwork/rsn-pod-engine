// client/src/features/reason/human/MoveBar.tsx
// The bar that stays at the bottom of the profile: one useful move, then Save and Remove.
//
// 30 Oct 2026 (Stefan): "The 'X' button is unclear ... it looks like 'close the bar'." The side buttons
// now say what they do, in words: Save / Saved and Remove / Undo remove. Remove only takes the person
// off the member's For You; it is not "Decline", which stays the word for turning a request down. When
// the person has asked to meet the member, the bar offers that request's own Accept and Decline. The
// profile draws no bar at all once the two are connected or have met (HumanProfilePage).
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, X } from 'lucide-react';
import { primaryActionFor, type PersonBrief } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { useRequestAnswer } from '@/features/messages/useRequestAnswer';
import { BUSY } from './busy';
import { NEXT_MOVE, PRIMARY_LABEL, STATE_LABEL } from './labels';

const SIDE_BUTTON = 'flex min-h-[48px] min-w-[48px] items-center justify-center gap-1 rounded-[11px] border border-reason-line bg-white px-3 text-[13px] font-bold';
const PRIMARY = 'min-h-[48px] rounded-[11px] px-5 text-[14px] font-bold';
const RED = 'bg-reason-red text-white shadow-[0_7px_18px_rgba(222,50,46,.18)] enabled:hover:bg-reason-red-hover';

interface Props {
  brief: PersonBrief;
  busy: boolean;
  onPrimary: () => void;
  onToggleSave: () => void;
  onToggleRemove: () => void;
}

/** Accept and Decline for the request this person sent the member, the same answer the bell and Messages give. */
function IncomingAnswer({ pokeId }: { pokeId: string }) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const { answer, busy, answering } = useRequestAnswer(pokeId, {
    onAccepted: (result) => {
      addToast('Connected — say hello', 'success');
      if (result.conversationId) navigate(`/messages/${result.conversationId}`);
    },
  });
  // aria-disabled, not disabled, while an answer is on its way, so the keyboard focus stays on the button.
  const press = (choice: 'accept' | 'decline') => () => { if (!busy) answer(choice); };
  return (
    <>
      <button type="button" onClick={press('accept')} aria-disabled={busy || undefined} className={cn(PRIMARY, RED, 'flex items-center justify-center gap-1.5', busy && BUSY)}>
        {answering === 'accept' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />} Accept
      </button>
      <button type="button" onClick={press('decline')} aria-disabled={busy || undefined} className={cn(SIDE_BUTTON, busy && BUSY)}>
        {answering === 'decline' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />} Decline
      </button>
    </>
  );
}

export default function MoveBar({ brief, busy, onPrimary, onToggleSave, onToggleRemove }: Props) {
  const r = brief.relationship;
  const action = primaryActionFor(r.state);
  const inert = action === 'requested' || action === 'declined';
  const answering = r.state === 'incoming' && !!r.pokeId;
  // While a press is on its way the buttons say so (aria-disabled), show the busy look and ignore presses.
  // They are not `disabled`: a disabled button drops the keyboard focus that is on it. The same goes for Request
  // sent and Request declined: the Meet sheet gives focus back to the button that opened it, and by then that
  // button has become one of them. Save and Remove carry no pressed state either: their names already flip
  // ("Save" / "Remove from saved", "Remove from For You" / "Put back in For You"), and both would be read.
  const press = (fn: () => void) => () => { if (!busy) fn(); };
  return (
    <div
      role="region"
      aria-label="Your move"
      aria-busy={busy || undefined}
      className="fixed inset-x-0 bottom-0 z-[96] border-t border-reason-line bg-white/95 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur-lg"
    >
      <div className="mx-auto flex w-full items-center justify-between gap-3.5 px-[11px] pt-[9px] pb-[calc(9px+env(safe-area-inset-bottom))] md:w-[min(1240px,calc(100%-44px))] md:px-0 md:pt-3 md:pb-[calc(12px+env(safe-area-inset-bottom))]">
        <div className="hidden min-w-0 md:block">
          <b className="block text-[13px]">{STATE_LABEL[r.state]}</b>
          <span className="text-[11px] text-[#646a77]">{r.passed ? 'You removed this person from your For You.' : NEXT_MOVE[r.state]}</span>
        </div>
        <div className="grid w-full grid-cols-[1fr_auto_auto] gap-2 md:flex md:w-auto">
          {answering ? <IncomingAnswer pokeId={r.pokeId as string} /> : (
            <button
              type="button"
              onClick={press(onPrimary)}
              aria-disabled={busy || inert || undefined}
              className={cn(PRIMARY, inert ? 'bg-[#f5f6f7] text-[#646a77] cursor-default' : RED, busy && !inert && BUSY)}
            >
              {PRIMARY_LABEL[action]}
            </button>
          )}
          <button
            type="button"
            onClick={press(onToggleSave)}
            aria-disabled={busy || undefined}
            aria-label={r.saved ? 'Remove from saved' : 'Save'}
            className={cn(SIDE_BUTTON, busy && BUSY)}
          >
            <span aria-hidden="true">{r.saved ? '★' : '☆'}</span>{r.saved ? 'Saved' : 'Save'}
          </button>
          {/* While a request from them waits, Decline is the answer to it, so Remove steps aside. */}
          {!answering && (
            <button
              type="button"
              onClick={press(onToggleRemove)}
              aria-disabled={busy || undefined}
              aria-label={r.passed ? 'Put back in For You' : 'Remove from For You'}
              className={cn(SIDE_BUTTON, busy && BUSY)}
            >
              {r.passed ? 'Undo remove' : 'Remove'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
