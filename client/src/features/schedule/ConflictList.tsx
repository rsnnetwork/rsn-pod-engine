// What needs the organiser's eye before publishing (spec 06 "Show conflicts before publishing", spec 07): rooms the
// checker refuses, locked meetings that lost someone, people who can't be in their seat, repeats and capacity gaps.
// Problems come first. Long lists fold after five.
import { useState } from 'react';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { roomTitle, type BoardConflict } from './board-model';

interface Props {
  title: string;
  conflicts: BoardConflict[];
  /** Show the round (and room) a conflict is in. */
  onShow?: (conflict: BoardConflict) => void;
  showRound?: boolean;
}

const FOLD = 5;

export default function ConflictList({ title, conflicts, onShow, showRound = false }: Props) {
  const [open, setOpen] = useState(false);
  if (conflicts.length === 0) return null;
  const problems = conflicts.filter((c) => c.tone === 'problem').length;
  const shown = open ? conflicts : conflicts.slice(0, FOLD);
  return (
    <section
      aria-label={title}
      data-testid="board-conflicts"
      className={cn('rounded-2xl border p-3', problems > 0 ? 'border-red-200 bg-red-50/60' : 'border-amber-200 bg-amber-50/60')}
    >
      <h3 className="text-[13px] font-bold text-[#12293a]">
        {title} <span className="font-normal text-[#5a6670]">({conflicts.length})</span>
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {shown.map((c, i) => (
          <li key={`${c.round}-${c.room}-${i}`} className="flex min-w-0 items-start gap-2">
            {c.tone === 'problem'
              ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-label="Problem" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-label="Warning" />}
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-[#3d4a55] [overflow-wrap:anywhere]">
              {showRound && <span className="font-semibold">Round {c.round}{c.room ? `, ${roomTitle(c.room)}` : ''}: </span>}
              {c.text}
            </p>
            {onShow && (
              <button
                type="button"
                onClick={() => onShow(c)}
                className="-my-2 inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-2 text-[13px] font-semibold text-[#1d6b5c] hover:underline"
              >
                Show
              </button>
            )}
          </li>
        ))}
      </ul>
      {conflicts.length > FOLD && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 inline-flex min-h-[44px] items-center text-[13px] font-semibold text-[#1d6b5c] hover:underline"
        >
          {open ? 'Show fewer' : `Show all ${conflicts.length}`}
        </button>
      )}
    </section>
  );
}
