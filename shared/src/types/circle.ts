// ─── Circles: who can join, and what a viewer may do (30 Oct review, items 7.4 to 7.6; L21, L22) ─────────────
// Types only, so a client built from `main` compiles unchanged and nothing here needs a value export.

/**
 * Open: anyone on REASON joins at once. Closed: people ask to join and the circle's managers let them in. Invite only
 * (Ben field test, 13 Nov 2026): no one can ask; only an invitation from someone who runs it lets a person in.
 * Everything that guards a closed circle guards an invite-only one the same way; the two differ only in asking.
 */
export type CircleJoinPolicy = 'open' | 'closed' | 'invite_only';

/** Where the viewer stands: in it, asked and waiting, turned down (they may ask again), or none of these. */
export type CircleMyStatus = 'member' | 'requested' | 'declined' | null;

/**
 * Added to every circle a member reads (the list and the page), beside the fields it always had.
 * `canManage`: the viewer runs it (its owner or a moderator, or a platform admin; Shirley pilot S2: being the person
 *   who made it gives no right of its own).
 * `canInvite`: an open circle, anyone in it or running it; a closed or invite-only circle, only the people who run it.
 * `requestCount`: pending asks, only for the people who run it.
 * `locked`: a closed or invite-only circle the viewer is not in, so its wall, members, pods and events are not sent.
 * `myRole`: the viewer's own role in it, or null when they are not in it.
 * `isOwner`: the viewer holds the owner's powers (its owner, or a platform admin): only they make or unmake
 *   moderators, hand the circle to someone else and choose who can join.
 */
export interface CircleAccess {
  joinPolicy: CircleJoinPolicy;
  myStatus: CircleMyStatus;
  canManage: boolean;
  canInvite: boolean;
  requestCount?: number;
  locked: boolean;
  myRole: CircleRole | null;
  isOwner: boolean;
}

/** A circle's roles (S2, D3): one owner, any number of moderators who run it with the owner, and members. */
export type CircleRole = 'owner' | 'moderator' | 'member';

/** The roles the owner gives and takes; the owner's own role moves only by handing the circle to someone else. */
export type CircleAssignableRole = 'moderator' | 'member';

/** Where one of a circle's invitations stands, in its managers' list (GET /invites/circle/:circleId). */
export type CircleInviteState = 'pending' | 'accepted' | 'declined';

/**
 * One of a circle's invitations (S2). `invitee` is the member's name when the address belongs to a member, else the
 * address, shown in full only to the person who sent it and to platform admins (masked for everyone else); a shared
 * link has none.
 */
export interface CircleInviteRow {
  id: string;
  state: CircleInviteState;
  invitee: string | null;
  inviteeUserId: string | null;
  /** A link anyone may open: no address, or more than one use. */
  isLink: boolean;
  inviterName: string | null;
  /** The person viewing the list sent it. */
  sentByMe: boolean;
  /** ISO times. */
  createdAt: string;
  expiresAt: string | null;
}

/** One pending ask, as the circle's managers see it (GET /circles/:id/requests). */
export interface CircleJoinRequest {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  /** ISO time the ask was made. */
  requestedAt: string;
}

/** What POST /circles/:id/request did: joined at once (an open circle, or someone who runs it) or asked. */
export interface CircleRequestResult {
  status: 'member' | 'requested';
}

/** A pod the viewer could attach to the circle (GET /circles/:id/attachable-pods). */
export interface CircleAttachablePod {
  podId: string;
  name: string;
  description: string | null;
  visibility: string;
  /** The viewer's role in it (director or host), or null for a platform admin who is not in it. */
  memberRole: string | null;
}

export interface CircleAttachablePodPage {
  items: CircleAttachablePod[];
  /** Ask again with ?page= this for more; null when there are no more. */
  nextPage: number | null;
}

// ─── Asking for a new circle (Ben field test, 13 Nov 2026: request, review, approve, create) ─────────────────────

/** Where an ask for a new circle stands. Only an approved ask makes a circle. */
export type CircleCreationRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

/** One ask for a new circle, as the member who made it sees it (GET /circle-requests/mine). */
export interface CircleCreationRequest {
  id: string;
  name: string;
  description: string | null;
  /** Why the circle should exist: the community or organisation it is for. */
  purpose: string;
  joinPolicy: CircleJoinPolicy;
  status: CircleCreationRequestStatus;
  /** The reviewer's words on a decline, when they gave any. */
  declineReason: string | null;
  /** The circle an approval made; it may since have been archived. */
  circleId: string | null;
  /** ISO times. */
  createdAt: string;
  decidedAt: string | null;
}

/** The same ask as a platform admin reviews it (GET /circle-requests), with who asked. */
export interface CircleCreationRequestForReview extends CircleCreationRequest {
  requester: {
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    jobTitle: string | null;
    company: string | null;
  };
}
