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

  // User-scoped
  user: (userId: string) => `user:${userId}`,
  userPods: (userId: string) => `user:${userId}:pods`,
  userInvites: (userId: string) => `user:${userId}:invites`,
  userSessions: (userId: string) => `user:${userId}:sessions`,
  userBlocks: (userId: string) => `user:${userId}:blocks`,
  userDms: (userId: string) => `user:${userId}:dms`,
  userNotifications: (userId: string) => `user:${userId}:notifications`,

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

  // Support
  supportTicket: (ticketId: string) => `support-ticket:${ticketId}`,

  // Admin
  adminPods: 'admin:pods',
  adminSessions: 'admin:sessions',
  adminUsers: 'admin:users',
  adminJoinRequests: 'admin:join-requests',
  adminViolations: 'admin:violations',
  adminSupportTickets: 'admin:support-tickets',
  adminAnalytics: 'admin:analytics',
} as const;
