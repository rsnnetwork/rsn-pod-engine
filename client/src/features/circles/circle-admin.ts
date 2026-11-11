// ─── Circles: roles, editing, invitations and pods (Shirley pilot S2, 11 Nov 2026; D2, D3) ───────────────────────
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/s2-circle-admin.test.ts.
// Split from circle-logic.ts, which keeps the join button, the asks and the tags.
import type { CircleJoinPolicy } from '@rsn/shared';
import { E } from '../../realtime/entities';
import type { CircleMember, CircleSummary } from './circle-logic';

// The server decides every one of these; the page only hides what the viewer may not do. Moderators run the circle
// with its owner (members, asks, invitations, pods, events, details); only the owner (or a platform admin, `isOwner`)
// makes and unmakes moderators, hands the circle over and chooses who can join, and only they remove a moderator.

/** The viewer owns the circle (their own role, not a platform admin's powers): they cannot leave it. */
export function ownsCircle(c: Pick<CircleSummary, 'myRole'>): boolean {
  return c.myRole === 'owner';
}

export type MemberAction = 'make-moderator' | 'remove-moderator' | 'make-owner' | 'remove';

/**
 * What the viewer may do to one member row, in menu order. Nothing to themselves or to the owner. The owner's powers:
 * make or unmake a moderator, hand the circle over, remove anyone. A moderator removes plain members only.
 */
export function memberActions(
  m: Pick<CircleMember, 'userId' | 'role'>,
  me: string | undefined,
  c: Pick<CircleSummary, 'canManage' | 'isOwner'>,
): MemberAction[] {
  if (!c.canManage || !me || m.userId === me || m.role === 'owner') return [];
  if (c.isOwner) {
    return [m.role === 'moderator' ? 'remove-moderator' : 'make-moderator', 'make-owner', 'remove'];
  }
  return m.role === 'moderator' ? [] : ['remove'];
}

export const MEMBER_ACTION_LABEL: Record<MemberAction, string> = {
  'make-moderator': 'Make moderator',
  'remove-moderator': 'Remove as moderator',
  'make-owner': 'Make owner',
  remove: 'Remove from circle',
};

/** The handover's question: what changes for both people, said before it happens. */
export function handoverQuestion(person: string, circle: string): { title: string; body: string } {
  return {
    title: `Make ${person} the owner of ${circle}?`,
    body: `${person} will own ${circle}: they choose its moderators, who can join, and can hand it on. You become a moderator, so you keep running it with them, but you can no longer change roles or hand it over.`,
  };
}

/** What the member is told after a role change or a handover. */
export function roleToast(action: Exclude<MemberAction, 'remove'>, person: string, circle: string): string {
  if (action === 'make-moderator') return `${person} is now a moderator of ${circle}.`;
  if (action === 'remove-moderator') return `${person} is no longer a moderator.`;
  return `${person} now owns ${circle}. You are a moderator.`;
}

/** Why the owner has no Leave button, said where it would be. */
export const OWNER_STAYS = 'You own this circle. To leave it, make someone else its owner first.';

export const EDIT_DETAILS = 'Edit details';
export const INVITATIONS = 'Invitations';
export const INVITATIONS_EMPTY = 'No invitations yet. People you invite are listed here.';
export const CIRCLE_NAME_MIN = 2;
export const CIRCLE_NAME_MAX = 120;
export const CIRCLE_DESCRIPTION_MAX = 2000;

/** The edit form's saved values: only the fields that changed, trimmed (an empty description clears it). */
export function circleEdits(
  before: { name: string; description: string | null; joinPolicy?: CircleJoinPolicy },
  after: { name: string; description: string; joinPolicy?: CircleJoinPolicy },
  mayChoosePolicy: boolean,
): { name?: string; description?: string | null; joinPolicy?: CircleJoinPolicy } {
  const edits: { name?: string; description?: string | null; joinPolicy?: CircleJoinPolicy } = {};
  const name = after.name.trim();
  const description = after.description.trim();
  if (name !== before.name) edits.name = name;
  if (description !== (before.description ?? '')) edits.description = description || null;
  if (mayChoosePolicy && after.joinPolicy && after.joinPolicy !== (before.joinPolicy ?? 'open')) edits.joinPolicy = after.joinPolicy;
  return edits;
}

/** A pod's badge on the circle page: Private, or Approval for a pod people ask to join; none for an open pod. */
export function podVisibilityBadge(visibility: string | undefined): string | null {
  if (visibility === 'private' || visibility === 'invite_only') return 'Private';
  if (visibility === 'public_with_approval') return 'Approval';
  return null;
}

/** An invitation row's state, in words. */
export const INVITE_STATE_LABEL: Record<'pending' | 'accepted' | 'declined', string> = {
  pending: 'Waiting',
  accepted: 'Accepted',
  declined: 'Declined',
};

/** The circle's invitations list follows the circle and its invites. */
export function circleInviteEntities(circleId: string): string[] {
  return [E.circle(circleId), E.circleInvites(circleId), E.circleMembers(circleId)];
}
