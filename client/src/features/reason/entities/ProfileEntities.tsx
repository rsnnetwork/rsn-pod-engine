// client/src/features/reason/entities/ProfileEntities.tsx
// "Entities & roles" on Your profile (Task 11, brief item 5): your own entities with your role and title, each opening
// the entity, as members see them on your Human Profile, and always "Add your company".
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import { Section } from '../human/ProfileDetails';
import { shouldRetry, statusOf } from '../human/profile-text';
import { ADD_COMPANY_TO } from '../profile/your-profile-text';
import EntityRows from './EntityRows';
import { entityKeys, fetchPersonEntities } from './entity-api';
import { loadFailedLine } from './entity-text';
import { QUIET_BUTTON } from './look';

const BODY = 'text-[14px] leading-relaxed text-[#505762] [overflow-wrap:anywhere]';

export default function ProfileEntities() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  // Every write that changes your entities (a create, a join, a role change, a leave, an edit or archive of one of
  // them) tells you user:<you>:entities, on any of your devices.
  const mine = useQuery({
    queryKey: entityKeys.person(me ?? ''),
    queryFn: () => fetchPersonEntities(me ?? ''),
    enabled: !!me,
    retry: shouldRetry,
    meta: { entities: me ? [E.userEntities(me)] : [] },
  });
  // Your own id is never a 404 on this route, so a 404 is an API without it (the live one, until it ships): none.
  const entities = statusOf(mine.error) === 404 ? [] : mine.data;
  // Offline, the library holds the request back instead of failing it: that is a failure to say, not a skeleton.
  const failed = entities === undefined && (mine.isError || mine.fetchStatus === 'paused');

  return (
    <Section kicker="Entities & roles" title={entities?.length ? 'The entities around you.' : 'Show where you work.'}>
      {failed ? (
        <div role="alert" className="grid justify-items-start gap-2.5">
          <p className={BODY}>We could not load your entities just now. {loadFailedLine(mine.error, mine.fetchStatus)}</p>
          <button type="button" onClick={() => void mine.refetch()} className={QUIET_BUTTON}>Try again</button>
        </div>
      ) : entities === undefined ? (
        <div className="grid gap-1.5" aria-busy="true">
          <span className="sr-only" role="status">Loading your entities</span>
          <Skeleton className="h-[56px] rounded-[14px]" />
        </div>
      ) : entities.length > 0 ? (
        <EntityRows entities={entities} />
      ) : (
        <p className={BODY}>Add your company and your role in it. Members see it on your profile.</p>
      )}
      <Link to={ADD_COMPANY_TO} className={cn(QUIET_BUTTON, 'mt-3.5 w-fit')}>Add your company</Link>
    </Section>
  );
}
