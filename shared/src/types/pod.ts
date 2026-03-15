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
  PUBLIC_WITH_APPROVAL = 'public_with_approval',  // anyone can find + request; director approves
  REQUEST_TO_JOIN      = 'request_to_join',        // request flow with optional rules/agreement
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
