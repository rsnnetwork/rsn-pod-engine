// ─── User Status Cache Tests ─────────────────────────────────────────────────
// Verifies invalidateUserStatusCache correctly evicts entries so status
// mutations (deactivate/reactivate) take effect immediately.

import { invalidateUserStatusCache, __test__ } from '../../middleware/auth';

jest.mock('../../config', () => ({
  default: { jwtSecret: 'test-secret-key' },
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

describe('user status cache', () => {
  beforeEach(() => {
    __test__.clearAll();
    mockQuery.mockReset();
  });

  it('stores the user status in the cache after a lookup', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', account_kind: 'member' }] });

    await __test__.isUserActive('user-1');

    expect(__test__.hasCached('user-1')).toBe(true);
    expect(__test__.getCached('user-1')?.status).toBe('active');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('serves subsequent calls from the cache without hitting the DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', account_kind: 'member' }] });

    await __test__.isUserActive('user-2');
    await __test__.isUserActive('user-2');
    await __test__.isUserActive('user-2');

    // Only the first call should hit the DB; the other two served from cache.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('removes the user from the cache when invalidateUserStatusCache is called', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', account_kind: 'member' }] });
    await __test__.isUserActive('user-3');
    expect(__test__.hasCached('user-3')).toBe(true);

    invalidateUserStatusCache('user-3');

    expect(__test__.hasCached('user-3')).toBe(false);
  });

  it('re-queries the DB on next lookup after invalidation (picks up new status)', async () => {
    // First lookup: user is active
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', account_kind: 'member' }] });
    const firstActive = await __test__.isUserActive('user-4');
    expect(firstActive).toBe(true);

    // Simulate admin deactivation + cache invalidation
    invalidateUserStatusCache('user-4');

    // Next lookup MUST hit the DB again and return the new status
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'deactivated' }] });
    const secondActive = await __test__.isUserActive('user-4');
    expect(secondActive).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('invalidate is a no-op for an unknown userId', () => {
    expect(() => invalidateUserStatusCache('never-cached')).not.toThrow();
    expect(__test__.hasCached('never-cached')).toBe(false);
  });

  it('invalidating one user does not affect other cached users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', account_kind: 'member' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', account_kind: 'member' }] });

    await __test__.isUserActive('user-a');
    await __test__.isUserActive('user-b');
    expect(__test__.hasCached('user-a')).toBe(true);
    expect(__test__.hasCached('user-b')).toBe(true);

    invalidateUserStatusCache('user-a');

    expect(__test__.hasCached('user-a')).toBe(false);
    expect(__test__.hasCached('user-b')).toBe(true);
  });
});
