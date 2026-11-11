// ─── A circle's roles and its handover (Shirley pilot S2, 11 Nov 2026; plan D3, brief RSN 02) ─────────────────────
// Read against a stand-in database that holds the circle's member rows and answers the service's own statements (the
// statements run on Postgres in the task's PGlite harness, s2-pglite.ts). Only the owner or a platform admin changes
// a role or hands the circle over; the circle row is locked first and the actor's role read again under the lock, so
// two people acting at once are taken in turn; every change writes an audit row in the same transaction.

const mockQuery = jest.fn();
const mockClientSql: string[] = [];
// Every write of the service locks the circle row first (SELECT … FOR UPDATE), so its transactions run one at a time;
// the stand-in takes them in turn the same way. A rolled-back transaction leaves the rows as they were.
let mockLockQueue: Promise<unknown> = Promise.resolve();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => {
    const run = mockLockQueue.then(async () => {
      const snapshot = JSON.stringify(rows);
      try {
        return await cb({ query: (...a: unknown[]) => { mockClientSql.push(String(a[0]).replace(/\s+/g, ' ').trim()); return mockQuery(...a); } });
      } catch (err) {
        rows = JSON.parse(snapshot);
        throw err;
      }
    });
    mockLockQueue = run.catch(() => undefined);
    return run;
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import {
  ALREADY_OWNER, NOT_ACTIVE_MEMBER, NOT_IN_CIRCLE, OWNER_ROLE_FIXED, TRANSFER_NOT_MEMBER,
  setCircleMemberRole, transferCircleOwnership,
} from '../../../services/circle/circle-roles.service';
import { OWNER_ONLY } from '../../../services/circle/circle-managers';

const C = 'circle-1';
interface Row { user_id: string; role: string; active_member: boolean }
let rows: Row[];
let circleLive: boolean;
const audits: Array<{ actor: string; action: string; details: Record<string, unknown> }> = [];
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

function world(members: Array<[string, string, boolean?]>, live = true) {
  rows = members.map(([user_id, role, active = true]) => ({ user_id, role, active_member: active }));
  circleLive = live;
  audits.length = 0;
  mockClientSql.length = 0;
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = flat(sql);
    if (text === 'SELECT id, name FROM circles WHERE id = $1 AND archived_at IS NULL FOR UPDATE') {
      return { rows: circleLive && params[0] === C ? [{ id: C, name: 'Curious Humans' }] : [] };
    }
    if (text === "SELECT user_id FROM circle_members WHERE circle_id = $1 AND role = 'owner' FOR UPDATE") {
      return { rows: rows.filter((r) => r.role === 'owner').map((r) => ({ user_id: r.user_id })) };
    }
    if (/^SELECT m\.user_id, m\.role, \(u\.status = 'active' AND u\.account_kind = 'member'\) AS active_member FROM circle_members m JOIN users u ON u\.id = m\.user_id WHERE m\.circle_id = \$1 AND m\.user_id = ANY\(\$2::uuid\[\]\) FOR UPDATE OF m$/.test(text)) {
      const ids = params[1] as string[];
      return { rows: rows.filter((r) => ids.includes(r.user_id)).map((r) => ({ ...r })) };
    }
    if (text === 'UPDATE circle_members SET role = $3 WHERE circle_id = $1 AND user_id = $2') {
      rows.filter((r) => r.user_id === params[1]).forEach((r) => { r.role = String(params[2]); });
      return { rowCount: 1, rows: [] };
    }
    if (text === "UPDATE circle_members SET role = 'moderator' WHERE circle_id = $1 AND user_id = $2 AND role = 'owner'") {
      rows.filter((r) => r.user_id === params[1] && r.role === 'owner').forEach((r) => { r.role = 'moderator'; });
      return { rowCount: 1, rows: [] };
    }
    if (text === "UPDATE circle_members SET role = 'owner' WHERE circle_id = $1 AND user_id = $2") {
      // The one-owner index: a second owner row is refused, as Postgres would.
      if (rows.some((r) => r.role === 'owner' && r.user_id !== params[1])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      rows.filter((r) => r.user_id === params[1]).forEach((r) => { r.role = 'owner'; });
      return { rowCount: 1, rows: [] };
    }
    if (/^INSERT INTO audit_log \(actor_id, action, entity_type, entity_id, details\) VALUES \(\$1, \$2, 'circle', \$3, \$4\)$/.test(text)) {
      audits.push({ actor: String(params[0]), action: String(params[1]), details: JSON.parse(String(params[3])) });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unmodelled statement: ${text}`);
  });
}

const roleOf = (id: string) => rows.find((r) => r.user_id === id)?.role ?? null;
const updates = () => mockClientSql.filter((s) => /^UPDATE circle_members/.test(s));
const actor = (userId: string, role = 'member') => ({ userId, role });

describe('setCircleMemberRole: who may make and unmake moderators', () => {
  beforeEach(() => world([['owner', 'owner'], ['mod', 'moderator'], ['mem', 'member'], ['mem2', 'member']]));

  it('the owner makes a member a moderator: the circle is locked first, the rows next, then one update and one audit row', async () => {
    await expect(setCircleMemberRole(C, 'mem', 'moderator', actor('owner')))
      .resolves.toEqual({ changed: true, circleName: 'Curious Humans', from: 'member', to: 'moderator' });
    expect(roleOf('mem')).toBe('moderator');
    expect(mockClientSql[0]).toMatch(/^SELECT id, name FROM circles .* FOR UPDATE$/);
    expect(mockClientSql[1]).toMatch(/^SELECT m\.user_id, m\.role/);
    expect(audits).toEqual([{ actor: 'owner', action: 'circle_role_change', details: { userId: 'mem', from: 'member', to: 'moderator' } }]);
  });

  it('the owner makes a moderator a member again', async () => {
    await setCircleMemberRole(C, 'mod', 'member', actor('owner'));
    expect(roleOf('mod')).toBe('member');
    expect(audits[0].details).toEqual({ userId: 'mod', from: 'moderator', to: 'member' });
  });

  it.each([
    ['a moderator', 'mod'],
    ['a member', 'mem'],
    ['someone not in the circle (a non-member, removed, left, invited or waiting on a request)', 'stranger'],
  ])('%s cannot change a role: 403 in words, nothing written', async (_who, id) => {
    await expect(setCircleMemberRole(C, 'mem2', 'moderator', actor(id))).rejects.toMatchObject({ statusCode: 403, message: OWNER_ONLY });
    expect(updates()).toEqual([]);
    expect(audits).toEqual([]);
    expect(roleOf('mem2')).toBe('member');
  });

  it('a platform admin (super admin) who is not in the circle may, and is the audit row\'s actor', async () => {
    await setCircleMemberRole(C, 'mem', 'moderator', actor('stefan', 'super_admin'));
    expect(roleOf('mem')).toBe('moderator');
    expect(audits[0].actor).toBe('stefan');
  });

  it('the owner\'s own role never moves this way (409), whoever asks', async () => {
    await expect(setCircleMemberRole(C, 'owner', 'member', actor('owner'))).rejects.toMatchObject({ statusCode: 409, message: OWNER_ROLE_FIXED });
    await expect(setCircleMemberRole(C, 'owner', 'moderator', actor('stefan', 'admin'))).rejects.toMatchObject({ statusCode: 409 });
    expect(roleOf('owner')).toBe('owner');
  });

  it('someone not in the circle cannot be given a role: 404 in words', async () => {
    await expect(setCircleMemberRole(C, 'stranger', 'moderator', actor('owner'))).rejects.toMatchObject({ statusCode: 404, message: NOT_IN_CIRCLE });
  });

  it('a new moderator must hold an active member account; stepping a closed account down is allowed', async () => {
    world([['owner', 'owner'], ['gone', 'member', false], ['gonemod', 'moderator', false]]);
    await expect(setCircleMemberRole(C, 'gone', 'moderator', actor('owner'))).rejects.toMatchObject({ statusCode: 400, message: NOT_ACTIVE_MEMBER });
    await setCircleMemberRole(C, 'gonemod', 'member', actor('owner'));
    expect(roleOf('gonemod')).toBe('member');
  });

  it('asking for the role they already hold changes nothing and writes no audit row', async () => {
    await expect(setCircleMemberRole(C, 'mod', 'moderator', actor('owner'))).resolves.toMatchObject({ changed: false });
    expect(updates()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('a missing or archived circle is a 404 before any row is read', async () => {
    world([['owner', 'owner'], ['mem', 'member']], false);
    await expect(setCircleMemberRole(C, 'mem', 'moderator', actor('owner'))).rejects.toMatchObject({ statusCode: 404 });
    expect(mockClientSql).toHaveLength(1);
  });

  it('two moderators being made at once by the owner: each is its own locked transaction; both end as moderators', async () => {
    await Promise.all([
      setCircleMemberRole(C, 'mem', 'moderator', actor('owner')),
      setCircleMemberRole(C, 'mem2', 'moderator', actor('owner')),
    ]);
    expect([roleOf('mem'), roleOf('mem2')]).toEqual(['moderator', 'moderator']);
    expect(mockClientSql.filter((s) => /FOR UPDATE$/.test(s) && /FROM circles/.test(s))).toHaveLength(2);
  });
});

describe('transferCircleOwnership: handing the circle to someone in it', () => {
  beforeEach(() => world([['shirley', 'member'], ['stefan', 'owner'], ['mod', 'moderator'], ['guest', 'member', false]]));

  it('the owner hands it to a member: the old owner becomes a moderator FIRST, then the new owner, then one audit row', async () => {
    await expect(transferCircleOwnership(C, 'shirley', actor('stefan'))).resolves.toEqual({ circleName: 'Curious Humans', previousOwnerId: 'stefan' });
    expect(roleOf('shirley')).toBe('owner');
    expect(roleOf('stefan')).toBe('moderator');
    const demote = mockClientSql.findIndex((s) => /SET role = 'moderator'/.test(s));
    const promote = mockClientSql.findIndex((s) => /SET role = 'owner'/.test(s));
    expect(demote).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(demote);
    expect(audits).toEqual([{
      actor: 'stefan', action: 'circle_ownership_transfer',
      details: { from: 'stefan', to: 'shirley', previousOwnerBecomes: 'moderator' },
    }]);
  });

  it('after the handover the old owner has a moderator\'s rights only: they can no longer change roles or hand it on', async () => {
    await transferCircleOwnership(C, 'shirley', actor('stefan'));
    await expect(setCircleMemberRole(C, 'mod', 'member', actor('stefan'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(transferCircleOwnership(C, 'mod', actor('stefan'))).rejects.toMatchObject({ statusCode: 403 });
    expect(roleOf('shirley')).toBe('owner');
    // ...and the new owner can.
    await setCircleMemberRole(C, 'stefan', 'member', actor('shirley'));
    expect(roleOf('stefan')).toBe('member');
  });

  it('to someone not in the circle: refused in words (invite them first), nothing written', async () => {
    await expect(transferCircleOwnership(C, 'outsider', actor('stefan'))).rejects.toMatchObject({ statusCode: 400, message: TRANSFER_NOT_MEMBER });
    expect(updates()).toEqual([]);
    expect(roleOf('stefan')).toBe('owner');
  });

  it('to an account that is not an active member account (closed, suspended or an event guest): refused', async () => {
    await expect(transferCircleOwnership(C, 'guest', actor('stefan'))).rejects.toMatchObject({ statusCode: 400, message: NOT_ACTIVE_MEMBER });
    expect(updates()).toEqual([]);
  });

  it('to the owner themselves: 409, nothing written', async () => {
    await expect(transferCircleOwnership(C, 'stefan', actor('stefan'))).rejects.toMatchObject({ statusCode: 409, message: ALREADY_OWNER });
  });

  it.each([['a moderator', 'mod'], ['a member', 'shirley'], ['a non-member', 'outsider']])('%s cannot hand it over (403)', async (_w, id) => {
    await expect(transferCircleOwnership(C, 'mod', actor(id))).rejects.toMatchObject({ statusCode: 403, message: OWNER_ONLY });
    expect(roleOf('stefan')).toBe('owner');
  });

  it('a platform admin may hand it over (the owner stays a moderator), and may give an ownerless circle an owner', async () => {
    await transferCircleOwnership(C, 'shirley', actor('admin-1', 'admin'));
    expect([roleOf('shirley'), roleOf('stefan')]).toEqual(['owner', 'moderator']);
    world([['a', 'member'], ['b', 'moderator']]);
    await expect(transferCircleOwnership(C, 'a', actor('admin-1', 'super_admin'))).resolves.toEqual({ circleName: 'Curious Humans', previousOwnerId: null });
    expect(roleOf('a')).toBe('owner');
    expect(audits[0].details).toEqual({ from: null, to: 'a', previousOwnerBecomes: null });
  });

  it('two handovers at once: the second, taken after the first under the lock, finds a new owner and is refused', async () => {
    const results = await Promise.allSettled([
      transferCircleOwnership(C, 'shirley', actor('stefan')),
      transferCircleOwnership(C, 'mod', actor('stefan')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rows.filter((r) => r.role === 'owner')).toHaveLength(1);
    expect(roleOf('shirley')).toBe('owner');
  });

  it('never leaves two owners: a promotion that would is undone with its transaction', async () => {
    // A stand-in for a stale read: the demotion matched no owner row, so the index refuses the promotion.
    world([['x', 'owner'], ['y', 'member']]);
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ id: C, name: 'Curious Humans' }] }));
    mockQuery.mockImplementationOnce(async () => ({ rows: [] })); // "no owner" read
    await expect(transferCircleOwnership(C, 'y', actor('admin', 'admin'))).rejects.toMatchObject({ code: '23505' });
    expect(rows.filter((r) => r.role === 'owner').map((r) => r.user_id)).toEqual(['x']);
  });
});
