// ─── Asking to join a closed circle, and the answers (T14, 1 Nov 2026; audit 05 §7.5) ─────────────────────────
//
// The rules, read against a stand-in database that answers by what the SQL asks (they run on real Postgres in
// circle-join-policy.sql.test.ts, opt-in): an ask is one pending row (the partial unique index is the conflict
// target) and rings the people who run the circle with a join_request bell; an answer is taken under a row lock on the
// ask, from an active account only, by the people who run it; approval lets the person in with the count moved and
// rings an approval bell; the owner is never removed; the attach picker lists the pods a manager runs.

const mockQuery = jest.fn();
const mockClientSql: string[] = [];
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({
    query: (...a: unknown[]) => { mockClientSql.push(String(a[0]).replace(/\s+/g, ' ')); return mockQuery(...a); },
  }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockEmitEntities = jest.fn();
const mockSocketEmit = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => ({ to: (room: string) => ({ emit: (...a: unknown[]) => mockSocketEmit(room, ...a) }) }),
  __esModule: true,
}));

import {
  requestToJoinCircle, approveJoinRequest, declineJoinRequest, listJoinRequests, removeCircleMember,
  listAttachablePods, REQUEST_ALREADY_ANSWERED,
} from '../../../services/circle/circle-join.service';

const C = 'c1';
const OWNER = 'u-owner';
const ASKER = 'u-asker';
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const sqls = () => mockQuery.mock.calls.map((c) => flat(c[0]));
const callOf = (re: RegExp) => mockQuery.mock.calls.find((c) => re.test(flat(c[0])));

interface World { policy?: 'open' | 'closed'; manager?: boolean; member?: boolean; inserted?: boolean; pending?: boolean; role?: string }
function world(w: World = {}) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = flat(sql);
    if (/^SELECT id, name, join_policy, created_by FROM circles/.test(text)) {
      return { rows: [{ id: C, name: 'Founders', join_policy: w.policy ?? 'closed', created_by: OWNER }] };
    }
    if (/^SELECT 1 FROM circles c WHERE c.id = \$1 AND \(c.created_by = \$2/.test(text)) return { rows: (w.manager ?? params[1] === OWNER) ? [{}] : [] };
    if (/^SELECT 1 FROM circle_members WHERE circle_id = \$1 AND user_id = \$2$/.test(text)) return { rows: w.member ? [{}] : [] };
    if (/^SELECT id, join_policy FROM circles/.test(text)) return { rows: [{ id: C, join_policy: w.policy ?? 'closed' }] };
    if (/^INSERT INTO circle_join_requests/.test(text)) return { rows: w.inserted === false ? [] : [{ id: 'r1' }] };
    if (/^SELECT display_name FROM users/.test(text)) return { rows: [{ display_name: 'Asker Name' }] };
    if (/^SELECT u.id FROM users u WHERE u.status = 'active' AND u.id <> \$3/.test(text)) return { rows: [{ id: OWNER }] };
    if (/^INSERT INTO notifications/.test(text)) return { rows: [{ id: 'n1', user_id: (params[0] as string[])[0], created_at: new Date() }] };
    if (/^SELECT r.id FROM circle_join_requests r/.test(text)) return { rows: w.pending === false ? [] : [{ id: 'r1' }] };
    if (/^SELECT role FROM circle_members/.test(text)) return { rows: w.member === false ? [] : [{ role: w.role ?? 'member' }] };
    if (/^INSERT INTO circle_members/.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientSql.length = 0;
  mockEmitEntities.mockReset();
  mockSocketEmit.mockReset();
});

describe('asking', () => {
  it('a closed circle: one pending row, the partial unique index as the conflict target, and a join_request bell to the people who run it', async () => {
    world();
    expect(await requestToJoinCircle(C, ASKER, 'member')).toEqual({ status: 'requested', created: true });
    expect(flat(callOf(/^INSERT INTO circle_join_requests/)![0])).toContain("ON CONFLICT (circle_id, user_id) WHERE status = 'pending' DO NOTHING");
    const bell = callOf(/^INSERT INTO notifications/)!;
    expect(flat(bell[0])).toContain("SELECT r.id, 'join_request', $2, $3, $4");
    expect(bell[1]).toEqual([[OWNER], 'Asker Name wants to join Founders', 'Approve or decline their request on the circle page.', `/circles/${C}?requests=1`]);
    expect(mockSocketEmit).toHaveBeenCalledWith(`user:${OWNER}`, 'notification:new', expect.objectContaining({ type: 'join_request', title: 'Asker Name wants to join Founders' }));
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [OWNER], [`user:${OWNER}:notifications`]);
  });

  it('asking again while one waits adds nothing and rings nobody', async () => {
    world({ inserted: false });
    expect(await requestToJoinCircle(C, ASKER, 'member')).toEqual({ status: 'requested', created: false });
    expect(sqls().some((s) => /INSERT INTO notifications/.test(s))).toBe(false);
  });

  it('someone already in it is a member; nothing is asked', async () => {
    world({ member: true });
    expect(await requestToJoinCircle(C, ASKER, 'member')).toEqual({ status: 'member', created: false });
    expect(sqls().some((s) => /INSERT INTO circle_join_requests/.test(s))).toBe(false);
  });

  it('an open circle simply joins', async () => {
    world({ policy: 'open' });
    expect(await requestToJoinCircle(C, ASKER, 'member')).toEqual({ status: 'member', created: false });
    expect(mockClientSql.some((s) => /^INSERT INTO circle_members/.test(s))).toBe(true);
    expect(sqls().some((s) => /INSERT INTO circle_join_requests/.test(s))).toBe(false);
  });
});

describe('answering', () => {
  it('approve: the ask is locked (an active account only), the person let in with the count moved, and rung "You\'re in"', async () => {
    world();
    await approveJoinRequest(C, ASKER, { userId: OWNER, role: 'member' });
    const lock = mockClientSql.find((s) => /^SELECT r.id FROM circle_join_requests r/.test(s))!;
    expect(lock).toContain("r.status = 'pending' AND u.status = 'active' FOR UPDATE OF r");
    expect(mockClientSql.some((s) => /^INSERT INTO circle_members/.test(s))).toBe(true);
    expect(mockClientSql.some((s) => /member_count = member_count \+ 1/.test(s))).toBe(true);
    expect(mockClientSql.some((s) => /^UPDATE circle_join_requests SET status = 'approved'/.test(s))).toBe(true);
    const bell = callOf(/^INSERT INTO notifications/)!;
    expect(flat(bell[0])).toContain("SELECT r.id, 'approval', $2, $3, $4");
    expect(bell[1]).toEqual([[ASKER], "You're in Founders", 'Your request to join was approved.', `/circles/${C}`]);
  });

  it('decline: turned down under the same lock, no one let in, no bell', async () => {
    world();
    await declineJoinRequest(C, ASKER, { userId: OWNER, role: 'member' });
    expect(mockClientSql.some((s) => /^UPDATE circle_join_requests SET status = 'declined'/.test(s))).toBe(true);
    expect(mockClientSql.some((s) => /^INSERT INTO circle_members/.test(s))).toBe(false);
    expect(sqls().some((s) => /INSERT INTO notifications/.test(s))).toBe(false);
  });

  it('an ask already answered (or withdrawn) is a 404 in words, and nothing changes', async () => {
    world({ pending: false });
    await expect(approveJoinRequest(C, ASKER, { userId: OWNER, role: 'member' })).rejects.toMatchObject({ statusCode: 404, message: REQUEST_ALREADY_ANSWERED });
    expect(mockClientSql.some((s) => /^INSERT INTO circle_members/.test(s))).toBe(false);
  });

  it('only the people who run it answer, or see the asks (403)', async () => {
    world({ manager: false });
    await expect(approveJoinRequest(C, ASKER, { userId: 'u-member', role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(declineJoinRequest(C, ASKER, { userId: 'u-member', role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(listJoinRequests(C, { userId: 'u-member', role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockClientSql).toEqual([]);
  });

  it('the asks listed are pending ones from active accounts only, oldest first', async () => {
    world();
    await listJoinRequests(C, { userId: OWNER, role: 'member' });
    const list = flat(callOf(/FROM circle_join_requests r JOIN users u/)![0]);
    expect(list).toContain("WHERE r.circle_id = $1 AND r.status = 'pending' AND u.status = 'active'");
    expect(list).toContain('ORDER BY r.created_at ASC');
  });
});

describe('removing a member', () => {
  it('the owner is never removed (403); a member is, with the count moved in the same transaction', async () => {
    world({ role: 'owner' });
    await expect(removeCircleMember(C, 'u-other-owner', { userId: 'u-platform', role: 'admin' })).rejects.toMatchObject({ statusCode: 403 });
    mockClientSql.length = 0;
    world({ role: 'member' });
    await removeCircleMember(C, ASKER, { userId: OWNER, role: 'member' });
    expect(mockClientSql.some((s) => /^DELETE FROM circle_members WHERE circle_id = \$1 AND user_id = \$2$/.test(s))).toBe(true);
    expect(mockClientSql.some((s) => /GREATEST\(member_count - 1, 0\)/.test(s))).toBe(true);
  });

  it('the creator is never removed, whatever their row says', async () => {
    world({ role: 'member' });
    await expect(removeCircleMember(C, OWNER, { userId: 'u-platform', role: 'admin' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the attach picker', () => {
  it('a manager sees the active pods they direct or host, not attached yet, a page at a time; an admin sees every pod', async () => {
    world();
    await listAttachablePods(C, { userId: OWNER, role: 'member' }, { q: 'Fo%', page: 2, pageSize: 20 });
    const [sql, params] = callOf(/FROM pods p LEFT JOIN pod_members pm/)!;
    expect(flat(sql)).toContain("WHERE p.status <> 'archived' AND ($3::boolean OR pm.role IN ('director', 'host'))");
    expect(flat(sql)).toContain('AND NOT EXISTS (SELECT 1 FROM circle_pods cp WHERE cp.circle_id = $1 AND cp.pod_id = p.id)');
    expect(params).toEqual([C, OWNER, false, '%Fo\\%%', 21, 20]);
    mockQuery.mockClear();
    await listAttachablePods(C, { userId: 'u-platform', role: 'admin' }, { page: 1, pageSize: 500 });
    expect(callOf(/FROM pods p LEFT JOIN pod_members pm/)![1]).toEqual([C, 'u-platform', true, null, 101, 0]);
  });
});
