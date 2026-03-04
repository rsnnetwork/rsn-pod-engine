// ─── Server Test Entry ───────────────────────────────────────────────────────
// Individual test suites are in subdirectories.
// This file just validates the test infrastructure works.

describe('Test infrastructure', () => {
  it('should run tests with ts-jest', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have access to @rsn/shared via moduleNameMapper', () => {
    const { UserRole, ErrorCodes } = require('@rsn/shared');
    expect(UserRole.MEMBER).toBe('member');
    expect(ErrorCodes.AUTH_UNAUTHORIZED).toBe('AUTH_UNAUTHORIZED');
  });
});