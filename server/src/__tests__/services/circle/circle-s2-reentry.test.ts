// ─── Removed from a circle: no way back by themselves (Shirley pilot S2 fix round 1, controller ruling) ────────────
// Someone the circle's owner or a moderator REMOVED (a circle_removals row) cannot rejoin an open circle by themselves;
// a closed circle tells them to ask, and their ask waits for an organiser. Only an organiser letting them in (approving
// the ask, or a personal invite made after the removal by someone who runs the circle now) brings them back, and that
// clears the row. A shared link or a plain member's invite does not. Someone who LEFT, or whose ask was DECLINED, is
// not "removed". Read against a stand-in for the circle's rows that answers the services' own statements.

let members: Array<{ user_id: string; role: string }>;
let removals: Array<{ user_id: string; created_at: Date }>;
let asks: Array<{ user_id: string; status: string }>;
let policy: 'open' | 'closed';
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

function answer(sql: string, params: unknown[] = []) {
  const s = flat(sql);
  const member = (u: unknown) => members.find((m) => m.user_id === u);
  if (/^SELECT id, join_policy FROM circles WHERE id = \$1 AND archived_at IS NULL$/.test(s)) return { rows: [{ id: 'c1', join_policy: policy }] };
  if (/^SELECT id, name, join_policy FROM circles WHERE id = \$1 AND archived_at IS NULL$/.test(s)) return { rows: [{ id: 'c1', name: 'Curious Humans', join_policy: policy }] };
  if (s === 'SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2') return { rows: member(params[1]) ? [{}] : [] };
  if (s === "SELECT 1 FROM circle_members m WHERE m.circle_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'moderator')") {
    return { rows: ['owner', 'moderator'].includes(member(params[1])?.role ?? '') ? [{}] : [] };
  }
  if (s === 'SELECT created_at FROM circle_removals WHERE circle_id = $1 AND user_id = $2') {
    const r = removals.find((x) => x.user_id === params[1]);
    return { rows: r ? [{ created_at: r.created_at }] : [] };
  }
  if (/^SELECT u\.role FROM users u WHERE u\.id = \$1 AND u\.status = 'active'$/.test(s)) {
    return { rows: [{ role: params[0] === 'stefan' ? 'super_admin' : 'member' }] };
  }
  if (s.startsWith('INSERT INTO circle_members (circle_id, user_id) SELECT $1, u.id FROM users u')) {
    if (member(params[1])) return { rowCount: 0, rows: [] };
    members.push({ user_id: String(params[1]), role: 'member' });
    return { rowCount: 1, rows: [] };
  }
  if (s === 'DELETE FROM circle_removals WHERE circle_id = $1 AND user_id = $2') {
    removals = removals.filter((r) => r.user_id !== params[1]);
    return { rowCount: 1, rows: [] };
  }
  if (s.startsWith('INSERT INTO circle_join_requests')) {
    if (asks.some((a) => a.user_id === params[1] && a.status === 'pending')) return { rows: [] };
    asks.push({ user_id: String(params[1]), status: 'pending' });
    return { rows: [{ id: 'ask' }] };
  }
  if (s === 'SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL FOR UPDATE' || s === 'SELECT id FROM circles WHERE id = $1 FOR UPDATE') return { rows: [{ id: 'c1' }] };
  if (s === 'SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE') return { rows: member(params[1]) ? [{ role: member(params[1])!.role }] : [] };
  if (s === 'SELECT user_id, role FROM circle_members WHERE circle_id = $1 AND user_id = ANY($2::uuid[]) FOR UPDATE') {
    return { rows: members.filter((m) => (params[1] as string[]).includes(m.user_id)) };
  }
  if (s === 'DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2') {
    members = members.filter((m) => m.user_id !== params[1]);
    return { rowCount: 1, rows: [] };
  }
  if (s.startsWith('INSERT INTO circle_removals (circle_id, user_id, removed_by)')) {
    removals = removals.filter((r) => r.user_id !== params[1]);
    removals.push({ user_id: String(params[1]), created_at: new Date() });
    return { rowCount: 1, rows: [] };
  }
  if (s.startsWith('UPDATE circles SET member_count') || s.startsWith('UPDATE circle_join_requests') || s.startsWith('SELECT display_name')
      || s.startsWith('SELECT u.id FROM users u') || s.startsWith('INSERT INTO notifications')) {
    return { rowCount: 1, rows: [] };
  }
  throw new Error(`unmodelled: ${s.slice(0, 120)}`);
}

jest.mock('../../../db', () => ({
  query: (sql: string, params: unknown[]) => Promise.resolve(answer(sql, params)),
  transaction: (cb: (c: { query: (s: string, p: unknown[]) => unknown }) => unknown) =>
    cb({ query: (sql: string, params: unknown[]) => Promise.resolve(answer(sql, params)) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../realtime/emit', () => ({ emitEntities: jest.fn(), getRealtimeIo: () => null, __esModule: true }));

import { CIRCLE_CLOSED_JOIN, REMOVED_FROM_CIRCLE, joinCircle, leaveCircle } from '../../../services/circle/circle.service';
import { removeCircleMember, requestToJoinCircle } from '../../../services/circle/circle-join.service';

const inviteFrom = (inviterId: string, over: Record<string, unknown> = {}) => ({
  invitedBy: inviterId,
  invite: { inviterId, inviteeEmail: 'ana@rsn-e2e.invalid', maxUses: 1, createdAt: new Date(Date.now() + 1000), ...over },
});
const isIn = (u: string) => members.some((m) => m.user_id === u);

beforeEach(async () => {
  members = [{ user_id: 'owner', role: 'owner' }, { user_id: 'mod', role: 'moderator' }, { user_id: 'mem', role: 'member' }, { user_id: 'ana', role: 'member' }];
  removals = [];
  asks = [];
  policy = 'open';
  await removeCircleMember('c1', 'ana', { userId: 'mod', role: 'member' });
});

describe('a removal is recorded and holds', () => {
  it('removing writes the circle_removals row in the same transaction', () => {
    expect(isIn('ana')).toBe(false);
    expect(removals.map((r) => r.user_id)).toEqual(['ana']);
  });

  it('an open circle: their own join, and their own ask (which would join), are refused in words', async () => {
    await expect(joinCircle('c1', 'ana', { role: 'member' })).rejects.toMatchObject({ statusCode: 403, message: REMOVED_FROM_CIRCLE });
    await expect(requestToJoinCircle('c1', 'ana', 'member')).rejects.toMatchObject({ statusCode: 403, message: REMOVED_FROM_CIRCLE });
    expect(isIn('ana')).toBe(false);
  });

  it('a closed circle: told to ask, and their ask is recorded for an organiser to answer', async () => {
    policy = 'closed';
    await expect(joinCircle('c1', 'ana', { role: 'member' })).rejects.toMatchObject({ statusCode: 403, message: CIRCLE_CLOSED_JOIN });
    await expect(requestToJoinCircle('c1', 'ana', 'member')).resolves.toMatchObject({ status: 'requested', created: true });
    expect(asks).toEqual([{ user_id: 'ana', status: 'pending' }]);
  });

  it('a shared link, or a link with several uses, does not bring them back', async () => {
    await expect(joinCircle('c1', 'ana', inviteFrom('owner', { inviteeEmail: null, maxUses: 50 }))).rejects.toMatchObject({ message: REMOVED_FROM_CIRCLE });
    await expect(joinCircle('c1', 'ana', inviteFrom('owner', { maxUses: 3 }))).rejects.toMatchObject({ message: REMOVED_FROM_CIRCLE });
  });

  it('a plain member\'s personal invite does not', async () => {
    await expect(joinCircle('c1', 'ana', inviteFrom('mem'))).rejects.toMatchObject({ message: REMOVED_FROM_CIRCLE });
  });

  it('an organiser\'s personal invite made before the removal does not (the removal is the newer decision)', async () => {
    await expect(joinCircle('c1', 'ana', inviteFrom('owner', { createdAt: new Date(Date.now() - 3600_000) }))).rejects.toMatchObject({ message: REMOVED_FROM_CIRCLE });
  });

  it('an organiser\'s (owner\'s or moderator\'s) personal invite made after the removal readmits them and clears the record', async () => {
    await joinCircle('c1', 'ana', inviteFrom('mod'));
    expect(isIn('ana')).toBe(true);
    expect(removals).toEqual([]);
    // Back in, leaving and rejoining is their own business again.
    await leaveCircle('c1', 'ana');
    await joinCircle('c1', 'ana', { role: 'member' });
    expect(isIn('ana')).toBe(true);
  });

  it('a platform admin joins whatever the record says', async () => {
    await removeCircleMember('c1', 'mem', { userId: 'owner', role: 'member' });
    await joinCircle('c1', 'mem', { role: 'admin' });
    expect(isIn('mem')).toBe(true);
  });
});

describe('leaving is not a removal', () => {
  it('someone who left an open circle joins again by themselves', async () => {
    await leaveCircle('c1', 'mem');
    expect(removals.some((r) => r.user_id === 'mem')).toBe(false);
    await joinCircle('c1', 'mem', { role: 'member' });
    expect(isIn('mem')).toBe(true);
  });
});
