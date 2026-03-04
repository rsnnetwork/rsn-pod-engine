// ─── Pod Domain Types ────────────────────────────────────────────────────────

export enum PodType {
  SPEED_NETWORKING = 'speed_networking',
  DUO = 'duo',
  TRIO = 'trio',
  KVARTET = 'kvartet',
  BAND = 'band',
  ORCHESTRA = 'orchestra',
  CONCERT = 'concert',
}

export enum OrchestrationMode {
  TIMED_ROUNDS = 'timed_rounds',        // 1:1 speed networking style
  FREE_FORM = 'free_form',              // open pod conversation
  MODERATED = 'moderated',              // host-controlled flow
}

export enum CommunicationMode {
  VIDEO = 'video',
  AUDIO = 'audio',
  TEXT = 'text',
  HYBRID = 'hybrid',
}

export enum PodVisibility {
  PRIVATE = 'private',
  INVITE_ONLY = 'invite_only',
  PUBLIC = 'public',
}

export enum PodStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  SUSPENDED = 'suspended',
}

export enum PodMemberRole {
  DIRECTOR = 'director',
  HOST = 'host',
  MEMBER = 'member',
}

export enum PodMemberStatus {
  INVITED = 'invited',
  PENDING_APPROVAL = 'pending_approval',
  ACTIVE = 'active',
  REMOVED = 'removed',
  LEFT = 'left',
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
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
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
  podType: PodType;
  orchestrationMode?: OrchestrationMode;
  communicationMode?: CommunicationMode;
  visibility?: PodVisibility;
  maxMembers?: number;
  rules?: string;
}

export interface UpdatePodInput {
  name?: string;
  description?: string;
  visibility?: PodVisibility;
  maxMembers?: number;
  rules?: string;
  status?: PodStatus;
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
