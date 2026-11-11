// ─── The invite sheet for a circle (T14, 1 Nov 2026; audit 05 §7.4 root cause B) ──────────────────────────────
//
// "Circle invites don't work": the circle page's Invite opened the old /invites form, whose search found only people
// met at an event. The sheet the pods and events use (the candidates list and the batch) now takes a circle. One rule
// decides who may invite to a circle for the single invite, the list and the batch (assertMayInviteToCircle): in an
// open circle anyone in it and the people who run it; in a closed circle only the people who run it. A person in the
// circle reads as a member; the invites the batch makes are circle invites that last a week.
//
// The database is a stand-in that answers by what the SQL asks; the SQL itself runs against real Postgres in
// services/circle/circle-join-policy.sql.test.ts.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendInviteEmail: jest.fn(),
  asBulkEmail: <T>(send: () => Promise<T>) => send(),
  __esModule: true,
}));
jest.mock('../../../services/pod/pod.service', () => ({ getPodById: jest.fn(), getMemberRole: jest.fn(), __esModule: true }));
jest.mock('../../../services/session/session.service', () => ({ getSessionById: jest.fn(), __esModule: true }));
jest.mock('../../../services/circle/circle.service', () => ({ joinCircle: jest.fn(), __esModule: true }));

// What the batch writes and rings is stood in; who may invite (assertMayInviteToCircle) is the real one.
const mockInsert = jest.fn();
const mockNotify = jest.fn();
const mockContext = jest.fn();
jest.mock('../../../services/invite/invite.service', () => {
  const actual = jest.requireActual('../../../services/invite/invite.service');
  return {
    ...actual,
    insertPendingInvite: (...args: unknown[]) => mockInsert(...args),
    notifyInvitee: (...args: unknown[]) => mockNotify(...args),
    buildInviteContext: (...args: unknown[]) => mockContext(...args),
    dailyInviteAllowance: async () => ({ maxPerDay: 100, sentToday: 0 }),
    isStillEmailable: async () => false,
  };
});

import { InviteType } from '@rsn/shared';
import { listInviteCandidates, createInvitesBatch } from '../../../services/invite/invite-candidates.service';
import { createInvite } from '../../../services/invite/invite.service';

const CIRCLE = 'c1000000-0000-4000-8000-000000000001';
const ASKER = 'a1000000-0000-4000-8000-000000000001';
const FRIEND = 'b1000000-0000-4000-8000-000000000001';
const flat = (text: unknown) => String(text).replace(/\s+/g, ' ').trim();

/** The circle and whether the asker passes its invite rule; then whatever the list or the batch asks. */
function world(opts: { policy?: 'open' | 'closed'; mayInvite?: boolean; archived?: boolean; recipient?: Record<string, unknown> } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    const text = flat(sql);
    if (/^SELECT id, name, join_policy FROM circles WHERE id = \$1 AND archived_at IS NULL$/.test(text)) {
      return { rows: opts.archived ? [] : [{ id: CIRCLE, name: 'Founders', join_policy: opts.policy ?? 'open' }] };
    }
    // Shirley pilot S2: the invite rule reads the asker's own row (an open circle: any role; closed: owner or moderator).
    if (/^SELECT 1 FROM circles c JOIN circle_members m ON m\.circle_id = c\.id AND m\.user_id = \$2 WHERE c\.id = \$1/.test(text)) {
      return { rows: opts.mayInvite === false ? [] : [{ '?column?': 1 }] };
    }
    // createInvite's own daily allowance: nothing sent today.
    if (/^SELECT COUNT\(\*\) as count FROM invites/.test(text)) return { rows: [{ count: '0' }] };
    if (/FROM wanted w/.test(text)) {
      return {
        rows: [{
          user_id: FRIEND, email: 'friend@example.com', active: true, blocked: false, connected: true, in_pod: false,
          state: 'available', latest_invite_id: null, ...opts.recipient,
        }],
      };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockInsert.mockReset();
  mockNotify.mockReset();
  mockContext.mockReset();
  mockContext.mockResolvedValue({ type: InviteType.CIRCLE, inviterName: 'Owner', targetName: 'Founders', circleId: CIRCLE });
  mockInsert.mockImplementation(async (row: { code: string }) => ({ duplicate: false, invite: { id: 'inv-1', code: row.code } }));
  mockNotify.mockResolvedValue(undefined);
});

describe('the candidates list for a circle', () => {
  it('reads the asker\'s active, unblocked connections and where each stands against the circle', async () => {
    world();
    await listInviteCandidates({ userId: ASKER, role: 'member' }, { circleId: CIRCLE, source: 'connections', before: null, limit: 30 });
    const list = mockQuery.mock.calls.map((c) => flat(c[0])).find((s) => /FROM people pe/.test(s))!;
    expect(list).toContain("u.status = 'active'");
    expect(list).toContain('NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))');
    expect(list).toContain("WHEN EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = $5 AND cm.user_id = p.user_id) THEN 'member'");
    expect(list).toContain("i.type = 'circle' AND i.circle_id = $5");
    const params = mockQuery.mock.calls.find((c) => /FROM people pe/.test(flat(c[0])))![1] as unknown[];
    expect(params[4]).toBe(CIRCLE);
  });

  it('a member of a closed circle may not list (403 in words); a missing or archived circle is a 404', async () => {
    world({ policy: 'closed', mayInvite: false });
    await expect(listInviteCandidates({ userId: ASKER, role: 'member' }, { circleId: CIRCLE, source: 'connections', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 403, message: 'Only the people who run this circle can invite to it.' });
    world({ archived: true });
    await expect(listInviteCandidates({ userId: ASKER, role: 'member' }, { circleId: CIRCLE, source: 'connections', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('a platform admin lists for any circle without the membership lookup', async () => {
    world({ policy: 'closed', mayInvite: false });
    await listInviteCandidates({ userId: ASKER, role: 'admin' }, { circleId: CIRCLE, source: 'connections', before: null, limit: 30 });
    expect(mockQuery.mock.calls.some((c) => /JOIN circle_members m ON m\.circle_id = c\.id/.test(flat(c[0])))).toBe(false);
  });

  it('naming two targets, or none, is refused', async () => {
    await expect(listInviteCandidates({ userId: ASKER }, { circleId: CIRCLE, podId: CIRCLE, source: 'connections', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(listInviteCandidates({ userId: ASKER }, { source: 'connections', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('the batch for a circle', () => {
  it('makes circle invites that last a week, rings each invitee, and names the circle it went to', async () => {
    world();
    const before = Date.now();
    const out = await createInvitesBatch({ userId: ASKER, role: 'member' }, { type: 'circle', circleId: CIRCLE, inviteeUserIds: [FRIEND] }, { emailGapMs: 0 });
    await out.delivery;
    expect(out.results).toEqual([{ userId: FRIEND, outcome: 'invited', inviteId: 'inv-1' }]);
    expect(out.target).toEqual({ podId: null, sessionId: null, circleId: CIRCLE });
    const row = mockInsert.mock.calls[0][0];
    expect(row).toMatchObject({ type: InviteType.CIRCLE, circleId: CIRCLE, podId: null, sessionId: null, maxUses: 1, inviteeEmail: 'friend@example.com' });
    const hours = (row.expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(168);
    expect(hours).toBeLessThan(168.1);
    expect(mockContext).toHaveBeenCalledWith(ASKER, InviteType.CIRCLE, { podId: null, sessionId: null, circleId: CIRCLE });
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('someone already in the circle is told so and not invited; a closed account or a block is not allowed', async () => {
    world({ recipient: { state: 'member' } });
    expect((await createInvitesBatch({ userId: ASKER }, { type: 'circle', circleId: CIRCLE, inviteeUserIds: [FRIEND] })).results[0].outcome).toBe('already_member');
    world({ recipient: { active: false } });
    expect((await createInvitesBatch({ userId: ASKER }, { type: 'circle', circleId: CIRCLE, inviteeUserIds: [FRIEND] })).results[0].outcome).toBe('not_allowed');
    world({ recipient: { blocked: true } });
    expect((await createInvitesBatch({ userId: ASKER }, { type: 'circle', circleId: CIRCLE, inviteeUserIds: [FRIEND] })).results[0].outcome).toBe('not_allowed');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('reads the recipients against the circle: membership from circle_members, invites of type circle', async () => {
    world();
    await createInvitesBatch({ userId: ASKER }, { type: 'circle', circleId: CIRCLE, inviteeUserIds: [FRIEND] }, { emailGapMs: 0 });
    const sql = mockQuery.mock.calls.map((c) => flat(c[0])).find((s) => /FROM wanted w/.test(s))!;
    expect(sql).toContain('FROM circle_members cm WHERE cm.circle_id = $4 AND cm.user_id = w.id');
    expect(sql).toContain("i.type = 'circle' AND i.circle_id = $4");
  });

  it('a member of a closed circle is refused for the whole batch, before anything is written', async () => {
    world({ policy: 'closed', mayInvite: false });
    await expect(createInvitesBatch({ userId: ASKER }, { type: 'circle', circleId: CIRCLE, inviteeUserIds: [FRIEND] }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('the single invite (production\'s /invites?type=circle form) asks the same rule', () => {
  it('a member of a closed circle is refused with the same sentence; an open circle\'s member is not', async () => {
    world({ policy: 'closed', mayInvite: false });
    await expect(createInvite(ASKER, { type: InviteType.CIRCLE, circleId: CIRCLE, maxUses: 10 }, 'member'))
      .rejects.toMatchObject({ statusCode: 403, message: 'Only the people who run this circle can invite to it.' });
    world({ policy: 'open', mayInvite: false });
    await expect(createInvite(ASKER, { type: InviteType.CIRCLE, circleId: CIRCLE, maxUses: 10 }, 'member'))
      .rejects.toMatchObject({ statusCode: 403, message: 'Only circle members can invite to a circle' });
  });
});
