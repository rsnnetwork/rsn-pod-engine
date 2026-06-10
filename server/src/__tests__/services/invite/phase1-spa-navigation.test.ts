// Phase 1 — Platform-spec spec, 29 April 2026.
//
// These tests pin the architectural invariants of Phase 1:
//   1. Invite-accept paths use react-router navigate(), not window.location.href.
//      The page-reload was a workaround for cache-staleness fears that wiped
//      the SPA experience and forced a white flash. Now we trust React Query.
//   2. Server-side display-name fallbacks use email-prefix / short-userId,
//      never the literal "User" or "Partner" — that's what produced the
//      "Not matched: User, User" placeholder on the host matching screen.
//   3. NotificationBell uses useNavigate (the bell IS inside the React Router
//      context — the old comment claiming otherwise was wrong; portal children
//      inherit context from where the portal is declared, not where it's
//      rendered in the DOM).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../../client/src', rel),
    'utf8',
  );
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../', rel),
    'utf8',
  );
}

describe('Phase 1 — SPA navigation + name-fallback architecture', () => {
  describe('client invite-accept paths use react-router navigate (not window.location.href)', () => {
    it('InviteAcceptPage.accept() does not redirect via window.location.href', () => {
      const src = readClient('features/invites/InviteAcceptPage.tsx');
      const acceptStart = src.indexOf('const accept = useCallback');
      expect(acceptStart).toBeGreaterThan(-1);
      const acceptEnd = src.indexOf('}, [code,', acceptStart);
      expect(acceptEnd).toBeGreaterThan(acceptStart);
      const acceptBody = src.slice(acceptStart, acceptEnd);
      // Strip line and block comments before testing — the file legitimately
      // mentions window.location.href in an explanatory comment about the
      // pre-fix workaround. We only want to ban actual statement-level usage.
      const stripped = acceptBody
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(stripped).not.toMatch(/window\.location\.href/);
      expect(acceptBody).toMatch(/navigate\(destination/);
    });

    it('NotificationBell handleAcceptInvite does not redirect via window.location.href', () => {
      const src = readClient('components/ui/NotificationBell.tsx');
      const handlerStart = src.indexOf('const handleAcceptInvite');
      expect(handlerStart).toBeGreaterThan(-1);
      // End at the next top-level handler declaration
      const handlerEnd = src.indexOf('const handleDeclineInvite', handlerStart);
      expect(handlerEnd).toBeGreaterThan(handlerStart);
      const body = src.slice(handlerStart, handlerEnd);
      expect(body).not.toMatch(/window\.location\.href/);
      expect(body).toMatch(/navigate\(dest\)/);
    });

    it('NotificationBell.handleClick (notification click navigation) uses navigate() not href', () => {
      const src = readClient('components/ui/NotificationBell.tsx');
      const handlerStart = src.indexOf('const handleClick = async (n: Notification)');
      expect(handlerStart).toBeGreaterThan(-1);
      const handlerEnd = src.indexOf('const formatTime', handlerStart);
      expect(handlerEnd).toBeGreaterThan(handlerStart);
      const body = src.slice(handlerStart, handlerEnd);
      expect(body).not.toMatch(/window\.location\.href/);
      expect(body).toMatch(/navigate\(dest\)/);
    });

    it('NotificationBell imports useNavigate from react-router-dom', () => {
      const src = readClient('components/ui/NotificationBell.tsx');
      expect(src).toMatch(/from\s+['"]react-router-dom['"]/);
      expect(src).toMatch(/useNavigate/);
    });
  });

  describe('server display-name fallbacks use email-prefix, never literal "User" / "Partner"', () => {
    it('matching-flow.ts sendMatchPreview builds nameMap with email-prefix fallback', () => {
      const src = readServer('services/orchestration/handlers/matching-flow.ts');
      const fnStart = src.indexOf('export async function sendMatchPreview');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Phase 5 (1 May spec) — the inline fallback function is gone; replaced
      // by the shared resolveDisplayName helper which still consults email.
      expect(fn).toMatch(/resolveDisplayName/);
      expect(fn).toMatch(/email/);
      // No literal "|| 'User'" in the nameMap construction (the placeholder bug)
      expect(fn).not.toMatch(/r\.displayName\s*\|\|\s*['"]User['"]/);
      expect(fn).not.toMatch(/nameMap\.get\([^)]+\)\s*\|\|\s*['"]User['"]/);
    });

    it('matching-flow.ts byeParticipants list never falls back to literal "User"', () => {
      const src = readServer('services/orchestration/handlers/matching-flow.ts');
      // The byeParticipants block builds displayName via the same safe fallback.
      // The placeholder text "Not matched: User, User" came from the previous
      // `|| 'User'` literal; we explicitly assert it is gone.
      const byeBlockStart = src.indexOf('let byeUserIds');
      expect(byeBlockStart).toBeGreaterThan(-1);
      const byeBlockEnd = src.indexOf('socket.emit(', byeBlockStart);
      expect(byeBlockEnd).toBeGreaterThan(byeBlockStart);
      const byeBlock = src.slice(byeBlockStart, byeBlockEnd);
      expect(byeBlock).not.toMatch(/\|\|\s*['"]User['"]/);
      expect(byeBlock).toMatch(/safeName\(uid\)/);
    });

    it('participant-flow.ts rating-prompt name lookup uses email-prefix fallback (no "Partner, Partner" trios)', () => {
      const src = readServer('services/orchestration/handlers/participant-flow.ts');
      // Phase 5 (1 May spec): inline fallback functions removed; the shared
      // resolveDisplayName helper consults email.
      expect(src).toMatch(/resolveDisplayName/);
      // No bare `|| 'Partner'` literal in the nameMap construction
      expect(src).not.toMatch(/r\.displayName\s*\|\|\s*['"]Partner['"]/);
    });
  });

  describe('client silent error swallows are gone for important user-facing paths', () => {
    it('useSessionSocket.ts auto-register does NOT silently swallow non-idempotent errors', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      // The auto-register catch should at least console.warn or surface the error,
      // not be a bare `.catch(() => {})`.
      const idx = src.indexOf("/sessions/${sessionId}/register");
      expect(idx).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 900);
      expect(block).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
      expect(block).toMatch(/console\.warn|addToast/);
    });

    it('SessionDetailPage auto-register surfaces non-idempotent errors via toast', () => {
      const src = readClient('features/sessions/SessionDetailPage.tsx');
      // The auto-register useEffect should call addToast on real errors,
      // not be a bare `.catch(() => {})`.
      const idx = src.indexOf("api.post(`/sessions/${sessionId}/register`).then");
      expect(idx).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 600);
      expect(block).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\/?\*[^*]*\*\/\s*\}\)/);
      expect(block).toMatch(/addToast/);
    });

    it('PodDetailPage Remind All tells the truth about send failures (no blanket success toast)', () => {
      const src = readClient('features/pods/PodDetailPage.tsx');
      // Pre-fix: forEach with .catch(() => {}) followed by an unconditional
      // success toast. Post-fix: Promise.allSettled + accurate toast.
      const idx = src.indexOf('Remind All');
      expect(idx).toBeGreaterThan(-1);
      const remindBlockStart = src.lastIndexOf('onClick={', idx);
      const remindBlockEnd = src.indexOf('}}', remindBlockStart);
      const block = src.slice(remindBlockStart, remindBlockEnd + 200);
      expect(block).toMatch(/Promise\.allSettled/);
      expect(block).toMatch(/failed/);
    });
  });
});
