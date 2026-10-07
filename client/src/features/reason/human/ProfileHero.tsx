// client/src/features/reason/human/ProfileHero.tsx
// The human on the left, the reason on the right: who they are, and why you two might matter to each other.
import type { PersonBrief } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import ReasonSheep from '../brand/ReasonSheep';
import { visibleText } from '../person';
import { SIGNAL, foundThrough, reasonText, type KnownSource, type PersonFacts } from './profile-text';

function Offer({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#31343a] p-[13px]">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#9ea2aa]">{label}</span>
      <b className="mt-1.5 block text-[13px] leading-snug [overflow-wrap:anywhere]">{text}</b>
    </div>
  );
}

interface Props { brief: PersonBrief; who: PersonFacts; source: KnownSource | null }

export default function ProfileHero({ brief, who, source }: Props) {
  const roleLine = [who.role, who.company].filter(Boolean).join(' · ');
  const bring = visibleText(brief.theyCanBring);
  const looking = visibleText(brief.youAreLookingFor);
  const found = foundThrough(source, who.first);

  return (
    // From 981px the three columns share the width. The side columns are slimmer, and the name smaller, until
    // 1200px, so a name in the middle column is not cut mid-word ("Northwin" / "d" at 1024px with the full-size
    // columns, and "Papadopoulos" at 981px with a 52px name).
    <section className="grid grid-cols-[minmax(0,1fr)] gap-[11px] md:grid-cols-[260px_minmax(0,1fr)] md:gap-[18px] min-[981px]:grid-cols-[250px_minmax(0,1fr)_290px] min-[1200px]:grid-cols-[320px_minmax(0,1fr)_330px]">
      {/* A photo fills the tile. With none, or one that fails to load, Avatar draws round initials in the middle. */}
      <div className="relative grid h-[43vh] min-h-[260px] place-items-center overflow-hidden rounded-[21px] bg-[#eceae6] shadow-[0_16px_50px_rgba(17,18,22,.08)] md:h-auto md:min-h-[430px] md:rounded-[26px] [&>img]:absolute [&>img]:inset-0 [&>img]:h-full [&>img]:w-full [&>img]:rounded-none">
        <Avatar src={brief.person.avatarUrl} name={who.name} size="2xl" />
        {brief.match && (
          <span className="absolute left-[18px] top-[18px] flex items-center gap-[7px] rounded-full bg-white px-3 py-2 text-[11px] font-extrabold shadow-[0_8px_24px_rgba(0,0,0,.08)]">
            <i aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-reason-red" />{SIGNAL[brief.match.strength]}
          </span>
        )}
      </div>

      <section className="flex min-w-0 flex-col rounded-[21px] border border-reason-line bg-white p-[18px] md:rounded-[26px] md:p-7">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#646a77] md:text-[11px]">The human</p>
        <h1 className="mt-2 text-[40px] font-extrabold leading-[.94] tracking-[-0.055em] [overflow-wrap:anywhere] md:text-[52px] min-[981px]:max-[1199px]:text-[44px]">{who.name}</h1>
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
              <b className="block text-[12px]">{found.title}</b>
              <span className="mt-0.5 block text-[11px] leading-snug text-reason-muted">{found.line}</span>
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
