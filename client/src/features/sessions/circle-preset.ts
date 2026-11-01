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

/** "Founding Circle's", and "AI Developers'" for a name that ends in s. */
export function possessive(name: string): string {
  const trimmed = name.trim();
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

/** What the Private choice means for a circle event (the label above it reads "Private"). */
export function circlePrivateSummary(name: string): string {
  return `Only ${possessive(name)} members and people you invite.`;
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

export type CircleGate = 'loading' | 'missing' | 'refused' | 'ok';

/**
 * What the form does with ?circleId=: wait for the circle, say it could not be opened (archived, or not there), say it
 * is not theirs to schedule (only its managers and platform admins may: the server's canManage), or go.
 */
export function circleGate(q: { isLoading: boolean; circle?: { canManage?: boolean } | null }): CircleGate {
  if (q.isLoading) return 'loading';
  if (!q.circle) return 'missing';
  return q.circle.canManage ? 'ok' : 'refused';
}

/** Duplicate keeps the circle the event is for; an event with none sends none, as production's copy does. */
export function duplicateCircleField(session: { circleId?: string | null }): { circleId?: string } {
  return session.circleId ? { circleId: session.circleId } : {};
}
