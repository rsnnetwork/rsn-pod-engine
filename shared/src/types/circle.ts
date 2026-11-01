// ─── Circles: who can join, and what a viewer may do (30 Oct review, items 7.4 to 7.6; L21, L22) ─────────────
// Types only, so a client built from `main` compiles unchanged and nothing here needs a value export.

/** Open: anyone on REASON joins at once. Closed: people ask to join and the circle's managers let them in. */
export type CircleJoinPolicy = 'open' | 'closed';

/** Where the viewer stands: in it, asked and waiting, turned down (they may ask again), or none of these. */
export type CircleMyStatus = 'member' | 'requested' | 'declined' | null;

/**
 * Added to every circle a member reads (the list and the page), beside the fields it always had.
 * `canManage`: the viewer runs it (its creator, an owner or moderator, or a platform admin).
 * `canInvite`: an open circle, anyone in it or running it; a closed circle, only the people who run it.
 * `requestCount`: pending asks, only for the people who run it.
 * `locked`: a closed circle the viewer is not in, so its wall, members, pods and events are not sent.
 */
export interface CircleAccess {
  joinPolicy: CircleJoinPolicy;
  myStatus: CircleMyStatus;
  canManage: boolean;
  canInvite: boolean;
  requestCount?: number;
  locked: boolean;
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
