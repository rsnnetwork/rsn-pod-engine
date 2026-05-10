// T1-3 — GET /pods/:id/active-session + auto-redirect after pod join (Issue 3)
//
// Pre-fix: PodDetailPage joined the pod, showed a toast, and left the user
// on the pod page. The user had to manually go to /sessions and find the
// event. Frustrating. Especially bad when the pod has a live event in
// progress — the user joined to participate but couldn't find it.
//
// Post-fix:
//   - New endpoint GET /api/pods/:id/active-session returns the live or
//     imminent session for that pod (or { session: null }).
//   - PodDetailPage.joinMutation.onSuccess calls the endpoint and auto-
//     navigates to /session/:id/live for live, /sessions/:id for imminent.
//   - Falls back to the original toast when no live/imminent session exists.
//
// NOTE on URL spelling: the live-event route is `/session/:id/live`
// (SINGULAR). Plural `/sessions/...` is the registration-list namespace
// — landing there falls into the SPA 404. This test previously asserted
// the plural URL, which silently pinned the bug it was supposed to guard.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string, root: string = '../../'): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, root, rel), 'utf8');
}

describe('T1-3 — pod active-session endpoint + auto-redirect', () => {
  describe('server: GET /pods/:id/active-session', () => {
    const src = readSource('routes/pods.ts');

    it('routes/pods.ts registers the new endpoint', () => {
      expect(src).toMatch(/router\.get\(\s*['"]\/:id\/active-session['"]/);
    });

    it('endpoint is gated by authenticate + pod membership (admin bypass)', () => {
      const epIdx = src.indexOf("'/:id/active-session'");
      const block = src.slice(epIdx, epIdx + 2000);
      expect(block).toMatch(/authenticate/);
      expect(block).toMatch(/getMemberRole\(req\.params\.id,\s*req\.user!\.userId\)/);
      expect(block).toMatch(/hasRoleAtLeast\(req\.user!\.role,\s*UserRole\.ADMIN\)/);
    });

    it('queries for live sessions across all 5 active statuses', () => {
      const epIdx = src.indexOf("'/:id/active-session'");
      const block = src.slice(epIdx, epIdx + 2500);
      // All five live statuses present in the IN clause
      ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'].forEach(s => {
        expect(block).toMatch(new RegExp(`'${s}'`));
      });
    });

    it('falls back to imminent-scheduled (next 60 min) when no live session', () => {
      const epIdx = src.indexOf("'/:id/active-session'");
      const block = src.slice(epIdx, epIdx + 3000);
      expect(block).toMatch(/scheduled_at <= NOW\(\) \+ INTERVAL '60 minutes'/);
      expect(block).toMatch(/status = 'scheduled'/);
    });

    it("returns { session: null } when nothing live or imminent (200 OK, not 404)", () => {
      const epIdx = src.indexOf("'/:id/active-session'");
      const block = src.slice(epIdx, epIdx + 3000);
      expect(block).toMatch(/data:\s*\{\s*session\s*\}/);
    });
  });

  describe('client: PodDetailPage auto-redirects after join', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../client/src/features/pods/PodDetailPage.tsx'),
      'utf8',
    );

    it('joinMutation.onSuccess calls /pods/:id/active-session', () => {
      const fnStart = src.indexOf('const joinMutation = useMutation');
      const fnEnd = src.indexOf('const requestJoinMutation', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/api\.get\(`\/pods\/\$\{podId\}\/active-session`\)/);
    });

    it('navigates to /session/:id/live for live statuses (singular — matches App.tsx Route)', () => {
      const fnStart = src.indexOf('const joinMutation = useMutation');
      const fnEnd = src.indexOf('const requestJoinMutation', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/navigate\(`\/session\/\$\{session\.id\}\/live`\)/);
      expect(fn).not.toMatch(/navigate\(`\/sessions\/\$\{session\.id\}\/live`\)/);
    });

    it('navigates to /sessions/:id (detail page) for imminent scheduled', () => {
      const fnStart = src.indexOf('const joinMutation = useMutation');
      const fnEnd = src.indexOf('const requestJoinMutation', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/navigate\(`\/sessions\/\$\{session\.id\}`\)/);
    });

    it('falls back to default toast when no live/imminent session', () => {
      const fnStart = src.indexOf('const joinMutation = useMutation');
      const fnEnd = src.indexOf('const requestJoinMutation', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/addToast\(['"]Joined pod!['"]/);
    });
  });
});
