// The board's view switch (round view / all rounds), its round picker, and search and filters (spec 06 "Support
// search and filtering"): by name, by group, by status, conflicts only, locked only. One column of 44px controls on a
// phone; a wrapping row from 768px.
import { Search, X } from 'lucide-react';
import type { BoardRound, EventGroup } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { NO_FILTER, STATUS_FILTERS, filterActive, type BoardFilter, type StatusFilter } from './board-model';

export type BoardView = 'round' | 'all';

interface Props {
  view: BoardView;
  onView: (view: BoardView) => void;
  rounds: BoardRound[];
  round: number;
  onRound: (round: number) => void;
  groups: EventGroup[];
  filter: BoardFilter;
  onFilter: (filter: BoardFilter) => void;
}

const SEGMENT = 'inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg px-3 text-[14px] font-semibold sm:flex-none';
const FIELD = 'min-h-[44px] w-full min-w-0 rounded-xl border border-[#cfd6db] bg-white px-3 text-[16px] text-[#12293a] sm:text-[14px] md:w-auto';
const TOGGLE = 'inline-flex min-h-[44px] items-center justify-center rounded-xl border px-3 text-[14px] font-semibold';

export default function BoardFilters({ view, onView, rounds, round, onRound, groups, filter, onFilter }: Props) {
  const set = (patch: Partial<BoardFilter>) => onFilter({ ...filter, ...patch });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div role="group" aria-label="Board view" className="flex rounded-xl bg-white p-1">
          <button type="button" aria-pressed={view === 'round'} onClick={() => onView('round')}
            className={cn(SEGMENT, view === 'round' ? 'bg-[#12293a] text-white' : 'text-[#3d4a55]')}>Round view</button>
          <button type="button" aria-pressed={view === 'all'} onClick={() => onView('all')}
            className={cn(SEGMENT, view === 'all' ? 'bg-[#12293a] text-white' : 'text-[#3d4a55]')}>All rounds</button>
        </div>
        {view === 'round' && rounds.length > 0 && (
          <nav aria-label="Rounds" className="flex flex-wrap gap-1.5">
            {rounds.map((r) => (
              <button
                key={r.roundNumber}
                type="button"
                aria-current={r.roundNumber === round ? 'true' : undefined}
                aria-label={`Round ${r.roundNumber}`}
                onClick={() => onRound(r.roundNumber)}
                className={cn(
                  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border px-3 text-[14px] font-bold',
                  r.roundNumber === round ? 'border-[#12293a] bg-[#12293a] text-white' : 'border-[#dfe5e8] bg-white text-[#3d4a55]',
                  !r.editable && r.roundNumber !== round && 'text-[#9aa3aa]',
                )}
              >
                {r.roundNumber}
              </button>
            ))}
          </nav>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <label className="relative col-span-2 md:min-w-[220px] md:flex-1">
          <span className="sr-only">Search by name</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7a858e]" aria-hidden="true" />
          <input type="search" value={filter.query} onChange={(e) => set({ query: e.target.value })} placeholder="Search by name"
            className={cn(FIELD, 'pl-9 md:w-full')} />
        </label>
        {groups.length > 0 && (
          <label className="min-w-0">
            <span className="sr-only">Group</span>
            <select value={filter.group} onChange={(e) => set({ group: e.target.value })} className={FIELD}>
              <option value="">Every group</option>
              {groups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </label>
        )}
        <label className={cn('min-w-0', groups.length === 0 && 'col-span-2')}>
          <span className="sr-only">Status</span>
          <select value={filter.status} onChange={(e) => set({ status: e.target.value as StatusFilter })} className={FIELD}>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <button type="button" aria-pressed={filter.conflictsOnly} onClick={() => set({ conflictsOnly: !filter.conflictsOnly })}
          className={cn(TOGGLE, filter.conflictsOnly ? 'border-red-300 bg-red-50 text-red-800' : 'border-[#dfe5e8] bg-white text-[#3d4a55]')}>
          Conflicts only
        </button>
        <button type="button" aria-pressed={filter.lockedOnly} onClick={() => set({ lockedOnly: !filter.lockedOnly })}
          className={cn(TOGGLE, filter.lockedOnly ? 'border-[#9fcfc4] bg-[#e3f1ee] text-[#1d6b5c]' : 'border-[#dfe5e8] bg-white text-[#3d4a55]')}>
          Locked only
        </button>
        {filterActive(filter) && (
          <button type="button" onClick={() => onFilter(NO_FILTER)} className={cn(TOGGLE, 'col-span-2 gap-1.5 border-transparent text-[#1d6b5c] md:col-span-1')}>
            <X className="h-4 w-4" aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
