// ─── Circles (REASON v1 Phase 3a, 19 Jul 2026) ───────────────────────────────
//
// Pins the architecture rules: nesting cycle/depth rejection, transactional
// counters that can't double-count, idempotent join/leave, archived circles
// invisible, and the route-level authz (admin gates pinned via source).

const mockQuery = jest.fn();
// The statements run on a transaction's client, apart from those run on the pool (1 Nov 2026).
const mockClientSql: string[] = [];

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({
    query: (...a: unknown[]) => { mockClientSql.push(String(a[0])); return mockQuery(...a); },
  }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import {
  createCircle, joinCircle, leaveCircle, archiveCircle, getCircleDetail,
  MAX_NESTING_DEPTH,
} from '../../../services/circle/circle.service';

beforeEach(() => { mockQuery.mockReset(); mockClientSql.length = 0; });

describe('nesting integrity', () => {
  it('rejects a circle that would contain itself (cycle)', async () => {
    // c1's ancestor chain leads back to c1.
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/SELECT parent_circle_id/.test(sql)) {
        const id = (params as string[])[0];
        // c2's parent is c1 — so making c1's parent c2 is a cycle.
        return Promise.resolve({ rows: [{ parent_circle_id: id === 'c2' ? 'c1' : null }] });
      }
      if (/SELECT id FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1' }] });
      return Promise.resolve({ rows: [] });
    });
    const { updateCircle } = await import('../../../services/circle/circle.service');
    await expect(updateCircle('c1', { parentCircleId: 'c2' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it(`rejects nesting deeper than ${MAX_NESTING_DEPTH} levels`, async () => {
    // Chain c1 <- c2 <- c3 <- c4: making something a child of c4 exceeds depth.
    const parents: Record<string, string | null> = { c4: 'c3', c3: 'c2', c2: 'c1', c1: null };
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/SELECT parent_circle_id/.test(sql)) {
        const id = (params as string[])[0];
        return Promise.resolve({ rows: [{ parent_circle_id: parents[id] ?? null }] });
      }
      return Promise.resolve({ rows: [{ id: 'x' }] });
    });
    await expect(createCircle('admin', { name: 'Too Deep', parentCircleId: 'c4' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('membership counters (transactional, never double-counted)', () => {
  function armJoin(insertedRows: number) {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, join_policy FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1', join_policy: 'open' }] });
      if (/INSERT INTO circle_members/.test(sql)) return Promise.resolve({ rowCount: insertedRows, rows: [] });
      if (/DELETE FROM circle_members/.test(sql)) return Promise.resolve({ rowCount: insertedRows, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
  }

  it('first join inserts AND increments member_count', async () => {
    armJoin(1);
    await joinCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /member_count = member_count \+ 1/.test(c[0] as string))).toBe(true);
  });

  it('a double-join is a no-op: ON CONFLICT insert misses → counter untouched', async () => {
    armJoin(0);
    await joinCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /member_count = member_count \+ 1/.test(c[0] as string))).toBe(false);
  });

  it('leaving without being a member never decrements', async () => {
    armJoin(0);
    await leaveCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /member_count = GREATEST/.test(c[0] as string))).toBe(false);
  });

  it('the decrement clamps at zero (GREATEST guard in SQL)', async () => {
    armJoin(1);
    await leaveCircle('c1', 'u1');
    const dec = mockQuery.mock.calls.find(c => /member_count = GREATEST/.test(c[0] as string));
    expect(dec).toBeTruthy();
    expect(dec![0]).toMatch(/GREATEST\(member_count - 1, 0\)/);
  });
});

describe('archive semantics', () => {
  it('archive sets archived_at, never DELETEs', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    await archiveCircle('c1');
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /SET archived_at = NOW\(\)/.test(s))).toBe(true);
    expect(sqls.some(s => /DELETE FROM circles/.test(s))).toBe(false);
  });

  it('detail of an archived circle is a 404 (reads filter archived_at)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(getCircleDetail('c-archived', 'u1')).rejects.toMatchObject({ statusCode: 404 });
    const detailSql = mockQuery.mock.calls[0][0] as string;
    expect(detailSql).toMatch(/archived_at IS NULL/);
  });
});

describe('the circle page (T13, 1 Nov 2026)', () => {
  // Production's client (origin/main CircleDetailPage.tsx) reads id, name, description, memberCount, isMember,
  // members, pods, upcomingEvents { id, title, scheduledAt, podId } and children. Those stay; forCircle and
  // canManage are additive.
  function arm(manager: boolean) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM circles c WHERE c\.id = \$1 AND c\.archived_at IS NULL/.test(sql)) {
        return { rows: [{ id: 'c1', name: 'Founders', description: null, parent_circle_id: null, member_count: 2, created_at: new Date(), is_member: true }] };
      }
      if (/FROM sessions s/.test(sql)) {
        return { rows: [
          { id: 'e1', title: 'For the circle', scheduled_at: new Date(), pod_id: 'p9', for_circle: true },
          { id: 'e2', title: 'Pod event', scheduled_at: new Date(), pod_id: 'p1', for_circle: false },
        ] };
      }
      if (/c\.created_by = \$2/.test(sql)) return { rows: manager ? [{ x: 1 }] : [] };
      return { rows: [] };
    });
  }

  it('lists the circle\'s own events and its pods\' events, each under the viewer rule, with production\'s fields', async () => {
    arm(false);
    const detail = await getCircleDetail('c1', 'u1', 'member');
    const events = mockQuery.mock.calls.find(([sql]) => /FROM sessions s/.test(String(sql)))!;
    expect(String(events[0])).toMatch(/WHERE \(s\.circle_id = \$1 OR s\.pod_id IN \(SELECT pod_id FROM circle_pods WHERE circle_id = \$1\)\)/);
    expect(events[1]).toEqual(['c1', 'u1', false]);
    for (const key of ['id', 'name', 'description', 'memberCount', 'isMember', 'members', 'pods', 'upcomingEvents', 'children']) {
      expect(detail).toHaveProperty(key);
    }
    expect(detail.upcomingEvents[0]).toEqual({ id: 'e1', title: 'For the circle', scheduledAt: expect.any(Date), podId: 'p9', forCircle: true });
    expect(detail.upcomingEvents[1]).toMatchObject({ id: 'e2', podId: 'p1', forCircle: false });
    expect(detail.canManage).toBe(false);
  });

  it('says canManage for someone who runs the circle, and for an admin without asking the database', async () => {
    arm(true);
    expect((await getCircleDetail('c1', 'u1', 'member')).canManage).toBe(true);
    mockQuery.mockClear();
    arm(false);
    expect((await getCircleDetail('c1', 'u1', 'admin')).canManage).toBe(true);
    expect(mockQuery.mock.calls.some(([sql]) => /c\.created_by = \$2/.test(String(sql)))).toBe(false);
  });
});

describe('route authz matrix (source pins)', () => {
  const fs = jest.requireActual('fs') as typeof import('fs');
  const path = jest.requireActual('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../../routes/circles.ts'), 'utf8',
  ).replace(/\r\n/g, '\n'); // CRLF-agnostic (the 15 Jul lesson)

  it('create and archive stay admin-gated', () => {
    for (const route of ["router.post('/',", "'/:id/archive'"]) {
      const i = src.indexOf(route);
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 200);
      expect(block).toMatch(/requireRole\(UserRole\.ADMIN\)/);
    }
  });

  // T14 (1 Nov 2026, L22): the people who run a circle edit it, attach and detach pods and remove members; the
  // asks are answered by them too (circle-join.service.ts asks assertCircleManager itself).
  it('update, attach and detach ask the manager gate before anything else, and no longer requireRole', () => {
    for (const route of ["router.patch('/:id',", "router.post('/:id/pods',", "router.delete('/:id/pods/:podId',"]) {
      const i = src.indexOf(route);
      expect(i).toBeGreaterThan(-1);
      const head = src.slice(i, src.indexOf('async (req', i));
      expect(head).not.toMatch(/requireRole/);
      const body = src.slice(i, i + 900);
      expect(body).toMatch(/await assertCircleManager\(req\.params\.id, req\.user!\.userId, req\.user!\.role/);
      expect(body.indexOf('assertCircleManager')).toBeLessThan(body.indexOf('circleService.'));
    }
  });

  it('join, leave, the asks and reads are authenticated but NOT role-gated (the service applies the circle\'s policy)', () => {
    for (const route of ["'/:id/join'", "'/:id/leave'", "router.get('/',", "router.get('/:id',", "router.post('/:id/request',", "router.delete('/:id/request',"]) {
      const i = src.indexOf(route);
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 200);
      expect(block).toMatch(/authenticate/);
      expect(block).not.toMatch(/requireRole/);
    }
  });
});

describe('creating a circle (1 Nov 2026, L21)', () => {
  function armCreate() {
    mockQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO circles/.test(sql)) return Promise.resolve({ rowCount: 1, rows: [{ id: 'new-circle' }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
  }

  it('the creator becomes its owner, in the same transaction as the circle, with member_count 1', async () => {
    armCreate();
    const created = await createCircle('admin-1', { name: 'Doctors' });
    expect(created).toEqual({ id: 'new-circle' });

    const insertCircle = mockQuery.mock.calls.find(c => /INSERT INTO circles/.test(c[0] as string));
    expect(insertCircle![0]).toMatch(/member_count/);
    expect(insertCircle![0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4, 1\)/);
    const insertOwner = mockQuery.mock.calls.find(c => /INSERT INTO circle_members/.test(c[0] as string));
    expect(insertOwner![0]).toMatch(/'owner'/);
    expect(insertOwner![1]).toEqual(['new-circle', 'admin-1']);
    expect(mockClientSql.some(s => /INSERT INTO circles/.test(s))).toBe(true);
    expect(mockClientSql.some(s => /INSERT INTO circle_members/.test(s))).toBe(true);
  });

  it('a name already taken adds no owner row', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO circles/.test(sql)) return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    await expect(createCircle('admin-1', { name: 'Doctors' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO circle_members/.test(c[0] as string))).toBe(false);
  });
});

describe('joining a closed circle (T14, 1 Nov 2026)', () => {
  function armClosed(opts: { member?: boolean; manager?: boolean } = {}) {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, join_policy FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1', join_policy: 'closed' }] });
      if (/SELECT 1 FROM circle_members WHERE circle_id = \$1 AND user_id = \$2/.test(sql)) return Promise.resolve({ rows: opts.member ? [{}] : [] });
      if (/c.created_by = \$2/.test(sql)) return Promise.resolve({ rows: opts.manager ? [{}] : [] });
      if (/INSERT INTO circle_members/.test(sql)) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
  }

  it('someone outside it is told to ask, 403 CIRCLE_CLOSED in words, and nothing is written', async () => {
    armClosed();
    await expect(joinCircle('c1', 'u1', { role: 'member' })).rejects.toMatchObject({
      statusCode: 403, code: 'CIRCLE_CLOSED', message: 'This circle is closed. Ask to join and its owner will let you in.',
    });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO circle_members/.test(c[0] as string))).toBe(false);
  });

  it('someone who runs it joins without asking, and the count moves', async () => {
    armClosed({ manager: true });
    await joinCircle('c1', 'u1', { role: 'member' });
    expect(mockQuery.mock.calls.some(c => /member_count = member_count \+ 1/.test(c[0] as string))).toBe(true);
  });

  it('an invite is the doorway: it joins without any check, and answers a pending ask as approved', async () => {
    armClosed();
    await joinCircle('c1', 'u1', { byInvite: true });
    expect(mockClientSql.some(s => /INSERT INTO circle_members/.test(s))).toBe(true);
    expect(mockClientSql.some(s => /UPDATE circle_join_requests SET status = 'approved'/.test(s) && /status = 'pending'/.test(s))).toBe(true);
  });

  it('an open circle still joins anyone, with no lookup of who runs it (production\'s Join circle)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, join_policy FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1', join_policy: 'open' }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    await joinCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /created_by = \$2/.test(c[0] as string))).toBe(false);
    expect(mockQuery.mock.calls.some(c => /member_count = member_count \+ 1/.test(c[0] as string))).toBe(true);
  });
});

describe('what a viewer may do with a circle (toCircleAccess)', () => {
  const { toCircleAccess } = jest.requireActual('../../../services/circle/circle-managers') as typeof import('../../../services/circle/circle-managers');
  const row = (over: Partial<Parameters<typeof toCircleAccess>[0]>) => ({
    join_policy: 'open' as const, is_member: false, can_manage: false, my_request: null, request_count: 3, ...over,
  });

  it('a legacy circle (no policy stored) reads as open', () => {
    expect(toCircleAccess(row({ join_policy: null }))).toEqual({ joinPolicy: 'open', myStatus: null, canManage: false, canInvite: false, locked: false });
  });

  it('open: a member may invite; a stranger may not; nothing is locked', () => {
    expect(toCircleAccess(row({ is_member: true }))).toMatchObject({ myStatus: 'member', canInvite: true, locked: false });
    expect(toCircleAccess(row({}))).toMatchObject({ canInvite: false, locked: false });
  });

  it('closed: a member may not invite, a stranger is locked, and their ask reads requested or declined', () => {
    expect(toCircleAccess(row({ join_policy: 'closed', is_member: true }))).toMatchObject({ canInvite: false, locked: false });
    expect(toCircleAccess(row({ join_policy: 'closed', my_request: 'pending' }))).toMatchObject({ myStatus: 'requested', locked: true });
    expect(toCircleAccess(row({ join_policy: 'closed', my_request: 'declined' }))).toMatchObject({ myStatus: 'declined', locked: true });
    expect(toCircleAccess(row({ join_policy: 'closed', my_request: 'cancelled' })).myStatus).toBeNull();
  });

  it('the people who run it may always invite, are never locked, and alone see the request count', () => {
    expect(toCircleAccess(row({ join_policy: 'closed', can_manage: true }))).toEqual({
      joinPolicy: 'closed', myStatus: null, canManage: true, canInvite: true, locked: false, requestCount: 3,
    });
    expect(toCircleAccess(row({ join_policy: 'closed', is_member: true }))).not.toHaveProperty('requestCount');
  });
});

describe("a closed circle's page, from outside it (T14)", () => {
  function armDetail(over: Record<string, unknown>) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM circles c WHERE c.id = \$1 AND c.archived_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 'c1', name: 'Doctors', description: null, parent_circle_id: null, member_count: 3, created_at: new Date(),
          public_pod_count: 2, join_policy: 'closed', is_member: false, can_manage: false, my_request: null, request_count: 1, ...over,
        }] });
      }
      return Promise.resolve({ rows: [{ user_id: 'u9', display_name: 'X', avatar_url: null, role: 'member', joined_at: new Date(), pod_id: 'p1', name: 'P', description: null, id: 's1', title: 'T', scheduled_at: new Date() }] });
    });
  }

  it('is locked: no member, pod or event is asked for, its counts still read', async () => {
    armDetail({});
    const d = await getCircleDetail('c1', 'stranger', 'member');
    expect(d).toMatchObject({ locked: true, members: [], pods: [], upcomingEvents: [], memberCount: 3, podCount: 2, joinPolicy: 'closed', canInvite: false });
    const asked = mockQuery.mock.calls.map(c => String(c[0]));
    expect(asked.some(s => /FROM circle_members m JOIN users u/.test(s))).toBe(false);
    expect(asked.some(s => /FROM circle_pods cp JOIN pods p ON p.id = cp.pod_id\s+WHERE cp.circle_id = \$1 AND/.test(s))).toBe(false);
    expect(asked.some(s => /FROM sessions s/.test(s))).toBe(false);
  });

  it("for someone in it the page reads in full, and the pods asked for leave out archived and others' private pods", async () => {
    armDetail({ is_member: true });
    const d = await getCircleDetail('c1', 'member', 'member');
    expect(d.locked).toBe(false);
    expect(d.members).toHaveLength(1);
    const pods = mockQuery.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' ')).find(s => /SELECT cp.pod_id, p.name, p.description/.test(s))!;
    expect(pods).toContain("p.status <> 'archived' AND ($3::boolean OR p.visibility <> 'private' OR EXISTS (SELECT 1 FROM pod_members vp_m WHERE vp_m.pod_id = p.id AND vp_m.user_id = $2 AND vp_m.status = 'active'))");
  });
});
