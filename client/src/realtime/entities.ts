// ─── Realtime entity vocabulary (client-side) ────────────────────────────────
//
// Mirrors server/src/realtime/entities.ts. Keep the two in lockstep — when
// you add a new entity here, add it on the server too (and to ENTITIES.md).
//
// Usage in queries:
//
//   useQuery({
//     queryKey: ['pod-members', podId],
//     queryFn: () => api.getPodMembers(podId),
//     meta: { entities: [E.pod(podId), E.podMembers(podId)] },
//   });

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

  // Circle (1 Nov 2026): a community of members. The detail, who is in it, its pending invites, and a
  // member's own circles list
  circle: (circleId: string) => `circle:${circleId}`,
  circleMembers: (circleId: string) => `circle:${circleId}:members`,
  circleInvites: (circleId: string) => `circle:${circleId}:invites`,
  // T14: the asks waiting to join a closed circle, for the people who run it
  circleRequests: (circleId: string) => `circle:${circleId}:requests`,
  userCircles: (userId: string) => `user:${userId}:circles`,

  // Session
  session: (sessionId: string) => `session:${sessionId}`,
  sessionParticipants: (sessionId: string) => `session:${sessionId}:participants`,
  sessionInvites: (sessionId: string) => `session:${sessionId}:invites`,
  /** T11 (1 Nov 2026): requests to join an event that asks the host to approve each place. */
  sessionJoinRequests: (sessionId: string) => `session:${sessionId}:join-requests`,
  /** Part 2 Task 4 (10 Nov 2026): the event's admission mode, allowed emails and codes (its organisers). */
  sessionAdmission: (sessionId: string) => `session:${sessionId}:admission`,
  sessionMatches: (sessionId: string) => `session:${sessionId}:matches`,
  sessionPlan: (sessionId: string) => `session:${sessionId}:plan`,
  sessionChat: (sessionId: string) => `session:${sessionId}:chat`,
  sessionReactions: (sessionId: string) => `session:${sessionId}:reactions`,
  /** Part 2 (10 Nov 2026): who did what to an event, for its organisers. */
  sessionAudit: (sessionId: string) => `session:${sessionId}:audit`,
  /** 10 Nov 2026 spec, Part 2 Task 5: the event's matching groups, round rules and who is in which group. */
  sessionGroups: (sessionId: string) => `session:${sessionId}:groups`,

  // Match (in-event)
  match: (matchId: string) => `match:${matchId}`,
  matchChat: (matchId: string) => `match:${matchId}:chat`,

  // DM
  dmConversation: (convId: string) => `dm-conversation:${convId}`,

  // Meetings (26 Oct 2026): a member's confirmed 1:1 meetings, and one meeting
  userMeetings: (userId: string) => `user:${userId}:meetings`,
  meeting: (meetingId: string) => `meeting:${meetingId}`,

  // Calls (1 Nov 2026): a call ringing the member, or one they rang, changed (rung, answered, declined,
  // cancelled, lapsed)
  userCalls: (userId: string) => `user:${userId}:calls`,

  // Support
  supportTicket: (ticketId: string) => `support-ticket:${ticketId}`,

  // Group chat (26 Oct 2026): its thread, details and members
  dmGroup: (groupId: string) => `dm-group:${groupId}`,

  // Admin
  adminPods: 'admin:pods',
  adminSessions: 'admin:sessions',
  adminUsers: 'admin:users',
  adminJoinRequests: 'admin:join-requests',
  adminViolations: 'admin:violations',
  adminSupportTickets: 'admin:support-tickets',
  adminAnalytics: 'admin:analytics',
  // 30 Oct 2026 — matching templates and the speed-networking presets (fanoutAdminEntities('templates')).
  adminTemplates: 'admin:templates',
  /** Feedback after meetings (30 Oct 2026): the admin feedback list. */
  adminMeetingFeedback: 'admin:meeting-feedback',
} as const;
