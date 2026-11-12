// client/src/features/reason/entities/EntityServices.tsx
// "Services" on an entity's page (Shirley pilot S7, RSN 15: "Put services on Entity, not on Person"): what the
// organisation offers, from the controlled list, each with its short description and website. Only here: no person's
// profile lists them. Its admins (and platform admins) see "Edit services", and an empty list asks them to add some;
// anyone else sees nothing when there are none. The list is the page's own (entity:<id>), so a save shows everywhere
// the page is open without a reload. Every word is React text; a website is drawn only through websiteLink (http or
// https, never javascript:).
import type { EntityPage } from '@rsn/shared';
import { serviceLabel } from './entity-services-form';
import { websiteLink } from './entity-text';
import { QUIET_BUTTON } from './look';

interface Props { page: EntityPage; onEdit: () => void }

export default function EntityServices({ page, onEdit }: Props) {
  const services = page.services ?? [];
  if (services.length === 0 && !page.canEdit) return null;
  return (
    <section aria-labelledby="entity-services-title" data-testid="entity-services" className="mt-[11px] min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:mt-[18px] md:rounded-[24px] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="entity-services-title" className="text-[22px] font-bold tracking-[-0.035em] md:text-[24px]">Services</h2>
          <p className="mt-1 text-[13px] text-reason-muted [overflow-wrap:anywhere]">What {page.entity.name} offers.</p>
        </div>
        {page.canEdit && (
          <button type="button" onClick={onEdit} data-testid="entity-services-edit" className={QUIET_BUTTON}>
            {services.length === 0 ? 'Add services' : 'Edit services'}
          </button>
        )}
      </div>
      {services.length === 0 ? (
        <p className="mt-3.5 rounded-2xl bg-reason-soft p-3.5 text-[13px] text-[#646a77]">
          Add the services this organisation offers, so members know what it can help with.
        </p>
      ) : (
        <ul className="mt-3.5 grid grid-cols-1 gap-2 min-[721px]:grid-cols-2">
          {services.map((s) => {
            const site = websiteLink(s.website);
            return (
              <li key={s.category} data-service={s.category} className="min-w-0 rounded-[14px] border border-reason-line px-3.5 py-3">
                <b className="block text-[14px]">{serviceLabel(s.category)}</b>
                {s.description && <p className="mt-1 whitespace-pre-line text-[13px] text-[#4d5562] [overflow-wrap:anywhere]">{s.description}</p>}
                {site && (
                  <a href={site.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="mt-1 inline-flex min-h-[44px] max-w-full items-center text-[13px] font-bold text-reason-ink underline decoration-reason-line underline-offset-4 [overflow-wrap:anywhere]">
                    <span className="min-w-0">{site.text}<span aria-hidden="true">&nbsp;↗</span></span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
