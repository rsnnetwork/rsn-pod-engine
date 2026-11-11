// ─── Shirley pilot S2 (11 Nov 2026): taking a pod out of a circle, an owner who tries to leave, and a circle's
// invitations list ──────────────────────────────────────────────────────────────────────────────────────────────
// detachPod: the circle's owner or a moderator, or the pod's own ACTIVE director (brief RSN 03: "allow owner to
// unlink"; the director may always unlink their pod from any circle), or a platform admin. A pod host, a pod member,
// a circle member and a stranger are refused (403); a missing or archived circle is a 404. Only the link row goes.
// leaveCircle: the owner cannot leave (they hand the circle over first); anyone else leaves as before.
// listCircleInvites: waiting, accepted and declined invitations; the address in full only to its sender and admins.

const mockQuery = jest.fn();
const mockClientSql: string[] = [];
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({
    query: (...a: unknown[]) => { mockClientSql.push(String(a[0]).replace(/\s+/g, ' ').trim()); return mockQuery(...a); },
  }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { DETACH_REFUSAL, OWNER_CANNOT_LEAVE, detachPod, leaveCircle } from '../../../services/circle/circle.service';
import { listCircleInvites } from '../../../services/invite/invite.service';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
beforeEach(() => { mockQuery.mockReset(); mockClientSql.length = 0; });

describe('detachPod (S2)', () => {
  function facts(f: { manages?: boolean; directs?: boolean } | null) {
    mockQuery.mockImplementation(async (sql: string) => {
      const text = flat(sql);
      if (/^SELECT EXISTS \(SELECT 1 FROM circle_members m/.test(text)) return { rows: f ? [{ manages: !!f.manages, directs: !!f.directs }] : [] };
      if (/^DELETE FROM circle_pods WHERE circle_id = \$1 AND pod_id = \$2$/.test(text)) return { rowCount: 1, rows: [] };
      throw new Error(`unmodelled: ${text}`);
    });
  }

  it('asks once: whether the actor runs the circle, and whether they are the pod\'s ACTIVE director (a host is not)', async () => {
    facts({ directs: true });
    await expect(detachPod('c1', 'p1', { userId: 'shirley', role: 'member' })).resolves.toEqual({ detached: true });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toBe(
      "SELECT EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $3 AND m.role IN ('owner', 'moderator')) AS manages, "
      + "EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = $2 AND pm.user_id = $3 AND pm.status = 'active' AND pm.role = 'director') AS directs "
      + 'FROM circles c WHERE c.id = $1 AND c.archived_at IS NULL');
    expect(params).toEqual(['c1', 'p1', 'shirley']);
    expect(flat(mockQuery.mock.calls[1][0])).toBe('DELETE FROM circle_pods WHERE circle_id = $1 AND pod_id = $2');
  });

  it('the circle\'s owner or a moderator may (they run the circle)', async () => {
    facts({ manages: true });
    await expect(detachPod('c1', 'p1', { userId: 'mod', role: 'member' })).resolves.toEqual({ detached: true });
  });

  it('a platform admin may, with neither tie', async () => {
    facts({});
    await expect(detachPod('c1', 'p1', { userId: 'stefan', role: 'super_admin' })).resolves.toEqual({ detached: true });
  });

  it('a pod host or member, a circle member, a removed or left director, a stranger: 403 in words, nothing deleted', async () => {
    facts({});
    await expect(detachPod('c1', 'p1', { userId: 'host', role: 'member' })).rejects.toMatchObject({ statusCode: 403, message: DETACH_REFUSAL });
    expect(mockQuery.mock.calls.some(([s]) => /^DELETE/.test(flat(s)))).toBe(false);
  });

  it('a missing or archived circle is a 404', async () => {
    facts(null);
    await expect(detachPod('c1', 'p1', { userId: 'shirley', role: 'member' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a link that was not there changes nothing (detached false)', async () => {
    facts({ directs: true });
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ manages: false, directs: true }] }));
    mockQuery.mockImplementationOnce(async () => ({ rowCount: 0, rows: [] }));
    await expect(detachPod('c1', 'p1', { userId: 'shirley', role: 'member' })).resolves.toEqual({ detached: false });
  });
});

describe('leaveCircle (S2): the owner stays', () => {
  function arm(role: string | null, circleExists = true) {
    mockQuery.mockImplementation(async (sql: string) => {
      const text = flat(sql);
      if (text === 'SELECT id FROM circles WHERE id = $1 FOR UPDATE') return { rows: circleExists ? [{ id: 'c1' }] : [] };
      if (text === 'SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE') return { rows: role ? [{ role }] : [] };
      if (/^DELETE FROM circle_members/.test(text)) return { rowCount: role ? 1 : 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
  }

  it('the owner is told to hand it over first (400), and nothing is deleted', async () => {
    arm('owner');
    await expect(leaveCircle('c1', 'shirley')).rejects.toMatchObject({ statusCode: 400, message: OWNER_CANNOT_LEAVE });
    expect(mockClientSql.some((s) => /^DELETE FROM circle_members/.test(s))).toBe(false);
  });

  it.each(['moderator', 'member'])('a %s leaves, the count moving in the same transaction; the role is read under a lock', async (role) => {
    arm(role);
    await leaveCircle('c1', 'someone');
    // Fix round 1: the circle row first, then the member row, the one lock order of every circle write (no deadlock
    // with a handover, a role change or a removal at the same moment).
    expect(mockClientSql[0]).toBe('SELECT id FROM circles WHERE id = $1 FOR UPDATE');
    expect(mockClientSql[1]).toBe('SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE');
    expect(mockClientSql.some((s) => /^DELETE FROM circle_members/.test(s))).toBe(true);
    expect(mockClientSql.some((s) => /GREATEST\(member_count - 1, 0\)/.test(s))).toBe(true);
  });

  it('a missing circle is a 404 before any member row is read', async () => {
    arm('member', false);
    await expect(leaveCircle('c1', 'someone')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockClientSql).toEqual(['SELECT id FROM circles WHERE id = $1 FOR UPDATE']);
  });

  it('every circle write takes the circle row before any member row (one lock order)', () => {
    const fsx = jest.requireActual('fs') as typeof import('fs');
    const pathx = jest.requireActual('path') as typeof import('path');
    const src = (f: string) => fsx.readFileSync(pathx.join(__dirname, '../../../services/circle', f), 'utf8');
    const body = (text: string, fn: string) => text.slice(text.indexOf(`export async function ${fn}`), text.indexOf('\n}\n', text.indexOf(`export async function ${fn}`)));
    const checks: Array<[string, string]> = [
      ['circle.service.ts', 'leaveCircle'], ['circle-join.service.ts', 'removeCircleMember'],
      ['circle-roles.service.ts', 'setCircleMemberRole'], ['circle-roles.service.ts', 'transferCircleOwnership'],
    ];
    for (const [file, fn] of checks) {
      const b = body(src(file).replace(/\r\n/g, '\n'), fn);
      const circleLock = Math.max(b.indexOf('FROM circles WHERE id = $1'), b.indexOf('lockCircle(client'));
      const memberLock = b.search(/FROM circle_members[^`]*FOR UPDATE|lockMembers\(client/);
      expect(circleLock).toBeGreaterThan(-1);
      expect(memberLock).toBeGreaterThan(circleLock);
    }
  });

  it('someone not in it leaves nothing, with no error (as before)', async () => {
    arm(null);
    await expect(leaveCircle('c1', 'stranger')).resolves.toBeUndefined();
    expect(mockClientSql.some((s) => /member_count/.test(s))).toBe(false);
  });
});

describe('listCircleInvites (S2)', () => {
  const at = new Date('2026-11-11T10:00:00Z');
  const row = (over: Record<string, unknown>) => ({
    id: 'i1', status: 'pending', declined_at: null, invitee_email: 'new@person.test', max_uses: 1, inviter_id: 'owner',
    inviter_name: 'Shirley', member_id: null, member_name: null, created_at: at, expires_at: null, ...over,
  });

  it('reads waiting (unexpired), accepted and declined invitations only, newest first, bounded, parameterised', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCircleInvites('c1', { userId: 'owner', isAdmin: false });
    const [sql, params] = mockQuery.mock.calls[0];
    const text = flat(sql);
    expect(params).toEqual(['c1']);
    expect(text).toContain("WHERE i.circle_id = $1 AND i.type = 'circle'");
    expect(text).toContain("AND ((i.status = 'pending' AND (i.expires_at IS NULL OR i.expires_at > NOW())) OR i.status = 'accepted' OR (i.status = 'revoked' AND i.declined_at IS NOT NULL))");
    expect(text).toContain('ORDER BY i.created_at DESC, i.id LIMIT 200');
    expect(text).toContain("u.status = 'active'"); // a member is named only while their account is active
  });

  it('the address in full to the person who sent it; masked for another moderator; a member is named', async () => {
    mockQuery.mockResolvedValue({ rows: [
      row({ id: 'mine' }),
      row({ id: 'theirs', inviter_id: 'mod', inviter_name: 'Stefan' }),
      row({ id: 'member', status: 'accepted', member_id: 'u-9', member_name: 'Ana' }),
      row({ id: 'declined', status: 'revoked', declined_at: at, inviter_id: 'mod' }),
      row({ id: 'link', invitee_email: null, max_uses: 50 }),
    ] });
    const list = await listCircleInvites('c1', { userId: 'owner', isAdmin: false });
    expect(list.map((r) => [r.id, r.state, r.invitee, r.sentByMe, r.isLink])).toEqual([
      ['mine', 'pending', 'new@person.test', true, false],
      ['theirs', 'pending', 'n•••@person.test', false, false],
      ['member', 'accepted', 'Ana', true, false],
      ['declined', 'declined', 'n•••@person.test', false, false],
      ['link', 'pending', null, true, true],
    ]);
    const asAdmin = await listCircleInvites('c1', { userId: 'admin', isAdmin: true });
    expect(asAdmin[1].invitee).toBe('new@person.test');
  });
});
