// The selected day's times still ahead, in one scrollable frame. A green cell (a time both people saved) opens the
// confirm card for its own time; it never takes your pick away (on 25 Oct "the green" did exactly that). Any other
// cell toggles your pick; the booked time shows the meeting.
//
// No overscroll-contain here: on a small phone this timeline is taller than the whole panel frame, so a lock would
// mean a drag that starts on it never carries on into the panel, stranding the person away from the confirm step. The
// panel's own lock still keeps the gesture off the page behind it.

import type { RefObject } from 'react';
import { cellAriaLabel, cellState, cellText, dayLabel, type CellState } from './scheduler-flow';

const CELL_CLASS: Record<CellState, string> = {
  agreed: 'border-emerald-400 bg-emerald-100 text-emerald-800 hover:bg-emerald-200',
  booked: 'border-emerald-600 bg-emerald-600 text-white',
  'unsent-both': 'border-rsn-red bg-rsn-red-light text-rsn-red',
  mine: 'border-rsn-red bg-rsn-red-light text-rsn-red',
  theirs: 'border-gray-300 bg-white text-gray-700 hover:border-gray-400',
  free: 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
};

interface Props {
  gridRef: RefObject<HTMLDivElement>;
  dayKey: string;
  /** The day's times that have not started, earliest first, and the words on each. */
  slots: readonly string[];
  labels: readonly string[];
  mine: ReadonlySet<string>;
  saved: ReadonlySet<string>;
  theirs: ReadonlySet<string>;
  booked: string | null;
  flashKey: string | null;
  onPress: (state: CellState, key: string) => void;
}

export default function SchedulerSlotGrid({ gridRef, dayKey, slots, labels, mine, saved, theirs, booked, flashKey, onPress }: Props) {
  return (
    <div
      ref={gridRef}
      className="relative max-h-[300px] overflow-y-auto rounded-lg border border-gray-100 bg-white/60 p-1.5"
      data-testid="slot-grid"
      aria-label={`Times on ${dayLabel(dayKey)}, scroll for earlier or later`}
    >
      {slots.length === 0 ? (
        <p className="px-2 py-3 text-sm text-gray-600">No times are left on this day. Pick another day.</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 min-[420px]:grid-cols-4 md:grid-cols-6">
          {slots.map((key, i) => {
            const state = cellState({ key, mine, saved, theirs, booked });
            const text = cellText(state);
            return (
              <button
                key={key}
                type="button"
                data-slot={key}
                onClick={() => onPress(state, key)}
                aria-pressed={state === 'agreed' || state === 'booked' ? undefined : mine.has(key)}
                aria-label={cellAriaLabel(state, labels[i])}
                className={`flex min-h-[44px] flex-col items-center justify-center rounded-lg border px-1 leading-tight transition-colors ${
                  CELL_CLASS[state]
                } ${flashKey === key ? 'ring-2 ring-rsn-red ring-offset-1' : ''}`}
              >
                <span className="text-xs font-semibold">{labels[i]}</span>
                {text && <span className="text-[10px]">{text}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
