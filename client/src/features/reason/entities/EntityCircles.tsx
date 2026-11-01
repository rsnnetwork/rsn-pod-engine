// client/src/features/reason/entities/EntityCircles.tsx
// "Circles" on an entity's page (30 Oct review, 7.3: "An entity should be linkable to one or more Circles"): the
// circles its people's communities have linked it to, each opening the circle. A closed circle the viewer is outside
// is named only (L22): no count, and its page shows its public face. The links are made from the circle's page by
// the people who run it; the list is the page's own (entity:<id>), so a link or an unlink shows without a reload.
import { Link } from 'react-router-dom';
import type { EntityPage } from '@rsn/shared';
import { circleCountLine } from './entity-text';

export default function EntityCircles({ page }: { page: EntityPage }) {
  const circles = page.circles ?? [];
  return (
    <section aria-labelledby="entity-circles-title" data-testid="entity-circles" className="mt-[11px] min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:mt-[18px] md:rounded-[24px] md:p-6">
      <h2 id="entity-circles-title" className="text-[22px] font-bold tracking-[-0.035em] md:text-[24px]">Circles</h2>
      <p className="mt-1 text-[13px] text-reason-muted">The communities {page.entity.name} is part of on REASON.</p>
      {circles.length === 0 ? (
        <p className="mt-3.5 rounded-2xl bg-reason-soft p-3.5 text-[13px] text-[#646a77]">Not linked to a circle yet. The people who run a circle can link it from the circle&apos;s page.</p>
      ) : (
        <ul className="mt-3.5 grid grid-cols-1 gap-2 min-[721px]:grid-cols-2 min-[1200px]:grid-cols-3">
          {circles.map((c) => (
            <li key={c.id} data-circle-id={c.id} className="min-w-0">
              <Link to={`/circles/${c.id}`} className="grid min-h-[44px] grid-cols-[minmax(0,1fr)_44px] items-center gap-2.5 rounded-[14px] border border-reason-line px-3 py-2 hover:bg-[#f6f5f3]">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <b className="block text-[14px]">{c.name}</b>
                  <span className="block text-[12px] text-[#646a77]">{circleCountLine(c)}</span>
                </span>
                <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-full border border-reason-line text-[15px]">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
