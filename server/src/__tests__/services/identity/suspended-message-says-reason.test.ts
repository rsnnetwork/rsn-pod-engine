// ─── The refusal for a suspended account says REASON (21 Oct 2026) ───────────
//
// The client's 19 Oct feedback: "Call it REASON everywhere". The sentence a suspended
// member reads when sign-in is refused names the REASON team.

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../middleware/auth', () => ({ invalidateUserStatusCache: jest.fn(), __esModule: true }));
jest.mock('../../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import { signInRefusal } from '../../../services/identity/account-access';

describe('signInRefusal', () => {
  it.each(['suspended', 'banned'])('tells a %s member to contact the REASON team', (status) => {
    expect(signInRefusal(status)?.message).toBe('This account is suspended. Please contact the REASON team if you think this is a mistake.');
  });

  it('never says RSN to a closed account either', () => {
    expect(signInRefusal('deactivated')?.message).not.toMatch(/\bRSN\b/);
  });

  it('lets an active account in', () => {
    expect(signInRefusal('active')).toBeNull();
  });
});
