// client/src/features/reason/human/ProfileHero.tsx
// The human on the left, the reason on the right: who they are, and why you two might matter to each other.
import type { MatchStrength, PersonBrief } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import ReasonSheep from '../brand/ReasonSheep';
import { personName, visibleText } from '../person';

export const SIGNAL: Record<MatchStrength, string> = { strong: 'Strong reason', close: 'Worth exploring' };

/** What the page shows about a person. Every text is trimmed and a blank one is null, so nothing blank is drawn. */
export interface PersonFacts {
  /** The heading. "Member" when the account has no name. */
  name: string;
  /** What a sentence calls them. */
  first: string;
  role: string | null;
  company: string | null;
  bio: string | null;
  tags: string[];
}

export function personFacts(p: PersonBrief['person']): PersonFacts {
  const name = personName(p.displayName);
  const roles = p.professionalRole.map(visibleText).filter((r): r is string => r !== null);
  return {
    name,
    first: visibleText(p.firstName) ?? name.split(' ')[0],
    role: roles.join(', ') || visibleText(p.jobTitle),
    company: visibleText(p.company),
    bio: visibleText(p.bio),
    tags: [visibleText(p.industry), ...roles].filter((t): t is string => t !== null).slice(0, 4),
  };
}

// The prototype's own "where you found them" copy, by source. `source` is one of the places the app
// itself writes into ?from= (see HumanProfilePage), or null when there is none.
function sourceLine(source: string | null, first: string): string {
  if (source === 'For You') return `REASON surfaced ${first} because this relationship looks unusually relevant to what you are trying to make happen now.`;
  if (source === 'People') return `You found ${first} while exploring the wider network. REASON still explains why this person may matter, rather than leaving you with a directory result.`;
  if (source === 'Messages') return 'This profile is the relationship layer behind your conversation. The history, reason and next useful move travel with the message thread.';
  if (source === 'Introductions') return 'This relationship arrived through an introduction. REASON keeps the introducer, reason and outcome as part of the relationship memory.';
  if (source) return `You encountered ${first} through ${source}. REASON changes the context, not the human: the same person, with a reason specific to where you found them.`;
  return 'REASON explains why this person may matter to you right now.';
}

// The brief scores the person's public card only, so someone For You listed for a private interest can
// have no match here. The panel then says neither that there is a reason nor that there is none.
function reasonText(brief: PersonBrief, first: string): string {
  const matched = visibleText(brief.match?.reason);
  if (matched) return matched;
  return visibleText(brief.theyCanBring)
    ? `Start with what ${first} can bring, and see whether there is a reason to meet.`
    : 'See what you have in common, and whether there is a reason to meet.';
}

function Offer({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#31343a] p-[13px]">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#9ea2aa]">{label}</span>
      <b className="mt-1.5 block text-[13px] leading-snug [overflow-wrap:anywhere]">{text}</b>
    </div>
  );
}

interface Props { brief: PersonBrief; who: PersonFacts; source: string | null }

export default function ProfileHero({ brief, who, source }: Props) {
  const roleLine = [who.role, who.company].filter(Boolean).join(' · ');
  const bring = visibleText(brief.theyCanBring);
  const looking = visibleText(brief.youAreLookingFor);

  return (
    // From 981px the three columns share the width. The side columns are slimmer until 1200px, so the name
    // in the middle one is not cut mid-word ("Northwin" / "d" at 1024px with the full-size columns).
    <section className="grid grid-cols-[minmax(0,1fr)] gap-[11px] md:grid-cols-[260px_minmax(0,1fr)] md:gap-[18px] min-[981px]:grid-cols-[250px_minmax(0,1fr)_290px] min-[1200px]:grid-cols-[320px_minmax(0,1fr)_330px]">
      {/* A photo fills the tile. With none, or one that fails to load, Avatar draws round initials in the middle. */}
      <div className="relative grid h-[43vh] min-h-[260px] place-items-center overflow-hidden rounded-[21px] bg-[#eceae6] shadow-[0_16px_50px_rgba(17,18,22,.08)] md:h-auto md:min-h-[430px] md:rounded-[26px] [&>img]:absolute [&>img]:inset-0 [&>img]:h-full [&>img]:w-full [&>img]:rounded-none">
        <Avatar src={brief.person.avatarUrl} name={who.name} size="2xl" />
        {brief.match && (
          <span className="absolute left-[18px] top-[18px] flex items-center gap-[7px] rounded-full bg-white px-3 py-2 text-[11px] font-black shadow-[0_8px_24px_rgba(0,0,0,.08)]">
            <i aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-reason-red" />{SIGNAL[brief.match.strength]}
          </span>
        )}
      </div>

      <section className="flex min-w-0 flex-col rounded-[21px] border border-reason-line bg-white p-[18px] md:rounded-[26px] md:p-7">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#646a77] md:text-[11px]">The human</p>
        <h1 className="mt-2 text-[40px] font-extrabold leading-[.94] tracking-[-0.055em] [overflow-wrap:anywhere] md:text-[52px]">{who.name}</h1>
        {roleLine && <p className="mt-3 text-[15px] text-reason-muted [overflow-wrap:anywhere]">{roleLine}</p>}
        {who.bio && <p className="mt-[17px] max-w-[620px] text-[18px] leading-[1.38] tracking-[-0.024em] [overflow-wrap:anywhere] md:mt-6 md:text-[21px]">{who.bio}</p>}
        <div className="mt-auto flex flex-col gap-4 pt-4 md:pt-6">
          {who.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {who.tags.map((t, i) => (
                <span key={`${i}-${t}`} className="max-w-full rounded-full bg-[#f3f4f6] px-2 py-1.5 text-[10px] text-[#646a77] [overflow-wrap:anywhere]">{t}</span>
              ))}
            </div>
          )}
          <div className="flex items-start gap-3 rounded-[18px] border border-reason-line bg-white p-3.5">
            <ReasonSheep pose="curious" className="h-12 w-12 shrink-0" />
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <b className="block text-[12px]">{source ? `You found ${who.first} through ${source}` : `About ${who.first}`}</b>
              <span className="mt-0.5 block text-[11px] leading-snug text-reason-muted">{sourceLine(source, who.first)}</span>
            </div>
          </div>
        </div>
      </section>

      <aside className="flex min-w-0 flex-col rounded-[21px] bg-[#111216] p-[18px] text-white shadow-[0_16px_48px_rgba(17,18,22,.12)] md:col-span-2 md:rounded-[26px] md:p-[26px] min-[981px]:col-span-1">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#b8bbc1] md:text-[11px]">The reason</p>
        <h2 className="mt-3 text-[26px] font-bold leading-[1.04] tracking-[-0.045em] [overflow-wrap:anywhere] md:text-[29px]">Why you and {who.first} might matter to each other.</h2>
        <p className="mt-3.5 text-[14px] leading-relaxed text-[#d4d6da] [overflow-wrap:anywhere]">{reasonText(brief, who.first)}</p>
        {(bring || looking) && (
          <div className="mt-[18px] grid gap-2.5 md:mt-auto md:pt-[22px]">
            {bring && <Offer label="They can bring" text={bring} />}
            {looking && <Offer label="You are looking for" text={looking} />}
          </div>
        )}
      </aside>
    </section>
  );
}
