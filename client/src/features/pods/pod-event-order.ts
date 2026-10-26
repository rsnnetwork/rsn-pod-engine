// The order a pod's page lists its events in. Pure on purpose (no React, axios, store or router), so a test can run
// it: server/src/__tests__/client/pod-wall-client.test.ts.

import { sessionStatusPhase, type StatusPhase } from '../sessions/statusConfig';

interface PodEventLike {
  status: string;
  scheduledAt: string | null;
}

// Live first, then what is coming, then what is over (ended and cancelled together).
const GROUP: Record<StatusPhase, number> = { live: 0, pre: 1, done: 2, cancelled: 2 };

const timeOf = (e: PodEventLike): number | null => {
  const t = e.scheduledAt ? Date.parse(e.scheduledAt) : NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * The pod's events as a member looks for them: what is live now, then what is coming, soonest first, then what has
 * ended or was cancelled, latest first. An event with no date yet comes after the dated ones of its group. The server
 * sends them newest date first, which put the event furthest off at the top and the next one somewhere below it.
 */
export function podEventsInOrder<T extends PodEventLike>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => {
    const group = GROUP[sessionStatusPhase(a.status)] - GROUP[sessionStatusPhase(b.status)];
    if (group !== 0) return group;
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta === null || tb === null) return (ta === null ? 1 : 0) - (tb === null ? 1 : 0);
    return GROUP[sessionStatusPhase(a.status)] === GROUP.done ? tb - ta : ta - tb;
  });
}
