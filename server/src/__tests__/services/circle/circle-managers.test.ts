// ─── Who runs a circle, and who may invite to it (1 Nov 2026, L21) ─────────────────────────────────────────────
// A circle's managers are its creator, its owner and moderators, and platform admins. Whoever is in the circle
// may invite to it (today's rule, unchanged); managers may too without being in it.

import { UserRole } from '@rsn/shared';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

import { isCircleManager, mayInviteToCircle } from '../../../services/circle/circle-managers';

beforeEach(() => mockQuery.mockReset());

describe('isCircleManager', () => {
  it('a platform admin or super admin manages every circle, with no lookup', async () => {
    expect(await isCircleManager('c1', 'u1', UserRole.ADMIN)).toBe(true);
    expect(await isCircleManager('c1', 'u1', UserRole.SUPER_ADMIN)).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('the creator, an owner and a moderator manage it; asked for in one parameterised query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await isCircleManager('c1', 'u1', UserRole.MEMBER)).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['c1', 'u1']);
    expect(String(sql)).toMatch(/created_by = \$2/);
    expect(String(sql)).toMatch(/role IN \('owner', 'moderator'\)/);
    expect(String(sql)).not.toMatch(/'member'/);
  });

  it('a plain member, or a stranger, does not manage it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await isCircleManager('c1', 'u2', UserRole.MEMBER)).toBe(false);
  });

  it('an unknown role is a member, never an admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await isCircleManager('c1', 'u2', undefined)).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('mayInviteToCircle', () => {
  it('a platform admin who is not in the circle may invite, with no lookup', async () => {
    expect(await mayInviteToCircle('c1', 'admin-1', UserRole.ADMIN)).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('anyone in the circle may, whatever their role there, and so may its creator', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await mayInviteToCircle('c1', 'u1', UserRole.MEMBER)).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['c1', 'u1']);
    expect(String(sql)).toMatch(/created_by = \$2/);
    expect(String(sql)).toMatch(/FROM circle_members/);
  });

  it('someone who is neither in the circle nor runs it may not', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await mayInviteToCircle('c1', 'stranger', UserRole.MEMBER)).toBe(false);
  });
});
