// ─── Invite Domain Types ─────────────────────────────────────────────────────

export enum InviteStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

export enum InviteType {
  POD = 'pod',
  SESSION = 'session',
  PLATFORM = 'platform',
  /** 13 Aug 2026 (C3): circle-level invites, mirroring the pod path. */
  CIRCLE = 'circle',
}

export interface Invite {
  id: string;
  code: string;
  type: InviteType;
  inviterId: string;
  inviteeEmail: string | null;
  podId: string | null;
  sessionId: string | null;
  circleId: string | null;
  status: InviteStatus;
  maxUses: number;
  useCount: number;
  expiresAt: Date | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInviteInput {
  type: InviteType;
  inviteeEmail?: string;
  /** Invite a member you picked from a list — the server resolves the
   *  address, so member lists never need to carry emails (9 Sep 2026). */
  inviteeUserId?: string;
  podId?: string;
  sessionId?: string;
  circleId?: string;
  maxUses?: number;
  expiresInHours?: number;
}

export interface AcceptInviteInput {
  code: string;
}

// ─── Inviting from your connections (26 Oct 2026) ────────────────────────────
// GET /invites/candidates and POST /invites/batch: the picker's two server calls. Types only, so a client built
// from `main` compiles unchanged.

/** Met (at an event, or in a 1:1 meeting both joined) and connected (an accepted request, or a conversation) are the People page's two readings; pod is a member of the event's pod. */
export type InviteCandidateHow = 'met' | 'connected' | 'pod';

/** Where one person stands against the pod or the event being invited to. `member` is for pods and `going` for events. */
export type InviteCandidateState = 'available' | 'member' | 'going' | 'invited' | 'declined';

/** `connections` lists the asker's own connections; `pod` lists the active members of an event's pod. */
export type InviteCandidateSource = 'connections' | 'pod';

export interface InviteCandidate {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  how: InviteCandidateHow;
  /** The latest date of anything between the two (connections), or when they joined the pod (pod list), ISO. */
  since: string;
  state: InviteCandidateState;
  /** The invite behind `invited` and `declined`, so an organiser can remind or withdraw it. */
  inviteId?: string;
}

export interface InviteCandidatePage {
  items: InviteCandidate[];
  /** Ask again with ?before= this for the next people; null when there are no more. */
  nextBefore: string | null;
}

export type InviteBatchOutcome =
  | 'invited'
  | 'already_member'
  | 'already_going'
  | 'already_invited'
  /** They said no to an invite to this very pod or event: a batch never invites them again. */
  | 'declined'
  | 'not_allowed'
  | 'failed';

export interface InviteBatchInput {
  type: 'pod' | 'session';
  podId?: string;
  sessionId?: string;
  /** 1 to 50 member ids; may be empty only with allPodMembers. */
  inviteeUserIds: string[];
  /** Events in a pod: also invite every pod member who is not going, invited or declined yet. */
  allPodMembers?: boolean;
}

export interface InviteBatchResult {
  userId: string;
  outcome: InviteBatchOutcome;
  inviteId?: string;
}

export interface InviteBatchResponse {
  results: InviteBatchResult[];
  counts: Record<InviteBatchOutcome, number>;
  /** With allPodMembers: how many more pod members can still be invited after this batch's 50. */
  remaining?: number;
}
