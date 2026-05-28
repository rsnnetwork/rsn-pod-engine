import { computeEligibility } from '../../../services/post-event-message/broadcast-eligibility';
import { UserRole } from '@rsn/shared';

describe('computeEligibility', () => {
  it('admin: enabled + visible', () => {
    expect(computeEligibility({ role: UserRole.ADMIN, isPro: false, isDirector: false }))
      .toEqual({ enabled: true, visible: true, reason: 'admin' });
  });
  it('super_admin: enabled', () => {
    expect(computeEligibility({ role: UserRole.SUPER_ADMIN, isPro: false, isDirector: false }).enabled).toBe(true);
  });
  it('pro (no subscription system yet): visible but disabled, coming soon', () => {
    expect(computeEligibility({ role: UserRole.PRO, isPro: true, isDirector: false }))
      .toEqual({ enabled: false, visible: true, reason: 'pro_coming_soon' });
  });
  it('pod director: visible but disabled, coming soon', () => {
    expect(computeEligibility({ role: UserRole.MEMBER, isPro: false, isDirector: true }))
      .toEqual({ enabled: false, visible: true, reason: 'director_coming_soon' });
  });
  it('plain member: not visible', () => {
    expect(computeEligibility({ role: UserRole.MEMBER, isPro: false, isDirector: false }))
      .toEqual({ enabled: false, visible: false, reason: 'not_allowed' });
  });
});
