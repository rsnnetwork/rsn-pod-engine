// client/src/features/reason/human/HumanCard.tsx
// The one person card used everywhere (Stefan's v4: "Human cards are the
// universal person object"). Four columns only from 1420px, where they fit;
// below that it stacks, so the reason and the buttons never clip.
import { useId, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { primaryActionFor, type RelationshipState } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { personName, visibleText } from '../person';
import { BUSY } from './busy';
import { PRIMARY_LABEL } from './labels';
import type { KnownSource } from './profile-text';

export interface HumanCardPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string | null;
  company: string | null;
  tags: string[];
  reason: string;
  theyCanBring: string | null;
  youAreLookingFor: string | null;
  state: RelationshipState;
  saved: boolean;
}

interface Props {
  person: HumanCardPerson;
  /** Where the card is drawn. The profile shows it as "You found them through ...", and only knows these places. */
  source: KnownSource;
  onMeet: (p: HumanCardPerson) => void;
  onToggleSave: (p: HumanCardPerson) => void;
  busy?: boolean;
}

export default function HumanCard({ person, source, onMeet, onToggleSave, busy }: Props) {
  const navigate = useNavigate();
  const headingId = useId();
  const profileUrl = `/people/${person.userId}?from=${encodeURIComponent(source)}`;
  const action = primaryActionFor(person.state);
  const inert = action === 'requested' || action === 'declined';
  // While a request is on its way the buttons say so (aria-disabled), show the busy look and ignore presses. They
  // are not `disabled`: a disabled button drops the keyboard focus that is on it, and a Save made from the keyboard
  // would leave the member on nothing. The same goes for Request sent and Request declined: the Meet sheet gives
  // focus back to the button that opened it, and by then that button has become one of them. The busy look is shared
  // with the profile's bar (busy.ts).
  const press = (fn: () => void) => () => { if (!busy) fn(); };

  // Any of these can arrive empty or as spaces. A field with nothing to read is left out, not drawn blank,
  // and a blank name is worded here, so no page has to remember to.
  const name = personName(person.displayName);
  const role = visibleText(person.role);
  const company = visibleText(person.company);
  const reason = visibleText(person.reason);
  const bring = visibleText(person.theyCanBring);
  const looking = visibleText(person.youAreLookingFor);
  const tags = person.tags.map(visibleText).filter((t): t is string => t !== null).slice(0, 3);

  const onPrimary = () => {
    if (action === 'meet') onMeet(person);
    else if (action === 'continue') navigate(`/messages/new/${person.userId}`);
    else if (action === 'respond') navigate(profileUrl);
  };
  const openProfile = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    navigate(profileUrl);
  };

  return (
    <article
      data-person-id={person.userId}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      onClick={openProfile}
      className="grid cursor-pointer grid-cols-[70px_minmax(0,1fr)] items-start gap-2.5 overflow-hidden rounded-[15px] border border-reason-line bg-white p-[11px] transition hover:shadow-[0_10px_28px_rgba(16,18,24,.06)] min-[721px]:grid-cols-[90px_minmax(0,1fr)] min-[721px]:gap-3.5 min-[721px]:p-3 min-[1420px]:grid-cols-[110px_minmax(160px,210px)_minmax(0,1fr)_150px] min-[1420px]:items-center"
    >
      <Link to={profileUrl} aria-hidden="true" tabIndex={-1} className="block">
        {/* The photo is a tap target only: the name link goes to the same page, so a keyboard and a screen
            reader meet one link, not two. Avatar shows the initials when there is no photo and when the
            photo fails to load, including one that fails at once. */}
        <Avatar
          src={person.avatarUrl}
          name={name}
          size="xl"
          className="h-[70px] w-[70px] rounded-xl min-[721px]:h-[88px] min-[721px]:w-[90px] min-[1420px]:h-[96px] min-[1420px]:w-[110px] min-[1420px]:rounded-[13px]"
        />
      </Link>

      <div className="min-w-0">
        <h3 id={headingId} className="text-[16px] font-bold leading-tight [overflow-wrap:anywhere] min-[721px]:text-[17px]">
          <Link to={profileUrl} className="hover:underline">{name}</Link>
        </h3>
        {role && <p className="mt-0.5 text-[12px] text-[#677080] [overflow-wrap:anywhere] min-[721px]:text-[13px]">{role}</p>}
        {company && <p className="mt-1.5 text-[12px] font-bold [overflow-wrap:anywhere] min-[721px]:text-[13px]">{company}</p>}
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t, i) => (
              <span key={`${i}-${t}`} className="max-w-full rounded-full bg-[#f3f4f6] px-2 py-1 text-[10px] text-[#68707e] [overflow-wrap:anywhere]">{t}</span>
            ))}
          </div>
        )}
      </div>

      {(reason || bring || looking) && (
        <div className="col-span-2 min-w-0 border-t border-[#f0f1f3] pt-2.5 min-[721px]:col-span-1 min-[721px]:col-start-2 min-[721px]:border-0 min-[721px]:pt-0 min-[1420px]:col-start-3">
          {reason && (
            <>
              <strong className="block text-[12px]">Why you should meet</strong>
              <p className="mt-1 text-[12px] leading-snug text-[#626a78] [overflow-wrap:anywhere]">{reason}</p>
            </>
          )}
          {(bring || looking) && (
            <div className={cn('grid grid-cols-1 gap-2.5 min-[391px]:grid-cols-2', reason && 'mt-2.5')}>
              {bring && (
                <div className="min-w-0 text-[11px] text-[#697180] [overflow-wrap:anywhere]"><b className="block text-[#282c34]">They can bring</b>{bring}</div>
              )}
              {looking && (
                <div className="min-w-0 text-[11px] text-[#697180] [overflow-wrap:anywhere]"><b className="block text-[#282c34]">You are looking for</b>{looking}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="col-span-2 grid grid-cols-2 gap-2 min-[721px]:col-span-1 min-[721px]:col-start-2 min-[1420px]:col-start-4 min-[1420px]:grid-cols-1">
        <button
          type="button"
          onClick={press(onPrimary)}
          aria-disabled={busy || inert || undefined}
          className={cn('min-h-[44px] rounded-[11px] px-3 text-[13px] font-bold transition',
            inert ? 'bg-[#f5f6f7] text-[#646a77] cursor-default' : 'bg-reason-red text-white shadow-[0_7px_18px_rgba(222,50,46,.18)] enabled:hover:bg-reason-red-hover',
            busy && !inert && BUSY)}
        >
          {PRIMARY_LABEL[action]}
        </button>
        {/* The label carries the state ("Save" / "Saved"), so there is no aria-pressed: a screen reader would say it twice. */}
        <button
          type="button"
          onClick={press(() => onToggleSave(person))}
          aria-disabled={busy || undefined}
          className={cn('min-h-[44px] rounded-[11px] bg-[#f5f6f7] px-3 text-[13px] font-bold text-[#2d3440]', busy && BUSY)}
        >
          {person.saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </article>
  );
}
