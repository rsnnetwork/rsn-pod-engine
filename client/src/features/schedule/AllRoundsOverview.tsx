// The all-rounds overview (spec 06 "Board views"): every round and room in one table, with time, room, group,
// participant, status, lock and conflicts, searched and filtered with the round view's controls. The table is wider
// than a phone, so it scrolls sideways inside its own frame; the page itself never does.
import { Lock } from 'lucide-react';
import type { ScheduleBoard } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, overviewRows, peopleOf, roomTitle, rowMatches, startsAtLabel, type BoardFilter } from './board-model';

interface Props {
  board: ScheduleBoard;
  filter: BoardFilter;
  onOpenPerson: (userId: string) => void;
  onOpenRound: (round: number) => void;
  /** The event's zone: round starts are on its clock. */
  zone: string | null | undefined;
}

const TH = 'whitespace-nowrap px-3 py-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[#5a6670]';
const TD = 'px-3 py-1 align-middle';

export default function AllRoundsOverview({ board, filter, onOpenPerson, onOpenRound, zone }: Props) {
  const people = peopleOf(board);
  const all = overviewRows(board);
  const rows = all.filter((row) => rowMatches(row, people.get(row.userId), filter));

  if (all.length === 0) {
    return <p className="rounded-2xl bg-white px-4 py-6 text-center text-[14px] text-[#5a6670]">Nothing planned yet. Auto generate fills every round.</p>;
  }
  return (
    <div data-testid="board-overview-scroll" className="max-w-full overflow-x-auto rounded-2xl border border-[#e3e7ea] bg-white">
      <table className="w-full min-w-[760px] border-collapse text-left text-[14px] text-[#12293a]">
        <caption className="sr-only">Every seat and every person waiting, round by round</caption>
        <thead className="border-b border-[#e3e7ea] bg-[#f7f9fa]">
          <tr>
            <th scope="col" className={TH}>Time</th>
            <th scope="col" className={TH}>Round</th>
            <th scope="col" className={TH}>Room</th>
            <th scope="col" className={TH}>Group</th>
            <th scope="col" className={TH}>Participant</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={TH}>Lock</th>
            <th scope="col" className={TH}>Conflicts</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={8} className="px-3 py-6 text-center text-[#5a6670]">Nobody matches the filters.</td></tr>
          )}
          {rows.map((row) => (
            <tr key={row.key} data-testid="board-overview-row" className="border-b border-[#eef1f3] last:border-0">
              <td className={cn(TD, 'whitespace-nowrap text-[#5a6670]')}>{startsAtLabel(row.startsAt, zone) ?? '–'}</td>
              <td className={TD}>
                <button type="button" onClick={() => onOpenRound(row.round)} className="min-h-[44px] whitespace-nowrap font-semibold text-[#1d6b5c] hover:underline">
                  Round {row.round}
                </button>
              </td>
              <td className={cn(TD, 'whitespace-nowrap')}>{row.room === null ? <span className="text-[#c4532f]">Basket</span> : roomTitle(row.room)}</td>
              <td className={cn(TD, 'text-[#5a6670]')}>{row.groups.join(', ') || '–'}</td>
              <td className={TD}>
                <button type="button" onClick={() => onOpenPerson(row.userId)} className="min-h-[44px] text-left font-medium hover:underline">
                  {row.name}
                </button>
              </td>
              <td className={cn(TD, 'whitespace-nowrap')}>{row.room === null && (row.status === 'registered' || row.status === 'present') ? 'Waiting' : STATUS_LABEL[row.status]}</td>
              <td className={cn(TD, 'whitespace-nowrap')}>
                {row.roomLocked || row.slotLocked
                  ? <span className="inline-flex items-center gap-1 text-[#1d6b5c]"><Lock className="h-3.5 w-3.5" aria-hidden="true" />{row.roomLocked ? 'Meeting' : 'Seat'}</span>
                  : <span className="text-[#9aa3aa]">–</span>}
              </td>
              <td className={cn(TD, row.conflicts.length ? 'text-red-700' : 'text-[#9aa3aa]')}>{row.conflicts.join(', ') || '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
