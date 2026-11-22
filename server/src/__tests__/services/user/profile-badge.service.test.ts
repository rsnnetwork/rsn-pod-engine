// ─── setProfileBadge (21 Nov 2026) ─────────────────────────────────────────────────────────────────────────────
//
// Gives (or takes away) the display-only badge on the members named, in one transaction with one audit_log row per
// member whose badge changed. The statements were also run for real on PGlite (workspace/scratch/2026-11-21-badge).

const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  __esModule: true,
  query: jest.fn(),
  transaction: (cb: (client: { query: typeof mockClientQuery }) => unknown) => cb({ query: mockClientQuery }),
}));

import { setProfileBadge } from '../../../services/user/profile-badge.service';

const A = '7a0d3b4e-1f2a-4c5d-8e9f-0a1b2c3d4e5f';
const B = '8b1e4c5f-2a3b-4d6e-9fa0-1b2c3d4e5f60';
const C = '9c2f5d60-3b4c-4e7f-8ab1-2c3d4e5f6071';

beforeEach(() => {
  mockClientQuery.mockReset();
});

describe('setProfileBadge', () => {
  it('locks the members named (each once, lower-cased), changes only those without the badge, and records each change', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: A, profile_badge: null }, { id: B, profile_badge: 'premium' }] })
      .mockResolvedValue({ rows: [] });
    const result = await setProfileBadge('u-admin', [A, A.toUpperCase(), B, C], 'premium', '10.0.0.1');

    expect(result).toEqual({ changed: [{ userId: A, from: null, to: 'premium' }], missing: [C], found: 2 });
    const [select, update, audit] = mockClientQuery.mock.calls;
    expect(select[0]).toMatch(/SELECT id, profile_badge FROM users WHERE id = ANY\(\$1::uuid\[\]\) FOR UPDATE/);
    expect(select[1]).toEqual([[A, B, C]]);
    expect(update[0]).toMatch(/UPDATE users SET profile_badge = \$1, updated_at = NOW\(\) WHERE id = ANY\(\$2::uuid\[\]\)/);
    expect(update[0]).not.toMatch(/is_premium/);
    expect(update[1]).toEqual(['premium', [A]]);
    expect(audit[0]).toMatch(/INSERT INTO audit_log \(actor_id, action, entity_type, entity_id, details, ip_address\)/);
    expect(audit[0]).toContain("'user.profile_badge_changed', 'user'");
    expect(audit[1][0]).toBe('u-admin');
    expect(JSON.parse(audit[1][1])).toEqual([{ id: A, details: { from: null, to: 'premium', bulk: true } }]);
    expect(audit[1][2]).toBe('10.0.0.1');
  });

  it('writes nothing when every member already holds what was asked', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: A, profile_badge: null }] });
    const result = await setProfileBadge('u-admin', [A], null);
    expect(result).toEqual({ changed: [], missing: [], found: 1 });
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
  });

  it('null takes the badge away, recorded as one press (not bulk), with no address when none is known', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: A, profile_badge: 'premium' }] })
      .mockResolvedValue({ rows: [] });
    const result = await setProfileBadge('u-admin', [A], null);
    expect(result.changed).toEqual([{ userId: A, from: 'premium', to: null }]);
    const audit = mockClientQuery.mock.calls[2];
    expect(JSON.parse(audit[1][1])).toEqual([{ id: A, details: { from: 'premium', to: null, bulk: false } }]);
    expect(audit[1][2]).toBeNull();
  });
});
