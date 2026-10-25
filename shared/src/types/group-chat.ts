// ─── Group chats (26 Oct 2026) ───────────────────────────────────────────────
//
// Stefan, 25 Oct (COM-04): "Can there be 3, 5, 10, 20, 50 people in a chat? There should be."
// A group chat holds 3 to 50 people, its creator included, and the product says so. An organiser of
// a completed event starts one with the people who took part in it; it lives in Messages beside the
// one-to-one conversations. Text only.

/** The most people a group chat holds, its creator included. Stated in the product: "Group chats hold up to 50 people." */
export const GROUP_CHAT_MAX_MEMBERS = 50;

/** The fewest people a group chat starts with, its creator included. Fewer is a conversation, not a group. */
export const GROUP_CHAT_MIN_MEMBERS = 3;

/** custom: made from people the creator has met; pod: one per pod (not in use); event: started from a completed event. */
export type DmGroupType = 'custom' | 'pod' | 'event';

/** The group's admin removes people, adds people who took part in its event, and is replaced by the earliest member when they leave. */
export type DmGroupRole = 'admin' | 'member';

/** The latest message a member can see in a group: never one from someone either of them has blocked. */
export interface DmGroupLastMessage {
  /** The first 200 characters. */
  content: string;
  at: string;
  fromUserId: string;
  /** "Former member" when the sender's account is closed. */
  senderName: string;
}

/** One group in GET /api/groups (most recent activity first), and the head of GET /api/groups/:id. */
export interface DmGroupSummary {
  id: string;
  name: string;
  type: DmGroupType;
  podId: string | null;
  /** The event it was started from; null for other groups, and once that event is deleted. */
  sessionId: string | null;
  createdBy: string | null;
  createdAt: string;
  /** When the latest message this member can see was sent; null when there is none yet. */
  lastMessageAt: string | null;
  memberCount: number;
  /** Messages from others since this member last read the group (or joined it), none from anyone blocked either way. */
  unreadCount: number;
  lastMessage: DmGroupLastMessage | null;
  myRole: DmGroupRole;
}

export interface DmGroupMember {
  userId: string;
  /** "Former member" when the account is closed. */
  displayName: string;
  avatarUrl: string | null;
  role: DmGroupRole;
  joinedAt: string;
}

/** GET /api/groups/:id: the group, its members (admin first, then by when they joined) and the cap. */
export interface DmGroupDetail extends DmGroupSummary {
  maxMembers: number;
  members: DmGroupMember[];
}

export interface GroupChatMessage {
  id: string;
  groupId: string;
  fromUserId: string;
  /** "Former member" when the sender's account is closed. */
  senderName: string;
  senderAvatarUrl: string | null;
  content: string;
  createdAt: string;
}

/** GET /api/groups/:id/messages: newest first; pass nextCursor back as ?before= for the page older than this one. */
export interface GroupChatMessagePage {
  messages: GroupChatMessage[];
  nextCursor: string | null;
}
