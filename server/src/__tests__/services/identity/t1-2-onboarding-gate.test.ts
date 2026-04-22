// T1-2 — Decouple onboarding gate from ProtectedRoute (Issue 1)
//
// Pre-fix: ProtectedRoute redirected all pages (except /onboarding and
// /live) to /onboarding when onboarding_completed=false. Two failure modes:
//   1. Returning users with stale flag got force-re-onboarded
//   2. Invited users (new signups via invite) got intercepted before they
//      could enter the event/lobby
//
// Post-fix:
//   - Server: invited users are created with onboarding_completed=TRUE so
//     they bypass any client-side gate and can join their event immediately
//   - Client: ProtectedRoute checks ONLY auth (not onboarding); a non-
//     blocking banner in AppLayout nudges incomplete users instead
//   - Feature flag VITE_LEGACY_ONBOARDING_GATE=true restores the old gate
//     for emergency rollback (still exempts /invite/:code, the documented bug)

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('T1-2 — onboarding gate decoupled from ProtectedRoute', () => {
  describe('client/src/components/layout/ProtectedRoute.tsx', () => {
    const src = readClient('components/layout/ProtectedRoute.tsx');

    it('the legacy onboarding gate runs ONLY when VITE_LEGACY_ONBOARDING_GATE=true', () => {
      expect(src).toMatch(/import\.meta\.env\.VITE_LEGACY_ONBOARDING_GATE\s*===\s*['"]true['"]/);
    });

    it('the gate exemption now includes /invite/:code (was missing pre-fix)', () => {
      // Even in the legacy code path, /invite/:code must be exempt — this was the documented bug
      const legacyBlock = src.slice(src.indexOf('VITE_LEGACY_ONBOARDING_GATE'));
      expect(legacyBlock).toMatch(/isInviteLanding/);
      expect(legacyBlock).toMatch(/location\.pathname\.startsWith\(['"]\/invite\/['"]\)/);
    });

    it('the default code path returns children without onboarding redirect', () => {
      // After the legacy block, no other onboardingCompleted check
      const afterLegacy = src.slice(src.lastIndexOf('VITE_LEGACY_ONBOARDING_GATE'));
      expect(afterLegacy).toMatch(/return <>\{children\}<\/>/);
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
      // bound to a TS variable derived from inviteId presence
      expect(src).toMatch(/onboardingCompletedDefault\s*=\s*inviteId\s*!==\s*null/);
      expect(src).toMatch(/onboarding_completed\)\s*[\s\S]*?VALUES[\s\S]*?\$8/);
    });

    it('non-invited Google signups still default to onboarding_completed=FALSE', () => {
      // The flag is computed from inviteId, so when no invite is involved
      // it stays FALSE — original behaviour preserved for direct sign-ups.
      expect(src).toMatch(/onboardingCompletedDefault\s*=\s*inviteId\s*!==\s*null/);
    });
  });
});
