// The days on offer (the next 7 that still have a time), "Sun" over "25 Oct"; a dot shows where picks already are:
// green where you both can, red where only you, grey where only they.

import { dayParts } from './scheduler-flow';

interface Props {
  days: readonly string[];
  current: string;
  mine: ReadonlySet<string>;
  theirs: ReadonlySet<string>;
  /** The day each picked time falls on in the reader's zone. */
  dayOf: ReadonlyMap<string, string>;
  onSelect: (dayKey: string) => void;
}

export default function SchedulerDayStrip({ days, current, mine, theirs, dayOf, onSelect }: Props) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Day">
      {days.map(dayKey => {
        const onDay = (k: string) => dayOf.get(k) === dayKey;
        const both = [...mine].some(k => onDay(k) && theirs.has(k));
        const iHave = [...mine].some(onDay);
        const theyHave = [...theirs].some(onDay);
        const active = dayKey === current;
        const { weekday, date } = dayParts(dayKey);
        return (
          <button
            key={dayKey}
            type="button"
            role="tab"
            aria-selected={active}
            data-day={dayKey}
            onClick={() => onSelect(dayKey)}
            className={`flex min-h-[44px] min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg border px-2 text-xs font-medium transition-colors ${
              active ? 'border-[#1a1a2e] bg-[#1a1a2e] text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            <span>{weekday}</span>
            <span className={`text-[11px] ${active ? 'text-gray-200' : 'text-gray-500'}`}>{date}</span>
            {(both || iHave || theyHave) && (
              <span
                aria-hidden
                className={`mt-0.5 h-1.5 w-1.5 rounded-full ${both ? 'bg-emerald-400' : iHave ? 'bg-rsn-red' : 'bg-gray-400'}`}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
