// client/src/features/reason/people/EveryoneCard.tsx
// One person on Everyone: photo, name, role and company, and one button for where the two of you stand
// ("I want to meet", "Request sent", "Respond", "Message"). It sizes itself to the room it is given (a container
// query), a single list on a phone and half a row from 1024px.
import { useId } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { primaryActionFor, type EveryoneMember } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { personName, visibleText } from '../person';
import { PRIMARY_LABEL } from '../human/labels';

// Everyone says what the button does in the member's own words; the other states keep the shared labels.
const LABEL = { ...PRIMARY_LABEL, meet: 'I want to meet' } as const;

interface Props { person: EveryoneMember; onMeet: (p: EveryoneMember) => void }

export default function EveryoneCard({ person, onMeet }: Props) {
  const headingId = useId();
  const navigate = useNavigate();
  const name = personName(person.displayName);
  const roleLine = [visibleText(person.jobTitle) ?? visibleText(person.professionalRole[0]), visibleText(person.company)].filter(Boolean).join(' · ');
  const profileUrl = `/people/${encodeURIComponent(person.id)}?from=People`;
  const action = primaryActionFor(person.relationship);
  const inert = action === 'requested' || action === 'declined';

  const onPrimary = () => {
    if (action === 'meet') onMeet(person);
    else if (action === 'continue') navigate(`/messages/new/${encodeURIComponent(person.id)}`);
    else if (action === 'respond') navigate(profileUrl);
  };

  return (
    <article
      data-person-id={person.id}
      aria-labelledby={headingId}
      className="flex flex-col overflow-hidden rounded-[15px] border border-reason-line bg-white p-[11px] [container-type:inline-size] min-[721px]:p-3"
    >
      <div className="grid flex-1 grid-cols-[56px_minmax(0,1fr)] content-between items-start gap-3 [@container(min-width:30rem)]:grid-cols-[56px_minmax(0,1fr)_auto_auto] [@container(min-width:30rem)]:content-center [@container(min-width:30rem)]:items-center">
        <Link to={profileUrl} aria-hidden="true" tabIndex={-1} className="block">
          <Avatar src={person.avatarUrl} name={name} size="lg" className="h-14 w-14 rounded-xl" />
        </Link>
        <div className="min-w-0">
          <h3 id={headingId} className="text-[16px] font-bold leading-tight [overflow-wrap:anywhere]">
            <Link to={profileUrl} className="hover:underline">{name}</Link>
          </h3>
          {person.alreadyMet && <p className="mt-0.5 text-[12px] font-bold text-[#555d69]">You marked as met</p>}
          {roleLine && <p className="mt-0.5 text-[12px] text-[#677080] [overflow-wrap:anywhere] min-[721px]:text-[13px]">{roleLine}</p>}
        </div>
        <Link
          to={profileUrl}
          aria-label={`View profile of ${name}`}
          className="col-span-2 flex min-h-[44px] items-center justify-center rounded-[11px] bg-[#f5f6f7] px-4 text-[13px] font-bold text-[#2d3440] hover:bg-[#eceef1] [@container(min-width:30rem)]:col-span-1"
        >
          View profile
        </Link>
        <button
          type="button"
          onClick={onPrimary}
          aria-disabled={inert || undefined}
          className={cn(
            'col-span-2 min-h-[44px] rounded-[11px] px-4 text-[13px] font-bold transition [@container(min-width:30rem)]:col-span-1',
            inert ? 'cursor-default bg-[#f5f6f7] text-[#646a77]' : 'bg-reason-red text-white hover:bg-reason-red-hover',
          )}
        >
          {LABEL[action]}
        </button>
      </div>
    </article>
  );
}
