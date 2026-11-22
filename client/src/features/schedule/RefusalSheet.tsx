// A move or swap the room checker refused (spec 07: "show the reason and clear alternatives rather than forcing a
// hidden reassignment"). The server's sentence, the rooms the person could join instead, the basket, and, for a group
// rule only and only for the event's owner or a super admin, seating them anyway with a reason that is recorded.
import { useState } from 'react';
import { Inbox, MoveRight, ShieldAlert } from 'lucide-react';
import { BOARD_BASKET_ROOM, type BoardOp, type ScheduleBoard } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { nameIn, peopleOf, roomOfPerson, roundOf } from './board-model';
import type { PendingRefusal } from './useBoard';

interface Props {
  board: ScheduleBoard;
  refusal: PendingRefusal;
  onChoose: (op: BoardOp) => void;
  onClose: () => void;
}

const ROW = 'flex min-h-[48px] w-full items-center gap-3 rounded-xl border border-[#e3e7ea] bg-white px-3 py-2 text-left text-[15px] font-semibold text-[#12293a] hover:bg-[#f1f4f5]';

export default function RefusalSheet({ board, refusal, onChoose, onClose }: Props) {
  const [reason, setReason] = useState('');
  const op = refusal.op;
  const round = 'round' in op ? op.round : null;
  const mover = 'userId' in op ? op.userId : null;
  const name = mover ? nameIn(peopleOf(board), mover) : 'them';
  const seated = round !== null && mover ? !!roomOfPerson(roundOf(board, round), mover) : false;

  const choose = (room: number) => {
    onClose();
    if (round === null || !mover) return;
    if (room !== BOARD_BASKET_ROOM) onChoose({ kind: 'move', round, userId: mover, toRoom: room });
    else if (seated) onChoose({ kind: 'unassign', round, userId: mover });
  };

  return (
    <Sheet open onClose={onClose} title="That move doesn't fit">
      <p data-testid="board-refusal-message" className="text-[14px] leading-relaxed text-[#454b55] [overflow-wrap:anywhere]">{refusal.message}</p>
      {refusal.alternatives.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#7a858e]">Where {name} could go instead</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {refusal.alternatives.map((alt) => (
              <li key={alt.room}>
                <button type="button" className={ROW} onClick={() => choose(alt.room)}>
                  {alt.room === BOARD_BASKET_ROOM
                    ? <Inbox className="h-4 w-4 shrink-0 text-[#c4532f]" aria-hidden="true" />
                    : <MoveRight className="h-4 w-4 shrink-0 text-[#1d6b5c]" aria-hidden="true" />}
                  <span className="min-w-0 [overflow-wrap:anywhere]">{alt.note}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {refusal.overridable && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-[13px] text-amber-900">As the event's owner you can seat them anyway. The board records who did it and why.</p>
          <label htmlFor="board-override-reason" className="mt-2 block text-[13px] font-semibold text-amber-900">Reason (optional)</label>
          <input
            id="board-override-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-xl border border-amber-200 bg-white px-3 text-[16px] sm:text-[14px]"
          />
          <button
            type="button"
            className="mt-2 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-amber-700 px-4 text-[14px] font-bold text-white sm:w-auto"
            onClick={() => { onClose(); onChoose({ ...op, override: true, ...(reason.trim() ? { reason: reason.trim() } : {}) }); }}
          >
            <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Seat them anyway
          </button>
        </div>
      )}
    </Sheet>
  );
}
