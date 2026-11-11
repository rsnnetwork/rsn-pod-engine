// ─── Who runs a circle, and who may invite to it (1 Nov 2026, L21; Shirley pilot S2, 11 Nov 2026, D3) ──────────
// A circle's managers are its owner and moderators (circle_members.role) and platform admins. S2: the role alone
// decides; having made the circle (circles.created_by) is no right of its own, so a maker who stepped down or left
// runs nothing. Whoever is in an open circle may invite to it; in a closed one only the people who run it. Only the
// owner (or a platform admin) holds the owner's powers.

import { UserRole } from '@rsn/shared';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

import {
  assertCircleManager, assertCircleOwner, circleAccessColumns, circleRoleOf, isCircleManager, mayInviteToCircle,
  toCircleAccess, OWNER_ONLY,
} from '../../../services/circle/circle-managers';

beforeEach(() => mockQuery.mockReset());
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

describe('isCircleManager', () => {
  it('a platform admin or super admin manages every circle, with no lookup', async () => {
    expect(await isCircleManager('c1', 'u1', UserRole.ADMIN)).toBe(true);
    expect(await isCircleManager('c1', 'u1', UserRole.SUPER_ADMIN)).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an owner or a moderator manages it, by their role row alone, in one parameterised query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await isCircleManager('c1', 'u1', UserRole.MEMBER)).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['c1', 'u1']);
    expect(flat(sql)).toBe(
      "SELECT 1 FROM circle_members m WHERE m.circle_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'moderator')");
  });

  it('S2: the person who made the circle is not asked about at all (a maker who stepped down runs nothing)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await isCircleManager('c1', 'maker', UserRole.MEMBER)).toBe(false);
    expect(flat(mockQuery.mock.calls[0][0])).not.toMatch(/created_by/);
  });

  it('a plain member, or a stranger, does not manage it; an unknown role is a member, never an admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await isCircleManager('c1', 'u2', UserRole.MEMBER)).toBe(false);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await isCircleManager('c1', 'u2', undefined)).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('circleRoleOf', () => {
  it('reads the role row; null for someone not in it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'moderator' }] });
    expect(await circleRoleOf('c1', 'u1')).toBe('moderator');
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await circleRoleOf('c1', 'u9')).toBeNull();
    expect(mockQuery.mock.calls[0][1]).toEqual(['c1', 'u1']);
  });
});

describe('mayInviteToCircle', () => {
  it('a platform admin who is not in the circle may invite, with no lookup', async () => {
    expect(await mayInviteToCircle('c1', 'admin-1', UserRole.ADMIN)).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('someone in the circle may (an open circle: any role; a closed one: owner or moderator), asked in one query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await mayInviteToCircle('c1', 'u1', UserRole.MEMBER)).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['c1', 'u1']);
    expect(flat(sql)).toBe(
      "SELECT 1 FROM circles c JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $2 WHERE c.id = $1 AND (c.join_policy = 'open' OR m.role IN ('owner', 'moderator'))");
  });

  it('someone who is not in the circle may not, even its maker (S2)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await mayInviteToCircle('c1', 'stranger', UserRole.MEMBER)).toBe(false);
    expect(flat(mockQuery.mock.calls[0][0])).not.toMatch(/created_by/);
  });
});

describe('assertCircleManager / assertCircleOwner', () => {
  const live = { rows: [{ id: 'c1', name: 'Curious Humans', join_policy: 'open' }] };

  it('a missing or archived circle is a 404 before anyone is asked about', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(assertCircleManager('c1', 'u1', 'member')).rejects.toMatchObject({ statusCode: 404 });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(assertCircleOwner('c1', 'u1', 'member')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('a moderator passes the manager gate but not the owner gate (403 in words)', async () => {
    mockQuery.mockResolvedValueOnce(live).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertCircleManager('c1', 'mod', 'member')).resolves.toEqual({ id: 'c1', name: 'Curious Humans', joinPolicy: 'open' });
    mockQuery.mockResolvedValueOnce(live).mockResolvedValueOnce({ rows: [{ role: 'moderator' }] });
    await expect(assertCircleOwner('c1', 'mod', 'member')).rejects.toMatchObject({ statusCode: 403, message: OWNER_ONLY });
  });

  it('the owner passes both; a platform admin passes the owner gate with no role lookup', async () => {
    mockQuery.mockResolvedValueOnce(live).mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    await expect(assertCircleOwner('c1', 'owner', 'member')).resolves.toMatchObject({ id: 'c1' });
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce(live);
    await expect(assertCircleOwner('c1', 'admin', 'super_admin')).resolves.toMatchObject({ id: 'c1' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('a member, someone removed or someone who left (no row) is refused by both', async () => {
    mockQuery.mockResolvedValueOnce(live).mockResolvedValueOnce({ rows: [] });
    await expect(assertCircleManager('c1', 'left', 'member', 'No.')).rejects.toMatchObject({ statusCode: 403, message: 'No.' });
    mockQuery.mockResolvedValueOnce(live).mockResolvedValueOnce({ rows: [{ role: 'member' }] });
    await expect(assertCircleOwner('c1', 'member', 'member')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the viewer\'s access on every circle read (S2: myRole and isOwner)', () => {
  it('the columns read the role row and never the maker', () => {
    const cols = flat(circleAccessColumns('c', '$2', '$3'));
    expect(cols).toContain('(SELECT ax_w.role FROM circle_members ax_w WHERE ax_w.circle_id = c.id AND ax_w.user_id = $2) AS my_role');
    expect(cols).toContain('$3::boolean AS viewer_is_admin');
    expect(cols).not.toMatch(/created_by/);
  });

  const row = (over: Record<string, unknown>) => ({
    join_policy: 'open' as const, is_member: false, my_role: null, viewer_is_admin: false, can_manage: false,
    my_request: null, request_count: 3, ...over,
  });

  it.each([
    ['owner', row({ is_member: true, my_role: 'owner', can_manage: true }), { myRole: 'owner', isOwner: true, canManage: true }],
    ['moderator', row({ is_member: true, my_role: 'moderator', can_manage: true }), { myRole: 'moderator', isOwner: false, canManage: true }],
    ['member', row({ is_member: true, my_role: 'member' }), { myRole: 'member', isOwner: false, canManage: false }],
    ['outsider', row({}), { myRole: null, isOwner: false, canManage: false }],
    ['platform admin outside it', row({ viewer_is_admin: true, can_manage: true }), { myRole: null, isOwner: true, canManage: true }],
  ] as const)('%s', (_who, r, expected) => {
    expect(toCircleAccess(r as never)).toMatchObject(expected);
  });

  it('an unknown role string reads as a plain member, never as the owner', () => {
    expect(toCircleAccess(row({ is_member: true, my_role: 'superuser' }) as never)).toMatchObject({ myRole: 'member', isOwner: false });
  });
});
