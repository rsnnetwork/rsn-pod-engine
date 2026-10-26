// What the scheduler shows, as the server says it: both people's saved times, the times both can still confirm, the
// meeting, and the days on offer on the reader's own clock. The clock moves each minute, so a time that starts while
// the panel is open drops out.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { E } from '@/realtime/entities';
import api from '@/lib/api';
import {
  SLOT_MINUTES, confirmable, dayKeyOf, daySlots, hasStarted, isSlotKey, meetingStands, upcomingDays,
} from './scheduler-flow';
import { schedulingKey, type Scheduling } from './scheduling-types';

const DAYS_AHEAD = 7;

export function useSchedulerData(conversationId: string, zone: string, selectedDay: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const query = useQuery<Scheduling>({
    queryKey: schedulingKey(conversationId),
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    refetchInterval: 15_000, // partner's picks appear without a refresh
    // The confirmed window lives on dm_conversations, so a confirm on either
    // side (which emits the dm-conversation entity) refreshes this panel live.
    meta: { entities: [E.dmConversation(conversationId)] },
  });
  const data = query.data;

  // The days on offer, each with every half hour it has in this zone. Built
  // again every half hour, so late at night today gives way to tomorrow.
  const halfHour = Math.floor(now / (SLOT_MINUTES * 60_000));
  const days = useMemo(
    () => upcomingDays(Date.now(), zone, DAYS_AHEAD).map(dayKey => ({ dayKey, slots: daySlots(dayKey, zone) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- halfHour is the clock this list follows
    [zone, halfHour],
  );

  const savedMine = useMemo(() => new Set((data?.mine ?? []).filter(isSlotKey)), [data]);
  const theirSet = useMemo(() => new Set((data?.theirs ?? []).filter(isSlotKey)), [data]);
  const standing = meetingStands(data?.confirmed, now);
  const bookedKey = standing && data?.confirmed && isSlotKey(data.confirmed.window) ? data.confirmed.window : null;
  // What can still be confirmed: times BOTH have saved, still ahead. With a
  // meeting standing, the others are where it can be moved to.
  const confirmables = confirmable(data?.overlap ?? [], now).filter(k => k !== bookedKey);

  // Until the member picks a day, open on the first day where you both can,
  // else where they can, else the first day on offer — so what matters is
  // visible at once. Derived (not an effect) so the strip never paints today
  // first and then jumps.
  const autoDay = useMemo(() => {
    const ahead = (k: string) => !hasStarted(k, now);
    const bothDays = new Set([...savedMine].filter(k => theirSet.has(k) && ahead(k)).map(k => dayKeyOf(k, zone)));
    const theirDays = new Set([...theirSet].filter(ahead).map(k => dayKeyOf(k, zone)));
    return (days.find(d => bothDays.has(d.dayKey)) ?? days.find(d => theirDays.has(d.dayKey)) ?? days[0]).dayKey;
  }, [days, savedMine, theirSet, zone, now]);
  const current = days.find(d => d.dayKey === (selectedDay ?? autoDay)) ?? days[0];
  // Times that have started are not offered: nobody can meet in the past.
  const visible = current.slots.filter(k => !hasStarted(k, now));

  return {
    query, data, now, days, savedMine, theirSet, standing, bookedKey, confirmables, current, visible,
    /** When the server last answered: a card judges "no longer shared" only on an answer newer than itself. */
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

export type SchedulerData = ReturnType<typeof useSchedulerData>;
