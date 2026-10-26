// client/src/features/meetings/useMeetings.ts
// Everything the meetings screens read and write: the lists under Events, the Events count, one meeting, and its
// cancel (GET /meetings, /meetings/summary, /meetings/:id, POST /meetings/:id/cancel).
//
// Each read declares the tags the server sends whenever a meeting is booked, moved, cancelled, attended or reminded
// (user:<id>:meetings to each of its two people, meeting:<id> with it), and the blocks tag, since a block hides a pair's
// meetings from both of them. So every screen redraws on its own, on both accounts. The clock moves them too: Join
// opens 5 minutes before the start, so the screens also redraw at that moment (useNow), with no request.
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Meeting, MeetingList, MeetingScope, MeetingSummary } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { shouldRetry } from '@/features/reason/human/profile-text';
import { eventsBadge, isMeetingId, nextChangeAt, tickDelay, type EventsBadge, type Timed } from './meeting-words';

export const meetingKeys = {
  all: ['meetings'] as const,
  list: (scope: MeetingScope) => ['meetings', 'list', scope] as const,
  summary: ['meetings', 'summary'] as const,
  detail: (id: string) => ['meetings', 'detail', id] as const,
};

/** One page of a list (the server takes 1 to 50). */
const PAGE_SIZE = 20;

const fetchMeetings = (scope: MeetingScope, before: string | null) =>
  api.get('/meetings', { params: { scope, limit: PAGE_SIZE, ...(before ? { before } : {}) } }).then((r) => r.data.data as MeetingList);
const fetchSummary = () => api.get('/meetings/summary').then((r) => r.data.data as MeetingSummary);
const fetchMeeting = (id: string) => api.get(`/meetings/${encodeURIComponent(id)}`).then((r) => r.data.data as Meeting);
const cancelMeeting = (id: string) => api.post(`/meetings/${encodeURIComponent(id)}/cancel`).then((r) => r.data.data as Meeting);

const useMe = () => useAuthStore((s) => s.user?.id as string | undefined);

/** One of the three lists under Events, a page at a time: upcoming soonest first, past and cancelled latest first. */
export function useMeetingList(scope: MeetingScope) {
  const me = useMe();
  return useInfiniteQuery({
    queryKey: meetingKeys.list(scope),
    queryFn: ({ pageParam }) => fetchMeetings(scope, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: !!me,
    meta: { entities: me ? [E.userMeetings(me), E.userBlocks(me)] : [] },
  });
}

/** How many meetings are still to come, whether one can be joined now, and which is next: the Events count. */
export function useMeetingSummary() {
  const me = useMe();
  return useQuery({
    queryKey: meetingKeys.summary,
    queryFn: fetchSummary,
    enabled: !!me,
    meta: { entities: me ? [E.userMeetings(me), E.userBlocks(me)] : [] },
  });
}

/** One meeting; none is asked for until there is an id, and an address that is no meeting id never is. */
export function useMeeting(id: string | null) {
  const me = useMe();
  return useQuery({
    queryKey: meetingKeys.detail(id ?? ''),
    queryFn: () => fetchMeeting(id ?? ''),
    enabled: !!me && !!id && isMeetingId(id),
    // A 4xx is an answer (not yours, gone, a bad id), so asking again changes nothing.
    retry: shouldRetry,
    meta: { entities: id && me ? [E.meeting(id), E.userBlocks(me)] : [] },
  });
}

/** Cancel, once: the server answers a repeat with the meeting as it stands. */
export function useCancelMeeting(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cancelMeeting(id),
    // The server tells both people's screens too; this is the canceller's own, without waiting for the socket.
    onSettled: () => qc.invalidateQueries({ queryKey: meetingKeys.all }),
  });
}

/**
 * The time, redrawn every `every` ms (null: no regular tick) and at the moment `wakeAtFor` names: the next change of
 * phase, worked out from the time this screen last drew. A moment that has passed by the time the timer is set (the
 * screen drew with an older time, then its data changed) redraws it at once.
 */
export function useNow(every: number | null, wakeAtFor?: (now: number) => number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const wakeAt = wakeAtFor ? wakeAtFor(now) : null;
  useEffect(() => {
    const current = Date.now();
    const delay = wakeAt !== null && wakeAt <= current ? 0 : tickDelay(current, every, wakeAt);
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [now, every, wakeAt]);
  return now;
}

/** The countdown on a meeting ("Starts in 25 min") moves by the minute, so its screens redraw this often. */
export const COUNTDOWN_TICK_MS = 30_000;

/** The time for screens that show meetings: every half minute for the countdown, and at the moment Join opens or closes. */
export function useMeetingClock(meetings: Timed[]): number {
  return useNow(COUNTDOWN_TICK_MS, (at) => nextChangeAt(meetings, at));
}

/**
 * The Events count and its live dot, for the sidebar, the rail and the phone bar. The next meeting is read as well,
 * for its length: that says when it stops being joinable, and so when the count goes down. At that moment the count
 * is read again; the rail and the phone bar share the one request.
 */
export function useEventsBadge(): EventsBadge {
  const qc = useQueryClient();
  const { data: summary } = useMeetingSummary();
  const { data: next } = useMeeting(summary?.next?.id ?? null);
  const now = useNow(null, (at) => eventsBadge(summary, next, at).wakeAt);
  const badge = eventsBadge(summary, next, now);
  useEffect(() => {
    if (badge.outOfDate) void qc.invalidateQueries({ queryKey: meetingKeys.summary }, { cancelRefetch: false });
  }, [badge.outOfDate, qc]);
  return badge;
}
