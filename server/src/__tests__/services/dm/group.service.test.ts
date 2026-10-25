// ─── Group chats: the service (26 Oct 2026) ──────────────────────────────────
//
// Stefan, 25 Oct (COM-04): "Can there be 3, 5, 10, 20, 50 people in a chat? There should be." Pinned here:
// who may start a group from an event and with whom (the people who took part: 3 to 50 with the creator);
// the 50 cap held under the group's row lock, so two adds at once never make 51; nobody blocked with the
// adder is added; members who block each other stay in the group but never see each other's messages, in
// the thread, the preview or the unread count, and never get each other's bells; unread counts; leaving,
// removing, and the admin handed to the earliest member; bells written once per person per group per 10
// minutes, honouring the group bell setting.
//
// The database is a stand-in that answers by what the SQL asks. Statements inside a transaction go to
// `tx`, reads outside one to `pool`. The concurrent-add test uses a fuller stand-in that keeps the group's
// members and grants its row lock (SELECT … FOR UPDATE) to one transaction at a time, as Postgres does, and
// makes a transaction's inserts visible to the other only when it commits. AppError subclasses fail
// `instanceof` (errors.ts sets the prototype to AppError's), so errors are matched by status, code and message.

type Rows = Array<Record<string, unknown>>;
type Answer = Rows | Error | { rows: Rows; rowCount: number };
type Rule = [RegExp, Answer | ((params: unknown[]) => Answer)];

const mockPool = jest.fn();
const mockTx = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockPool(...a),
  transaction: (cb: (client: unknown) => Promise<unknown>) => mockTransaction(cb),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockAreBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
  __esModule: true,
}));
const mockSocketEmit = jest.fn();
const mockTo = jest.fn();
const mockIo = { to: (...a: unknown[]) => mockTo(...a) };
const mockEmitEntities = jest.fn();
let mockIoPresent = true;
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
  getRealtimeIo: () => (mockIoPresent ? mockIo : null),
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import {
  GROUP_COPY, addGroupMembers, createCustomGroup, createGroupFromEvent, getGroup, leaveGroup, listGroupMessages,
  listMyGroups, markGroupRead, pushGroupBells, removeGroupMember, sendGroupMessage,
} from '../../../services/dm/group.service';
import { E } from '../../../realtime/entities';
import { ErrorCodes, GROUP_CHAT_MAX_MEMBERS, UserRole } from '@rsn/shared';

const CREATOR = 'c0000000-0000-4000-8000-000000000001';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'd0000000-0000-4000-8000-00000000000c';
const NEVER_CAME = 'e0000000-0000-4000-8000-00000000000e';
const SESSION = '5e000000-0000-4000-8000-000000000001';
const GROUP = '90000000-0000-4000-8000-000000000001';
const MSG = '70000000-0000-4000-8000-000000000001';

/** n distinct member ids, none of them the people above. */
const people = (n: number, tag = 'f') =>
  Array.from({ length: n }, (_, i) => `${tag}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

/** The SQL as one line, so a pattern can span what the code wrote on several. */
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

function answerWith(mock: jest.Mock, rules: Rule[]) {
  mock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const rule = rules.find(([re]) => re.test(flat(sql)));
    if (!rule) return { rows: [], rowCount: 0 };
    const answer = typeof rule[1] === 'function' ? rule[1](params) : rule[1];
    if (answer instanceof Error) throw answer;
    if (Array.isArray(answer)) return { rows: answer, rowCount: answer.length };
    return answer;
  });
}
const pool = (rules: Rule[]) => answerWith(mockPool, rules);
const tx = (rules: Rule[]) => answerWith(mockTx, rules);

const sqlOf = (mock: jest.Mock) => mock.mock.calls.map((c) => flat(c[0]));
const callTo = (mock: jest.Mock, re: RegExp) => mock.mock.calls.find((c) => re.test(flat(c[0])));
const ran = (mock: jest.Mock, re: RegExp) => sqlOf(mock).some((s) => re.test(s));
const indexOf = (mock: jest.Mock, re: RegExp) => sqlOf(mock).findIndex((s) => re.test(s));

type Caught = Error & { statusCode?: number; code?: string };
const caught = (p: Promise<unknown>) => p.then(() => null, (e: Caught) => e);
const refusal = (e: Caught | null) => (e ? { status: e.statusCode, code: e.code, message: e.message } : null);

// The statements, as the patterns that route each to its answer.
const EVENT = /FROM sessions s WHERE s\.id = \$1/;
const TOOK_PART = /FROM session_participants sp JOIN users u ON u\.id = sp\.user_id WHERE sp\.session_id = \$1/;
const BLOCKED_WITH = /FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = ANY\(\$2::uuid\[\]\)\)/;
const INSERT_GROUP = /INSERT INTO dm_groups/;
const LOCK = /FROM dm_groups WHERE id = \$1 FOR UPDATE/;
const MEMBER_IDS = /SELECT user_id FROM dm_group_members WHERE group_id = \$1$/;
const ROLE_OF = /SELECT role FROM dm_group_members WHERE group_id = \$1 AND user_id = \$2/;
const INSERT_MEMBERS = /INSERT INTO dm_group_members/;
const DELETE_MEMBER = /DELETE FROM dm_group_members WHERE group_id = \$1 AND user_id = \$2 RETURNING role/;
const ANY_ADMIN = /FROM dm_group_members WHERE group_id = \$1 AND role = 'admin'/;
const PROMOTE = /UPDATE dm_group_members SET role = 'admin'/;
const SENDER = /FROM dm_group_members m JOIN users u ON u\.id = m\.user_id WHERE m\.group_id = \$1 AND m\.user_id = \$2/;
const INSERT_MESSAGE = /INSERT INTO direct_messages/;
const TOUCH = /UPDATE dm_groups SET last_message_at/;
const BELLS = /INSERT INTO notifications/;
const ACCESS = /FROM dm_groups g LEFT JOIN dm_group_members me ON me\.group_id = g\.id AND me\.user_id = \$2 WHERE g\.id = \$1/;
const THREAD = /FROM direct_messages d JOIN users u ON u\.id = d\.from_user_id WHERE d\.group_id = \$1/;
const SUMMARY = /FROM dm_group_members me JOIN dm_groups g ON g\.id = me\.group_id/;
const MEMBERS = /FROM dm_group_members m JOIN users u ON u\.id = m\.user_id WHERE m\.group_id = \$1 ORDER BY/;
const READ_MARK = /UPDATE dm_group_members SET last_read_at = NOW\(\)/;
const GROUP_EXISTS = /SELECT id FROM dm_groups WHERE id = \$1$/;

const NOW = new Date('2026-10-26T10:00:00.000Z');

/** The event row the organiser lookup returns; the host is CREATOR unless a test says otherwise. */
const eventRow = (over: Record<string, unknown> = {}) => ({
  status: 'completed', title: 'Video meeting · Test', host_user_id: CREATOR,
  is_cohost: false, is_pod_organiser: false, ...over,
});
const groupRow = (over: Record<string, unknown> = {}) => ({
  id: GROUP, name: 'Video meeting · Test', type: 'event', pod_id: null, session_id: SESSION,
  created_by: CREATOR, last_message_at: null, created_at: NOW, ...over,
});
const tookPart = (ids: string[]) => ids.map((user_id) => ({ user_id }));

beforeEach(() => {
  jest.clearAllMocks();
  mockIoPresent = true;
  pool([]);
  tx([]);
  mockTransaction.mockImplementation(async (cb: (client: unknown) => Promise<unknown>) => cb({ query: (...a: unknown[]) => mockTx(...a) }));
  mockAreBlocked.mockResolvedValue(false);
  mockTo.mockReturnValue({ emit: mockSocketEmit });
  mockEmitEntities.mockResolvedValue(undefined);
});

describe('the words people read', () => {
  it('says the two limits verbatim', () => {
    expect(GROUP_COPY.full).toBe('This group is full (50 people).');
    expect(GROUP_COPY.tooSmall).toBe('A group chat needs at least 3 people.');
    expect(GROUP_CHAT_MAX_MEMBERS).toBe(50);
  });
});

// ─── Starting a group from an event ──────────────────────────────────────────

describe('createGroupFromEvent', () => {
  const host = { userId: CREATOR, role: UserRole.MEMBER };
  const startsWith = (attendees: string[], extra: Rule[] = [], event = eventRow()) => tx([
    [EVENT, [event]],
    [TOOK_PART, tookPart(attendees)],
    ...extra,
    [INSERT_GROUP, [groupRow()]],
    [LOCK, [{ id: GROUP, name: 'Video meeting · Test', type: 'event', session_id: SESSION }]],
  ]);

  it('the host starts a group with everyone who took part: they are its admin, the others members, all in one transaction', async () => {
    startsWith([A, B]);
    const out = await createGroupFromEvent(host, SESSION, {});
    expect(out).toEqual(expect.objectContaining({ id: GROUP, type: 'event', sessionId: SESSION, podId: null, memberCount: 3 }));
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPool).not.toHaveBeenCalled();
    expect(callTo(mockTx, INSERT_GROUP)![1]).toEqual(['Video meeting · Test', SESSION, CREATOR]);
    expect(flat(callTo(mockTx, INSERT_GROUP)![0])).toMatch(/VALUES \(\$1, 'event', \$2, \$3\)/);
    expect(callTo(mockTx, INSERT_MEMBERS)![1]).toEqual([GROUP, [CREATOR, A, B], ['admin', 'member', 'member']]);
  });

  it('takes the new group\'s row lock and reads its members before putting anyone in (the one path that holds the cap)', async () => {
    startsWith([A, B]);
    await createGroupFromEvent(host, SESSION, {});
    const lockAt = indexOf(mockTx, LOCK);
    expect(lockAt).toBeGreaterThan(indexOf(mockTx, INSERT_GROUP));
    expect(indexOf(mockTx, MEMBER_IDS)).toBeGreaterThan(lockAt);
    expect(indexOf(mockTx, INSERT_MEMBERS)).toBeGreaterThan(indexOf(mockTx, MEMBER_IDS));
  });

  it('took part means joined and not removed, with an open account: the read says so, for this event, without the creator', async () => {
    startsWith([A, B]);
    await createGroupFromEvent(host, SESSION, {});
    const read = callTo(mockTx, TOOK_PART)!;
    const sql = flat(read[0]);
    expect(sql).toMatch(/sp\.joined_at IS NOT NULL/);
    expect(sql).toMatch(/sp\.status <> 'removed'/);
    expect(sql).toMatch(/u\.status = 'active'/);
    expect(read[1]).toEqual([SESSION]);
  });

  it('never puts the creator in twice when they took part too', async () => {
    startsWith([CREATOR, A, B]);
    await createGroupFromEvent(host, SESSION, {});
    expect(callTo(mockTx, INSERT_MEMBERS)![1]).toEqual([GROUP, [CREATOR, A, B], ['admin', 'member', 'member']]);
  });

  it('refuses someone who registered and never came, by name, and writes nothing', async () => {
    startsWith([A, B]); // NEVER_CAME is registered but has no joined_at, so the read does not return them
    const e = await caught(createGroupFromEvent(host, SESSION, { memberIds: [A, NEVER_CAME] }));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'Only people who took part in this event can be added.' });
    expect(ran(mockTx, INSERT_GROUP)).toBe(false);
  });

  it.each([
    ['a co-host', eventRow({ host_user_id: A, is_cohost: true }), UserRole.MEMBER],
    ['a director or host of the event\'s pod', eventRow({ host_user_id: A, is_pod_organiser: true }), UserRole.MEMBER],
    ['an admin with no tie to the event', eventRow({ host_user_id: A }), UserRole.ADMIN],
    ['a super admin with no tie to the event', eventRow({ host_user_id: A }), UserRole.SUPER_ADMIN],
  ])('%s may start one too', async (_who, event, role) => {
    startsWith([A, B], [], event);
    const out = await createGroupFromEvent({ userId: CREATOR, role }, SESSION, {});
    expect(out.memberCount).toBe(3);
  });

  it('asks about co-hosts and the pod\'s active directors and hosts for the person starting it', async () => {
    startsWith([A, B]);
    await createGroupFromEvent(host, SESSION, {});
    const read = callTo(mockTx, EVENT)!;
    expect(read[1]).toEqual([SESSION, CREATOR]);
    expect(flat(read[0])).toMatch(/FROM session_cohosts sc WHERE sc\.session_id = s\.id AND sc\.user_id = \$2/);
    expect(flat(read[0])).toMatch(/pm\.role IN \('director', 'host'\) AND pm\.status = 'active'/);
  });

  it('refuses someone who took part but did not run the event, and writes nothing', async () => {
    startsWith([A, B], [], eventRow({ host_user_id: A }));
    const e = await caught(createGroupFromEvent({ userId: CREATOR, role: UserRole.MEMBER }, SESSION, {}));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'Only the people who ran this event can start a group chat from it.' });
    expect(ran(mockTx, INSERT_GROUP)).toBe(false);
  });

  it('says an event that is not there cannot be found', async () => {
    tx([[EVENT, []]]);
    const e = await caught(createGroupFromEvent(host, SESSION, {}));
    expect(refusal(e)).toEqual({ status: 404, code: 'SESSION_NOT_FOUND', message: 'This event could not be found.' });
  });

  it.each(['scheduled', 'lobby_open', 'round_active', 'closing_lobby', 'cancelled'])('waits for the event to end (%s)', async (status) => {
    startsWith([A, B], [], eventRow({ status }));
    const e = await caught(createGroupFromEvent(host, SESSION, {}));
    expect(refusal(e)).toEqual({ status: 409, code: ErrorCodes.VALIDATION_ERROR, message: 'You can start a group chat after the event ends.' });
    expect(ran(mockTx, INSERT_GROUP)).toBe(false);
  });

  it('needs at least 3 people with the creator', async () => {
    startsWith([A]);
    const e = await caught(createGroupFromEvent(host, SESSION, {}));
    expect(refusal(e)).toEqual({ status: 400, code: ErrorCodes.GROUP_TOO_SMALL, message: 'A group chat needs at least 3 people.' });
    expect(ran(mockTx, INSERT_GROUP)).toBe(false);
  });

  it('an empty choice of people is too small too, not "everyone"', async () => {
    startsWith([A, B, C]);
    const e = await caught(createGroupFromEvent(host, SESSION, { memberIds: [] }));
    expect(refusal(e)?.code).toBe(ErrorCodes.GROUP_TOO_SMALL);
  });

  it('holds 50 with the creator, and refuses 51', async () => {
    startsWith(people(49));
    expect((await createGroupFromEvent(host, SESSION, {})).memberCount).toBe(50);

    jest.clearAllMocks();
    startsWith(people(50));
    const e = await caught(createGroupFromEvent(host, SESSION, {}));
    expect(refusal(e)).toEqual({ status: 409, code: ErrorCodes.GROUP_FULL, message: 'This group is full (50 people).' });
    expect(ran(mockTx, INSERT_GROUP)).toBe(false);
  });

  it('with more than 49 others, the creator picks up to 49 of them', async () => {
    const many = people(80);
    startsWith(many);
    const out = await createGroupFromEvent(host, SESSION, { memberIds: many.slice(0, 49) });
    expect(out.memberCount).toBe(50);
    expect(callTo(mockTx, INSERT_MEMBERS)![1][1]).toEqual([CREATOR, ...many.slice(0, 49)]);
  });

  it('uses only the people chosen, each once, and never the creator as a member', async () => {
    startsWith([A, B, C]);
    await createGroupFromEvent(host, SESSION, { memberIds: [B, C, B, CREATOR] });
    expect(callTo(mockTx, INSERT_MEMBERS)![1]).toEqual([GROUP, [CREATOR, B, C], ['admin', 'member', 'member']]);
  });

  it('leaves out, unasked, anyone blocked with the creator in either direction', async () => {
    startsWith([A, B, C], [[BLOCKED_WITH, [{ user_id: B }]]]);
    const out = await createGroupFromEvent(host, SESSION, {});
    expect(out.memberCount).toBe(3);
    expect(callTo(mockTx, INSERT_MEMBERS)![1][1]).toEqual([CREATOR, A, C]);
    const blocks = callTo(mockTx, BLOCKED_WITH)!;
    expect(flat(blocks[0])).toMatch(/OR \(b\.blocked_id = \$1 AND b\.blocker_id = ANY\(\$2::uuid\[\]\)\)/);
    expect(blocks[1]).toEqual([CREATOR, [A, B, C]]);
  });

  it('refuses to add, by name, someone blocked with the creator, and writes nothing', async () => {
    startsWith([A, B, C], [[BLOCKED_WITH, [{ user_id: B }]]]);
    const e = await caught(createGroupFromEvent(host, SESSION, { memberIds: [A, B] }));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: "You can't add someone you can no longer message." });
    expect(ran(mockTx, INSERT_GROUP)).toBe(false);
  });

  it('is named after the event unless the creator names it, trimmed; a blank name is no name', async () => {
    startsWith([A, B]);
    await createGroupFromEvent(host, SESSION, { name: '  Follow-up crew  ' });
    expect(callTo(mockTx, INSERT_GROUP)![1][0]).toBe('Follow-up crew');

    jest.clearAllMocks();
    startsWith([A, B]);
    await createGroupFromEvent(host, SESSION, { name: '   ' });
    expect(callTo(mockTx, INSERT_GROUP)![1][0]).toBe('Video meeting · Test');
  });

  it('cuts a long event title to the 200 characters a group name holds', async () => {
    startsWith([A, B], [], eventRow({ title: 'x'.repeat(300) }));
    await createGroupFromEvent(host, SESSION, {});
    expect(callTo(mockTx, INSERT_GROUP)![1][0]).toBe('x'.repeat(200));
  });
});

// ─── Adding people ───────────────────────────────────────────────────────────

describe('addGroupMembers', () => {
  const ADMIN = CREATOR;
  const adds = (members: string[], attendees: string[], extra: Rule[] = [], group = { id: GROUP, name: 'G', type: 'event', session_id: SESSION }) => tx([
    [LOCK, [group]],
    [ROLE_OF, (p) => (members.includes(String(p[1])) ? [{ role: p[1] === ADMIN ? 'admin' : 'member' }] : [])],
    [MEMBER_IDS, members.map((user_id) => ({ user_id }))],
    [TOOK_PART, (p) => tookPart((p[1] as string[]).filter((id) => attendees.includes(id)))],
    ...extra,
  ]);

  it('the admin adds people who took part in the group\'s event', async () => {
    adds([ADMIN, A, B], [A, B, C]);
    const out = await addGroupMembers(GROUP, ADMIN, [C]);
    expect(out).toEqual({ added: [C], memberCount: 4 });
    expect(callTo(mockTx, INSERT_MEMBERS)![1]).toEqual([GROUP, [C], ['member']]);
    expect(callTo(mockTx, TOOK_PART)![1]).toEqual([SESSION, [C]]);
  });

  it('takes the group\'s row lock before anything else', async () => {
    adds([ADMIN, A, B], [A, B, C]);
    await addGroupMembers(GROUP, ADMIN, [C]);
    expect(indexOf(mockTx, LOCK)).toBe(0);
  });

  it('two adds at once to a group of 49: one gets the 50th place, the other is told it is full, and the group never holds 51', async () => {
    const members = new Map<string, string>([[ADMIN, 'admin'], ...people(48).map((id) => [id, 'member'] as [string, string])]);
    const [X, Y] = people(2, '1');
    let holder: number | null = null;
    const waiting: Array<() => void> = [];
    let next = 0;
    mockTransaction.mockImplementation(async (cb: (client: unknown) => Promise<unknown>) => {
      const me = ++next;
      const pending = new Map<string, string>(); // inserted here, seen by the other transaction only after commit
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          await new Promise((r) => setImmediate(r)); // every statement yields, so the two transactions interleave
          const text = flat(sql);
          if (/FROM dm_groups WHERE id = \$1/.test(text)) {
            // Only FOR UPDATE waits for the lock; a plain read of the row does not, as in Postgres.
            if (LOCK.test(text)) {
              if (holder !== null && holder !== me) await new Promise<void>((r) => waiting.push(r));
              holder = me;
            }
            return { rows: [{ id: GROUP, name: 'G', type: 'event', session_id: SESSION }], rowCount: 1 };
          }
          if (ROLE_OF.test(text)) return { rows: members.has(String(params[1])) ? [{ role: members.get(String(params[1])) }] : [], rowCount: 1 };
          if (MEMBER_IDS.test(text)) return { rows: [...members.keys(), ...pending.keys()].map((user_id) => ({ user_id })), rowCount: 0 };
          if (TOOK_PART.test(text)) return { rows: tookPart(params[1] as string[]), rowCount: 0 };
          if (INSERT_MEMBERS.test(text)) {
            (params[1] as string[]).forEach((id, i) => pending.set(id, (params[2] as string[])[i]));
            return { rows: [], rowCount: (params[1] as string[]).length };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      try {
        const out = await cb(client);
        for (const [id, role] of pending) members.set(id, role); // commit
        return out;
      } finally {
        if (holder === me) {
          holder = null;
          waiting.shift()?.();
        }
      }
    });

    const results = await Promise.allSettled([addGroupMembers(GROUP, ADMIN, [X]), addGroupMembers(GROUP, ADMIN, [Y])]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(refusal(rejected[0].reason)).toEqual({ status: 409, code: ErrorCodes.GROUP_FULL, message: 'This group is full (50 people).' });
    expect(members.size).toBe(50);
  });

  it('only the group\'s admin adds', async () => {
    adds([ADMIN, A, B], [A, B, C]);
    const e = await caught(addGroupMembers(GROUP, A, [C]));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: "Only the group's admin can add people." });
    expect(ran(mockTx, INSERT_MEMBERS)).toBe(false);
  });

  it('someone outside the group cannot add to it', async () => {
    adds([ADMIN, A, B], [A, B, C]);
    const e = await caught(addGroupMembers(GROUP, C, [C]));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'You are not in this group.' });
  });

  it('only people who took part in the event: someone who registered and never came is refused', async () => {
    adds([ADMIN, A, B], [A, B]);
    const e = await caught(addGroupMembers(GROUP, ADMIN, [NEVER_CAME]));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'Only people who took part in this event can be added.' });
    expect(ran(mockTx, INSERT_MEMBERS)).toBe(false);
  });

  it('a group with no event (not started from one, or its event deleted) takes nobody new', async () => {
    adds([ADMIN, A, B], [A, B, C], [], { id: GROUP, name: 'G', type: 'event', session_id: null } as never);
    const e = await caught(addGroupMembers(GROUP, ADMIN, [C]));
    expect(refusal(e)).toEqual({ status: 409, code: ErrorCodes.VALIDATION_ERROR, message: 'New people can only be added to a group started from an event.' });
  });

  it('nobody can add someone blocked with them, in either direction', async () => {
    adds([ADMIN, A, B], [A, B, C], [[BLOCKED_WITH, [{ user_id: C }]]]);
    const e = await caught(addGroupMembers(GROUP, ADMIN, [C]));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: "You can't add someone you can no longer message." });
    expect(callTo(mockTx, BLOCKED_WITH)![1]).toEqual([ADMIN, [C]]);
    expect(ran(mockTx, INSERT_MEMBERS)).toBe(false);
  });

  it('people already in the group are not added again, and adding nobody new changes nothing', async () => {
    adds([ADMIN, A, B], [A, B, C]);
    expect(await addGroupMembers(GROUP, ADMIN, [A, B, ADMIN])).toEqual({ added: [], memberCount: 3 });
    expect(ran(mockTx, INSERT_MEMBERS)).toBe(false);
  });

  it('refuses the 51st person', async () => {
    const full = [ADMIN, ...people(49)];
    adds(full, [C]);
    const e = await caught(addGroupMembers(GROUP, ADMIN, [C]));
    expect(refusal(e)).toEqual({ status: 409, code: ErrorCodes.GROUP_FULL, message: 'This group is full (50 people).' });
    expect(ran(mockTx, INSERT_MEMBERS)).toBe(false);
  });

  it('says a group that is not there cannot be found', async () => {
    tx([[LOCK, []]]);
    const e = await caught(addGroupMembers(GROUP, ADMIN, [C]));
    expect(refusal(e)).toEqual({ status: 404, code: 'GROUP_NOT_FOUND', message: 'This group chat could not be found.' });
  });
});

// ─── Removing, leaving and the admin hand-over ───────────────────────────────

describe('removeGroupMember', () => {
  const members = (roles: Record<string, string>) => tx([
    [LOCK, [{ id: GROUP, name: 'G', type: 'event', session_id: SESSION }]],
    [ROLE_OF, (p) => (roles[String(p[1])] ? [{ role: roles[String(p[1])] }] : [])],
    [DELETE_MEMBER, (p) => (roles[String(p[1])] ? [{ role: roles[String(p[1])] }] : [])],
  ]);

  it('the admin removes a member, under the group\'s row lock', async () => {
    members({ [CREATOR]: 'admin', [A]: 'member' });
    expect(await removeGroupMember(GROUP, CREATOR, A)).toEqual({ removedUserId: A });
    expect(indexOf(mockTx, LOCK)).toBe(0);
    expect(callTo(mockTx, DELETE_MEMBER)![1]).toEqual([GROUP, A]);
  });

  it('a member cannot remove anyone', async () => {
    members({ [CREATOR]: 'admin', [A]: 'member', [B]: 'member' });
    const e = await caught(removeGroupMember(GROUP, A, B));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: "Only the group's admin can remove people." });
    expect(ran(mockTx, DELETE_MEMBER)).toBe(false);
  });

  it('someone outside the group cannot remove anyone', async () => {
    members({ [CREATOR]: 'admin', [A]: 'member' });
    const e = await caught(removeGroupMember(GROUP, C, A));
    expect(refusal(e)?.message).toBe('You are not in this group.');
  });

  it('says so when the person is not in the group', async () => {
    members({ [CREATOR]: 'admin' });
    const e = await caught(removeGroupMember(GROUP, CREATOR, A));
    expect(refusal(e)).toEqual({ status: 404, code: 'GROUP_MEMBER_NOT_FOUND', message: 'This person is not in the group.' });
  });

  it('the admin leaves with Leave, not by removing themselves', async () => {
    members({ [CREATOR]: 'admin' });
    const e = await caught(removeGroupMember(GROUP, CREATOR, CREATOR));
    expect(refusal(e)).toEqual({ status: 400, code: ErrorCodes.VALIDATION_ERROR, message: 'To leave the group, use Leave.' });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('leaveGroup', () => {
  const leaving = (role: string | null, extra: Rule[] = []) => tx([
    [LOCK, [{ id: GROUP, name: 'G', type: 'event', session_id: SESSION }]],
    [DELETE_MEMBER, role ? [{ role }] : []],
    ...extra,
  ]);

  it('a member leaves: their place goes and nobody is promoted', async () => {
    leaving('member');
    expect(await leaveGroup(GROUP, A)).toEqual({ left: true, newAdminId: null });
    expect(callTo(mockTx, DELETE_MEMBER)![1]).toEqual([GROUP, A]);
    expect(ran(mockTx, PROMOTE)).toBe(false);
    expect(indexOf(mockTx, LOCK)).toBe(0);
  });

  it('the admin leaves and no admin is left: the earliest member becomes admin', async () => {
    leaving('admin', [[ANY_ADMIN, []], [PROMOTE, [{ user_id: B }]]]);
    expect(await leaveGroup(GROUP, CREATOR)).toEqual({ left: true, newAdminId: B });
    const promote = callTo(mockTx, PROMOTE)!;
    expect(flat(promote[0])).toMatch(/WHERE id = \(SELECT id FROM dm_group_members WHERE group_id = \$1 ORDER BY joined_at ASC, id ASC LIMIT 1\)/);
    expect(promote[1]).toEqual([GROUP]);
    expect(indexOf(mockTx, PROMOTE)).toBeGreaterThan(indexOf(mockTx, DELETE_MEMBER));
  });

  it('an admin leaves while another admin stays: nobody is promoted', async () => {
    leaving('admin', [[ANY_ADMIN, [{ '?column?': 1 }]]]);
    expect(await leaveGroup(GROUP, CREATOR)).toEqual({ left: true, newAdminId: null });
    expect(ran(mockTx, PROMOTE)).toBe(false);
  });

  it('the last one out leaves nobody to promote', async () => {
    leaving('admin', [[ANY_ADMIN, []], [PROMOTE, []]]);
    expect(await leaveGroup(GROUP, CREATOR)).toEqual({ left: true, newAdminId: null });
  });

  it('leaving a group one has already left changes nothing (a second press of Leave)', async () => {
    leaving(null);
    expect(await leaveGroup(GROUP, A)).toEqual({ left: false, newAdminId: null });
    expect(ran(mockTx, PROMOTE)).toBe(false);
  });

  it('says a group that is not there cannot be found', async () => {
    tx([[LOCK, []]]);
    expect(refusal(await caught(leaveGroup(GROUP, A)))?.status).toBe(404);
  });
});

// ─── Sending, and the bells it rings ─────────────────────────────────────────

describe('sendGroupMessage', () => {
  const sends = (extra: Rule[] = []) => tx([
    [LOCK, [{ id: GROUP, name: 'Follow-up crew', type: 'event', session_id: SESSION }]],
    [SENDER, [{ display_name: 'Claus Meyer', avatar_url: 'https://res.cloudinary.com/x/claus.jpg' }]],
    [INSERT_MESSAGE, [{ id: MSG, created_at: NOW }]],
    [BELLS, [{ id: 'n-1', user_id: A, created_at: NOW }, { id: 'n-2', user_id: B, created_at: NOW }]],
    ...extra,
  ]);

  it('a member\'s message is kept in the group, under its row lock, and its last activity moves', async () => {
    sends();
    const out = await sendGroupMessage(GROUP, CREATOR, '  Thanks for coming!  ');
    expect(out.message).toEqual({
      id: MSG, groupId: GROUP, fromUserId: CREATOR, senderName: 'Claus Meyer',
      senderAvatarUrl: 'https://res.cloudinary.com/x/claus.jpg', content: 'Thanks for coming!', createdAt: NOW.toISOString(),
    });
    expect(callTo(mockTx, INSERT_MESSAGE)![1]).toEqual([GROUP, CREATOR, 'Thanks for coming!']);
    expect(callTo(mockTx, TOUCH)![1]).toEqual([GROUP, NOW]);
    expect(indexOf(mockTx, LOCK)).toBe(0);
    expect(indexOf(mockTx, SENDER)).toBeGreaterThan(0);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('someone outside the group cannot write in it, and nothing is kept', async () => {
    tx([[LOCK, [{ id: GROUP, name: 'G', type: 'event', session_id: SESSION }]], [SENDER, []]]);
    const e = await caught(sendGroupMessage(GROUP, C, 'hello'));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'You are not in this group.' });
    expect(ran(mockTx, INSERT_MESSAGE)).toBe(false);
    expect(ran(mockTx, BELLS)).toBe(false);
  });

  it.each([['an empty message', '   '], ['a message over 4000 characters', 'x'.repeat(4001)]])('refuses %s', async (_what, text) => {
    sends();
    const e = await caught(sendGroupMessage(GROUP, CREATOR, text));
    expect(refusal(e)?.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('says a group that is not there cannot be found', async () => {
    tx([[LOCK, []]]);
    expect(refusal(await caught(sendGroupMessage(GROUP, CREATOR, 'hi')))?.status).toBe(404);
  });

  describe('the bells', () => {
    const bellSql = async () => {
      sends();
      await sendGroupMessage(GROUP, CREATOR, 'Thanks for coming!');
      return { sql: flat(callTo(mockTx, BELLS)![0]), params: callTo(mockTx, BELLS)![1] as unknown[] };
    };

    it('are written in one statement for the group\'s members, in the message\'s transaction, after it is kept', async () => {
      const { sql } = await bellSql();
      expect(sql).toMatch(/INSERT INTO notifications \(user_id, type, title, body, link\) SELECT m\.user_id, 'group_message', \$3, \$4, \$5 FROM dm_group_members m JOIN users u ON u\.id = m\.user_id WHERE m\.group_id = \$1/);
      expect(mockTx.mock.calls.filter((c) => BELLS.test(flat(c[0])))).toHaveLength(1);
      expect(indexOf(mockTx, BELLS)).toBeGreaterThan(indexOf(mockTx, INSERT_MESSAGE));
      expect(indexOf(mockTx, BELLS)).toBeGreaterThan(indexOf(mockTx, LOCK));
    });

    it('never ring the sender, or an account that is closed', async () => {
      const { sql, params } = await bellSql();
      expect(sql).toMatch(/m\.user_id <> \$2/);
      expect(sql).toMatch(/u\.status = 'active'/);
      expect(params[1]).toBe(CREATOR);
    });

    it('honour the group bell setting: off means no bell, and a member who never set it is rung', async () => {
      const { sql } = await bellSql();
      expect(sql).toMatch(/u\.notification_prefs -> 'group_bell' IS DISTINCT FROM 'false'::jsonb/);
    });

    it('never ring someone blocked with the sender, in either direction', async () => {
      const { sql } = await bellSql();
      expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = m\.user_id AND b\.blocked_id = \$2\) OR \(b\.blocker_id = \$2 AND b\.blocked_id = m\.user_id\)\)/);
    });

    it('ring a person once per group in 10 minutes, however many messages come', async () => {
      const { sql, params } = await bellSql();
      expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM notifications n WHERE n\.user_id = m\.user_id AND n\.type = 'group_message' AND n\.link = \$5 AND n\.created_at > NOW\(\) - INTERVAL '10 minutes'\)/);
      expect(params[4]).toBe(`/messages/g/${GROUP}`);
    });

    it('say who wrote, in which group, and the start of what they wrote', async () => {
      const { params } = await bellSql();
      expect(params).toEqual([GROUP, CREATOR, 'Claus Meyer wrote in ‘Follow-up crew’', 'Thanks for coming!', `/messages/g/${GROUP}`]);
    });

    it('come back with the message, for the route to push', async () => {
      sends();
      const out = await sendGroupMessage(GROUP, CREATOR, 'x'.repeat(300));
      expect(out.bells).toEqual({
        title: 'Claus Meyer wrote in ‘Follow-up crew’', body: 'x'.repeat(140), link: `/messages/g/${GROUP}`,
        rows: [{ id: 'n-1', userId: A, createdAt: NOW }, { id: 'n-2', userId: B, createdAt: NOW }],
      });
    });
  });
});

describe('pushGroupBells', () => {
  const bells = {
    title: 'Claus Meyer wrote in ‘Follow-up crew’', body: 'Thanks for coming!', link: `/messages/g/${GROUP}`,
    rows: [{ id: 'n-1', userId: A, createdAt: NOW }, { id: 'n-2', userId: B, createdAt: NOW }],
  };

  it('pushes each bell to its own person, live, with their own notifications tag', async () => {
    await pushGroupBells(bells);
    expect(mockTo.mock.calls).toEqual([[`user:${A}`], [`user:${B}`]]);
    expect(mockSocketEmit).toHaveBeenCalledWith('notification:new', {
      id: 'n-1', type: 'group_message', title: bells.title, body: bells.body, link: bells.link, isRead: false, createdAt: NOW,
    });
    expect(mockEmitEntities.mock.calls).toEqual([
      [mockIo, [A], [E.userNotifications(A)]],
      [mockIo, [B], [E.userNotifications(B)]],
    ]);
  });

  it('pushes nothing when nobody was rung, or there is no socket server', async () => {
    await pushGroupBells({ ...bells, rows: [] });
    mockIoPresent = false;
    await pushGroupBells(bells);
    expect(mockSocketEmit).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });
});

// ─── Reading ─────────────────────────────────────────────────────────────────

describe('listGroupMessages', () => {
  const member = (role: string | null = 'member') => [ACCESS, [{ id: GROUP, role }]] as Rule;
  const row = (i: number, over: Record<string, unknown> = {}) => ({
    id: `7000000${i}-0000-4000-8000-000000000001`, from_user_id: A, content: `message ${i}`,
    created_at: new Date(NOW.getTime() - i * 1000), display_name: 'Ana Lopez', avatar_url: null, status: 'active', ...over,
  });

  it('reads newest first, and leaves out every message from someone the reader blocked or who blocked the reader', async () => {
    pool([member(), [THREAD, [row(1), row(2)]]]);
    const page = await listGroupMessages(GROUP, B, {});
    expect(page.messages.map((m) => m.content)).toEqual(['message 1', 'message 2']);
    const read = callTo(mockPool, THREAD)!;
    const sql = flat(read[0]);
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$2 AND b\.blocked_id = d\.from_user_id\) OR \(b\.blocker_id = d\.from_user_id AND b\.blocked_id = \$2\)\)/);
    expect(sql).toMatch(/ORDER BY d\.created_at DESC, d\.id DESC LIMIT \$4/);
    expect(read[1]).toEqual([GROUP, B, null, 51]);
  });

  it('pages by keyset: before a message means strictly older than it, ties broken by id, in the same group', async () => {
    pool([member(), [THREAD, []]]);
    await listGroupMessages(GROUP, B, { before: MSG, limit: 20 });
    const read = callTo(mockPool, THREAD)!;
    expect(flat(read[0])).toMatch(/\(\$3::uuid IS NULL OR \(d\.created_at, d\.id\) < \(SELECT c\.created_at, c\.id FROM direct_messages c WHERE c\.id = \$3::uuid AND c\.group_id = \$1\)\)/);
    expect(read[1]).toEqual([GROUP, B, MSG, 21]);
    expect(flat(read[0])).not.toMatch(/OFFSET/);
  });

  it('a full page says where the next one starts; the last page says there is none', async () => {
    pool([member(), [THREAD, [row(1), row(2), row(3)]]]);
    const full = await listGroupMessages(GROUP, B, { limit: 2 });
    expect(full.messages).toHaveLength(2);
    expect(full.nextCursor).toBe(row(2).id);

    pool([member(), [THREAD, [row(1), row(2)]]]);
    expect((await listGroupMessages(GROUP, B, { limit: 2 })).nextCursor).toBeNull();
  });

  it('holds the page size between 1 and 100, 50 when none is asked for', async () => {
    pool([member(), [THREAD, []]]);
    await listGroupMessages(GROUP, B, { limit: 1000 });
    expect(callTo(mockPool, THREAD)![1][3]).toBe(101);
    await listGroupMessages(GROUP, B, { limit: 0 });
    expect(mockPool.mock.calls.filter((c) => THREAD.test(flat(c[0])))[1][1][3]).toBe(2);
  });

  it('a sender whose account is closed shows as "Former member", with no picture', async () => {
    pool([member(), [THREAD, [row(1, { status: 'deactivated', display_name: 'Gone Person', avatar_url: 'https://res.cloudinary.com/x.jpg' })]]]);
    const page = await listGroupMessages(GROUP, B, {});
    expect(page.messages[0]).toEqual(expect.objectContaining({ senderName: 'Former member', senderAvatarUrl: null }));
  });

  it('someone outside the group reads nothing', async () => {
    pool([member(null)]);
    expect(refusal(await caught(listGroupMessages(GROUP, C, {})))).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'You are not in this group.' });
    expect(ran(mockPool, THREAD)).toBe(false);
  });

  it('says a group that is not there cannot be found', async () => {
    pool([[ACCESS, []]]);
    expect(refusal(await caught(listGroupMessages(GROUP, C, {})))?.status).toBe(404);
  });
});

describe('listMyGroups', () => {
  const summaryRow = (over: Record<string, unknown> = {}) => ({
    id: GROUP, name: 'Follow-up crew', type: 'event', pod_id: null, session_id: SESSION, created_by: CREATOR, created_at: NOW,
    my_role: 'member', member_count: 12, unread_count: 3,
    last_content: 'See you all next week', last_at: new Date(NOW.getTime() + 60_000), last_from: A, last_name: 'Ana Lopez', last_status: 'active',
    ...over,
  });

  it('lists each group with its members, the reader\'s unread count and the last message they can see', async () => {
    pool([[SUMMARY, [summaryRow()]]]);
    expect(await listMyGroups(B)).toEqual([{
      id: GROUP, name: 'Follow-up crew', type: 'event', podId: null, sessionId: SESSION, createdBy: CREATOR,
      createdAt: NOW.toISOString(), lastMessageAt: new Date(NOW.getTime() + 60_000).toISOString(),
      memberCount: 12, unreadCount: 3, myRole: 'member',
      lastMessage: { content: 'See you all next week', at: new Date(NOW.getTime() + 60_000).toISOString(), fromUserId: A, senderName: 'Ana Lopez' },
    }]);
    expect(callTo(mockPool, SUMMARY)![1]).toEqual([B]);
  });

  it('a group with no message yet has no last message', async () => {
    pool([[SUMMARY, [summaryRow({ last_content: null, last_at: null, last_from: null, last_name: null, last_status: null, unread_count: 0 })]]]);
    const [g] = await listMyGroups(B);
    expect(g.lastMessage).toBeNull();
    expect(g.lastMessageAt).toBeNull();
  });

  it('a last message from a closed account is from "Former member"', async () => {
    pool([[SUMMARY, [summaryRow({ last_status: 'suspended' })]]]);
    expect((await listMyGroups(B))[0].lastMessage?.senderName).toBe('Former member');
  });

  it('counts as unread only others\' messages since the reader last read the group (or joined it), never one from someone blocked either way', async () => {
    pool([[SUMMARY, [summaryRow()]]]);
    await listMyGroups(B);
    const sql = flat(callTo(mockPool, SUMMARY)![0]);
    expect(sql).toMatch(/d\.from_user_id <> me\.user_id AND d\.created_at > COALESCE\(me\.last_read_at, me\.joined_at\)/);
    const blocked = /NOT EXISTS \( SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = me\.user_id AND b\.blocked_id = d\.from_user_id\) OR \(b\.blocker_id = d\.from_user_id AND b\.blocked_id = me\.user_id\)\)/g;
    // Once in the unread count and once in the last message: a blocked sender's words appear in neither.
    expect(sql.match(blocked)).toHaveLength(2);
  });

  it('puts the most recent activity first and reads a bounded list', async () => {
    pool([[SUMMARY, []]]);
    await listMyGroups(B);
    expect(flat(callTo(mockPool, SUMMARY)![0])).toMatch(/ORDER BY COALESCE\(last\.created_at, g\.created_at\) DESC, g\.id DESC LIMIT 100/);
  });
});

describe('getGroup', () => {
  it('gives the group, the cap and its members, admin first, a closed account as "Former member"', async () => {
    pool([
      [ACCESS, [{ id: GROUP, role: 'admin' }]],
      [SUMMARY, [{
        id: GROUP, name: 'Follow-up crew', type: 'event', pod_id: null, session_id: SESSION, created_by: CREATOR, created_at: NOW,
        my_role: 'admin', member_count: 3, unread_count: 0, last_content: null, last_at: null, last_from: null, last_name: null, last_status: null,
      }]],
      [MEMBERS, [
        { user_id: CREATOR, role: 'admin', joined_at: NOW, display_name: 'Claus Meyer', avatar_url: 'https://res.cloudinary.com/c.jpg', status: 'active' },
        { user_id: A, role: 'member', joined_at: NOW, display_name: 'Ana Lopez', avatar_url: null, status: 'active' },
        { user_id: B, role: 'member', joined_at: NOW, display_name: 'Gone', avatar_url: 'https://res.cloudinary.com/g.jpg', status: 'banned' },
      ]],
    ]);
    const g = await getGroup(GROUP, CREATOR);
    expect(g).toEqual(expect.objectContaining({ id: GROUP, memberCount: 3, myRole: 'admin', maxMembers: 50, sessionId: SESSION }));
    expect(g.members).toEqual([
      { userId: CREATOR, displayName: 'Claus Meyer', avatarUrl: 'https://res.cloudinary.com/c.jpg', role: 'admin', joinedAt: NOW.toISOString() },
      { userId: A, displayName: 'Ana Lopez', avatarUrl: null, role: 'member', joinedAt: NOW.toISOString() },
      { userId: B, displayName: 'Former member', avatarUrl: null, role: 'member', joinedAt: NOW.toISOString() },
    ]);
    expect(flat(callTo(mockPool, MEMBERS)![0])).toMatch(/ORDER BY \(m\.role = 'admin'\) DESC, m\.joined_at ASC, m\.user_id ASC/);
    expect(callTo(mockPool, SUMMARY)![1]).toEqual([CREATOR, GROUP]);
  });

  it('someone outside the group sees nothing of it', async () => {
    pool([[ACCESS, [{ id: GROUP, role: null }]]]);
    expect(refusal(await caught(getGroup(GROUP, C)))?.status).toBe(403);
    expect(ran(mockPool, MEMBERS)).toBe(false);
  });

  it('says a group that is not there cannot be found', async () => {
    pool([[ACCESS, []]]);
    expect(refusal(await caught(getGroup(GROUP, C)))).toEqual({ status: 404, code: 'GROUP_NOT_FOUND', message: 'This group chat could not be found.' });
  });
});

describe('markGroupRead', () => {
  it('marks the group read for this member now', async () => {
    pool([[READ_MARK, [{ last_read_at: NOW }]]]);
    expect(await markGroupRead(GROUP, B)).toEqual({ lastReadAt: NOW.toISOString() });
    const write = callTo(mockPool, READ_MARK)!;
    expect(flat(write[0])).toMatch(/WHERE group_id = \$1 AND user_id = \$2 RETURNING last_read_at/);
    expect(write[1]).toEqual([GROUP, B]);
  });

  it('someone outside the group cannot mark it, and a group that is not there cannot be found', async () => {
    pool([[READ_MARK, []], [GROUP_EXISTS, [{ id: GROUP }]]]);
    expect(refusal(await caught(markGroupRead(GROUP, C)))?.status).toBe(403);
    pool([[READ_MARK, []], [GROUP_EXISTS, []]]);
    expect(refusal(await caught(markGroupRead(GROUP, C)))?.status).toBe(404);
  });
});

// ─── The custom groups the old route makes ───────────────────────────────────

describe('createCustomGroup (POST /groups, unused by any screen) keeps to the same sizes', () => {
  const met = () => tx([
    [INSERT_GROUP, [groupRow({ type: 'custom', session_id: null })]],
    [LOCK, [{ id: GROUP, name: 'Old style', type: 'custom', session_id: null }]],
  ]);
  beforeEach(() => pool([[/FROM encounter_history/, [{ id: 'enc' }]]]));

  it('makes a group of 3 through the locked insert', async () => {
    met();
    const out = await createCustomGroup(CREATOR, 'Old style', [A, B]);
    expect(out.type).toBe('custom');
    expect(out.sessionId).toBeNull();
    expect(callTo(mockTx, INSERT_MEMBERS)![1]).toEqual([GROUP, [CREATOR, A, B], ['admin', 'member', 'member']]);
    expect(indexOf(mockTx, LOCK)).toBeLessThan(indexOf(mockTx, INSERT_MEMBERS));
  });

  it('refuses 2 people and 51, as the event groups do', async () => {
    met();
    expect(refusal(await caught(createCustomGroup(CREATOR, 'Old style', [A])))?.code).toBe(ErrorCodes.GROUP_TOO_SMALL);
    met();
    expect(refusal(await caught(createCustomGroup(CREATOR, 'Old style', people(50))))?.code).toBe(ErrorCodes.GROUP_FULL);
  });

  it('never names a person by their id when the creator has not met them', async () => {
    met();
    pool([[/FROM encounter_history/, []]]);
    const e = await caught(createCustomGroup(CREATOR, 'Old style', [A, B]));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'You can only add people you have met.' });
    expect(e?.message).not.toContain(A);
  });
});
