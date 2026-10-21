// client/src/features/reason/entities/OtherEntities.tsx
// The search box, then the entities the member is not linked to: those with the search in their name, or the most
// recently active when there is no search (or only one character of one, which the server does not search).
import { Search } from 'lucide-react';
import { ENTITY_LIMITS, type EntitySummary } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/Spinner';
import EntityCard from './EntityCard';
import { tidyName } from './entity-text';
import { PANEL, QUIET_BUTTON } from './look';
import { CARD_GRID } from './YourEntities';

interface Props {
  typed: string;
  onType: (text: string) => void;
  /** What the list was asked for: a search of 2 characters or more, or '' for the recent list. */
  term: string;
  /** null while the first answer is on its way. */
  others: EntitySummary[] | null;
  mine: EntitySummary[];
  /** The list on screen is for an earlier search while the new one is on its way. */
  stale: boolean;
  onCreate: (name: string) => void;
}

export default function OtherEntities({ typed, onType, term, others, mine, stale, onCreate }: Props) {
  const oneCharacter = tidyName(typed).length === 1;
  const needle = term.toLowerCase();
  const onlyMine = term !== '' && mine.some((e) => e.name.toLowerCase().includes(needle));

  return (
    <section aria-labelledby="other-entities-title" className={PANEL}>
      <div className="grid gap-3 min-[721px]:grid-cols-[minmax(0,1fr)_minmax(260px,400px)] min-[721px]:items-end">
        <div className="min-w-0">
          <h2 id="other-entities-title" className="text-[18px] font-bold leading-[1.12] tracking-[-0.025em] min-[721px]:text-[22px]">Other entities</h2>
          <p className="mt-1 text-[12px] text-reason-muted [overflow-wrap:anywhere] min-[721px]:text-[13px]">
            {term ? `Names with “${term}” in them.` : 'The most recently active first. Search to find one by name.'}
          </p>
        </div>
        <div className="relative min-w-0">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#303641]" />
          <input
            type="search"
            value={typed}
            onChange={(e) => onType(e.target.value)}
            maxLength={ENTITY_LIMITS.searchMax}
            aria-label="Search entities"
            placeholder="Search entities by name…"
            enterKeyHint="search"
            className="h-11 w-full rounded-xl border border-transparent bg-[#f4f5f7] pl-10 pr-3 text-[16px] outline-none transition placeholder:text-[#646a77] focus:border-[#cfd2d8] focus:bg-white focus:shadow-[0_0_0_4px_rgba(222,50,46,.06)] min-[721px]:text-[15px]"
          />
        </div>
      </div>
      {oneCharacter && <p className="mt-2 text-[12px] text-[#646a77]">Type at least 2 characters to search.</p>}

      <div className="mt-3.5">
        {/* An empty answer for the last search is not one for this search: wait for this one before saying "none". */}
        {others === null || (stale && others.length === 0) ? (
          <div className={CARD_GRID} aria-busy="true">
            <span className="sr-only" role="status">Loading entities</span>
            {[0, 1].map((i) => <Skeleton key={i} className="h-[118px]" />)}
          </div>
        ) : others.length === 0 ? (
          <div className="rounded-2xl bg-reason-soft p-3.5 [overflow-wrap:anywhere]">
            {term === '' ? (
              <>
                <h3 className="text-[15px] font-bold">No other entities yet.</h3>
                <p className="mt-1 text-[13px] text-[#646a77]">When people add their companies and organisations, they show here.</p>
              </>
            ) : onlyMine ? (
              <h3 className="text-[15px] font-bold">Only your own entities have “{term}” in their name.</h3>
            ) : (
              <>
                <h3 className="text-[15px] font-bold">No entity has “{term}” in its name yet.</h3>
                <p className="mt-1 text-[13px] text-[#646a77]">If it is yours, add it, and the people around it can find it.</p>
                <button type="button" onClick={() => onCreate(term)} className={cn(QUIET_BUTTON, 'mt-3 max-w-full [overflow-wrap:anywhere]')}>Create “{term}”</button>
              </>
            )}
          </div>
        ) : (
          <div className={cn(CARD_GRID, stale && 'opacity-60 transition-opacity')} aria-busy={stale || undefined}>
            {others.map((e) => <EntityCard key={e.id} entity={e} />)}
          </div>
        )}
      </div>
    </section>
  );
}
