// client/src/features/reason/human/ProfileDetails.tsx
// Everything under the hero: what they are trying to make happen, how you are connected, a first line to
// open with, and where the relationship stands.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { OUTCOME_LABELS, type PersonBrief } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { personName, visibleText } from '../person';
import { STATE_LABEL } from './labels';
import { SIGNAL, type PersonFacts } from './ProfileHero';

const WORTH_LABEL = { yes: 'Worth continuing', maybe: 'Maybe worth continuing', no: 'Not worth continuing' } as const;

// When the keyboard moves focus to a link or button in the page, the browser scrolls it into view. A control
// half under the sticky header or the fixed bar counts as in view, so these margins keep it clear of both.
const KEEP_CLEAR = 'scroll-mt-[calc(90px+env(safe-area-inset-top))] scroll-mb-[calc(100px+env(safe-area-inset-bottom))]';
const BODY = 'text-[14px] leading-relaxed text-[#505762] [overflow-wrap:anywhere]';
const CHIP = cn('flex min-h-[44px] max-w-full items-center rounded-full bg-[#f3f4f6] px-3 py-1 text-[12px] [overflow-wrap:anywhere]', KEEP_CLEAR);

function Section({ kicker, title, children, className }: { kicker: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:rounded-[24px] md:p-6', className)}>
      <p className="text-[11px] font-extrabold uppercase tracking-[0.11em]">{kicker}</p>
      <h3 className="mt-3.5 text-[22px] font-bold tracking-[-0.035em] [overflow-wrap:anywhere] md:text-[24px]">{title}</h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Panel({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 rounded-[18px] bg-reason-soft p-4">
      <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#646a77] [overflow-wrap:anywhere]">{label}</p>
      <p className="text-[12px] leading-relaxed text-[#454b55] [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

function Timeline({ items }: { items: Array<{ title: string; text: string }> }) {
  return (
    <ul className="grid">
      {items.map((it, i) => (
        <li key={`${it.title}-${i}`} className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 pb-3.5 last:pb-0">
          <span className="mt-[5px] h-[7px] w-[7px] rounded-full bg-reason-red" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <b className="block text-[12px]">{it.title}</b>
            <span className="mt-[3px] block text-[11px] text-reason-muted">{it.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// A meeting can be on record without a date (a one to one meeting from Messages), so "no meeting
// recorded" is only said when there is none.
function lastMetText(r: PersonBrief['relationship']): string {
  if (r.lastMetAt) return `Last met ${new Date(r.lastMetAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}.`;
  return r.timesMet > 0 ? 'The date of your last meeting is not recorded.' : 'No meeting recorded yet.';
}

interface Props { brief: PersonBrief; who: PersonFacts; source: string | null; onRecordOutcome: () => void }

export default function ProfileDetails({ brief, who, source, onRecordOutcome }: Props) {
  const r = brief.relationship;
  const { first } = who;
  const { circles, pods, upcomingEvents } = brief.shared;
  const hasShared = circles.length + pods.length + upcomingEvents.length > 0;
  const bring = visibleText(brief.theyCanBring);
  const last = r.outcomes[0];

  const whyNow = [
    ...(brief.match ? [{ title: SIGNAL[brief.match.strength], text: 'REASON believes this is currently relevant.' }] : []),
    ...(source ? [{ title: source, text: 'This is the context where you encountered each other.' }] : []),
    ...(upcomingEvents[0] ? [{ title: upcomingEvents[0].title, text: 'You will both be there.' }] : []),
  ];

  return (
    <section className="mt-[11px] grid grid-cols-[minmax(0,1fr)] gap-[11px] md:mt-[18px] min-[981px]:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)] min-[981px]:gap-[18px]">
      <Section kicker="Right now" title={`What ${first} is trying to make happen`}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
          <Panel label="Active reasons" text={`${first} has not shared what they are looking for yet.`} />
          <Panel label={`What ${first} can bring`} text={bring ?? `${first} has not said yet.`} />
        </div>
      </Section>

      <Section kicker="Your path" title={brief.path || hasShared ? 'You are not strangers.' : 'No shared path yet.'}>
        <p className={BODY}>REASON shows the shortest credible path, not a meaningless mutual-connection count.</p>
        {brief.path && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px] font-extrabold">
            <span className="rounded-full bg-[#111216] px-3 py-2 text-white">You</span>
            <span className="text-[#a5a9b0]" aria-hidden="true">→</span>
            <Link
              to={`/people/${brief.path.id}?from=${encodeURIComponent('Your path')}`}
              className={cn('flex min-h-[44px] max-w-full items-center rounded-full border border-reason-line bg-[#f6f5f3] px-3 py-1 [overflow-wrap:anywhere]', KEEP_CLEAR)}
            >
              {personName(brief.path.displayName)}
            </Link>
            <span className="text-[#a5a9b0]" aria-hidden="true">→</span>
            <span className="max-w-full rounded-full border border-reason-line bg-[#f6f5f3] px-3 py-2 [overflow-wrap:anywhere]">{first}</span>
          </div>
        )}
        {hasShared && (
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {circles.map((c) => <Link key={c.id} to={`/circles/${c.id}`} className={CHIP}>{c.name}</Link>)}
            {pods.map((x) => <Link key={x.id} to={`/pods/${x.id}`} className={CHIP}>{x.name}</Link>)}
            {upcomingEvents.map((e) => <Link key={e.id} to={`/sessions/${e.id}`} className={CHIP}>{e.title}</Link>)}
          </div>
        )}
      </Section>

      <Section kicker="Entities & roles" title={who.company ?? 'No organisation shared yet'}>
        {who.company ? (
          <p className={BODY}>
            {first} is connected to this entity{who.role ? <> as <strong>{who.role}</strong></> : null}. REASON uses entity relationships as context, not as a replacement for the human.
          </p>
        ) : (
          <p className={BODY}>Organisations and roles arrive in the next step of REASON.</p>
        )}
      </Section>

      <Section kicker="The first 20 minutes" title="Skip the small talk." className="border-[#ffd4d0] bg-reason-pink">
        <p className="text-[20px] leading-[1.34] tracking-[-0.03em] text-[#252931] [overflow-wrap:anywhere] md:text-[24px]">“{brief.opener}”</p>
      </Section>

      <Section kicker="Why now" title="Context creates timing.">
        {whyNow.length > 0 ? <Timeline items={whyNow} /> : <p className={BODY}>Nothing time-bound yet.</p>}
      </Section>

      <Section kicker="Relationship memory" title={r.timesMet > 0 ? `You have met ${r.timesMet} time${r.timesMet === 1 ? '' : 's'}.` : 'You have not met yet.'}>
        <Timeline
          items={[
            { title: STATE_LABEL[r.state], text: lastMetText(r) },
            ...(last ? [{ title: WORTH_LABEL[last.worthContinuing], text: last.outcomes.length ? last.outcomes.map((k) => OUTCOME_LABELS[k]).join(', ') : 'Nothing noted.' }] : []),
          ]}
        />
        {(r.state === 'connected' || r.state === 'met') && (
          <button type="button" onClick={onRecordOutcome} className={cn('mt-3.5 min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white enabled:hover:bg-reason-red-hover', KEEP_CLEAR)}>Record what happened</button>
        )}
      </Section>

      <Section kicker="What happens next" title="One useful move.">
        <p className={BODY}>REASON does not want you living on the profile. Meet, continue, save, or pass. The relationship state should move.</p>
      </Section>
    </section>
  );
}
