// ─── An admin changing an account's status reaches everyone around it (T2, 1 Nov 2026) ──────────────────────────
//
// Removing, suspending, banning or reactivating changes only the account's status, so the people who could be
// looking at the person are read from what the person is in: their pods (members, and the wall where their posts turn
// into "Former member"), the events they hold a place in that have not ended, their connections and conversation
// partners (Messages and People), their group chats and their circles. Each is told with the tags its lists declare.

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn(async () => {});
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => (mockEmitEntities as jest.Mock)(...a),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { accountAudience, fanoutAccountStatusChange } from '../../realtime/fanout';

const GONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const POD = 'bbbbbbbb-0000-4000-8000-000000000002';
const EVENT = 'cccccccc-0000-4000-8000-000000000003';
const FRIEND = 'dddddddd-0000-4000-8000-000000000004';
const PODMATE = 'eeeeeeee-0000-4000-8000-000000000005';
const GROUP = 'ffffffff-0000-4000-8000-000000000006';
const CIRCLE = '11111111-0000-4000-8000-000000000007';
const CIRCLEMATE = '22222222-0000-4000-8000-000000000008';

function answer(sql: string): { rows: unknown[] } {
  if (/FROM pod_members WHERE user_id = \$1 AND status IN \('active', 'pending_approval'\)/.test(sql)) return { rows: [{ pod_id: POD }] };
  if (/FROM session_participants sp JOIN sessions s/.test(sql)) return { rows: [{ session_id: EVENT, pod_id: POD }] };
  if (/WITH signals AS/.test(sql)) return { rows: [{ person_id: FRIEND }] };
  if (/FROM dm_group_members WHERE user_id = \$1/.test(sql)) return { rows: [{ group_id: GROUP }] };
  if (/FROM circle_members WHERE user_id = \$1/.test(sql)) return { rows: [{ circle_id: CIRCLE }] };
  if (/FROM pod_members\s+WHERE pod_id = \$1/.test(sql)) return { rows: [{ user_id: PODMATE }] };
  if (/FROM session_participants\s+WHERE session_id = \$1/.test(sql)) return { rows: [{ user_id: PODMATE }] };
  if (/FROM dm_group_members WHERE group_id = \$1/.test(sql)) return { rows: [{ user_id: FRIEND }] };
  if (/FROM circle_members WHERE circle_id = \$1/.test(sql)) return { rows: [{ user_id: CIRCLEMATE }] };
  return { rows: [] };
}

/** Every tag a person's room was sent. */
const tagsFor = (userId: string) => (mockEmitEntities.mock.calls as unknown as Array<[unknown, string[], string[]]>)
  .filter(([, users]) => users.includes(userId))
  .flatMap(([, , tags]) => tags);

beforeEach(() => {
  mockEmitEntities.mockClear();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => answer(sql));
});

describe('accountAudience', () => {
  it('reads the pods, live or upcoming events, connections, group chats and circles of the account', async () => {
    expect(await accountAudience(GONE)).toEqual({
      podIds: [POD], events: [{ podId: POD, sessionId: EVENT }], people: [FRIEND], groupIds: [GROUP], circleIds: [CIRCLE],
    });
    for (const call of mockQuery.mock.calls) expect(call[1]).toEqual([GONE]);
    // The connections read is bounded, newest first (review minor 4).
    const people = mockQuery.mock.calls.map((c) => String(c[0])).find((sql) => /WITH signals AS/.test(sql))!;
    expect(people).toMatch(/ORDER BY since DESC LIMIT 2000$/);
  });
});

describe('fanoutAccountStatusChange', () => {
  it('tells each list that shows the person, with the tags it declares', async () => {
    await fanoutAccountStatusChange(GONE);
    expect(tagsFor(PODMATE)).toEqual(expect.arrayContaining([
      `pod:${POD}`, `pod:${POD}:members`, `pod:${POD}:wall`, `session:${EVENT}`, `session:${EVENT}:participants`,
    ]));
    expect(tagsFor(FRIEND)).toEqual(expect.arrayContaining([`user:${FRIEND}:dms`, `dm-group:${GROUP}`]));
    expect(tagsFor(CIRCLEMATE)).toEqual(expect.arrayContaining([`circle:${CIRCLE}`, `circle:${CIRCLE}:members`, `user:${GONE}:circles`]));
  });

  it('never fails the status change it reports', async () => {
    mockQuery.mockRejectedValue(new Error('pool closed'));
    await expect(fanoutAccountStatusChange(GONE)).resolves.toBeUndefined();
  });
});
