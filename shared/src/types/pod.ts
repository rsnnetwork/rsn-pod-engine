// ─── Pod Domain Types ────────────────────────────────────────────────────────

export enum PodType {
  SPEED_NETWORKING    = 'speed_networking',
  REASON              = 'reason',
  CONVERSATIONAL      = 'conversational',
  WEBINAR             = 'webinar',
  PHYSICAL_EVENT      = 'physical_event',
  CHAT                = 'chat',
  TWO_SIDED_NETWORKING = 'two_sided_networking',
  ONE_SIDED_NETWORKING = 'one_sided_networking',
}

export enum OrchestrationMode {
  TIMED_ROUNDS = 'timed_rounds',        // 1:1 speed networking style
  FREE_FORM    = 'free_form',           // open pod conversation
  MODERATED    = 'moderated',           // host-controlled flow
}

export enum CommunicationMode {
  VIDEO  = 'video',
  AUDIO  = 'audio',
  TEXT   = 'text',
  HYBRID = 'hybrid',
}

export enum PodVisibility {
  PRIVATE              = 'private',
  INVITE_ONLY          = 'invite_only',
  PUBLIC               = 'public',
  PUBLIC_WITH_APPROVAL = 'public_with_approval',  // anyone can find + request; director approves; optional rules/agreement
}

/**
 * Shirley pilot S2 (11 Nov 2026, D2): a pod has three settings. "Invite only" is retired: it behaved like Public with
 * approval while reading like Private, so migration 148 maps any such pod to Private (the more private setting) and
 * nothing may set it again. The enum keeps the value because Postgres cannot drop one; every read treats it as Private.
 */
export const POD_VISIBILITY_SETTINGS = [
  PodVisibility.PRIVATE,
  PodVisibility.PUBLIC_WITH_APPROVAL,
  PodVisibility.PUBLIC,
] as const;
export type PodVisibilitySetting = (typeof POD_VISIBILITY_SETTINGS)[number];

/** Each setting's name and the exact words for who finds the pod, who sees inside it and how people get in. */
export const POD_VISIBILITY_COPY: Record<PodVisibilitySetting, { label: string; summary: string }> = {
  [PodVisibility.PRIVATE]: {
    label: 'Private',
    summary: 'Not listed anywhere. Only its members see it. People join only when you, a host or (if you allow it) a member invites them.',
  },
  [PodVisibility.PUBLIC_WITH_APPROVAL]: {
    label: 'Public with approval',
    summary: 'Listed on REASON. Anyone can see its name and description and ask to join; you approve each person. Only members see its discussion, members and events.',
  },
  [PodVisibility.PUBLIC]: {
    label: 'Public open',
    summary: 'Listed on REASON. Anyone can see its name and description and join straight away. Only members see its discussion and members.',
  },
};

/** Whether people outside a pod may find it and read its overview: never for Private, nor an old Invite only row. */
export function isDiscoverablePod(visibility: string | null | undefined): boolean {
  return visibility === PodVisibility.PUBLIC || visibility === PodVisibility.PUBLIC_WITH_APPROVAL;
}

export enum PodStatus {
  DRAFT     = 'draft',
  ACTIVE    = 'active',
  ARCHIVED  = 'archived',
  SUSPENDED = 'suspended',
}

export enum PodMemberRole {
  DIRECTOR = 'director',
  HOST     = 'host',
  MEMBER   = 'member',
}

export enum PodMemberStatus {
  INVITED          = 'invited',
  PENDING_APPROVAL = 'pending_approval',
  ACTIVE           = 'active',
  REMOVED          = 'removed',
  LEFT             = 'left',
  DECLINED         = 'declined',     // invitee explicitly refused
  NO_RESPONSE      = 'no_response',  // invite was sent but never actioned
}

export interface Pod {
  id: string;
  name: string;
  description: string | null;
  podType: PodType;
  orchestrationMode: OrchestrationMode;
  communicationMode: CommunicationMode;
  visibility: PodVisibility;
  status: PodStatus;
  maxMembers: number | null;
  rules: string | null;
  joinConfig: PodJoinConfig | null;
  allowMemberInvites: boolean;
  /** 22 Nov 2026: the main pod this pod is inside, or null for a pod that stands alone (migration 161). */
  parentPodId: string | null;
  /** A main pod's director's choice: people must be its active members to join the pods inside it (off by default). */
  innerPodsMembersOnly: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Stored in pods.join_config JSONB — director-authored config for the request-to-join flow */
export interface PodJoinConfig {
  rulesText?: string;       // Displayed to requester before they submit
  agreementText?: string;   // Checkbox text the requester must tick
}

export interface PodMember {
  id: string;
  podId: string;
  userId: string;
  role: PodMemberRole;
  status: PodMemberStatus;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface CreatePodInput {
  name: string;
  description?: string;
  podType?: PodType;
  orchestrationMode?: OrchestrationMode;
  communicationMode?: CommunicationMode;
  visibility?: PodVisibility;
  maxMembers?: number;
  rules?: string;
  allowMemberInvites?: boolean;
  /** 1 Nov 2026: made from a circle's page, and attached to that circle in the same transaction (its managers only). */
  circleId?: string;
  /** 22 Nov 2026: made inside this main pod, in the same transaction (its director or a platform admin only). */
  parentPodId?: string;
}

export interface UpdatePodInput {
  name?: string;
  description?: string;
  podType?: PodType;
  orchestrationMode?: OrchestrationMode;
  communicationMode?: CommunicationMode;
  visibility?: PodVisibility;
  maxMembers?: number | null;
  rules?: string;
  status?: PodStatus;
  joinConfig?: PodJoinConfig | null;
  allowMemberInvites?: boolean;
}

// ─── Pods inside pods (Stefan, 22 Nov 2026) ─────────────────────────────────────────────────────────────────
// Circle (RSN admins) > main pod > the pods inside it > events. One level only: a main pod holds pods, a pod inside
// one holds none. The main pod's director chooses whether people must be its members to join its pods.

/** The main pod a pod is inside, as the viewer may see it. */
export interface ParentPodSummary {
  id: string;
  name: string;
}

/** What the pod's page reads about where the pod sits (GET /pods/:id carries these beside the pod). */
export interface PodNesting {
  /** The main pod it is inside, when the viewer may see that pod; null when it stands alone or the main pod is hidden. */
  parentPod: ParentPodSummary | null;
  /** It is inside a main pod the viewer may not see (a private pod they are not in). */
  parentPodHidden: boolean;
  /** How many pods inside it the viewer may see. */
  innerPodCount: number;
  /** Joining it needs the viewer to be a member of its main pod first, and they are not. */
  joinNeedsMainPod: boolean;
  /** It may hold pods (it is not inside another pod). */
  mayHoldPods: boolean;
}

/** One pod inside a main pod, as GET /pods/:id/pods lists it for the viewer. */
export interface InnerPodItem {
  id: string;
  name: string;
  description: string | null;
  visibility: PodVisibility;
  status: PodStatus;
  memberCount: number;
  sessionCount: number;
  /** The viewer's active role in it, or null. */
  memberRole: PodMemberRole | null;
  /** The viewer may take it out of the main pod (they direct it or the main pod, or are a platform admin). */
  mayTakeOut: boolean;
}

/** One of the viewer's own pods that could be put inside a main pod (GET /pods/:id/pods/candidates). */
export interface InnerPodCandidate {
  id: string;
  name: string;
  memberCount: number;
}

export interface PodConfig {
  matchingWeights: MatchingWeightConfig;
  hardConstraints: string[];
  featureFlags: Record<string, boolean>;
}

export interface MatchingWeightConfig {
  sharedInterests: number;
  sharedIndustry: number;
  sharedReasons: number;
  diversity: number;
  [key: string]: number;
}
