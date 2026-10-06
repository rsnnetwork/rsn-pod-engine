// client/src/features/reason/for-you/ForYouRail.tsx
// Real data only. No "Suggested entities" (no organisations yet) and no event
// photo (events have none): nothing is invented. A card shows a skeleton until its
// answer arrives and says so if it cannot; "none yet" is only said once the server
// has answered that there is none.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import Avatar from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { fetchRecentConnections, personName, reasonKeys, type ForYouPayload } from '../api';
import { firstCharacter } from './firstCharacter';

// GET /pods?status=active: the pods the member is in, each with its live member count.
interface RailPod { id: string; name: string; memberCount: number }

type Load = 'pending' | 'failed' | 'ready';
// No data yet is either still asking or a failed ask; any data at all (even an empty list) is an answer.
const loadOf = (data: unknown, failed: boolean): Load => (data !== undefined ? 'ready' : failed ? 'failed' : 'pending');
// A request waiting for the network (the member is offline) is not on its way, so it counts as failed; it resumes by itself.
const cannotAnswer = (q: { isError: boolean; fetchStatus: string }) => q.isError || q.fetchStatus === 'paused';

const NOTE = 'text-[12px] text-reason-muted';

// "View all" alone names four different links; `all` completes it for anyone who hears the links one by one.
function RailCard({ title, to, all, load, children }: { title: string; to: string; all: string; load: Load; children: ReactNode }) {
  return (
    <section className="rounded-[18px] border border-reason-line bg-white p-3.5 shadow-[0_6px_24px_rgba(16,18,24,.025)]">
      <div className="mb-2 flex items-center justify-between gap-3.5">
        <h2 className="text-[14px] font-bold">{title}</h2>
        <Link to={to} aria-label={`View all ${all}`} className="flex min-h-[44px] items-center px-1 text-[12px] text-[#575f6f] hover:text-reason-red">View all</Link>
      </div>
      {load === 'ready' ? children : load === 'pending' ? <Skeleton className="h-[52px]" /> : <p className={NOTE}>We could not load this just now.</p>}
    </section>
  );
}

const ROW = 'grid min-h-[44px] grid-cols-[38px_1fr_auto] items-center gap-2.5 border-t border-[#f0f1f3] py-2 first:border-t-0';

interface Props {
  /** The For You answer: undefined until it has come, null when there is no upcoming event. */
  nextEvent: ForYouPayload['nextEvent'] | undefined;
  /** True when the For You request could not answer (failed, or waiting for the network), so a missing answer is not still on its way. */
  failed: boolean;
}

export default function ForYouRail({ nextEvent, failed }: Props) {
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  // A key of its own: ['my-pods', ...] is shared by pages that fetch different URLs, and a query's meta
  // belongs to its key, so sharing it lets whichever page fetched last decide which events refresh it.
  const pods = useQuery({
    queryKey: ['reason', 'rail-pods'],
    queryFn: () => api.get('/pods?status=active').then((r) => r.data.data as RailPod[]),
    enabled: !!userId,
    meta: { entities: userId ? [E.userPods(userId)] : [] },
  });
  const recent = useQuery({
    queryKey: reasonKeys.recent,
    queryFn: fetchRecentConnections,
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId)] : [] },
  });
  const when = nextEvent ? new Date(nextEvent.scheduledAt) : null;

  return (
    <aside aria-label="Your context" className="hidden min-w-0 gap-3.5 min-[981px]:grid">
      <RailCard title="Your next event" to="/sessions" all="events" load={loadOf(nextEvent, failed)}>
        {nextEvent && when ? (
          <Link to={`/sessions/${nextEvent.id}`} className="grid grid-cols-[52px_1fr] gap-[11px]">
            <span className="grid h-[52px] place-items-center rounded-[10px] bg-reason-red text-center text-[11px] font-extrabold leading-tight text-white">
              {when.toLocaleString([], { month: 'short' }).toUpperCase()}<br />{String(when.getDate()).padStart(2, '0')}
            </span>
            <span className="min-w-0">
              <b className="block text-[13px] [overflow-wrap:anywhere]">{nextEvent.title}</b>
              <span className="text-[11px] text-reason-muted">{when.toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' })}</span>
            </span>
          </Link>
        ) : (
          <p className={NOTE}>No upcoming event yet. New ones appear here.</p>
        )}
      </RailCard>

      <RailCard title="Your pods" to="/pods" all="pods" load={loadOf(pods.data, cannotAnswer(pods))}>
        {pods.data?.length === 0 ? (
          <p className={NOTE}>You are not in a pod yet.</p>
        ) : pods.data?.slice(0, 3).map((p) => (
          <Link key={p.id} to={`/pods/${p.id}`} className={ROW}>
            {/* Beside the name, not part of it: a screen reader skips the initial. */}
            <span aria-hidden="true" className="grid h-[38px] w-[38px] place-items-center rounded-full bg-[#f1f2f4] font-extrabold">{firstCharacter(p.name)}</span>
            <span className="min-w-0">
              <b className="block truncate text-[12px]">{p.name}</b>
              <span className="text-[10px] text-reason-muted">{p.memberCount === 1 ? '1 member' : `${p.memberCount} members`}</span>
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </RailCard>

      <RailCard title="Recent introductions" to="/messages" all="introductions" load={loadOf(recent.data, cannotAnswer(recent))}>
        {recent.data?.length === 0 ? (
          <p className={NOTE}>When someone accepts a meeting request, they show up here.</p>
        ) : recent.data?.map((r) => {
          const name = personName(r.displayName);
          return (
            <Link key={r.userId} to={`/people/${r.userId}?from=Introductions`} className={ROW}>
              {/* The photo repeats the name beside it, so a screen reader skips it. */}
              <span aria-hidden="true" className="flex"><Avatar src={r.avatarUrl} name={name} size="sm" className="h-[38px] w-[38px]" /></span>
              <span className="min-w-0">
                <b className="block truncate text-[12px]">{name}</b>
                <span className="text-[10px] text-reason-muted">{new Date(r.connectedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
              </span>
              <span className="rounded-full bg-[#e9f8f1] px-2 py-1 text-[10px] font-extrabold text-[#147a4f]">Connected</span>
            </Link>
          );
        })}
      </RailCard>
    </aside>
  );
}
