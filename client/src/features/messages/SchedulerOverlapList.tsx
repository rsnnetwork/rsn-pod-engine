// The confirm step at the top of the scheduler, where a laptop-height window always shows it: the times both people
// have saved (with a meeting standing, the times it can be moved to), and the confirm card for the one picked.

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { slotLabel } from './scheduler-flow';

const PREVIEW = 8;

interface Props {
  /** A meeting stands: these are the times it can move to. */
  standing: boolean;
  times: readonly string[];
  /** The time whose card is open (its chip is not repeated under it). */
  open: string | null;
  showAll: boolean;
  onShowAll: () => void;
  onPick: (slot: string) => void;
  busy: boolean;
  zone: string;
  /** The confirm card, when one is open. */
  card: ReactNode;
}

export default function SchedulerOverlapList({ standing, times, open, showAll, onShowAll, onPick, busy, zone, card }: Props) {
  const shown = showAll ? times : times.slice(0, PREVIEW);
  return (
    <div className="space-y-1.5" data-testid="overlap-list">
      <p className="text-[11px] font-medium text-emerald-700">
        {standing ? 'Move it to another time you both can:' : 'You both can — pick one to confirm:'}
      </p>
      {card}
      <div className="flex flex-wrap gap-1.5">
        {shown.filter(w => w !== open).map(w => (
          <button
            key={w}
            type="button"
            onClick={() => onPick(w)}
            disabled={busy}
            aria-label={`Confirm ${slotLabel(w, zone)}`}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-sm font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
          >
            <Check className="h-4 w-4" />
            {slotLabel(w, zone)}
          </button>
        ))}
        {!showAll && times.length > PREVIEW && (
          <button
            type="button"
            onClick={onShowAll}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
          >
            +{times.length - PREVIEW} more
          </button>
        )}
      </div>
    </div>
  );
}
