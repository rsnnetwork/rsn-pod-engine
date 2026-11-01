// ─── A pod's events, on the pod's page (extracted from PodDetailPage.tsx, P1 item 16) ─────────────────────────────
//
// The server lists a pod's events to its active members and to admins (the page works out which, `mayReadEvents`)
// and answers 403 to anyone else. It reads the route's largest page (P1 item 15): the default page of twenty, newest
// first, dropped a busy pod's soonest upcoming events; past a hundred the heading says "and more". Someone who may not
// read them sees a sentence and no count, so a just-removed member never keeps a cached "Events (3)".
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Spinner';
import { isForbidden, retryUnlessAnswered } from '@/components/wall/wall-logic';
import { sessionStatusColor, sessionStatusLabel } from '@/features/sessions/statusConfig';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { E } from '@/realtime/entities';
import { podEventsInOrder } from './pod-event-order';

/** The most events the page reads (the route's largest page); the heading says "and more" past it. */
export const EVENTS_PAGE = 100;
const eventsCount = (n: number): string => (n >= EVENTS_PAGE ? `${EVENTS_PAGE} and more` : String(n));

interface PodEventRow {
  id: string;
  title: string | null;
  scheduledAt: string | null;
  status: string;
}

export default function PodEventsSection({ podId, mayReadEvents }: { podId: string; mayReadEvents: boolean }) {
  const navigate = useNavigate();
  const {
    data: podSessions, isError: sessionsFailed, error: sessionsError, refetch: refetchSessions,
  } = useQuery({
    queryKey: ['pod-sessions', podId],
    queryFn: () => api.get(`/sessions?podId=${podId}&pageSize=${EVENTS_PAGE}`).then(r => (r.data.data ?? []) as PodEventRow[]),
    enabled: !!podId && mayReadEvents,
    retry: retryUnlessAnswered,
    meta: { entities: podId ? [E.pod(podId), E.podSessions(podId)] : [] },
  });
  // Refused all the same: the page's copy of the pod still named a role the member has just lost.
  const eventsRefused = isForbidden(sessionsError);

  return (
    <section id="pod-events" className="scroll-mt-4 animate-fade-in-up stagger-2">
      <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
        <Calendar className="h-5 w-5 text-rsn-red" /> Events{podSessions && mayReadEvents && !eventsRefused ? ` (${eventsCount(podSessions.length)})` : ''}
      </h2>
      {!mayReadEvents || eventsRefused ? (
        <Card className="!p-4">
          <p className="text-center text-sm text-gray-500">Members see the pod's events here.</p>
        </Card>
      ) : sessionsFailed && !podSessions ? (
        <Card className="!p-4 text-center">
          <p className="text-sm text-gray-600">We could not load the events just now.</p>
          <Button variant="ghost" onClick={() => void refetchSessions()} className="mx-auto mt-2 min-h-[44px]">Try again</Button>
        </Card>
      ) : !podSessions ? (
        <Skeleton className="h-16" />
      ) : podSessions.length > 0 ? (
        <div className="grid grid-cols-1 gap-2">
          {podEventsInOrder(podSessions).map((s) => (
            <Card
              key={s.id}
              className="!p-4 cursor-pointer hover:border-gray-300 transition-colors"
              onClick={() => navigate(`/sessions/${s.id}`)}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-[#1a1a2e]">{s.title || 'Untitled Event'}</p>
                  <p className="text-xs text-gray-400">
                    {s.scheduledAt ? formatDateTime(s.scheduledAt) : 'No date set'}
                  </p>
                </div>
                {/* One helper names every state in plain words (21 Sep 2026: this showed the raw "round_transition"). */}
                <Badge variant={sessionStatusColor(s.status)} className="shrink-0">
                  {sessionStatusLabel(s.status)}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="!p-4">
          <p className="text-center text-sm text-gray-400">No events yet.</p>
        </Card>
      )}
    </section>
  );
}
