// client/src/features/reason/for-you/ForYouWaiting.tsx
// "Waiting for their answer" (22 Nov 2026, Stefan approved): the people the member asked to meet who have not answered
// yet. They used to keep their For You cards, badged "Request sent", and a member who had asked many people found every
// suggestion was someone already asked. Now they sit here, below the suggestions: the lasting sign that a request went,
// without taking a place. Each opens the person's profile (Withdraw is there); the full list is on Matches.
import { Link } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import ProfileBadge from '@/components/ui/ProfileBadge';
import { personName, type WaitingRequest } from '../api';
import { personHref } from '../human/profile-text';
import { waitingRow } from './for-you-view';

/** Where every waiting request is listed, with Withdraw beside each. */
export const ALL_WAITING_TO = '/matches#waiting';

interface Props { waiting: WaitingRequest[] | undefined; waitingCount: number | undefined }

export default function ForYouWaiting({ waiting, waitingCount }: Props) {
  const { shown, more } = waitingRow(waiting, waitingCount);
  if (shown.length === 0) return null;
  const total = shown.length + more;
  return (
    <section aria-labelledby="foryou-waiting-title" className="mt-4 border-t border-reason-line pt-3.5" data-testid="foryou-waiting">
      <h3 id="foryou-waiting-title" className="text-[14px] font-bold">Waiting for their answer ({total})</h3>
      <p className="mt-0.5 text-[12px] text-reason-muted">People you asked to meet. When they say yes, you can talk and book a time.</p>
      <ul className="mt-2 grid gap-1 min-[481px]:grid-cols-2 min-[1280px]:grid-cols-3">
        {shown.map((w) => {
          const name = personName(w.displayName);
          const about = [w.professionalRole, w.company].filter(Boolean).join(' · ');
          return (
            <li key={w.userId} className="min-w-0">
              <Link to={personHref(w.userId, 'For You')} className="flex min-h-[44px] items-center gap-2.5 rounded-[11px] px-1.5 py-1 hover:bg-reason-soft">
                {/* The photo repeats the name beside it, so a screen reader skips it. */}
                <span aria-hidden="true" className="flex shrink-0"><Avatar src={w.avatarUrl} name={name} size="sm" className="h-8 w-8" /></span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <b className="truncate text-[13px]">{name}</b>
                    <ProfileBadge badge={w.profileBadge} />
                  </span>
                  {about && <span className="block truncate text-[11px] text-reason-muted">{about}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Link to={ALL_WAITING_TO} aria-label={`See all ${total} people waiting for their answer`} className="mt-1 inline-flex min-h-[44px] items-center px-1.5 text-[12px] font-bold text-[#575f6f] hover:text-reason-red">
          and {more} more
        </Link>
      )}
    </section>
  );
}
