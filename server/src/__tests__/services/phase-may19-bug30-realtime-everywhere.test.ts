// Bug 30 (19 May Ali) — Stefan's "every action is instant" mandate
// generalised across every invite + pod + session mutation route. Three
// distinct gaps closed:
//
//  Class 1: realtime fanout missing on POST/POST/POST/DELETE/POST routes
//           in routes/invites.ts (create, mark-accepted, decline, revoke,
//           bulk), and on PUT/DELETE/PUT/DELETE in pods.ts + sessions.ts.
//
//  Class 2: status-blind pod_members EXISTS checks in routes/notifications.ts
//           and services/invite/invite.service.ts. A 'removed' row was
//           counted as "still a member", so a re-invited removed user
//           saw the new pending invite displayed as "Accepted" in the
//           notification bell, and the same user's "Received Invites"
//           list silently hid the new invite altogether.
//
//  Class 3: orphan accepted invites stayed valid after the user was
//           removed from the pod. Clicking the old link would silently
//           reactivate their pod membership via addMember's reactivation
//           path. removeMember now revokes the user's prior invites for
//           that pod so the only way back in is a fresh invite.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Bug 30 — realtime fanout on every invite / pod / session mutation', () => {
  const invitesRoute = readServer('routes/invites.ts');
  const podsRoute = readServer('routes/pods.ts');
  const sessionsRoute = readServer('routes/sessions.ts');

  describe('Class 1 — invite routes', () => {
    it('POST /invites fans out pod + session list changes', () => {
      const idx = invitesRoute.search(/const\s+invite\s*=\s*await\s+inviteService\.createInvite/);
      expect(idx).toBeGreaterThan(-1);
      const fn = invitesRoute.slice(idx, idx + 1500);
      expect(fn).toMatch(/notifyPodChanged\(invite\.podId\s*,\s*'invite_sent'/);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,120}invite\.sessionId[\s\S]{0,80}'invite_sent'/);
    });

    it('POST /invites/:code/mark-accepted fans out', () => {
      const idx = invitesRoute.indexOf("'/:code/mark-accepted'");
      const end = invitesRoute.indexOf("// ─── POST /invites/:code/decline", idx);
      const fn = invitesRoute.slice(idx, end > -1 ? end : idx + 3000);
      expect(fn).toMatch(/notifyPodChanged\([\s\S]{0,80}'invite_force_accepted'/);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,160}'invite_force_accepted'/);
    });

    it('POST /invites/:code/decline fans out', () => {
      const idx = invitesRoute.indexOf("'/:code/decline'");
      const end = invitesRoute.indexOf("// ─── DELETE /invites/:id", idx);
      const fn = invitesRoute.slice(idx, end > -1 ? end : idx + 3000);
      expect(fn).toMatch(/notifyPodChanged\([\s\S]{0,80}'invite_declined'/);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,160}'invite_declined'/);
    });

    it('DELETE /invites/:id (revoke) fans out', () => {
      const idx = invitesRoute.search(/const\s+revoked\s*=\s*await\s+inviteService\.revokeInvite/);
      expect(idx).toBeGreaterThan(-1);
      const fn = invitesRoute.slice(idx, idx + 1500);
      expect(fn).toMatch(/notifyPodChanged\([\s\S]{0,80}'invite_revoked'/);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,160}'invite_revoked'/);
    });

    it('POST /invites/bulk fans out once after the loop', () => {
      const idx = invitesRoute.indexOf("'/bulk'");
      const fn = invitesRoute.slice(idx, idx + 3500);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,160}'invite_bulk_sent'/);
      expect(fn).toMatch(/notifyPodChanged\([\s\S]{0,80}'invite_bulk_sent'/);
    });
  });

  describe('Class 1 — pod routes', () => {
    it('PUT /pods/:id fans out pod_updated', () => {
      const idx = podsRoute.search(/const\s+pod\s*=\s*await\s+podService\.updatePod/);
      expect(idx).toBeGreaterThan(-1);
      const fn = podsRoute.slice(idx, idx + 1500);
      expect(fn).toMatch(/notifyPodChanged\([\s\S]{0,80}'pod_updated'/);
    });

    it('DELETE /pods/:id fans out pod_deleted before the delete query runs', () => {
      const idx = podsRoute.search(/await\s+podService\.deletePod/);
      expect(idx).toBeGreaterThan(-1);
      // Take a window that covers the surrounding handler body.
      const fn = podsRoute.slice(Math.max(0, idx - 1500), idx + 500);
      expect(fn).toMatch(/notifyPodChanged\([\s\S]{0,80}'pod_deleted'/);
      const notifyIdx = fn.indexOf("'pod_deleted'");
      const deleteIdx = fn.indexOf('podService.deletePod');
      expect(notifyIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(notifyIdx).toBeLessThan(deleteIdx);
    });
  });

  describe('Class 1 — session routes', () => {
    it('PUT /sessions/:id fans out session_updated', () => {
      const idx = sessionsRoute.search(/const\s+session\s*=\s*await\s+sessionService\.updateSession/);
      expect(idx).toBeGreaterThan(-1);
      const fn = sessionsRoute.slice(idx, idx + 1500);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,200}'session_updated'/);
    });

    it('DELETE /sessions/:id fans out session_deleted after the delete', () => {
      const idx = sessionsRoute.search(/await\s+sessionService\.deleteSession/);
      expect(idx).toBeGreaterThan(-1);
      const fn = sessionsRoute.slice(Math.max(0, idx - 1500), idx + 1500);
      expect(fn).toMatch(/notifySessionListChanged\([\s\S]{0,200}'session_deleted'/);
      const podLookup = fn.indexOf('SELECT pod_id FROM sessions');
      const deleteCall = fn.indexOf('sessionService.deleteSession');
      expect(podLookup).toBeGreaterThan(-1);
      expect(deleteCall).toBeGreaterThan(-1);
      expect(podLookup).toBeLessThan(deleteCall);
    });
  });

  describe('Class 2 — pod_members EXISTS checks filter by status', () => {
    const notificationsRoute = readServer('routes/notifications.ts');
    const inviteService = readServer('services/invite/invite.service.ts');

    it('notifications GET smart-status CASE excludes removed/left/declined for the pod branch', () => {
      // The pod branch in the CASE block must include the status filter
      // — mirroring the sessions branch above it.
      const podBranchIdx = notificationsRoute.indexOf(
        'WHEN i.pod_id IS NOT NULL AND EXISTS',
      );
      expect(podBranchIdx).toBeGreaterThan(-1);
      const branch = notificationsRoute.slice(podBranchIdx, podBranchIdx + 700);
      expect(branch).toMatch(
        /pm\.status\s+NOT\s+IN\s*\(\s*'removed'\s*,\s*'left'\s*,\s*'declined'\s*\)/,
      );
    });

    it('listReceivedInvites filter excludes removed/left/declined for the pod branch', () => {
      // userFilter must apply the same predicate to its pod_members
      // NOT EXISTS so a removed user still sees the new pending invite.
      const filterIdx = inviteService.indexOf('AND (i.pod_id IS NULL OR NOT EXISTS');
      expect(filterIdx).toBeGreaterThan(-1);
      const block = inviteService.slice(filterIdx, filterIdx + 700);
      expect(block).toMatch(
        /pm\.status\s+NOT\s+IN\s*\(\s*'removed'\s*,\s*'left'\s*,\s*'declined'\s*\)/,
      );
    });
  });

  describe('Class 3 — pod removeMember invalidates orphan accepted invites', () => {
    const podService = readServer('services/pod/pod.service.ts');

    it('removeMember revokes accepted+pending invites for this (pod, user)', () => {
      const fnIdx = podService.indexOf('export async function removeMember');
      expect(fnIdx).toBeGreaterThan(-1);
      const end = podService.indexOf('\nexport async function', fnIdx + 1);
      const fn = podService.slice(fnIdx, end > -1 ? end : podService.length);
      expect(fn).toMatch(
        /UPDATE\s+invites\s+SET\s+status\s*=\s*'revoked'/,
      );
      expect(fn).toMatch(/pod_id\s*=\s*\$1/);
      expect(fn).toMatch(
        /status\s+IN\s*\(\s*'accepted'\s*,\s*'pending'\s*\)/,
      );
      // Match either user_id directly or by email (covers both shapes).
      expect(fn).toMatch(/accepted_by_user_id\s*=\s*\$2/);
      expect(fn).toMatch(/LOWER\(invitee_email\)\s*=\s*LOWER\(\$3\)/);
    });
  });

  describe('Service layer returns affected IDs so routes can fan out', () => {
    const inviteService = readServer('services/invite/invite.service.ts');

    it('declineInvite returns { podId, sessionId }', () => {
      expect(inviteService).toMatch(
        /export async function declineInvite\([\s\S]{0,200}\):\s*Promise<\{\s*podId:\s*string\s*\|\s*null;\s*sessionId:\s*string\s*\|\s*null;?\s*\}>/,
      );
      // Underlying UPDATE uses RETURNING so the affected row's pod_id/
      // session_id are surfaced without a second query.
      const fnIdx = inviteService.indexOf('export async function declineInvite');
      const fn = inviteService.slice(fnIdx, fnIdx + 1500);
      expect(fn).toMatch(/RETURNING pod_id, session_id/);
    });

    it('revokeInvite returns { podId, sessionId }', () => {
      expect(inviteService).toMatch(
        /export async function revokeInvite\([\s\S]{0,200}\):\s*Promise<\{\s*podId:\s*string\s*\|\s*null;\s*sessionId:\s*string\s*\|\s*null;?\s*\}>/,
      );
      const fnIdx = inviteService.indexOf('export async function revokeInvite');
      const fn = inviteService.slice(fnIdx, fnIdx + 1500);
      expect(fn).toMatch(/RETURNING pod_id, session_id/);
    });
  });

  describe('Client — legacy invalidation bridge invalidates invite query keys on socket events', () => {
    // Bug 32 (19 May Ali) — handlers moved out of NotificationBell into the
    // app-root bridge so they fire on EVERY page, not just AppLayout-wrapped
    // pages. The same key inventory the bell used to own now lives here.
    const bridgeSrc = readClient('realtime/useLegacyInvalidationBridge.ts');

    it('pod:membership_updated handler invalidates every pod + invite list query key', () => {
      // Bug 41 (19 May Ali) — bridge moved keys into scoped const
      // arrays. Pin keys-as-strings anywhere in the file.
      const requiredKeys = [
        'my-pods', 'pod', 'pod-members', 'pod-member-counts',
        'pod-pending-invites', 'pod-session-count',
        'received-invites', 'my-invites',
      ];
      for (const key of requiredKeys) {
        expect(bridgeSrc).toMatch(new RegExp(`['"]${key}['"]`));
      }
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]pod:membership_updated['"]/);
    });

    it('session:list_changed handler invalidates every session + invite query key', () => {
      const requiredKeys = [
        'my-sessions', 'session-detail', 'session-participants',
        'session-participant-counts', 'session-pending-invites',
        'received-invites', 'my-invites',
      ];
      for (const key of requiredKeys) {
        expect(bridgeSrc).toMatch(new RegExp(`['"]${key}['"]`));
      }
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]session:list_changed['"]/);
    });

    it('notification:new handler invalidates received-invites for the invitee', () => {
      const handlerIdx = bridgeSrc.indexOf("socket.on('notification:new'");
      // Look at the handler defined right above the .on() registration.
      const start = bridgeSrc.lastIndexOf('const notificationNewHandler', handlerIdx);
      const fn = bridgeSrc.slice(start, handlerIdx);
      expect(fn).toMatch(/queryKey:\s*\[\s*['"]received-invites['"]\s*\]/);
    });
  });
});
