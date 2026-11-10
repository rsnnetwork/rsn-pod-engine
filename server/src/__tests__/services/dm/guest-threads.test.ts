// ─── No path pulls an event guest into a message thread or rings their bell with a message (Part 2, Task 3) ──
//
// Fix round 1, review Important 2. canMessage already refuses a guest; these are the writers that skip it:
// group chats (started from an event, custom, the pod chat and its sync), the group bell and the direct message bell.
// Each is asked here what it sends; the read-only probe runs the same SQL on Postgres (task report). The post-event
// broadcast is in post-event-message/service.test.ts and worker.test.ts.

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockClientQuery(sql, params) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: jest.fn(async () => false), __esModule: true }));
jest.mock('../../../realtime/emit', () => ({ emitEntities: jest.fn(async () => undefined), getRealtimeIo: () => null, __esModule: true }));
jest.mock('../../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendBell: jest.fn(async () => true), shouldSendEmail: jest.fn(async () => false), __esModule: true,
}));
jest.mock('../../../services/email/email.service');
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));

import { UserRole } from '@rsn/shared';
import {
  createCustomGroup, createGroupFromEvent, ensurePodGroup, eventGroupCandidates, sendGroupMessage, syncPodMember,
} from '../../../services/dm/group.service';
import { broadcastDmMessage } from '../../../services/orchestration/handlers/dm-handlers';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const MEMBERS_ONLY = /u\.account_kind = 'member'/;
const sqls = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => flat(sql));
const ORGANISER = '0a000000-0000-4000-8000-000000000001';
const EVENT = '0e000000-0000-4000-8000-000000000001';
const GUEST = '9e570000-0000-4000-8000-000000000001';

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('group chats hold members only', () => {
  it('a group started from an event takes the people who took part who are members', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/FROM sessions s/.test(flat(sql))) return { rows: [{ status: 'completed', title: 'E', host_user_id: ORGANISER, is_cohost: false, is_pod_organiser: false }] };
      return { rows: [], rowCount: 0 };
    });
    await createGroupFromEvent({ userId: ORGANISER, role: UserRole.MEMBER }, EVENT, {}).catch(() => undefined);
    const tookPart = sqls(mockClientQuery).find((s) => /FROM session_participants sp JOIN users u/.test(s))!;
    expect(tookPart).toMatch(MEMBERS_ONLY);
  });

  it('a guest named for a group from an event is refused as someone who did not take part, and nothing is written', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      const s = flat(sql);
      if (/FROM sessions s/.test(s)) return { rows: [{ status: 'completed', title: 'E', host_user_id: ORGANISER, is_cohost: false, is_pod_organiser: false }] };
      if (/FROM session_participants sp JOIN users u/.test(s)) return { rows: [] }; // the guest is not read as taking part
      if (/SELECT id, display_name, status FROM users/.test(s)) return { rows: [{ id: GUEST, display_name: 'Gia', status: 'active' }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(createGroupFromEvent({ userId: ORGANISER, role: UserRole.MEMBER }, EVENT, { memberIds: [GUEST, 'x', 'y'] }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(sqls(mockClientQuery).some((s) => /INSERT INTO dm_group/.test(s))).toBe(false);
  });

  it('the picker lists members only', async () => {
    mockQuery.mockImplementation(async (sql: string) => (
      /FROM sessions s/.test(flat(sql))
        ? { rows: [{ status: 'completed', title: 'E', host_user_id: ORGANISER, is_cohost: false, is_pod_organiser: false }] }
        : { rows: [] }
    ));
    await eventGroupCandidates({ userId: ORGANISER, role: UserRole.MEMBER }, EVENT);
    expect(sqls(mockQuery).find((s) => /SELECT u\.id, u\.display_name/.test(s))).toMatch(MEMBERS_ONLY);
  });

  it('a custom group refuses a guest the creator met, before anything is written', async () => {
    await expect(createCustomGroup(ORGANISER, 'Friends', [GUEST, '0b000000-0000-4000-8000-000000000002']))
      .rejects.toMatchObject({ statusCode: 403 });
    const [sql, params] = mockQuery.mock.calls.find(([s]) => /encounter_history/.test(String(s)))!;
    expect(flat(sql)).toContain("EXISTS (SELECT 1 FROM users u WHERE u.id = $3 AND u.account_kind = 'member')");
    expect(params[2]).toBe(GUEST);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('the pod chat takes members only, when it is made and when it is synced', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      const s = flat(sql);
      if (/SELECT name, created_by FROM pods/.test(s)) return { rows: [{ name: 'Pod', created_by: ORGANISER }] };
      if (/INSERT INTO dm_groups/.test(s)) return { rows: [{ id: 'g1', name: 'Pod', type: 'pod' }] };
      return { rows: [], rowCount: 0 };
    });
    await syncPodMember('pod-1', GUEST, 'add');
    expect(sqls(mockClientQuery).find((s) => /INSERT INTO dm_group_members/.test(s))).toMatch(MEMBERS_ONLY);
    expect(sqls(mockQuery).find((s) => /INSERT INTO dm_group_members/.test(s)))
      .toContain("WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.account_kind = 'member')");
    await ensurePodGroup('pod-1');
  });

  it('a group message rings members only', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      const s = flat(sql);
      if (/FROM dm_groups WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: 'g1', name: 'G', type: 'event', session_id: EVENT }] };
      if (/SELECT u\.display_name, u\.avatar_url FROM dm_group_members/.test(s)) return { rows: [{ display_name: 'Ana', avatar_url: null }] };
      if (/INSERT INTO direct_messages/.test(s)) return { rows: [{ id: 'm1', created_at: new Date() }] };
      return { rows: [], rowCount: 0 };
    });
    await sendGroupMessage('g1', ORGANISER, 'Hello all');
    expect(sqls(mockClientQuery).find((s) => /INSERT INTO notifications/.test(s))).toMatch(MEMBERS_ONLY);
  });
});

describe('the direct message bell rings members only', () => {
  const io = { to: () => ({ emit: jest.fn() }), in: () => ({ fetchSockets: async () => [] }) } as never;
  const message = {
    id: 'm1', conversationId: 'c1', fromUserId: ORGANISER, content: 'A private note', readAt: null, createdAt: new Date(),
  } as never;

  it('writes the bell only for a member, so no excerpt reaches a guest', async () => {
    await broadcastDmMessage(io, ORGANISER, GUEST, 'c1', message);
    const bell = mockQuery.mock.calls.find(([sql]) => /INSERT INTO notifications/.test(String(sql)))!;
    expect(flat(bell[0])).toContain("WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.account_kind = 'member')");
    expect(bell[1][1]).toBe(GUEST);
  });
});
