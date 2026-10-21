// client/src/features/reason/people/ConnectionCard.tsx
// One person on Your connections: who they are, whether you met or are connected, and since when. The card
// sizes itself to the room it is given (a container query, not the window): a single list on a phone, and
// half a row from 1024px, where it is narrower than a tablet's list.
import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { PersonConnection } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { STATE_LABEL } from '../human/labels';
import { personName, visibleText } from '../person';

// Green on mint is 4.88:1 and the darker red on pink 5.09:1, both above AA for this small bold label.
const HOW_LOOK = {
  connected: 'bg-[#e9f8f1] text-[#147a4f]',
  met: 'bg-reason-pink text-reason-red-hover',
} as const;

export default function ConnectionCard({ person }: { person: PersonConnection }) {
  const headingId = useId();
  const name = personName(person.displayName);
  const roleLine = [visibleText(person.jobTitle), visibleText(person.company)].filter(Boolean).join(' · ');
  const profileUrl = `/people/${encodeURIComponent(person.userId)}?from=People`;
  const since = new Date(person.since);

  return (
    <article
      data-person-id={person.userId}
      aria-labelledby={headingId}
      className="flex flex-col overflow-hidden rounded-[15px] border border-reason-line bg-white p-[11px] [container-type:inline-size] min-[721px]:p-3"
    >
      {/* A card as tall as the one beside it keeps its button at the foot when the button sits under the text, and
          centres its one row when the button sits beside it (from 30rem). */}
      <div className="grid flex-1 grid-cols-[56px_minmax(0,1fr)] content-between items-start gap-3 [@container(min-width:30rem)]:grid-cols-[56px_minmax(0,1fr)_auto] [@container(min-width:30rem)]:content-center [@container(min-width:30rem)]:items-center">
        {/* The photo is a pointer-only target: the name and View profile go to the same page. */}
        <Link to={profileUrl} aria-hidden="true" tabIndex={-1} className="block">
          <Avatar src={person.avatarUrl} name={name} size="lg" className="h-14 w-14 rounded-xl" />
        </Link>
        <div className="min-w-0">
          <h2 id={headingId} className="text-[16px] font-bold leading-tight [overflow-wrap:anywhere]">
            <Link to={profileUrl} className="hover:underline">{name}</Link>
          </h2>
          {roleLine && <p className="mt-0.5 text-[12px] text-[#677080] [overflow-wrap:anywhere] min-[721px]:text-[13px]">{roleLine}</p>}
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-reason-muted">
            <span className={cn('rounded-full px-2 py-1 font-extrabold', HOW_LOOK[person.how])}>{STATE_LABEL[person.how]}</span>
            <time dateTime={person.since}>{since.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</time>
          </p>
        </div>
        <Link
          to={profileUrl}
          aria-label={`View profile of ${name}`}
          className="col-span-2 flex min-h-[44px] items-center justify-center rounded-[11px] bg-[#f5f6f7] px-4 text-[13px] font-bold text-[#2d3440] hover:bg-[#eceef1] [@container(min-width:30rem)]:col-span-1"
        >
          View profile
        </Link>
      </div>
    </article>
  );
}
