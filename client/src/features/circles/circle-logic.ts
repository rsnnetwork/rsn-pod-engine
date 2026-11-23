// ─── Circles: what a member reads and may do (T14, 1 Nov 2026; 30 Oct review 7.4 to 7.6, L21, L22) ────────────────
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/t14-circles.test.ts.
// The server says, per circle, who may do what (CircleAccess: joinPolicy, myStatus, canManage, canInvite,
// requestCount, locked); this turns it into the button, the setting and the sentences. A server from before T14 sends
// none of those fields: then a circle reads as open, and the member's place comes from isMember, as before.
import type { CircleAccess, CircleCreationRequestStatus, CircleEntityLink, CircleJoinPolicy, CircleMyStatus } from '@rsn/shared';
import { E } from '../../realtime/entities';
import { memberActions } from './circle-admin';

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
  /** S2: each pod's visibility (a server from before S2 sends none). */
  pods: Array<{ podId: string; name: string; description: string | null; visibility?: string }>;
  /** Part 3: each event's zone (its time is on its clock, named) and its image, when it has one. */
  upcomingEvents: Array<{
    id: string; title: string; scheduledAt: string; podId: string; forCircle?: boolean; timezone?: string | null; imageUrl?: string | null;
  }>;
  children: Array<{ id: string; name: string; memberCount: number }>;
  /** T15: the entities linked to it (a server from before T15 sends none). */
  entities?: CircleEntityLink[];
}

// Ben field test (13 Nov 2026): a third choice, invitation only. Each sentence starts with its label and a colon: the
// settings sheet shows the label in bold and the rest after it.
export const POLICY_LABEL: Record<CircleJoinPolicy, string> = { open: 'Open', closed: 'Closed', invite_only: 'Invitation only' };
export const POLICY_COPY: Record<CircleJoinPolicy, string> = {
  open: 'Open: anyone on REASON can join.',
  closed: 'Closed: people ask to join and you approve them. People you invite join straight away.',
  invite_only: 'Invitation only: nobody can ask to join. Only the people you or your moderators invite can join.',
};
/** The three choices, in the order every form shows them. */
export const POLICY_ORDER: readonly CircleJoinPolicy[] = ['open', 'closed', 'invite_only'];
/** A new circle starts closed unless its maker chooses otherwise (the server's default too). */
export const NEW_CIRCLE_POLICY: CircleJoinPolicy = 'closed';
export const WHO_CAN_JOIN = 'Who can join';
export const LOCKED_COPY = 'This circle is closed. Ask to join to see its wall, members and events.';
export const INVITE_ONLY_LOCKED_COPY = 'This circle is by invitation only. Its owner or a moderator can invite you.';

/** What someone outside a circle they may not see reads, in the circle's own terms. */
export function lockedCopy(policy: CircleJoinPolicy | undefined): string {
  return policy === 'invite_only' ? INVITE_ONLY_LOCKED_COPY : LOCKED_COPY;
}

/** Whether a circle keeps outsiders out (closed or invitation only). An older server sends no policy: open. */
export function isRestricted(policy: CircleJoinPolicy | undefined): boolean {
  return policy === 'closed' || policy === 'invite_only';
}

/** What the owner is told once a new choice is saved. */
export function policySavedToast(name: string, policy: CircleJoinPolicy): string {
  if (policy === 'closed') return `${name} is closed. People now ask to join.`;
  if (policy === 'invite_only') return `${name} is by invitation only. Only the people you invite can join.`;
  return `${name} is open. Anyone on REASON can join.`;
}
export const NO_REQUESTS = 'Nobody is waiting to join.';
export const ATTACH_EMPTY = 'You have no other pods to attach. Pods you direct or host are listed here.';
/** A search that finds none of the viewer's pods (a pod can be in several circles, so only this circle's own are left out). */
export function attachNoMatch(q: string): string {
  return `None of your pods matches “${q}”.`;
}

/** T15 (30 Oct review 7.3): the circle's Organisations. */
export const ORGANISATIONS = 'Organisations';
export const LINK_ENTITY = 'Link an entity';
export const ORGANISATIONS_EMPTY = 'No organisations are linked to this circle yet.';
export const LINK_SEARCH_HINT = 'Type at least 2 letters of its name.';
export const linkedToast = (entity: string, circle: string) => `${entity} is linked to ${circle}.`;
export const unlinkedToast = (entity: string, circle: string) => `${entity} is no longer linked to ${circle}.`;

/** The member's place, whatever the server sent: myStatus when it says, else isMember (an older server). */
export function placeOf(c: Pick<CircleSummary, 'isMember' | 'myStatus'>): CircleMyStatus {
  if (c.myStatus !== undefined) return c.myStatus;
  return c.isMember ? 'member' : null;
}

/** `none`: an invite-only circle the viewer is outside; there is nothing to press, only a line saying so. */
export type CircleAction = 'join' | 'request' | 'cancel' | 'leave' | 'none';

/**
 * The circle's one button: Join (open), Ask to join (closed, or turned down before: they may ask again),
 * Requested · Cancel (waiting), or Leave. Someone who runs a closed circle without being in it joins directly.
 * Invitation only (Ben field test): no button for someone outside it, only "Invitation only"; an ask from before the
 * circle became invite-only can still be withdrawn.
 */
export function joinButton(c: Pick<CircleSummary, 'isMember' | 'myStatus' | 'joinPolicy' | 'canManage'>): { action: CircleAction; label: string } {
  const place = placeOf(c);
  if (place === 'member') return { action: 'leave', label: 'Leave' };
  if (place === 'requested') return { action: 'cancel', label: 'Requested · Cancel' };
  if (c.joinPolicy === 'invite_only' && !c.canManage) return { action: 'none', label: 'Invitation only' };
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

/**
 * A member row's Remove: never the owner, never yourself (you leave instead), only for the people who run it; S2: a
 * moderator only by the owner (or a platform admin, `isOwner`).
 */
export function canRemoveMember(
  m: Pick<CircleMember, 'userId' | 'role'>,
  me: string | undefined,
  canManage: boolean | undefined,
  isOwner = false,
): boolean {
  return memberActions(m, me, { canManage, isOwner }).includes('remove');
}

/** The role badge on a member row. */
export function roleBadge(role: string): string | null {
  if (role === 'owner') return 'OWNER';
  if (role === 'moderator') return 'MOD';
  return null;
}

/** Where a member's ask for a new circle stands, in plain words (Ben field test, 13 Nov 2026). */
export const REQUEST_STATUS_LABEL: Record<CircleCreationRequestStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  declined: 'Not approved',
  cancelled: 'Withdrawn',
};
