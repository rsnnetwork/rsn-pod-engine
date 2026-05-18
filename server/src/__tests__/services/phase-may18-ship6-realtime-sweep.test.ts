// Stefan's 18 May post-test feedback — Ship #6 realtime sweep.
//
// Bugs 19 + 20 + 21 — the systematic "no refresh anywhere" mandate
// extended past in-session surfaces to pods, sessions/events lists, and
// late-joiner state propagation.

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
function readShared(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../shared/src', rel),
    'utf8',
  );
}

describe('Stefan 18 May — Ship #6 realtime sweep', () => {
  describe('Bug 19 — pod mutations broadcast to every member', () => {
    const orchSrc = readServer('services/orchestration/orchestration.service.ts');
    const podsRoutes = readServer('routes/pods.ts');

    it('notifyPodChanged fans out pod:membership_updated to every active member', () => {
      const fnIdx = orchSrc.indexOf('export async function notifyPodChanged');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = orchSrc.slice(fnIdx, fnIdx + 2000);
      expect(fn).toMatch(/SELECT user_id FROM pod_members/);
      expect(fn).toMatch(
        /io\.to\(userRoom\(row\.user_id\)\)\.emit\(\s*'pod:membership_updated'/,
      );
    });

    it('add / remove / role-change / join / approve / reject routes all call notifyPodChanged', () => {
      // Every pod-mutating REST handler wires the fan-out. Pre-fix only
      // the affected user received pod:membership_updated; OTHER pod
      // members' UIs went stale until refresh.
      const causes = [
        'member_added',
        'member_removed',
        'role_changed',
        'member_joined',
        'member_approved',
        'member_rejected',
      ];
      for (const cause of causes) {
        expect(podsRoutes).toMatch(
          new RegExp(`notifyPodChanged\\(req\\.params\\.id,\\s*'${cause}'`),
        );
      }
    });
  });

  describe('Bug 20 — sessions list mutations broadcast', () => {
    const orchSrc = readServer('services/orchestration/orchestration.service.ts');
    const sessionsRoutes = readServer('routes/sessions.ts');
    const eventsSrc = readShared('types/events.ts');
    // Bug 32 (19 May Ali) — the legacy invalidation logic the bell used
    // to own was extracted into an app-root bridge so it fires on every
    // page, not just AppLayout-wrapped pages. Test pin moved accordingly.
    const bridgeSrc = readClient('realtime/useLegacyInvalidationBridge.ts');

    it('notifySessionListChanged fans out session:list_changed via session_participants + pod_members union', () => {
      const fnIdx = orchSrc.indexOf('export async function notifySessionListChanged');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = orchSrc.slice(fnIdx, fnIdx + 2500);
      expect(fn).toMatch(/FROM session_participants/);
      expect(fn).toMatch(/FROM pod_members/);
      expect(fn).toMatch(
        /io\.to\(userRoom\(row\.user_id\)\)\.emit\(\s*'session:list_changed'/,
      );
    });

    it('session creation route emits notifySessionListChanged', () => {
      // Inline dynamic import keeps the import graph light but the call
      // must still fire on successful creation.
      expect(sessionsRoutes).toMatch(/notifySessionListChanged\(/);
      expect(sessionsRoutes).toMatch(/session_created/);
    });

    it('shared event type declares session:list_changed', () => {
      expect(eventsSrc).toMatch(
        /'session:list_changed':[\s\S]{0,200}sessionId:\s*string;\s*podId:\s*string\s*\|\s*null;\s*cause:\s*string/,
      );
    });

    it('App-root invalidation bridge subscribes to session:list_changed and invalidates session queries', () => {
      // Bug 41 (19 May Ali) — bridge moved keys into scoped const
      // arrays. Pin keys as string literals + the subscription.
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]session:list_changed['"]/);
      expect(bridgeSrc).toMatch(/['"]my-sessions['"]/);
      expect(bridgeSrc).toMatch(/['"]pod-sessions['"]/);
      expect(bridgeSrc).toMatch(/['"]session-detail['"]/);
    });
  });

  describe('Bug 21 — late-joiner roster propagation', () => {
    const flowSrc = readServer('services/orchestration/handlers/participant-flow.ts');

    it('participant:joined emit is followed by a roster:changed broadcast for the whole session', () => {
      // Pre-fix only the local participant:joined event handler added the
      // user to each client's local store, which could leave the hostsSet
      // / count derivation stale on slow networks. Now the server also
      // broadcasts roster:changed so every client refetches the snapshot
      // and converges on the same count, hosts, and badges.
      expect(flowSrc).toMatch(
        /emit\(\s*'participant:joined'[\s\S]{0,800}emit\(\s*'roster:changed'[\s\S]{0,200}participant_joined/,
      );
    });
  });
});
