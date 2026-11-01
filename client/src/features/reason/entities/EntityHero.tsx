// client/src/features/reason/entities/EntityHero.tsx
// The top of an entity's page (the v4 prototype's .entity-hero): the dark panel with its letter and facts, the entity
// itself (name, type, place, about, website), and your relationship to it. Up to 980px they stack, as the prototype's
// do, with the dark panel as a band (side by side at 768px they squeezed a long name into four lines); from 981px
// they share one row.
// 30 Oct review (T15, 7.1): the tile shows the logo, and its admins have T3a's pencil at the tile's bottom right
// ("Add logo" / "Change logo", the editor at 1:1) and "Remove logo" beside Edit and Archive, which asks first.
import { useState, type ReactNode } from 'react';
import type { EntityPage } from '@rsn/shared';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import PencilButton from '@/components/picture/PencilButton';
import PictureEditor from '@/components/picture/PictureEditor';
import EntityMark from './EntityMark';
import { useEntityPicture } from './useEntityPicture';
import { entityMeta, kindLabel, peopleCount, sizeText, websiteLink } from './entity-text';
import { QUIET_BUTTON } from './look';

const FACT_LABEL = 'text-[10px] font-extrabold uppercase tracking-[0.12em] text-[#bec2c9]';
const FACT = 'mt-0.5 text-[13px] font-bold text-white [overflow-wrap:anywhere]';

interface Props {
  page: EntityPage;
  /** The pink "Your relationship" panel. */
  relationship: ReactNode;
  onEdit: () => void;
  onArchive: () => void;
}

export default function EntityHero({ page, relationship, onEdit, onArchive }: Props) {
  const e = page.entity;
  const facts = [
    { label: 'Type', value: kindLabel(e.kind) },
    { label: 'Location', value: e.location },
    { label: 'Size', value: sizeText(e.size) },
    { label: 'On REASON', value: peopleCount(e.peopleCount) },
  ].filter((f): f is { label: string; value: string } => !!f.value?.trim());
  const site = websiteLink(e.website);
  const logo = useEntityPicture(e, 'logo', !!e.logoUrl);
  const [removingLogo, setRemovingLogo] = useState(false);
  const removeLogo = async () => {
    try {
      await logo.remove();
      setRemovingLogo(false);
    } catch {
      // Said in a toast by the hook; the dialog stays open to try again or cancel.
    }
  };

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-[11px] md:gap-[18px] min-[981px]:grid-cols-[200px_minmax(0,1fr)_290px] min-[1200px]:grid-cols-[230px_minmax(0,1fr)_340px]">
      <div className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] items-center gap-4 rounded-[21px] bg-[#111216] p-[17px] text-white shadow-[0_16px_50px_rgba(17,18,22,.1)] md:rounded-[26px] min-[981px]:flex min-[981px]:min-h-[360px] min-[981px]:flex-col min-[981px]:items-start min-[981px]:p-6">
        {/* The pencil sits on the tile's corner, half outside it, so it keeps 44px on the 74px phone tile. */}
        <span className="relative w-fit">
          <EntityMark name={e.name} size="hero" logoUrl={e.logoUrl} />
          {page.canEdit && (
            <PencilButton label={logo.words.edit} onClick={logo.edit} disabled={logo.busy} className="absolute -bottom-2.5 -right-2.5" />
          )}
        </span>
        <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 md:grid-cols-4 min-[981px]:mt-auto min-[981px]:grid-cols-1 min-[981px]:gap-y-2">
          {facts.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className={FACT_LABEL}>{f.label}</dt>
              <dd className={FACT}>{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <section className="flex min-w-0 flex-col rounded-[21px] border border-reason-line bg-white p-[18px] md:rounded-[26px] md:p-7">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#646a77] md:text-[11px]">The entity</p>
        <h1 className="mt-2 text-[36px] font-extrabold leading-[.98] tracking-[-0.05em] [overflow-wrap:anywhere] md:text-[44px] min-[1200px]:text-[50px]">{e.name}</h1>
        <p className="mt-3 text-[14px] text-reason-muted [overflow-wrap:anywhere]">{entityMeta(e)}</p>
        {e.about ? (
          <p className="mt-[17px] max-w-[650px] whitespace-pre-line text-[17px] leading-[1.4] tracking-[-0.02em] [overflow-wrap:anywhere] md:mt-6 md:text-[19px]">{e.about}</p>
        ) : (
          <p className="mt-[17px] text-[14px] text-reason-muted md:mt-6">No description yet.</p>
        )}
        {(site || page.canEdit) && (
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-5 md:pt-6">
            {site && (
              <a href={site.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="mr-auto inline-flex min-h-[44px] max-w-full items-center text-[14px] font-bold text-reason-ink underline decoration-reason-line underline-offset-4 [overflow-wrap:anywhere] hover:decoration-reason-ink">
                {/* One run of text, so the arrow wraps with the address instead of standing apart from it. */}
                <span className="min-w-0">{site.text}<span aria-hidden="true">&nbsp;↗</span></span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            {page.canEdit && (
              <>
                <button type="button" onClick={onEdit} className={QUIET_BUTTON}>Edit</button>
                {e.logoUrl && (
                  <button type="button" onClick={() => setRemovingLogo(true)} disabled={logo.busy} className={QUIET_BUTTON}>{logo.words.remove}</button>
                )}
                <button type="button" onClick={onArchive} className={QUIET_BUTTON}>Archive</button>
              </>
            )}
          </div>
        )}
      </section>

      {relationship}
      {page.canEdit && (
        <>
          <PictureEditor {...logo.editor} />
          <ConfirmDialog
            open={removingLogo}
            title="Remove the logo?"
            body={`${e.name}'s page and cards show its first letter until you add a logo again.`}
            confirmLabel="Remove"
            tone="danger"
            busy={logo.removing}
            busyLabel="Removing…"
            onConfirm={() => void removeLogo()}
            onCancel={() => setRemovingLogo(false)}
          />
        </>
      )}
    </section>
  );
}
