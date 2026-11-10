// One attendee's meetings across every round (spec 07: "review all assignments for that attendee"), and the
// organiser's late and no-show marks (spec 07 "Missing participants", 12/10): marking someone late empties their
// unlocked seats before the round they arrive for and seats the rest again; a locked meeting keeps the gap and shows it.
import { useId, useState } from 'react';
import { Clock, UserX, Undo2 } from 'lucide-react';
import type { BoardOp, BoardPerson, ScheduleBoard } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, groupLabels, startsAtLabel, timelineLine, timelineOf } from './board-model';

interface Props {
  board: ScheduleBoard;
  person: BoardPerson;
  busy: boolean;
  /** Editing is on (the toolbar's Edit): with it off, the marks are not offered. */
  canEdit: boolean;
  onRun: (op: BoardOp, success: string) => void;
  onClose: () => void;
}

const ACTION = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-bold disabled:opacity-50';

export default function PersonTimeline({ board, person, busy, canEdit, onRun, onClose }: Props) {
  const selectId = useId();
  const rounds = board.rounds.filter((r) => !r.beyondLastRound);
  // Only rounds that have not started can be the one they arrive for (the server refuses the rest).
  const lateChoices = rounds.filter((r) => r.editable).map((r) => r.roundNumber).filter((n) => n >= 2);
  const [arrives, setArrives] = useState<number>(lateChoices[0] ?? 2);
  const entries = timelineOf(board, person.userId);
  const current = board.people.find((p) => p.userId === person.userId) ?? person;
  const groups = groupLabels(board, current.groupKeys);
  const editable = canEdit && rounds.some((r) => r.editable);
  const name = current.displayName;

  return (
    <Sheet open onClose={onClose} title={`${name}'s meetings`}>
      <p className="text-[14px] text-[#5a6670]">
        {[groups.join(', '), STATUS_LABEL[current.status]].filter(Boolean).join(' · ')}
      </p>
      <ol className="mt-3 flex flex-col gap-2" data-testid="person-timeline">
        {entries.map((e) => (
          <li key={e.round} className="rounded-xl border border-[#e3e7ea] bg-white px-3 py-2">
            <p className="text-[12px] font-extrabold uppercase tracking-[0.1em] text-[#7a858e]">
              Round {e.round}{startsAtLabel(e.startsAt) ? ` · ${startsAtLabel(e.startsAt)}` : ''}{e.editable ? '' : ' · started'}
            </p>
            <p className={cn('mt-0.5 text-[15px] [overflow-wrap:anywhere]', e.place.kind === 'room' ? 'text-[#12293a]' : 'text-[#c4532f]')}>
              {timelineLine(e)}
            </p>
          </li>
        ))}
      </ol>

      {editable && (
        <div className="mt-4 rounded-xl bg-[#f1f4f5] p-3">
          <h3 className="text-[13px] font-bold text-[#12293a]">Late or not coming</h3>
          {current.status === 'absent' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => { onClose(); onRun({ kind: 'clear_absence', userId: person.userId }, `${name} is back in the basket for every round.`); }}
              className={cn(ACTION, 'mt-2 w-full bg-white text-[#12293a] sm:w-auto')}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" /> Clear late or not coming
            </button>
          ) : (
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
              {lateChoices.length > 0 && (
                <>
                  <label htmlFor={selectId} className="sr-only">Arrives for round</label>
                  <select
                    id={selectId}
                    value={arrives}
                    onChange={(e) => setArrives(Number(e.target.value))}
                    className="min-h-[44px] rounded-xl border border-[#cfd6db] bg-white px-3 text-[16px] sm:text-[14px]"
                  >
                    {lateChoices.map((n) => <option key={n} value={n}>Arrives for round {n}</option>)}
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { onClose(); onRun({ kind: 'mark_late', userId: person.userId, fromRound: arrives }, `${name} is marked late. Their earlier seats were filled again.`); }}
                    className={cn(ACTION, 'bg-[#12293a] text-white')}
                  >
                    <Clock className="h-4 w-4" aria-hidden="true" /> Mark late
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => { onClose(); onRun({ kind: 'mark_no_show', userId: person.userId }, `${name} is marked as not coming.`); }}
                className={cn(ACTION, 'border border-[#cfd6db] bg-white text-[#12293a]')}
              >
                <UserX className="h-4 w-4" aria-hidden="true" /> Mark as not coming
              </button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
