// client/src/features/reason/human/ProfileHero.tsx
// The human on the left, the reason on the right: who they are, and why you two might matter to each other.
// The frame (photo, person, dark panel) is shared: your own profile is drawn by it too (21 Oct 2026), so what you
// see of yourself looks exactly like what other members see of you.
import type { ReactNode } from 'react';
import type { PersonBrief } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import ReasonSheep from '../brand/ReasonSheep';
import { visibleText } from '../person';
import { SIGNAL, foundThrough, reasonText, type KnownSource, type PersonFacts } from './profile-text';

// The Human Profile fills the window. Your own profile sits beside the app's sidebar (232px from 981px), so its columns
// follow the width of the page, not of the window: its page is as wide at a 1213px window as the Human Profile's is at
// 981px, and at 1432px as at 1200px. With the window's breakpoints the name had 160px at 1024 and broke mid-word.
export type HeroFit = 'screen' | 'shell';
const FRAME: Record<HeroFit, { grid: string; name: string; panel: string }> = {
  screen: {
    // From 981px the three columns share the width. The side columns are slimmer, and the name smaller, until
    // 1200px, so a name in the middle column is not cut mid-word ("Northwin" / "d" at 1024px with the full-size
    // columns, and "Papadopoulos" at 981px with a 52px name).
    grid: 'grid grid-cols-[minmax(0,1fr)] gap-[11px] md:grid-cols-[260px_minmax(0,1fr)] md:gap-[18px] min-[981px]:grid-cols-[250px_minmax(0,1fr)_290px] min-[1200px]:grid-cols-[320px_minmax(0,1fr)_330px]',
    name: 'min-[981px]:max-[1199px]:text-[44px]',
    panel: 'min-[981px]:col-span-1',
  },
  shell: {
    grid: 'grid grid-cols-[minmax(0,1fr)] gap-[11px] md:grid-cols-[260px_minmax(0,1fr)] md:gap-[18px] min-[1213px]:grid-cols-[250px_minmax(0,1fr)_290px] min-[1432px]:grid-cols-[320px_minmax(0,1fr)_330px]',
    name: 'min-[1213px]:max-[1431px]:text-[44px]',
    panel: 'min-[1213px]:col-span-1',
  },
};

export function Offer({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#31343a] p-[13px]">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#9ea2aa]">{label}</span>
      <b className="mt-1.5 block text-[13px] leading-snug [overflow-wrap:anywhere]">{text}</b>
    </div>
  );
}

/** The box at the foot of the person's card: the sheep, a title and a line. */
export function NoteBox({ title, line }: { title: string; line: string }) {
  return (
    <div className="flex items-start gap-3 rounded-[18px] border border-reason-line bg-white p-3.5">
      <ReasonSheep pose="curious" className="h-12 w-12 shrink-0" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <b className="block text-[12px]">{title}</b>
        <span className="mt-0.5 block text-[11px] leading-snug text-reason-muted">{line}</span>
      </div>
    </div>
  );
}

/** The dark panel beside the person: a label, a heading, and what goes under it. */
export function DarkPanel({ kicker, title, children, fit = 'screen' }: { kicker: string; title: string; children: ReactNode; fit?: HeroFit }) {
  return (
    <aside className={cn('flex min-w-0 flex-col rounded-[21px] bg-[#111216] p-[18px] text-white shadow-[0_16px_48px_rgba(17,18,22,.12)] md:col-span-2 md:rounded-[26px] md:p-[26px]', FRAME[fit].panel)}>
      <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#b8bbc1] md:text-[11px]">{kicker}</p>
      <h2 className="mt-3 text-[26px] font-bold leading-[1.04] tracking-[-0.045em] [overflow-wrap:anywhere] md:text-[29px]">{title}</h2>
      {children}
    </aside>
  );
}

interface FrameProps {
  photo: string | null;
  who: PersonFacts;
  /** The small label above the name. */
  kicker: string;
  /** Drawn over the photo, top left. */
  badge?: ReactNode;
  /** The box under the tags. */
  note: ReactNode;
  /** The dark panel beside the person. */
  panel: ReactNode;
  /** The Human Profile fills the window (screen); your own profile sits beside the sidebar (shell). */
  fit?: HeroFit;
}

export function HeroFrame({ photo, who, kicker, badge, note, panel, fit = 'screen' }: FrameProps) {
  const roleLine = [who.role, who.company].filter(Boolean).join(' · ');
  return (
    <section className={FRAME[fit].grid}>
      {/* A photo fills the tile. With none, or one that fails to load, Avatar draws round initials in the middle. */}
      <div className="relative grid h-[43vh] min-h-[260px] place-items-center overflow-hidden rounded-[21px] bg-[#eceae6] shadow-[0_16px_50px_rgba(17,18,22,.08)] md:h-auto md:min-h-[430px] md:rounded-[26px] [&>img]:absolute [&>img]:inset-0 [&>img]:h-full [&>img]:w-full [&>img]:rounded-none">
        <Avatar src={photo} name={who.name} size="2xl" />
        {badge}
      </div>

      <section className="flex min-w-0 flex-col rounded-[21px] border border-reason-line bg-white p-[18px] md:rounded-[26px] md:p-7">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#646a77] md:text-[11px]">{kicker}</p>
        <h1 className={cn('mt-2 text-[40px] font-extrabold leading-[.94] tracking-[-0.055em] [overflow-wrap:anywhere] md:text-[52px]', FRAME[fit].name)}>{who.name}</h1>
        {roleLine && <p className="mt-3 text-[15px] text-reason-muted [overflow-wrap:anywhere]">{roleLine}</p>}
        {/* Final review, 21 Oct 2026: nobody could see anyone's LinkedIn. Only ever an https address on LinkedIn. */}
        {who.linkedin && (
          <a
            href={who.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            className="-ml-1 mt-1 inline-flex min-h-[44px] w-fit items-center gap-1 rounded-lg px-1 text-[14px] font-bold text-[#0a66c2] scroll-mt-[calc(90px+env(safe-area-inset-top))] scroll-mb-[calc(100px+env(safe-area-inset-bottom))] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0a66c2]"
          >
            LinkedIn <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {who.bio &&<p className="mt-[17px] max-w-[620px] text-[18px] leading-[1.38] tracking-[-0.024em] [overflow-wrap:anywhere] md:mt-6 md:text-[21px]">{who.bio}</p>}
        <div className="mt-auto flex flex-col gap-4 pt-4 md:pt-6">
          {who.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {who.tags.map((t, i) => (
                <span key={`${i}-${t}`} className="max-w-full rounded-full bg-[#f3f4f6] px-2 py-1.5 text-[10px] text-[#646a77] [overflow-wrap:anywhere]">{t}</span>
              ))}
            </div>
          )}
          {note}
        </div>
      </section>

      {panel}
    </section>
  );
}

interface Props { brief: PersonBrief; who: PersonFacts; source: KnownSource | null }

export default function ProfileHero({ brief, who, source }: Props) {
  const bring = visibleText(brief.theyCanBring);
  const looking = visibleText(brief.youAreLookingFor);
  const found = foundThrough(source, who.first);

  return (
    <HeroFrame
      photo={brief.person.avatarUrl}
      who={who}
      kicker="The human"
      badge={brief.match && (
        <span className="absolute left-[18px] top-[18px] flex items-center gap-[7px] rounded-full bg-white px-3 py-2 text-[11px] font-extrabold shadow-[0_8px_24px_rgba(0,0,0,.08)]">
          <i aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-reason-red" />{SIGNAL[brief.match.strength]}
        </span>
      )}
      note={<NoteBox title={found.title} line={found.line} />}
      panel={(
        <DarkPanel kicker="The reason" title={`Why you and ${who.first} might matter to each other.`}>
          <p className="mt-3.5 text-[14px] leading-relaxed text-[#d4d6da] [overflow-wrap:anywhere]">{reasonText(brief, who.first)}</p>
          {(bring || looking) && (
            <div className="mt-[18px] grid gap-2.5 md:mt-auto md:pt-[22px]">
              {bring && <Offer label="They can bring" text={bring} />}
              {looking && <Offer label="You are looking for" text={looking} />}
            </div>
          )}
        </DarkPanel>
      )}
    />
  );
}
