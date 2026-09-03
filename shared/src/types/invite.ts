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
  podId?: string;
  sessionId?: string;
  circleId?: string;
  maxUses?: number;
  expiresInHours?: number;
}

export interface AcceptInviteInput {
  code: string;
}
