// ─── Pod Access Control Tests ────────────────────────────────────────────────
// Unit tests for canViewPod() — enforces read-access gate on pod detail.
// Shirley pilot S2 (11 Nov 2026): one read answers both questions (the pod's visibility, and whether the person is an
// ACTIVE member). A private pod (and an old invite-only one, D2) is open only to its active members and admins: a row
// that is removed, left, declined or pending no longer opens it.

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery }));

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

describe('canViewPod', () => {
  beforeEach(() => mockQuery.mockReset());

  it('grants access to admin regardless of visibility', async () => {
    const { canViewPod } = await import('../../../services/pods/pod-access');
    const result = await canViewPod('admin-id', 'pod-1', 'admin');
    expect(result).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('grants access to super_admin', async () => {
    const { canViewPod } = await import('../../../services/pods/pod-access');
    const result = await canViewPod('sa-id', 'pod-1', 'super_admin');
    expect(result).toBe(true);
  });

  it('asks once: the visibility and whether the person holds an ACTIVE membership, parameterised', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ visibility: 'private', active_member: true }] });
    const { canViewPod } = await import('../../../services/pods/pod-access');
    expect(await canViewPod('me', 'pod-1', 'member')).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(flat(sql)).toBe(
      "SELECT p.visibility::text AS visibility, EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active') AS active_member FROM pods p WHERE p.id = $1");
    expect(params).toEqual(['pod-1', 'me']);
  });

  it.each(['public', 'public_with_approval'])('grants access to a non-member for a %s pod (its overview is discoverable)', async (visibility) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ visibility, active_member: false }] });
    const { canViewPod } = await import('../../../services/pods/pod-access');
    expect(await canViewPod('me', 'pod-1', 'member')).toBe(true);
  });

  it.each(['private', 'invite_only', 'request_to_join'])('denies a non-member a %s pod (old values read as private)', async (visibility) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ visibility, active_member: false }] });
    const { canViewPod } = await import('../../../services/pods/pod-access');
    expect(await canViewPod('me', 'pod-1', 'member')).toBe(false);
  });

  it('S2: someone removed from a private pod, who left it, or whose ask waits or was turned down is denied (no active row)', async () => {
    // The removed / left / declined / pending rows exist, but the EXISTS reads status = 'active' only, so it is false.
    mockQuery.mockResolvedValueOnce({ rows: [{ visibility: 'private', active_member: false }] });
    const { canViewPod } = await import('../../../services/pods/pod-access');
    expect(await canViewPod('removed', 'pod-1', 'member')).toBe(false);
  });

  it('returns false for non-existent pod', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { canViewPod } = await import('../../../services/pods/pod-access');
    const result = await canViewPod('me', 'missing', 'member');
    expect(result).toBe(false);
  });
});
