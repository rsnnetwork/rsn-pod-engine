// ─── Circles: what a member reads and may do (T14, 1 Nov 2026; 30 Oct review 7.4 to 7.6, L21, L22) ────────────────
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/t14-circles.test.ts.
// The server says, per circle, who may do what (CircleAccess: joinPolicy, myStatus, canManage, canInvite,
// requestCount, locked); this turns it into the button, the setting and the sentences. A server from before T14 sends
// none of those fields: then a circle reads as open, and the member's place comes from isMember, as before.
import type { CircleAccess, CircleJoinPolicy, CircleMyStatus } from '@rsn/shared';
import { E } from '../../realtime/entities';

/** What the list and the page read of a circle, the T14 fields optional (an older server sends none). */
export interface CircleSummary extends Partial<CircleAccess> {
  id: string;
  name: string;
  description: string | null;
  parentCircleId: string | null;
  memberCount: number;
  podCount: number;
  isMember: boolean;
}

export interface CircleMember { userId: string; displayName: string | null; avatarUrl: string | null; role: string }

export interface CircleDetail extends CircleSummary {
  members: CircleMember[];
  pods: Array<{ podId: string; name: string; description: string | null }>;
  upcomingEvents: Array<{ id: string; title: string; scheduledAt: string; podId: string; forCircle?: boolean }>;
  children: Array<{ id: string; name: string; memberCount: number }>;
}

export const POLICY_LABEL: Record<CircleJoinPolicy, string> = { open: 'Open', closed: 'Closed' };
export const POLICY_COPY: Record<CircleJoinPolicy, string> = {
  open: 'Open: anyone on REASON can join.',
  closed: 'Closed: people ask to join and you approve them. People you invite join straight away.',
};
export const WHO_CAN_JOIN = 'Who can join';
export const LOCKED_COPY = 'This circle is closed. Ask to join to see its wall, members and events.';
export const NO_REQUESTS = 'Nobody is waiting to join.';
export const ATTACH_EMPTY = 'You have no other pods to attach. Pods you direct or host are listed here.';

/** The member's place, whatever the server sent: myStatus when it says, else isMember (an older server). */
export function placeOf(c: Pick<CircleSummary, 'isMember' | 'myStatus'>): CircleMyStatus {
  if (c.myStatus !== undefined) return c.myStatus;
  return c.isMember ? 'member' : null;
}

export type CircleAction = 'join' | 'request' | 'cancel' | 'leave';

/**
 * The circle's one button: Join (open), Ask to join (closed, or turned down before: they may ask again),
 * Requested · Cancel (waiting), or Leave. Someone who runs a closed circle without being in it joins directly.
 */
export function joinButton(c: Pick<CircleSummary, 'isMember' | 'myStatus' | 'joinPolicy' | 'canManage'>): { action: CircleAction; label: string } {
  const place = placeOf(c);
  if (place === 'member') return { action: 'leave', label: 'Leave' };
  if (place === 'requested') return { action: 'cancel', label: 'Requested · Cancel' };
  if (c.joinPolicy === 'closed' && !c.canManage) return { action: 'request', label: 'Ask to join' };
  return { action: 'join', label: 'Join' };
}

/** What the member is told after the button's call answered. */
export function joinToast(action: CircleAction, name: string, answer?: { status?: string }): string {
  if (action === 'leave') return `You left ${name}.`;
  if (action === 'cancel') return 'Your request was withdrawn.';
  if (action === 'request' && answer?.status === 'requested') return `Your request to join ${name} was sent.`;
  return `Welcome to ${name}!`;
}

/**
 * The tags a circle's page follows: the circle (and its members) and the member's own circles and events (T13: a new
 * event for the circle, or a change to one of its events, reaches the member's own events list); managers add the asks.
 */
export function circleEntities(circleId: string, me: string | undefined, manager = false): string[] {
  const tags = [E.circle(circleId), E.circleMembers(circleId)];
  if (me) tags.push(E.userCircles(me), E.user(me), E.userSessions(me));
  if (manager) tags.push(E.circleRequests(circleId));
  return tags;
}

/** "Requests (3)" on the managers' button; just "Requests" when nobody waits. */
export function requestsLabel(n: number | undefined): string {
  return n && n > 0 ? `Requests (${n})` : 'Requests';
}

/** After New pod in a circle: the page stays on the circle. */
export function podMadeToast(pod: string, circle: string): string {
  return `${pod} is created and added to ${circle}.`;
}

/** A member row's Remove: never the owner, never yourself (you leave instead), only for the people who run it. */
export function canRemoveMember(m: Pick<CircleMember, 'userId' | 'role'>, me: string | undefined, canManage: boolean | undefined): boolean {
  return !!canManage && m.userId !== me && m.role !== 'owner';
}

/** The role badge on a member row. */
export function roleBadge(role: string): string | null {
  if (role === 'owner') return 'OWNER';
  if (role === 'moderator') return 'MOD';
  return null;
}
