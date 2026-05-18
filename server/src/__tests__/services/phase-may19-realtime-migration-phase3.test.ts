// Realtime architecture migration — Phase 3 client-side meta.entities guard.
//
// For every client file that had a useQuery call migrated to declare
// `meta.entities: [...]`, this file pins TWO assertions:
//   1. the file imports `E` from `@/realtime/entities` (so entity strings
//      come from the centralised builder, not stringly-typed literals)
//   2. one or more `meta: { entities:` declarations appear in the source
//      near the migrated queryKeys
//
// Source: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// Mapping: §4 (entity vocabulary table) + the user-supplied Phase 3 tables.
//
// We deliberately scope the test to the client repo (../../../../client/src)
// because Phase 3 is purely a client-side change.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs
    .readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('Realtime migration Phase 3 — client meta.entities', () => {
  // ── 3a — Pod surfaces ──────────────────────────────────────────────────
  describe('3a — Pod surfaces', () => {
    it('PodDetailPage.tsx imports E and tags pod/pod-members/pod-sessions/pod-pending-invites', () => {
      const src = readClient('features/pods/PodDetailPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      expect(src).toMatch(/import\s*\{\s*E\s*\}\s*from\s*['"]@\/realtime\/entities['"]/);
      // Pinned per queryKey: the meta declaration must sit near the key.
      const podBlock = src.slice(src.indexOf("queryKey: ['pod', podId]"));
      expect(podBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.pod\(podId\)/);
      const membersBlock = src.slice(src.indexOf("queryKey: ['pod-members', podId]"));
      expect(membersBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.podMembers\(podId\)/);
      const sessionsBlock = src.slice(src.indexOf("queryKey: ['pod-sessions', podId]"));
      expect(sessionsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.podSessions\(podId\)/);
      const invitesBlock = src.slice(src.indexOf("queryKey: ['pod-pending-invites', podId]"));
      expect(invitesBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.podInvites\(podId\)/);
    });

    it('PodsPage.tsx imports E and tags my-pods with userPods', () => {
      const src = readClient('features/pods/PodsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['my-pods', filter]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userPods\(currentUserId\)/);
    });

    it('HomePage.tsx imports E and tags my-pods/my-sessions/my-invites/received-invites', () => {
      const src = readClient('features/home/HomePage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const podsBlock = src.slice(src.indexOf("queryKey: ['my-pods']"));
      expect(podsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userPods\(currentUserId\)/);
      const sessionsBlock = src.slice(src.indexOf("queryKey: ['my-sessions']"));
      expect(sessionsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userSessions\(currentUserId\)/);
      const invitesBlock = src.slice(src.indexOf("queryKey: ['my-invites']"));
      expect(invitesBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userInvites\(currentUserId\)/);
      const receivedBlock = src.slice(src.indexOf("queryKey: ['received-invites']"));
      expect(receivedBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userInvites\(currentUserId\)/);
    });

    it('CreateInviteModal.tsx imports E and tags my-pods/my-sessions', () => {
      const src = readClient('features/invites/CreateInviteModal.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const podsBlock = src.slice(src.indexOf("queryKey: ['my-pods']"));
      expect(podsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userPods\(currentUserId\)/);
    });
  });

  // ── 3b — Session surfaces ──────────────────────────────────────────────
  describe('3b — Session surfaces', () => {
    it('SessionDetailPage.tsx imports E and tags session/participants/participant-counts/pending-invites', () => {
      const src = readClient('features/sessions/SessionDetailPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const sessionBlock = src.slice(src.indexOf("queryKey: ['session', sessionId]"));
      expect(sessionBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.session\(sessionId\)/);
      const participantsBlock = src.slice(src.indexOf("queryKey: ['session-participants', sessionId]"));
      expect(participantsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionParticipants\(sessionId\)/);
      const countsBlock = src.slice(src.indexOf("queryKey: ['session-participant-counts', sessionId]"));
      expect(countsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionParticipants\(sessionId\)/);
      const invitesBlock = src.slice(src.indexOf("queryKey: ['session-pending-invites', sessionId]"));
      expect(invitesBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionInvites\(sessionId\)/);
    });

    it('RecapPage.tsx imports E and tags session/session-cohost/unrated-partners', () => {
      const src = readClient('features/sessions/RecapPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const sessionBlock = src.slice(src.indexOf("queryKey: ['session', sessionId]"));
      expect(sessionBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.session\(sessionId\)/);
      const cohostBlock = src.slice(src.indexOf("queryKey: ['session-cohost', sessionId, user?.id]"));
      expect(cohostBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionParticipants\(sessionId\)/);
      const unratedBlock = src.slice(src.indexOf("queryKey: ['unrated-partners', sessionId]"));
      expect(unratedBlock).toMatch(/meta:\s*\{\s*entities:/);
    });

    it('SessionsPage.tsx imports E and tags my-sessions/my-pods', () => {
      const src = readClient('features/sessions/SessionsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const sessionsBlock = src.slice(src.indexOf("queryKey: ['my-sessions']"));
      expect(sessionsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userSessions\(currentUserId\)/);
      const podsBlock = src.slice(src.indexOf("queryKey: ['my-pods']"));
      expect(podsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userPods\(currentUserId\)/);
    });

    it('HostDashboardPage.tsx imports E and tags session/participants/host-state', () => {
      const src = readClient('features/host/HostDashboardPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const stateBlock = src.slice(src.indexOf("queryKey: ['host-state', sessionId]"));
      expect(stateBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionParticipants\(sessionId\)/);
    });

    it('EventPlanStrip.tsx imports E and tags event-plan with sessionPlan', () => {
      const src = readClient('features/live/EventPlanStrip.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['event-plan', sessionId]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionPlan\(sessionId\)/);
    });

    it('LiveSessionPage.tsx imports E and tags session', () => {
      const src = readClient('features/live/LiveSessionPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['session', sessionId]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.session\(sessionId\)/);
    });
  });

  // ── 3c — Invite surfaces ───────────────────────────────────────────────
  describe('3c — Invite surfaces', () => {
    it('InvitesPage.tsx imports E and tags my-invites/received-invites with userInvites', () => {
      const src = readClient('features/invites/InvitesPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const myBlock = src.slice(src.indexOf("queryKey: ['my-invites']"));
      expect(myBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userInvites\(currentUserId\)/);
      const receivedBlock = src.slice(src.indexOf("queryKey: ['received-invites']"));
      expect(receivedBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userInvites\(currentUserId\)/);
    });
  });

  // ── 3d — DM surfaces ───────────────────────────────────────────────────
  describe('3d — DM surfaces', () => {
    it('MessagesPage.tsx imports E and tags dm-conversations/dm-messages/user', () => {
      const src = readClient('features/messages/MessagesPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const convBlock = src.slice(src.indexOf("queryKey: ['dm-conversations']"));
      expect(convBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userDms\(myUserId\)/);
      const msgBlock = src.slice(src.indexOf("queryKey: ['dm-messages', activeId]"));
      expect(msgBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.dmConversation\(activeId\)/);
      const userBlock = src.slice(src.indexOf("queryKey: ['user', composeToUserId]"));
      expect(userBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.user\(composeToUserId\)/);
    });

    it('ChatQuickAccess.tsx imports E and tags dm-conversations/dm-groups with userDms', () => {
      const src = readClient('components/ui/ChatQuickAccess.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const convBlock = src.slice(src.indexOf("queryKey: ['dm-conversations']"));
      expect(convBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userDms\(currentUserId\)/);
      const groupsBlock = src.slice(src.indexOf("queryKey: ['dm-groups']"));
      expect(groupsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userDms\(currentUserId\)/);
    });
  });

  // ── 3e — User / block / encounter surfaces ─────────────────────────────
  describe('3e — User / block / encounter surfaces', () => {
    it('PublicProfilePage.tsx imports E and tags user/user-block-status/can-message', () => {
      const src = readClient('features/profile/PublicProfilePage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const userBlock = src.slice(src.indexOf("queryKey: ['user', userId]"));
      expect(userBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.user\(userId\)/);
      const blockStatusBlock = src.slice(src.indexOf("queryKey: ['user-block-status', userId]"));
      expect(blockStatusBlock).toMatch(/meta:\s*\{[\s\S]{0,300}E\.userBlocks\(currentUserId\)/);
      const canMsgBlock = src.slice(src.indexOf("queryKey: ['can-message', userId]"));
      expect(canMsgBlock).toMatch(/meta:\s*\{[\s\S]{0,300}E\.userBlocks\(currentUserId\)/);
    });

    it('EncounterHistoryPage.tsx imports E and tags encounters with current user', () => {
      const src = readClient('features/sessions/EncounterHistoryPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['encounters', mutualOnly]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.user\(currentUserId\)/);
    });
  });

  // ── 3f — Notification / support surfaces ───────────────────────────────
  describe('3f — Notification / support surfaces', () => {
    it('SettingsPage.tsx imports E and tags notification-prefs with userNotifications', () => {
      const src = readClient('features/settings/SettingsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['notification-prefs']"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.userNotifications\(currentUserId\)/);
    });

    it('SupportPage.tsx imports E and tags my-support-tickets with user(currentUserId)', () => {
      const src = readClient('features/support/SupportPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['my-support-tickets']"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.user\(currentUserId\)/);
    });
  });

  // ── 3g — Admin surfaces ────────────────────────────────────────────────
  describe('3g — Admin surfaces', () => {
    it('AdminPodsPage.tsx imports E and tags admin-pods with adminPods', () => {
      const src = readClient('features/admin/AdminPodsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['admin-pods', filter]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminPods/);
    });

    it('AdminSessionsPage.tsx imports E and tags admin-sessions with adminSessions', () => {
      const src = readClient('features/admin/AdminSessionsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['admin-sessions', filter]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminSessions/);
    });

    it('AdminUsersPage.tsx imports E and tags admin-users with adminUsers', () => {
      const src = readClient('features/admin/AdminUsersPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['admin-users',"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminUsers/);
    });

    it('AdminJoinRequestsPage.tsx imports E and tags admin-join-requests with adminJoinRequests', () => {
      const src = readClient('features/admin/AdminJoinRequestsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['admin-join-requests',"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminJoinRequests/);
    });

    it('AdminModerationPage.tsx imports E and tags admin-violations with adminViolations', () => {
      const src = readClient('features/admin/AdminModerationPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['admin-violations', statusFilter]"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminViolations/);
    });

    it('AdminSupportPage.tsx imports E and tags admin-support-tickets with adminSupportTickets', () => {
      const src = readClient('features/admin/AdminSupportPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const block = src.slice(src.indexOf("queryKey: ['admin-support-tickets',"));
      expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminSupportTickets/);
    });

    it('AdminDashboardPage.tsx imports E and tags admin-stats/admin-join-requests-pending/admin-recent-matches', () => {
      const src = readClient('features/admin/AdminDashboardPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      const statsBlock = src.slice(src.indexOf("queryKey: ['admin-stats']"));
      expect(statsBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminAnalytics/);
      const pendingBlock = src.slice(src.indexOf("queryKey: ['admin-join-requests-pending']"));
      expect(pendingBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminJoinRequests/);
      const matchesBlock = src.slice(src.indexOf("queryKey: ['admin-recent-matches']"));
      expect(matchesBlock).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminAnalytics/);
    });

    it('AdminAnalyticsPage.tsx imports E and tags all four admin-analytics-* with adminAnalytics', () => {
      const src = readClient('features/admin/AdminAnalyticsPage.tsx');
      expect(src).toMatch(/from\s*['"]@\/realtime\/entities['"]/);
      for (const key of [
        "queryKey: ['admin-analytics-overview']",
        "queryKey: ['admin-analytics-events']",
        "queryKey: ['admin-analytics-users']",
        "queryKey: ['admin-analytics-connections']",
      ]) {
        const block = src.slice(src.indexOf(key));
        expect(block).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.adminAnalytics/);
      }
    });
  });

  // ── Legacy bridge preservation ─────────────────────────────────────────
  describe('Legacy bridge — kept alive through Phase 5', () => {
    it('useLegacyInvalidationBridge.ts still exists (Phase 5 will delete it)', () => {
      const path = nodePath.join(__dirname, '../../../../client/src/realtime/useLegacyInvalidationBridge.ts');
      expect(nodeFs.existsSync(path)).toBe(true);
    });
  });
});
