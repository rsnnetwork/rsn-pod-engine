// client/src/features/reason/entities/EntityCard.tsx
// One entity in a list (the v4 prototype's company card, without the reasons we do not have yet): the letter mark,
// the name, its kind and place, how many people are around it, and your role when you are one of them. The whole card
// is one link, so a phone has one big target and a keyboard one stop.
import { Link } from 'react-router-dom';
import type { EntitySummary } from '@rsn/shared';
import EntityMark from './EntityMark';
import { entityMeta, peopleCount, roleLabel } from './entity-text';

export default function EntityCard({ entity }: { entity: EntitySummary }) {
  return (
    <Link
      to={`/entities/${entity.id}`}
      data-entity-id={entity.id}
      className="flex min-w-0 flex-col rounded-[18px] border border-reason-line bg-white p-3.5 shadow-[0_7px_28px_rgba(16,18,24,.025)] transition hover:shadow-[0_14px_38px_rgba(16,18,24,.065)] min-[721px]:rounded-[21px] min-[721px]:p-[18px]"
    >
      <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-3 min-[721px]:grid-cols-[56px_minmax(0,1fr)]">
        <EntityMark name={entity.name} size="card" />
        <div className="min-w-0">
          <h3 className="text-[17px] font-bold leading-tight tracking-[-0.02em] [overflow-wrap:anywhere] min-[721px]:text-[19px]">{entity.name}</h3>
          <p className="mt-1 text-[12px] text-reason-muted [overflow-wrap:anywhere]">{entityMeta(entity)}</p>
        </div>
      </div>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#f0f1f3] pt-3">
        <span className="text-[12px] text-[#4c5462]">{peopleCount(entity.peopleCount)}</span>
        {entity.myRole && (
          <span className="rounded-full bg-reason-pink px-2.5 py-1 text-[11px] font-extrabold text-reason-red-hover">
            <span className="sr-only">Your role: </span>{roleLabel(entity.myRole)}
          </span>
        )}
      </div>
    </Link>
  );
}
