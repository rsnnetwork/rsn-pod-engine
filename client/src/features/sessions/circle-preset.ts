// ─── An event for a whole circle: the words and the rules (T13, 1 Nov 2026; 30 Oct review 6.5, L20) ──────────────
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/t13-circle-event-ui.test.ts.
// The circle's managers schedule from the circle page (?circleId=). The event still lives in a pod they run; the circle's
// active members are its audience too, so "private" means the circle (and the pod) plus the people invited. The server
// holds every rule (who may schedule, who sees it); this only words them and orders the form.

/** "9 members", "1 member". */
export function membersWord(n: number): string {
  return `${n} ${n === 1 ? 'member' : 'members'}`;
}

/** The form's line naming who the event is for. */
export function circleForLine(name: string, memberCount: number): string {
  return `For everyone in ${name} · ${membersWord(memberCount)}`;
}

/**
 * What the Private choice reads for a circle event, the brief's words verbatim (fix round 1):
 * "Private: only {circle}'s members and people you invite". The card draws the lead in bold, then the rest.
 */
export const CIRCLE_PRIVATE_LEAD = 'Private:';

export function circlePrivateRest(name: string): string {
  return `only ${name.trim()}'s members and people you invite`;
}

export function circlePrivateLine(name: string): string {
  return `${CIRCLE_PRIVATE_LEAD} ${circlePrivateRest(name)}`;
}

/** The event page's private notice for a circle event (final fix wave CM2, 2 Nov 2026): the circle, not the pod. */
export function circlePrivateNotice(name: string): string {
  return `This event is private. It is for ${name.trim()}'s members and the people the host invites.`;
}

/** The pod choice: the circle's own pods (that you run) first, then your other pods, each kept in its order. */
export function podsForCircle<T extends { id: string }>(pods: T[], attachedPodIds: string[]): { inCircle: T[]; others: T[] } {
  const attached = new Set(attachedPodIds);
  return { inCircle: pods.filter((p) => attached.has(p.id)), others: pods.filter((p) => !attached.has(p.id)) };
}

/** Where "Schedule an event" on a circle page goes. */
export function scheduleForCircleHref(circleId: string): string {
  return `/sessions/new?circleId=${encodeURIComponent(circleId)}`;
}

/** The event page's line naming the circle it is for. */
export function eventCircleLine(name: string): string {
  return `For ${name}`;
}

export type CircleGate = 'loading' | 'missing' | 'error' | 'refused' | 'ok';

/**
 * What the form does with ?circleId=: wait for the circle; say it could not be opened (the server has no such circle:
 * archived, or not there); say it could not be loaded (any other failure: the connection, a server error), with a
 * retry; say it is not theirs to schedule (only its managers and platform admins may: the server's canManage); or go.
 */
export function circleGate(q: {
  isLoading: boolean;
  isError?: boolean;
  notFound?: boolean;
  circle?: { canManage?: boolean } | null;
}): CircleGate {
  if (q.isLoading) return 'loading';
  if (q.circle) return q.circle.canManage ? 'ok' : 'refused';
  if (q.isError && !q.notFound) return 'error';
  return 'missing';
}

/** Duplicate keeps the circle the event is for; an event with none sends none, as production's copy does. */
export function duplicateCircleField(session: { circleId?: string | null }): { circleId?: string } {
  return session.circleId ? { circleId: session.circleId } : {};
}
