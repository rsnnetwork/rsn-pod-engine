// client/src/features/reason/entities/EntityRows.tsx
// A person's entities as rows: the letter mark, the name, the role and the title, each opening the entity. The Human
// Profile ("Entities & roles") and Your profile draw them alike. 30 Oct review (T15): the logo when it has one, and on
// your own profile a claim that waits says "Waiting for approval". A circle's Organisations draw the same rows with
// the entity's kind in place of a role, and a control of their own beside each (Unlink, for the people who run it).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PersonEntity } from '@rsn/shared';
import { cn } from '@/lib/utils';
import EntityMark from './EntityMark';
import { WAITING_FOR_APPROVAL, kindLabel, roleLine } from './entity-text';

/** One row: a person's link to an entity (role and title), or an entity on its own (its kind). */
export type EntityRowItem = Pick<PersonEntity, 'id' | 'name' | 'kind' | 'logoUrl' | 'status'> & Partial<Pick<PersonEntity, 'role' | 'title'>>;

interface Props {
  entities: EntityRowItem[];
  /** Extra classes for each link (the Human Profile keeps a focused link clear of its fixed header and bar). */
  linkClassName?: string;
  /** A control beside a row's link, never inside it. */
  trailing?: (e: EntityRowItem) => ReactNode;
}

export default function EntityRows({ entities, linkClassName, trailing }: Props) {
  return (
    <ul className="grid gap-1.5">
      {entities.map((e) => (
        <li key={e.id} data-entity-row={e.id} className={cn(trailing && 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5')}>
          <Link
            to={`/entities/${e.id}`}
            className={cn('grid min-h-[44px] grid-cols-[38px_minmax(0,1fr)] items-center gap-2.5 rounded-[14px] border border-reason-line px-2.5 py-2 hover:bg-[#f6f5f3]', linkClassName)}
          >
            <EntityMark name={e.name} size="row" logoUrl={e.logoUrl} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <b className="block text-[13px]">{e.name}</b>
              <span className="block text-[12px] text-[#646a77]">
                {e.role ? roleLine(e.role, e.title) : kindLabel(e.kind)}
                {e.status === 'pending' && <span className="font-bold text-[#555d69]"> · {WAITING_FOR_APPROVAL}</span>}
              </span>
            </span>
          </Link>
          {trailing?.(e)}
        </li>
      ))}
    </ul>
  );
}
