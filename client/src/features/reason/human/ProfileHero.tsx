// client/src/features/reason/human/ProfileHero.tsx
// The human and the reason: who they are (photo, name and links centred in one card), and why you two might matter to each other.
// The frame (photo, person, dark panel) is shared: your own profile is drawn by it too (21 Oct 2026), so what you
// see of yourself looks exactly like what other members see of you.
import type { ReactNode } from 'react';
import { Facebook, Globe, Instagram, Linkedin, Twitter, type LucideIcon } from 'lucide-react';
import type { PersonBrief } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import ReasonSheep from '../brand/ReasonSheep';
import { visibleText } from '../person';
import ProfileCallButton from '@/features/calls/ProfileCallButton';
import ProfileHeroActions from './ProfileHeroActions';
import { SIGNAL, foundThrough, reasonText, type KnownSource, type PersonFacts, type ProfileLinkItem } from './profile-text';

// The person card (photo, name, links) and the dark panel. The photo sits centred at the top of the card at every width
// (Stefan, 10 Nov 2026), so there is no side column: below 981px the card and the panel stack, from there they share the
// width. The Human Profile fills the window; your own profile sits beside the app's sidebar (232px from 981px), so its
// columns follow the width of the page, not of the window.
export type HeroFit = 'screen' | 'shell';
const GRID: Record<HeroFit, string> = {
  screen: 'grid grid-cols-[minmax(0,1fr)] gap-[11px] md:gap-[18px] min-[981px]:grid-cols-[minmax(0,1fr)_330px] min-[1200px]:grid-cols-[minmax(0,1fr)_380px]',
  shell: 'grid grid-cols-[minmax(0,1fr)] gap-[11px] md:gap-[18px] min-[1213px]:grid-cols-[minmax(0,1fr)_330px] min-[1432px]:grid-cols-[minmax(0,1fr)_380px]',
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
    <div className="flex items-start gap-3 rounded-[18px] border border-reason-line bg-white p-3.5 text-left">
      <ReasonSheep pose="curious" className="h-12 w-12 shrink-0" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <b className="block text-[12px]">{title}</b>
        <span className="mt-0.5 block text-[11px] leading-snug text-reason-muted">{line}</span>
      </div>
    </div>
  );
}

/** The dark panel beside the person: a label, a heading, and what goes under it. */
export function DarkPanel({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <aside className="flex min-w-0 flex-col rounded-[21px] bg-[#111216] p-[18px] text-white shadow-[0_16px_48px_rgba(17,18,22,.12)] md:rounded-[26px] md:p-[26px]">
      <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#b8bbc1] md:text-[11px]">{kicker}</p>
      <h2 className="mt-3 text-[26px] font-bold leading-[1.04] tracking-[-0.045em] [overflow-wrap:anywhere] md:text-[29px]">{title}</h2>
      {children}
    </aside>
  );
}

const LINK_ICON: Record<ProfileLinkItem['kind'], LucideIcon> = {
  linkedin: Linkedin, website: Globe, instagram: Instagram, x: Twitter, facebook: Facebook,
};
const LINK_BUTTON = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-reason-line bg-white px-3.5 text-[14px] font-bold scroll-mt-[calc(90px+env(safe-area-inset-top))] scroll-mb-[calc(100px+env(safe-area-inset-bottom))] hover:bg-reason-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-reason-red';

/** LinkedIn, Website, Instagram, X and Facebook, only those the member gave: each an icon and its name, opening in a new tab. */
function ProfileLinks({ links }: { links: ProfileLinkItem[] }) {
  if (links.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap justify-center gap-2" data-testid="profile-links">
      {links.map(({ kind, label, href }) => {
        const Icon = LINK_ICON[kind];
        return (
          <a key={kind} href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK_BUTTON, kind === 'linkedin' && 'text-[#0a66c2]')}>
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{label}<span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
      })}
    </div>
  );
}

interface FrameProps {
  photo: string | null;
  who: PersonFacts;
  /** The small label above the name. */
  kicker: string;
  /** Drawn under the role line, centred: the match strength. */
  badge?: ReactNode;
  /** Drawn on the photo's lower right: the pencil, on your own profile only (30 Oct review, T3a). */
  photoAction?: ReactNode;
  /**
   * Your own profile only (Shirley pilot S6, RSN 13): the photo itself is a button that opens the photo editor, the same
   * as the pencil, named by `photoLabel`. On anyone else's profile the photo is only a picture.
   */
  onPhotoClick?: () => void;
  photoLabel?: string;
  /** True when a banner is drawn above the hero: the photo then overlaps its lower edge. */
  hasBanner?: boolean;
  /** The box under the tags. */
  note: ReactNode;
  /** The dark panel beside the person. */
  panel: ReactNode;
  /** Buttons under the name (a connection's Message, ProfileHeroActions). */
  actions?: ReactNode;
  /** The Human Profile fills the window (screen); your own profile sits beside the sidebar (shell). */
  fit?: HeroFit;
}

// With a banner above, the photo is pulled up by the card's own padding, the gap between banner and card, and half the
// photo, so the circle straddles the banner's lower edge. Without one it simply sits at the top of the card.
const OVERLAP = '-mt-[85px] md:-mt-[118px]';

export function HeroFrame({
  photo, who, kicker, badge, photoAction, onPhotoClick, photoLabel, hasBanner = false, note, panel, actions, fit = 'screen',
}: FrameProps) {
  const roleLine = [who.role, who.company].filter(Boolean).join(' · ');
  const avatar = <Avatar src={photo} name={who.name} size="2xl" className="h-28 w-28 text-4xl ring-4 ring-white shadow-[0_10px_30px_rgba(17,18,22,.12)] md:h-36 md:w-36 md:text-5xl" />;
  return (
    <section className={GRID[fit]}>
      <section className="flex min-w-0 flex-col items-center rounded-[21px] border border-reason-line bg-white p-[18px] text-center md:rounded-[26px] md:p-7">
        {/* Round, centred, at every width. With none, or one that fails to load, Avatar draws initials in the same circle. */}
        <div className={cn('relative shrink-0 rounded-full', hasBanner && OVERLAP)} data-testid="profile-photo">
          {onPhotoClick ? (
            <button
              type="button"
              onClick={onPhotoClick}
              aria-label={photoLabel}
              className="block rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-reason-red focus-visible:ring-offset-2"
              data-testid="profile-photo-button"
            >
              {avatar}
            </button>
          ) : avatar}
          {photoAction && <div className="absolute -bottom-1 -right-3">{photoAction}</div>}
        </div>
        <p className="mt-4 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#646a77] md:text-[11px]">{kicker}</p>
        <h1 className="mt-2 text-[40px] font-extrabold leading-[.94] tracking-[-0.055em] [overflow-wrap:anywhere] md:text-[52px]">{who.name}</h1>
        {roleLine && <p className="mt-3 text-[15px] text-reason-muted [overflow-wrap:anywhere]">{roleLine}</p>}
        {badge}
        <ProfileLinks links={who.links} />
        {actions}
        {who.bio && <p className="mt-[17px] max-w-[620px] text-[18px] leading-[1.38] tracking-[-0.024em] [overflow-wrap:anywhere] md:mt-6 md:text-[21px]">{who.bio}</p>}
        <div className="mt-auto flex w-full flex-col gap-4 pt-4 md:pt-6">
          {who.tags.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5">
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

interface Props { brief: PersonBrief; who: PersonFacts; source: KnownSource | null; userId: string }

export default function ProfileHero({ brief, who, source, userId }: Props) {
  const bring = visibleText(brief.theyCanBring);
  const looking = visibleText(brief.youAreLookingFor);
  const found = foundThrough(source, who.first);

  return (
    <HeroFrame
      photo={brief.person.avatarUrl}
      who={who}
      hasBanner={!!brief.person.bannerUrl}
      kicker="The human"
      actions={<ProfileHeroActions brief={brief} userId={userId} call={brief.canCall && <ProfileCallButton brief={brief} userId={userId} name={who.name} />} />}
      badge={brief.match && (
        <span className="mt-3 flex items-center gap-[7px] rounded-full bg-white px-3 py-2 text-[11px] font-extrabold shadow-[0_8px_24px_rgba(0,0,0,.08)]">
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
