// T1-2 — Decouple onboarding gate from ProtectedRoute (Issue 1)
//
// Pre-fix: ProtectedRoute redirected all pages (except /onboarding and
// /live) to /onboarding when onboarding_completed=false. Two failure modes:
//   1. Returning users with stale flag got force-re-onboarded
//   2. Invited users (new signups via invite) got intercepted before they
//      could enter the event/lobby
//
// Post-fix (T1-2): ProtectedRoute checked ONLY auth; a non-blocking banner
// in AppLayout nudged incomplete users instead. The legacy blocking gate was
// kept behind VITE_LEGACY_ONBOARDING_GATE for emergency rollback.
//
// D2 supersedes T1-2's flag-gated legacy block with an always-on gate keyed
// on `onboarding_status` (see shared/src/types/onboarding.ts and D1). The
// legacy flag and its block are deleted entirely — see
// client/src/components/layout/ProtectedRoute.tsx and
// e2e/tests/reonboarding-gate.spec.ts for the new contract.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('T1-2 — onboarding gate decoupled from ProtectedRoute', () => {
  describe('client/src/components/layout/ProtectedRoute.tsx (D2: always-on status gate)', () => {
    const src = readClient('components/layout/ProtectedRoute.tsx');

    it('the legacy env-flagged gate is gone — no VITE_LEGACY_ONBOARDING_GATE anywhere', () => {
      expect(src).not.toMatch(/VITE_LEGACY_ONBOARDING_GATE/);
    });

    it('gates on user.onboardingStatus, redirecting to /onboarding unless completed', () => {
      expect(src).toMatch(/user\.onboardingStatus/);
      expect(src).toMatch(/status\s*!==\s*undefined\s*&&\s*status\s*!==\s*['"]completed['"]/);
    });

    it('undefined onboardingStatus fails open (no redirect for a stale cached session)', () => {
      // needsOnboarding must require status !== undefined — an old cached
      // payload without the field must never trigger the redirect.
      expect(src).toMatch(/status\s*!==\s*undefined/);
    });

    it('exempts /onboarding itself, /invite/:code, and live-session paths', () => {
      expect(src).toMatch(/location\.pathname === ['"]\/onboarding['"]/);
      expect(src).toMatch(/location\.pathname\.startsWith\(['"]\/invite\/['"]\)/);
      expect(src).toMatch(/location\.pathname\.startsWith\(['"]\/session\/['"]\)/);
      expect(src).toMatch(/location\.pathname\.includes\(['"]\/live['"]\)/);
    });

    it('has no role exemption — no role/admin check gates the redirect', () => {
      expect(src).not.toMatch(/role\s*===\s*['"]admin['"]/);
      expect(src).not.toMatch(/UserRole\.(ADMIN|SUPER_ADMIN)/);
    });
  });

  describe('client/src/components/layout/AppLayout.tsx — non-blocking banner', () => {
    const src = readClient('components/layout/AppLayout.tsx');

    it('renders a banner when user.onboardingCompleted === false', () => {
      expect(src).toMatch(/onboardingCompleted === false/);
      expect(src).toMatch(/Complete your profile/);
    });

    it('banner is suppressed on the /onboarding page itself (no recursion)', () => {
      expect(src).toMatch(/location\.pathname !== ['"]\/onboarding['"]/);
    });

    it('banner provides a "Complete now" CTA navigating to /onboarding', () => {
      expect(src).toMatch(/navigate\(['"]\/onboarding['"]\)/);
      expect(src).toMatch(/Complete now/);
    });
  });

  describe('server/src/services/identity/identity.service.ts — invited users marked onboarded', () => {
    const src = readServer('services/identity/identity.service.ts');

    it('findOrCreateGoogleUser sets onboarding_completed=TRUE when inviteId is set', () => {
      // The INSERT INTO users statement now includes onboarding_completed column
      // bound to a TS variable derived from inviteId presence. (linkedin_url was
      // appended after it for the join-request seed — the $8 binding is unchanged.)
      expect(src).toMatch(/onboardingCompletedDefault\s*=\s*inviteId\s*!==\s*null/);
      expect(src).toMatch(/onboarding_completed,\s*linkedin_url\)\s*[\s\S]*?VALUES[\s\S]*?\$8/);
    });

    it('non-invited Google signups still default to onboarding_completed=FALSE', () => {
      // The flag is computed from inviteId, so when no invite is involved
      // it stays FALSE — original behaviour preserved for direct sign-ups.
      expect(src).toMatch(/onboardingCompletedDefault\s*=\s*inviteId\s*!==\s*null/);
    });
  });
});
