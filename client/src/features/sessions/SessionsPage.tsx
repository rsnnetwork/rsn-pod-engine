import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Calendar, Plus, Mic, ChevronRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { cn, formatDateTime, LOCAL_TIME_LABEL } from '@/lib/utils';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import MeetingsSection from '@/features/meetings/MeetingsSection';
import { sessionStatusLabel, sessionStatusColor, sessionStatusPhase } from './statusConfig';

// 26 Oct 2026 (CON-04): the meetings two members agree sit above the events, under one filter. The filter is kept in
// the address (?filter=), so Back from a meeting or an event returns to the same view.
type EventFilter = 'upcoming' | 'past' | 'cancelled';

const FILTERS: Array<{ key: EventFilter; label: string }> = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** ?filter= is part of the address, so anyone can write anything into it: Upcoming unless it names another filter. */
const toFilter = (value: string | null): EventFilter => (value === 'past' || value === 'cancelled' ? value : 'upcoming');

/** What the list reads of each event GET /sessions returns (its times arrive as ISO strings). */
interface EventRow {
  id: string;
  title: string | null;
  status: string;
  scheduledAt: string | null;
  hostUserId: string;
  podName?: string | null;
  hostDisplayName?: string | null;
}

/** What the page reads of each of the member's pods: whether they may run events in it. */
interface PodRole { memberRole?: string | null }

/** Upcoming is still to come or under way (a live event included), Past has ended, Cancelled is cancelled. */
function inFilter(status: string, filter: EventFilter): boolean {
  const phase = sessionStatusPhase(status);
  if (filter === 'past') return phase === 'done';
  if (filter === 'cancelled') return phase === 'cancelled';
  return phase === 'pre' || phase === 'live';
}

export default function SessionsPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const currentUserId = user?.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = toFilter(searchParams.get('filter'));
  // Replaced, not pushed: Back leaves Events rather than stepping through every filter tried.
  const choose = (next: EventFilter) => setSearchParams(next === 'upcoming' ? {} : { filter: next }, { replace: true });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get('/sessions').then(r => (r.data.data ?? []) as EventRow[]),
    meta: { entities: currentUserId ? [E.userSessions(currentUserId)] : [] },
  });

  const { data: myPods } = useQuery({
    queryKey: ['my-pods'],
    queryFn: () => api.get('/pods?status=active').then(r => (r.data.data ?? []) as PodRole[]),
    meta: { entities: currentUserId ? [E.userPods(currentUserId)] : [] },
  });
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const canCreateEvent = isAdmin || (myPods ?? []).some((p) => p.memberRole === 'director' || p.memberRole === 'host');

  // statusVariant retained for legacy 'active' / 'in_progress' values that may appear
  // in the API payload alongside the official enum; for canonical statuses, prefer
  // sessionStatusColor.
  const statusVariant = (s: string) => {
    if (s === 'active' || s === 'in_progress') return 'success';
    return sessionStatusColor(s);
  };

  const filtered = (data ?? []).filter((s) => inFilter(s.status, filter));

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Events</h1>
        {canCreateEvent ? (
          <Button onClick={() => navigate('/sessions/new')} className="btn-glow"><Plus className="h-4 w-4 mr-2" /> New Event</Button>
        ) : (
          // 21 Sep 2026 (Shradha's deck, P3): "users cannot create events" was
          // reported as a fault. It is the rule, but the rule was invisible —
          // the button simply was not there and nothing said why, which reads
          // as something broken. Say who can, and how to become one.
          <p className="max-w-[16rem] text-right text-xs text-gray-500">
            Events are run by pod directors and hosts.{' '}
            <button
              type="button"
              onClick={() => navigate('/pods')}
              className="font-medium text-rsn-red underline underline-offset-2"
            >
              Start a pod
            </button>{' '}
            to run your own.
          </p>
        )}
      </div>

      {/* One filter for the meetings and the events below it. */}
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5 font-reason animate-fade-in-up">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => choose(f.key)}
            aria-pressed={filter === f.key}
            className={cn(
              'flex min-h-[44px] items-center rounded-full border px-4 text-[13px] font-bold',
              filter === f.key ? 'border-[#ffc9c4] bg-reason-pink text-reason-red-hover' : 'border-reason-line text-[#4d5562] hover:bg-reason-soft',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <MeetingsSection scope={filter} />

      <section aria-labelledby="pod-events-title" className="space-y-3">
        <h2 id="pod-events-title" className="font-reason text-[18px] font-extrabold tracking-[-0.02em] text-reason-ink">Pod events</h2>
        {isLoading ? (
          <div className="flex justify-center py-10" aria-busy="true">
            <Spinner className="h-7 w-7" />
            <span className="sr-only">Loading events</span>
          </div>
        ) : isError && !data ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-reason-line bg-white p-4 font-reason">
            <p className="text-[15px] font-bold">We could not load events just now.</p>
            <button type="button" onClick={() => void refetch()} className="inline-flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white hover:bg-reason-red-hover">
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Calendar className="h-8 w-8" />}
            title={`No ${filter} events`}
            description={
              filter !== 'upcoming'
                ? 'No events match this filter.'
                : canCreateEvent
                  ? 'Schedule an event to start connecting.'
                  : 'Events are run by pod directors and hosts. Join a pod to be invited to theirs, or start your own.'
            }
            action={filter === 'upcoming'
              ? canCreateEvent
                ? <Button onClick={() => navigate('/sessions/new')}>Schedule Event</Button>
                : <Button onClick={() => navigate('/pods')}>Browse pods</Button>
              : undefined}
          />
        ) : (
          <div className="grid gap-4 animate-fade-in-up">
            {filtered.map((s) => {
              const isHost = s.hostUserId === user?.id;
              return (
                <Card key={s.id} hover onClick={() => navigate(`/sessions/${s.id}`)} className="card-hover">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-gray-800">
                          {s.title || 'Open event'}
                        </p>
                        {isHost && (
                          <Badge variant="brand" className="text-xs">
                            <Mic className="h-3 w-3 mr-1" /> Hosting
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-0.5">
                        {s.scheduledAt ? `${formatDateTime(s.scheduledAt)} ${LOCAL_TIME_LABEL}` : 'No date'}
                        {s.podName && <span className="ml-2 text-gray-400">· {s.podName}</span>}
                        {s.hostDisplayName && !isHost && (
                          <span className="ml-2 text-gray-400">· Host: {s.hostDisplayName}</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Badge variant={statusVariant(s.status)}>{sessionStatusLabel(s.status)}</Badge>
                      <ChevronRight className="h-4 w-4 text-gray-300" />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
