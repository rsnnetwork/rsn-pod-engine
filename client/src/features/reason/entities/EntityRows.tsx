// client/src/features/reason/entities/EntityRows.tsx
// A person's entities as rows: the letter mark, the name, the role and the title, each opening the entity. The Human
// Profile ("Entities & roles") and Your profile draw them alike.
import { Link } from 'react-router-dom';
import type { PersonEntity } from '@rsn/shared';
import { cn } from '@/lib/utils';
import EntityMark from './EntityMark';
import { roleLine } from './entity-text';

interface Props {
  entities: PersonEntity[];
  /** Extra classes for each link (the Human Profile keeps a focused link clear of its fixed header and bar). */
  linkClassName?: string;
}

export default function EntityRows({ entities, linkClassName }: Props) {
  return (
    <ul className="grid gap-1.5">
      {entities.map((e) => (
        <li key={e.id}>
          <Link
            to={`/entities/${e.id}`}
            className={cn('grid min-h-[44px] grid-cols-[38px_minmax(0,1fr)] items-center gap-2.5 rounded-[14px] border border-reason-line px-2.5 py-2 hover:bg-[#f6f5f3]', linkClassName)}
          >
            <EntityMark name={e.name} size="row" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <b className="block text-[13px]">{e.name}</b>
              <span className="block text-[12px] text-[#646a77]">{roleLine(e.role, e.title)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
