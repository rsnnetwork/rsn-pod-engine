// ─── Realtime entity vocabulary (server-side) ────────────────────────────────
//
// Centralised entity-string builders so server emit sites and client queries
// stay in lockstep. Both sides should import from the matching `entities.ts`
// (server/src/realtime/entities.ts ↔ client/src/realtime/entities.ts) so
// typos like `pod:abc` vs `pods:abc` are caught at compile time.
//
// See: ENTITIES.md at repo root for the canonical list and rationale.
// See: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
//      for the full migration plan.

export const E = {
  // Pod
  pod: (podId: string) => `pod:${podId}`,
  podMembers: (podId: string) => `pod:${podId}:members`,
  podInvites: (podId: string) => `pod:${podId}:invites`,
  podSessions: (podId: string) => `pod:${podId}:sessions`,

  // Pod wall (26 Oct 2026): a pod's discussion feed, and one post's thread on it
  podWall: (podId: string) => `pod:${podId}:wall`,
  podWallPost: (postId: string) => `pod-wall-post:${postId}`,

  // User-scoped
  user: (userId: string) => `user:${userId}`,
  userPods: (userId: string) => `user:${userId}:pods`,
  userInvites: (userId: string) => `user:${userId}:invites`,
  userSessions: (userId: string) => `user:${userId}:sessions`,
  userBlocks: (userId: string) => `user:${userId}:blocks`,
  userDms: (userId: string) => `user:${userId}:dms`,
  userNotifications: (userId: string) => `user:${userId}:notifications`,
  /** The entities (companies, funds…) a member is linked to. */
  userEntities: (userId: string) => `user:${userId}:entities`,

  // Entity: an organisation members create (a company, a fund…), not this file's realtime "entities"
  entity: (entityId: string) => `entity:${entityId}`,

  // Session
  session: (sessionId: string) => `session:${sessionId}`,
  sessionParticipants: (sessionId: string) => `session:${sessionId}:participants`,
  sessionInvites: (sessionId: string) => `session:${sessionId}:invites`,
  sessionMatches: (sessionId: string) => `session:${sessionId}:matches`,
  sessionPlan: (sessionId: string) => `session:${sessionId}:plan`,
  sessionChat: (sessionId: string) => `session:${sessionId}:chat`,
  sessionReactions: (sessionId: string) => `session:${sessionId}:reactions`,

  // Match (in-event)
  match: (matchId: string) => `match:${matchId}`,
  matchChat: (matchId: string) => `match:${matchId}:chat`,

  // DM
  dmConversation: (convId: string) => `dm-conversation:${convId}`,

  // Meetings (26 Oct 2026): a member's confirmed 1:1 meetings, and one meeting
  userMeetings: (userId: string) => `user:${userId}:meetings`,
  meeting: (meetingId: string) => `meeting:${meetingId}`,

  // Support
  supportTicket: (ticketId: string) => `support-ticket:${ticketId}`,

  // Group chat (26 Oct 2026): its thread, details and members
  dmGroup: (groupId: string) => `dm-group:${groupId}`,

  // Admin (global-scoped, sent to every admin's user-room)
  adminPods: 'admin:pods',
  adminSessions: 'admin:sessions',
  adminUsers: 'admin:users',
  adminJoinRequests: 'admin:join-requests',
  adminViolations: 'admin:violations',
  adminSupportTickets: 'admin:support-tickets',
  adminAnalytics: 'admin:analytics',
} as const;
