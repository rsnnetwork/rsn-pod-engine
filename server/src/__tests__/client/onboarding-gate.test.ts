// server/src/__tests__/client/onboarding-gate.test.ts
// The preview's onboarding gate (30 Oct review, 2.1 and 1.2; L3): everyone who has not done the new onboarding is
// taken through it the next time they open the preview, admins included, and someone who did it without saying where
// they are based is asked for that once. The rule is one pure helper, EXECUTED here against the shapes production
// holds (00-production-facts.md: 27 completed v1, 35 update_required, 15 not_started, 2 in_progress, 44 of 81 with no
// location, values like "USA" and "Nepal"); ProtectedRoute's use of it, its exemptions and its two destinations are
// pinned in its source.
import * as fs from 'fs';
import * as path from 'path';
import { gateTarget, isGateExempt, onboardingDue } from '../../../../client/src/components/layout/onboarding-gate';

const member = (over: Record<string, unknown>) => ({ onboardingStatus: 'completed', onboardingVersion: 2, location: 'Copenhagen, Denmark', ...over });

describe('onboardingDue: who is taken where', () => {
  it('a member who finished the new onboarding and says where they are based goes where they were going', () => {
    expect(onboardingDue(member({}))).toBeNull();
    expect(onboardingDue(member({ location: 'Omaha, NE ' }))).toBeNull();
    expect(onboardingDue(member({ location: 'Greater Copenhagen Region' }))).toBeNull();
  });

  it('a member who finished only the earlier onboarding is taken through the new one (27 on production)', () => {
    expect(onboardingDue(member({ onboardingVersion: null, location: 'Manchester, UK' }))).toBe('flow');
    expect(onboardingDue(member({ onboardingVersion: 1 }))).toBe('flow');
  });

  it('a member who has not finished any is taken through it: update_required, not_started, in_progress', () => {
    for (const onboardingStatus of ['update_required', 'not_started', 'in_progress']) {
      expect(onboardingDue(member({ onboardingStatus, onboardingVersion: null }))).toBe('flow');
    }
  });

  it('a new-onboarding member with no location, or only a country, is asked for it once', () => {
    expect(onboardingDue(member({ location: null }))).toBe('location');
    expect(onboardingDue(member({ location: '' }))).toBe('location');
    expect(onboardingDue(member({ location: '   ' }))).toBe('location');
    expect(onboardingDue(member({ location: 'United Kingdom' }))).toBe('location');
    expect(onboardingDue(member({ location: 'USA' }))).toBe('location');
    expect(onboardingDue(member({ location: 'Nepal' }))).toBe('location');
  });

  it('fails open on a session that does not say: no status at all (a stale cached session)', () => {
    expect(onboardingDue(member({ onboardingStatus: undefined }))).toBeNull();
    expect(onboardingDue({})).toBeNull();
    expect(onboardingDue(null)).toBeNull();
  });

  it('fails open on a session from a server without onboardingVersion: the old status rule, and no location ask', () => {
    expect(onboardingDue(member({ onboardingVersion: undefined, location: null }))).toBeNull();
    expect(onboardingDue(member({ onboardingVersion: undefined, onboardingStatus: 'update_required' }))).toBe('flow');
  });

  it('has no role exemption: an admin is gated like everyone', () => {
    expect(onboardingDue(member({ role: 'super_admin', location: null }))).toBe('location');
    expect(onboardingDue(member({ role: 'admin', onboardingVersion: null }))).toBe('flow');
  });
});

describe('isGateExempt: pages never diverted', () => {
  it.each([
    '/onboarding', '/invite/abc123', '/session/s-1/live', '/meet/x', '/meet/0a1b2c', '/session/s-1/host',
    '/logout', '/signout', '/privacy', '/terms', '/legal', '/legal/terms',
  ])('%s is exempt', (p) => {
    expect(isGateExempt(p)).toBe(true);
  });

  it.each(['/', '/profile', '/profile/edit', '/session/s-1', '/sessions', '/meetings', '/admin/users', '/meet', '/meetx', '/onboarding/x'])(
    '%s is gated', (p) => {
      expect(isGateExempt(p)).toBe(false);
    },
  );
});

describe('gateTarget: where the gate sends them, carrying the page', () => {
  it('the whole flow, or straight to the location field, each with the page they were going to', () => {
    expect(gateTarget('flow', '/pods/p-1', '?tab=members')).toBe('/onboarding?redirect=%2Fpods%2Fp-1%3Ftab%3Dmembers');
    expect(gateTarget('location', '/profile', '')).toBe('/onboarding?edit=profile&redirect=%2Fprofile');
  });

  it('a page inside onboarding itself is never a redirect target', () => {
    expect(gateTarget('flow', '/onboarding/x', '')).toBe('/onboarding?redirect=%2F');
  });
});

describe('ProtectedRoute uses the helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../../client/src/components/layout/ProtectedRoute.tsx'), 'utf8');

  it('gates on onboardingDue with the exemptions, and keeps the sign-in redirect carrying the page', () => {
    expect(src).toMatch(/onboardingDue\(user\)/);
    expect(src).toMatch(/isGateExempt\(location\.pathname\)/);
    expect(src).toMatch(/gateTarget\(due, location\.pathname, location\.search\)/);
    expect(src).toMatch(/signInPathFor\(location\.pathname, location\.search\)/);
    expect(src).not.toMatch(/role\s*===\s*['"]admin['"]|UserRole\.(ADMIN|SUPER_ADMIN)/);
  });
});
