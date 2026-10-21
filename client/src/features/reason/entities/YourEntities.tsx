// client/src/features/reason/entities/YourEntities.tsx
// The entities the member is linked to, each with their role, and the way to add their own company.
import type { ReactNode } from 'react';
import type { EntitySummary } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/Spinner';
import ReasonSheep from '../brand/ReasonSheep';
import EntityCard from './EntityCard';
import { PANEL, PRIMARY_BUTTON } from './look';

/** Two cards a row from 1024px; one list on phones and tablets (the brief). */
export const CARD_GRID = 'grid grid-cols-1 gap-3 min-[1024px]:grid-cols-2 min-[1024px]:gap-3.5';

interface Props {
  /** null while the first answer is on its way. */
  mine: EntitySummary[] | null;
  /** Said instead of the list when the list could not load (the page's error, with its Try again). */
  failure: ReactNode;
  onCreate: () => void;
}

export default function YourEntities({ mine, failure, onCreate }: Props) {
  return (
    <section aria-labelledby="your-entities-title" className={PANEL}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="your-entities-title" className="text-[18px] font-bold leading-[1.12] tracking-[-0.025em] min-[721px]:text-[22px]">Your entities</h2>
          <p className="mt-1 text-[12px] text-reason-muted min-[721px]:text-[13px]">The companies and organisations you are part of, with your role in each.</p>
        </div>
        <button type="button" onClick={onCreate} className={cn(PRIMARY_BUTTON, 'w-full min-[481px]:w-auto')}>Create your company</button>
      </div>
      <div className="mt-3.5">
        {failure ?? (mine === null ? (
          <div className={CARD_GRID} aria-busy="true">
            <span className="sr-only" role="status">Loading your entities</span>
            <Skeleton className="h-[118px]" />
          </div>
        ) : mine.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
            <ReasonSheep pose="curious" className="h-[52px] w-[52px] shrink-0" />
            <div className="min-w-0">
              <h3 className="text-[15px] font-bold">You are not linked to an entity yet.</h3>
              <p className="mt-1 text-[13px] text-reason-muted">Create your company, or find it below and join it with your role.</p>
            </div>
          </div>
        ) : (
          <div className={CARD_GRID}>
            {mine.map((e) => <EntityCard key={e.id} entity={e} />)}
          </div>
        ))}
      </div>
    </section>
  );
}
