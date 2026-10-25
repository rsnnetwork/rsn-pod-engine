// ─── Module-level mocks (hoisted by jest.mock) ───────────────────────────────
// These must come before any imports that transitively load the mocked modules.

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
const mockTransaction = jest.fn<any>();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetSessionParticipants = jest.fn<any>();
jest.mock('../../../services/session/session.service', () => ({
  getSessionParticipants: (...args: unknown[]) => mockGetSessionParticipants(...args),
}));

// ─── Existing task-6 export check ────────────────────────────────────────────

import * as dm from '../../../services/dm/dm.service';
import { BroadcastBlockedError } from '../../../services/dm/broadcast-errors';
import { AppError } from '../../../middleware/errors';

describe('sendBroadcastMessage', () => {
  it('is exported and takes (from, to, content)', () => {
    expect(typeof dm.sendBroadcastMessage).toBe('function');
    expect(dm.sendBroadcastMessage.length).toBeGreaterThanOrEqual(3);
  });
});

// A broadcast skips the "have you met" gate on purpose, because the sender was authorised for the
// whole audience. It must NOT skip blocks: a block is the one thing a person says to stop hearing
// from someone. Both the template path and the organiser's-words path go through here.
describe('sendBroadcastMessage and blocks', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  /** A transaction whose client answers the two inserts a DM makes, and remembers the message text. */
  function fakeInsert(sent: string[]) {
    mockTransaction.mockImplementation(async (cb: any) => cb({
      query: jest.fn(async (sql: string, params?: any[]) => {
        if (/INSERT INTO dm_conversations/.test(sql)) return { rows: [{ id: 'conv-1' }] };
        sent.push(String(params?.[3]));
        return {
          rows: [{
            id: 'msg-1', conversation_id: 'conv-1', from_user_id: 'organiser', content: params?.[3],
            read_at: null, created_at: new Date('2026-10-26T10:00:00Z'),
            attachment_url: null, attachment_type: null, attachment_meta: null, kind: 'user', system_meta: null,
          }],
        };
      }),
    }));
  }

  it('refuses a recipient the sender has blocked, and writes nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'block-1' }] }); // areBlocked: a block exists
    const sent: string[] = [];
    fakeInsert(sent);

    await expect(dm.sendBroadcastMessage('organiser', 'recipient', 'Thanks all')).rejects.toMatchObject({
      statusCode: 403,
      message: 'You can no longer message this user',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('the refusal is a BroadcastBlockedError, so the worker can tell a block (a skip) from a fault (a failure)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'block-1' }] });
    fakeInsert([]);

    const refusal = await dm.sendBroadcastMessage('organiser', 'recipient', 'Thanks all').catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(BroadcastBlockedError);
    expect(refusal).toBeInstanceOf(AppError); // still an ordinary 403 to anything that only knows AppError
    expect(refusal).toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });

  it('refuses a recipient who has blocked the sender (the check reads both directions)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'block-2' }] });
    fakeInsert([]);

    await expect(dm.sendBroadcastMessage('organiser', 'recipient', 'Thanks all')).rejects.toMatchObject({ statusCode: 403 });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/blocker_id = \$1 AND blocked_id = \$2/);
    expect(String(sql)).toMatch(/blocker_id = \$2 AND blocked_id = \$1/);
    expect(params).toEqual(['organiser', 'recipient']);
  });

  it('still sends to someone who blocked nobody, with no "have you met" check', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // areBlocked: no block
    const sent: string[] = [];
    fakeInsert(sent);

    const result = await dm.sendBroadcastMessage('organiser', 'recipient', '  Thanks all  ');

    expect(result.conversationId).toBe('conv-1');
    expect(sent).toEqual(['Thanks all']);
    // The block lookup is the only query: no encounter_history, no thread count, no role lookup.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('still rejects a message to yourself and an empty message before it looks anything up', async () => {
    await expect(dm.sendBroadcastMessage('a', 'a', 'hi')).rejects.toMatchObject({ statusCode: 400 });
    await expect(dm.sendBroadcastMessage('a', 'b', '   ')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a fake participant row matching the shape getSessionParticipants returns */
function makeParticipant(
  userId: string,
  opts: {
    joinedAt?: Date | null;
    leftAt?: Date | null;
    roundsCompleted?: number;
    displayName?: string;
  } = {},
) {
  return {
    userId,
    joinedAt: opts.joinedAt !== undefined ? opts.joinedAt : new Date('2024-01-01T10:00:00Z'),
    leftAt: opts.leftAt !== undefined ? opts.leftAt : null,
    roundsCompleted: opts.roundsCompleted ?? 2,
    displayName: opts.displayName ?? `User ${userId}`,
    email: `${userId}@test.com`,
    status: 'attended',
  };
}

// ─── assembleRecipients ───────────────────────────────────────────────────────

describe('assembleRecipients', () => {
  const SESSION_ID = 'session-abc';
  const HOST_ID = 'user-host';
  const ADMIN_ID = 'user-admin';
  const SUPER_ADMIN_ID = 'user-superadmin';
  const USER_STAYED = 'user-stayed';
  const USER_NO_SHOW = 'user-noshow';

  const sessionEndedAt = new Date('2024-01-01T12:00:00Z');

  beforeEach(() => {
    mockQuery.mockReset();
    mockGetSessionParticipants.mockReset();
    mockTransaction.mockReset();
  });

  it('excludes the host and admin/super_admin users; classifies remaining into correct buckets', async () => {
    // getSessionParticipants: host + admin + super_admin + 2 real participants
    mockGetSessionParticipants.mockResolvedValueOnce([
      makeParticipant(HOST_ID, { roundsCompleted: 3 }),
      makeParticipant(ADMIN_ID, { roundsCompleted: 2 }),
      makeParticipant(SUPER_ADMIN_ID, { roundsCompleted: 1 }),
      makeParticipant(USER_STAYED, { roundsCompleted: 2, leftAt: null }),
      makeParticipant(USER_NO_SHOW, { joinedAt: null, roundsCompleted: 0 }),
    ]);

    // session row query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        host_user_id: HOST_ID,
        ended_at: sessionEndedAt,
        updated_at: new Date(),
        has_matches: true,
      }],
    });

    // users-roles query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: HOST_ID,       role: 'member',      first_name: 'Host' },
        { id: ADMIN_ID,      role: 'admin',        first_name: 'Admin' },
        { id: SUPER_ADMIN_ID, role: 'super_admin', first_name: 'SuperAdmin' },
        { id: USER_STAYED,   role: 'member',       first_name: 'Stayed' },
        { id: USER_NO_SHOW,  role: 'member',       first_name: 'NoShow' },
      ],
    });

    const { assembleRecipients } = await import('../../../services/post-event-message/post-event-message.service');
    const result = await assembleRecipients(SESSION_ID);

    const ids = result.map((r) => r.userId);
    expect(ids).not.toContain(HOST_ID);
    expect(ids).not.toContain(ADMIN_ID);
    expect(ids).not.toContain(SUPER_ADMIN_ID);
    expect(ids).toContain(USER_STAYED);
    expect(ids).toContain(USER_NO_SHOW);

    const stayed = result.find((r) => r.userId === USER_STAYED);
    expect(stayed?.bucket).toBe('stayed');
    expect(stayed?.firstName).toBe('Stayed');

    const noShow = result.find((r) => r.userId === USER_NO_SHOW);
    expect(noShow?.bucket).toBe('no_show');
  });

  // The classification fix applies to the template path too. A video meeting has no matches, so its
  // attendees have zero rounds; they were all put in "could_not_join" and told they "weren't able to
  // get into the conversations" (25 Oct). The evidence is the event's own match rows.
  describe('judging attendees by rounds only when the event had matches', () => {
    async function recipientsWhen(hasMatches: boolean | undefined) {
      mockGetSessionParticipants.mockResolvedValueOnce([
        makeParticipant('p-in', { roundsCompleted: 0, leftAt: sessionEndedAt }),
        makeParticipant('p-early', { roundsCompleted: 0, leftAt: new Date('2024-01-01T11:00:00Z') }),
        makeParticipant('p-out', { joinedAt: null, roundsCompleted: 0 }),
      ]);
      mockQuery.mockResolvedValueOnce({
        rows: [{ host_user_id: HOST_ID, ended_at: sessionEndedAt, updated_at: new Date(), has_matches: hasMatches }],
      });
      mockQuery.mockResolvedValueOnce({
        rows: ['p-in', 'p-early', 'p-out'].map((id) => ({ id, role: 'member', first_name: id })),
      });
      const { assembleRecipients } = await import('../../../services/post-event-message/post-event-message.service');
      return Object.fromEntries((await assembleRecipients(SESSION_ID)).map((r) => [r.userId, r.bucket]));
    }

    it('no matches: stayed, left_early and no_show, and never could_not_join', async () => {
      expect(await recipientsWhen(false)).toEqual({ 'p-in': 'stayed', 'p-early': 'left_early', 'p-out': 'no_show' });
    });

    it('matches exist: zero rounds still means could_not_join, exactly as before', async () => {
      expect(await recipientsWhen(true)).toEqual({ 'p-in': 'could_not_join', 'p-early': 'could_not_join', 'p-out': 'no_show' });
    });

    it('asks the database for the evidence in the session row query it already made', async () => {
      await recipientsWhen(false);
      const sessionQuery = mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ')).find((s) => /FROM sessions/.test(s))!;
      expect(sessionQuery).toMatch(/EXISTS \(SELECT 1 FROM matches WHERE session_id = sessions\.id\) AS has_matches/);
      expect(mockQuery).toHaveBeenCalledTimes(2); // the session row and the users: no extra round trip
    });
  });
});

// ─── previewJob ───────────────────────────────────────────────────────────────

describe('previewJob', () => {
  const SESSION_ID = 'session-preview';
  const HOST_ID = 'host-preview';

  beforeEach(() => {
    mockQuery.mockReset();
    mockGetSessionParticipants.mockReset();
    mockTransaction.mockReset();
  });

  it('returns totalRecipients and bucket counts summing to that total', async () => {
    // 3 non-excluded participants: 2 stayed, 1 no_show
    mockGetSessionParticipants.mockResolvedValueOnce([
      makeParticipant('p1', { roundsCompleted: 2 }),
      makeParticipant('p2', { roundsCompleted: 2 }),
      makeParticipant('p3', { joinedAt: null, roundsCompleted: 0 }),
    ]);

    const endedAt = new Date('2024-01-01T12:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{
        host_user_id: HOST_ID,
        ended_at: endedAt,
        updated_at: new Date(),
        title: 'Preview Test',
      }],
    });

    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'p1', role: 'member', first_name: 'P1' },
        { id: 'p2', role: 'member', first_name: 'P2' },
        { id: 'p3', role: 'member', first_name: 'P3' },
      ],
    });

    const { previewJob } = await import('../../../services/post-event-message/post-event-message.service');
    const result = await previewJob(SESSION_ID);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.totalRecipients).toBe(3);

    const bucketSum = result.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(bucketSum).toBe(3);

    const stayedBucket = result.buckets.find((b) => b.bucket === 'stayed');
    expect(stayedBucket?.count).toBe(2);

    const noShowBucket = result.buckets.find((b) => b.bucket === 'no_show');
    expect(noShowBucket?.count).toBe(1);
  });
});

// ─── createJob ────────────────────────────────────────────────────────────────

describe('createJob', () => {
  const SESSION_ID = 'session-create';
  const HOST_ID = 'host-create';
  const CREATOR_ID = 'user-creator';

  beforeEach(() => {
    mockQuery.mockReset();
    mockGetSessionParticipants.mockReset();
    mockTransaction.mockReset();
  });

  it('throws AppError 409 when the transaction throws a 23505 unique-violation', async () => {
    // assembleRecipients mocks
    mockGetSessionParticipants.mockResolvedValueOnce([
      makeParticipant('p1', { roundsCompleted: 2 }),
    ]);
    const endedAt = new Date('2024-01-01T12:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{
        host_user_id: HOST_ID,
        ended_at: endedAt,
        updated_at: new Date(),
        title: 'Create Test',
      }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', role: 'member', first_name: 'P1' }],
    });

    // already-sent query: nobody already sent
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // transaction throws 23505
    const pgUniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockTransaction.mockRejectedValueOnce(pgUniqueViolation);

    const { createJob } = await import('../../../services/post-event-message/post-event-message.service');

    await expect(createJob(SESSION_ID, CREATOR_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('filters out already-sent users and inserts only the remainder', async () => {
    const ALREADY_SENT_ID = 'user-already-sent';
    const NEW_USER_ID = 'user-new';

    // assembleRecipients mocks: 2 participants
    mockGetSessionParticipants.mockResolvedValueOnce([
      makeParticipant(ALREADY_SENT_ID, { roundsCompleted: 2 }),
      makeParticipant(NEW_USER_ID, { roundsCompleted: 2 }),
    ]);
    const endedAt = new Date('2024-01-01T12:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{
        host_user_id: HOST_ID,
        ended_at: endedAt,
        updated_at: new Date(),
        title: 'Create Test 2',
      }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: ALREADY_SENT_ID, role: 'member', first_name: 'AlreadySent' },
        { id: NEW_USER_ID,     role: 'member', first_name: 'New' },
      ],
    });

    // already-sent query returns ALREADY_SENT_ID
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: ALREADY_SENT_ID }] });

    // Verify the already-sent query targets status = 'sent'
    // (asserted below after run)

    // Build fake transaction: captures INSERT calls
    const insertedUserIds: string[] = [];
    let jobInsertCalled = false;

    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const fakeClient = {
        query: jest.fn(async (sql: string, params?: any[]) => {
          if (/INSERT INTO post_event_message_jobs/.test(sql)) {
            jobInsertCalled = true;
            return {
              rows: [{
                id: 'job-uuid-1',
                session_id: SESSION_ID,
                created_by: CREATOR_ID,
                status: 'pending',
                total_recipients: 1,
                sent_count: 0,
                failed_count: 0,
                error: null,
                created_at: new Date(),
                started_at: null,
                completed_at: null,
              }],
            };
          }
          if (/INSERT INTO post_event_message_recipients/.test(sql)) {
            // params: [job_id, user_id, bucket]
            if (params) insertedUserIds.push(params[1] as string);
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };
      return cb(fakeClient);
    });

    const { createJob } = await import('../../../services/post-event-message/post-event-message.service');
    const job = await createJob(SESSION_ID, CREATOR_ID);

    // Already-sent user should NOT be inserted
    expect(insertedUserIds).not.toContain(ALREADY_SENT_ID);
    expect(insertedUserIds).toContain(NEW_USER_ID);

    // total_recipients should be 1 (only new user)
    expect(job.totalRecipients).toBe(1);
    expect(job.id).toBe('job-uuid-1');
    expect(jobInsertCalled).toBe(true);

    // Assert the already-sent query used status = 'sent'
    const alreadySentCall = mockQuery.mock.calls.find(
      (call) => /status\s*=\s*'sent'/.test(String(call[0])),
    );
    expect(alreadySentCall).toBeDefined();
  });
});

// ─── getLatestJob ─────────────────────────────────────────────────────────────

describe('getLatestJob', () => {
  const SESSION_ID = 'session-latest';

  beforeEach(() => {
    mockQuery.mockReset();
    mockGetSessionParticipants.mockReset();
    mockTransaction.mockReset();
  });

  it('returns null when no job exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { getLatestJob } = await import('../../../services/post-event-message/post-event-message.service');
    const result = await getLatestJob(SESSION_ID);

    expect(result).toBeNull();
  });

  it('returns a mapped PostEventMessageJob when a row exists', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'job-xyz',
        session_id: SESSION_ID,
        status: 'completed',
        total_recipients: 5,
        sent_count: 4,
        failed_count: 1,
        created_at: now,
        completed_at: now,
      }],
    });

    const { getLatestJob } = await import('../../../services/post-event-message/post-event-message.service');
    const result = await getLatestJob(SESSION_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('job-xyz');
    expect(result?.sessionId).toBe(SESSION_ID);
    expect(result?.status).toBe('completed');
    expect(result?.totalRecipients).toBe(5);
    expect(result?.sentCount).toBe(4);
    expect(result?.failedCount).toBe(1);
    expect(typeof result?.createdAt).toBe('string');
    expect(result?.completedAt).toBe(now.toISOString());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Version 2 (26 Oct 2026): the organiser writes the message
// ═════════════════════════════════════════════════════════════════════════════

const SERVICE = '../../../services/post-event-message/post-event-message.service';

interface PersonRow {
  user_id: string;
  account_status?: string;
  blocked?: boolean;
}
interface ParticipantRow extends PersonRow {
  status?: string;
  joined_at?: Date | null;
  left_at?: Date | null;
  rounds_completed?: number;
}

const ENDED = new Date('2026-10-25T12:00:00Z');
const JOINED = new Date('2026-10-25T11:00:00Z');

function participant(user_id: string, over: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    user_id, account_status: 'active', blocked: false,
    status: 'left', joined_at: JOINED, left_at: ENDED, rounds_completed: 0,
    ...over,
  };
}

/**
 * Answer the three reads the v2 recipient plan makes, by what they ask:
 * the event, its participants (with blocks and account status joined on), and the host as a person.
 */
function planWorld(world: {
  host?: string | null;
  hasMatches?: boolean;
  participants?: ParticipantRow[];
  hostPerson?: PersonRow | null;
}) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/FROM sessions WHERE id = \$1/.test(s) && /has_matches/.test(s)) {
      return { rows: [{ host_user_id: world.host ?? null, ended_at: ENDED, updated_at: ENDED, has_matches: world.hasMatches ?? false }] };
    }
    if (/FROM session_participants sp/.test(s)) return { rows: world.participants ?? [] };
    if (/FROM users u WHERE u\.id = \$1/.test(s)) return { rows: world.hostPerson ? [world.hostPerson] : [] };
    throw new Error(`unexpected query: ${s}`);
  });
}

describe('assembleRecipientsV2: who a message from this sender would reach', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockGetSessionParticipants.mockReset();
  });

  it('the Claus case: the host sends, and the one other attendee, a super_admin, is a recipient', async () => {
    planWorld({ host: 'claus', participants: [participant('stefan')] });
    const { assembleRecipientsV2 } = await import(SERVICE);

    const plan = await assembleRecipientsV2('s1', 'claus');

    expect(plan).toEqual([
      { userId: 'stefan', bucket: 'stayed', kind: 'took_part', skip: null },
    ]);
  });

  it('never looks at the account role: admins and super_admins are recipients like anyone', async () => {
    planWorld({ host: 'claus', participants: [participant('a'), participant('b')] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    await assembleRecipientsV2('s1', 'claus');
    for (const call of mockQuery.mock.calls) expect(String(call[0])).not.toMatch(/\brole\b/);
  });

  it('the host is left out when the host is the one sending', async () => {
    planWorld({ host: 'claus', participants: [participant('claus'), participant('p1')] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    const ids = (await assembleRecipientsV2('s1', 'claus')).map((r: { userId: string }) => r.userId);
    expect(ids).toEqual(['p1']);
  });

  it('the sender is never a recipient, even if the read hands them back', async () => {
    planWorld({ host: 'someone', participants: [participant('me'), participant('p1')], hostPerson: { user_id: 'someone' } });
    const { assembleRecipientsV2 } = await import(SERVICE);
    const ids = (await assembleRecipientsV2('s1', 'me')).map((r: { userId: string }) => r.userId);
    expect(ids).not.toContain('me');
  });

  it('the host is added when someone else sends, even though the host has no participant row', async () => {
    planWorld({
      host: 'claus',
      participants: [participant('p1')],
      hostPerson: { user_id: 'claus', account_status: 'active', blocked: false },
    });
    const { assembleRecipientsV2 } = await import(SERVICE);

    const plan = await assembleRecipientsV2('s1', 'stefan');

    expect(plan.find((r: { userId: string }) => r.userId === 'claus')).toEqual({
      userId: 'claus', bucket: 'stayed', kind: 'took_part', skip: null,
    });
    expect(plan.map((r: { userId: string }) => r.userId).sort()).toEqual(['claus', 'p1']);
  });

  it('the host is counted once when they are also a participant, and counted as having taken part even if they never joined', async () => {
    planWorld({ host: 'claus', participants: [participant('claus', { joined_at: null, left_at: null, status: 'registered' })] });
    const { assembleRecipientsV2 } = await import(SERVICE);

    const plan = await assembleRecipientsV2('s1', 'stefan');

    expect(plan).toEqual([{ userId: 'claus', bucket: 'stayed', kind: 'took_part', skip: null }]);
    // Already on the list, so the host is not looked up a second time.
    expect(mockQuery.mock.calls.some((c) => /FROM users u WHERE u\.id = \$1/.test(String(c[0])))).toBe(false);
  });

  it('a registered person who never joined is a no-show; a person who joined took part', async () => {
    planWorld({
      host: 'claus',
      participants: [participant('came'), participant('away', { joined_at: null, left_at: null, status: 'registered' })],
    });
    const { assembleRecipientsV2 } = await import(SERVICE);
    const plan = await assembleRecipientsV2('s1', 'claus');
    expect(plan.find((r: { userId: string }) => r.userId === 'came')).toMatchObject({ kind: 'took_part', bucket: 'stayed' });
    expect(plan.find((r: { userId: string }) => r.userId === 'away')).toMatchObject({ kind: 'no_show', bucket: 'no_show' });
  });

  it('a blocked pair, in either direction, is planned but skipped', async () => {
    planWorld({ host: 'claus', participants: [participant('blocked-pair', { blocked: true }), participant('fine')] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    const plan = await assembleRecipientsV2('s1', 'claus');
    expect(plan.find((r: { userId: string }) => r.userId === 'blocked-pair')).toMatchObject({ skip: 'blocked' });
    expect(plan.find((r: { userId: string }) => r.userId === 'fine')).toMatchObject({ skip: null });
  });

  it.each(['deactivated', 'suspended', 'banned'])('a %s account is planned but skipped', async (account_status) => {
    planWorld({ host: 'claus', participants: [participant('gone', { account_status })] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    expect((await assembleRecipientsV2('s1', 'claus'))[0]).toMatchObject({ userId: 'gone', skip: 'inactive' });
  });

  it('a closed account that is also blocked is skipped as closed: there is no one to message', async () => {
    planWorld({ host: 'claus', participants: [participant('gone', { account_status: 'deactivated', blocked: true })] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    expect((await assembleRecipientsV2('s1', 'claus'))[0].skip).toBe('inactive');
  });

  it('a blocked or closed HOST is skipped too, when someone else sends', async () => {
    planWorld({ host: 'claus', participants: [], hostPerson: { user_id: 'claus', account_status: 'deactivated' } });
    const { assembleRecipientsV2 } = await import(SERVICE);
    expect((await assembleRecipientsV2('s1', 'stefan'))[0]).toMatchObject({ userId: 'claus', skip: 'inactive' });
  });

  it('a host who no longer exists is simply not a recipient', async () => {
    planWorld({ host: 'claus', participants: [participant('p1')], hostPerson: null });
    const { assembleRecipientsV2 } = await import(SERVICE);
    expect((await assembleRecipientsV2('s1', 'stefan')).map((r: { userId: string }) => r.userId)).toEqual(['p1']);
  });

  it('reads blocks and account status in the same query as the participants, parameterised, never the removed', async () => {
    planWorld({ host: 'claus', participants: [participant('p1')] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    await assembleRecipientsV2('s1', 'claus');

    const [sql, params] = mockQuery.mock.calls.find((c) => /FROM session_participants sp/.test(String(c[0])))! as [string, unknown[]];
    expect(params).toEqual(['s1', 'claus']);
    expect(sql).not.toContain('claus');
    expect(sql).toMatch(/user_blocks/);
    expect(sql.replace(/\s+/g, ' ')).toMatch(/\(b\.blocker_id = \$2 AND b\.blocked_id = sp\.user_id\)/);
    expect(sql.replace(/\s+/g, ' ')).toMatch(/\(b\.blocker_id = sp\.user_id AND b\.blocked_id = \$2\)/);
    expect(sql).toMatch(/sp\.user_id <> \$2/);
    expect(sql).toMatch(/sp\.status <> 'removed'/); // someone the organiser removed is not messaged
  });

  it('no matches: a video meeting\'s attendees are judged by presence, never by rounds', async () => {
    planWorld({
      host: 'claus', hasMatches: false,
      participants: [
        participant('in', { rounds_completed: 0 }),
        participant('early', { rounds_completed: 0, left_at: new Date('2026-10-25T11:10:00Z') }),
      ],
    });
    const { assembleRecipientsV2 } = await import(SERVICE);
    const buckets = Object.fromEntries(
      (await assembleRecipientsV2('s1', 'claus')).map((r: { userId: string; bucket: string }) => [r.userId, r.bucket]),
    );
    expect(buckets).toEqual({ in: 'stayed', early: 'left_early' });
  });

  it('matches exist: zero rounds is could_not_join, as for speed networking always', async () => {
    planWorld({ host: 'claus', hasMatches: true, participants: [participant('in', { rounds_completed: 0 })] });
    const { assembleRecipientsV2 } = await import(SERVICE);
    expect((await assembleRecipientsV2('s1', 'claus'))[0].bucket).toBe('could_not_join');
  });
});

describe('countAudience', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetSessionParticipants.mockReset();
  });

  it('counts the people the send would reach, split into those who took part and those who never came', async () => {
    planWorld({
      host: 'claus',
      participants: [
        participant('a'), participant('b'),
        participant('n1', { joined_at: null, left_at: null, status: 'registered' }),
      ],
    });
    const { countAudience } = await import(SERVICE);
    expect(await countAudience('s1', 'claus')).toEqual({ tookPart: 2, registeredNoShow: 1 });
  });

  it('does not count people it would skip, so the sender is never told someone blocked them', async () => {
    planWorld({
      host: 'claus',
      participants: [
        participant('a'),
        participant('blocked', { blocked: true }),
        participant('closed', { account_status: 'deactivated' }),
        participant('away-blocked', { joined_at: null, left_at: null, status: 'registered', blocked: true }),
      ],
    });
    const { countAudience } = await import(SERVICE);
    expect(await countAudience('s1', 'claus')).toEqual({ tookPart: 1, registeredNoShow: 0 });
  });

  it('counts the host for anyone but the host', async () => {
    planWorld({ host: 'claus', participants: [], hostPerson: { user_id: 'claus', account_status: 'active' } });
    const { countAudience } = await import(SERVICE);
    expect(await countAudience('s1', 'stefan')).toEqual({ tookPart: 1, registeredNoShow: 0 });
    expect(await countAudience('s1', 'claus')).toEqual({ tookPart: 0, registeredNoShow: 0 });
  });
});

// ─── createJobV2 ──────────────────────────────────────────────────────────────

interface Captured {
  jobParams?: unknown[];
  recipientParams?: unknown[];
  statements: string[];
}

/** A transaction that answers the two inserts a v2 job makes and remembers what they were given. */
function captureTransaction(captured: Captured, jobRow: Record<string, unknown> = {}) {
  mockTransaction.mockImplementation(async (cb: any) => cb({
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.statements.push(sql.replace(/\s+/g, ' '));
      if (/INSERT INTO post_event_message_jobs/.test(sql)) {
        captured.jobParams = params;
        return {
          rows: [{
            id: 'job-v2', session_id: 's1', created_by: 'claus', status: 'pending',
            total_recipients: params?.[2], sent_count: 0, failed_count: 0, error: null,
            created_at: new Date('2026-10-25T12:05:00Z'), started_at: null, completed_at: null,
            ...jobRow,
          }],
        };
      }
      if (/INSERT INTO post_event_message_recipients/.test(sql)) {
        captured.recipientParams = params;
        return { rows: [] };
      }
      return { rows: [] };
    }),
  }));
}

describe('createJobV2', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockGetSessionParticipants.mockReset();
  });

  const send = { body: 'Thank you all for coming. The recording is on its way.', includeNoShows: false };

  it('stores the organiser\'s words and the audience choice on the job, and counts only the people it will message', async () => {
    planWorld({
      host: 'claus',
      participants: [participant('a'), participant('b'), participant('blocked', { blocked: true })],
    });
    const captured: Captured = { statements: [] };
    captureTransaction(captured);
    const { createJobV2 } = await import(SERVICE);

    const job = await createJobV2('s1', 'claus', send);

    // [session, creator, total, body, includeNoShows]
    expect(captured.jobParams).toEqual(['s1', 'claus', 2, send.body, false]);
    expect(job).toMatchObject({ id: 'job-v2', status: 'pending', totalRecipients: 2, sentCount: 0, failedCount: 0 });
  });

  it('writes one row per person in ONE statement: pending for those it will message, skipped (with the reason) for the rest', async () => {
    planWorld({
      host: 'claus',
      participants: [
        participant('a'),
        participant('blocked', { blocked: true }),
        participant('closed', { account_status: 'deactivated' }),
      ],
    });
    const captured: Captured = { statements: [] };
    captureTransaction(captured);
    const { createJobV2 } = await import(SERVICE);

    await createJobV2('s1', 'claus', send);

    const recipientInserts = captured.statements.filter((s) => /INSERT INTO post_event_message_recipients/.test(s));
    expect(recipientInserts).toHaveLength(1);
    // [job, user ids, buckets, statuses, errors]
    const [jobId, ids, buckets, statuses, errors] = captured.recipientParams as [string, string[], string[], string[], Array<string | null>];
    expect(jobId).toBe('job-v2');
    expect(ids).toEqual(['a', 'blocked', 'closed']);
    expect(buckets).toEqual(['stayed', 'stayed', 'stayed']);
    expect(statuses).toEqual(['pending', 'skipped', 'skipped']);
    expect(errors).toEqual([null, 'blocked', 'inactive']);
  });

  it('does not message the people who never came unless asked, and does not even list them', async () => {
    planWorld({
      host: 'claus',
      participants: [participant('a'), participant('away', { joined_at: null, left_at: null, status: 'registered' })],
    });
    const captured: Captured = { statements: [] };
    captureTransaction(captured);
    const { createJobV2 } = await import(SERVICE);

    await createJobV2('s1', 'claus', { ...send, includeNoShows: false });

    expect((captured.recipientParams as unknown[][])[1]).toEqual(['a']);
    expect(captured.jobParams?.[2]).toBe(1);
  });

  it('messages the people who never came when asked', async () => {
    planWorld({
      host: 'claus',
      participants: [participant('a'), participant('away', { joined_at: null, left_at: null, status: 'registered' })],
    });
    const captured: Captured = { statements: [] };
    captureTransaction(captured);
    const { createJobV2 } = await import(SERVICE);

    await createJobV2('s1', 'claus', { ...send, includeNoShows: true });

    expect((captured.recipientParams as unknown[][])[1]).toEqual(['a', 'away']);
    expect((captured.recipientParams as unknown[][])[2]).toEqual(['stayed', 'no_show']);
    expect(captured.jobParams).toEqual(['s1', 'claus', 2, send.body, true]);
  });

  it('every send is a new message: it never filters out people an earlier job already reached', async () => {
    planWorld({ host: 'claus', participants: [participant('a')] });
    captureTransaction({ statements: [] });
    const { createJobV2 } = await import(SERVICE);

    await createJobV2('s1', 'claus', send);

    for (const call of mockQuery.mock.calls) expect(String(call[0])).not.toMatch(/status\s*=\s*'sent'/);
  });

  it('refuses, writing nothing, when nobody would be messaged: the only other attendee blocked the sender', async () => {
    planWorld({ host: 'claus', participants: [participant('a', { blocked: true })] });
    const { createJobV2 } = await import(SERVICE);

    await expect(createJobV2('s1', 'claus', send)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Nobody else took part in this event.',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('refuses when only people who never came exist and they were not asked for', async () => {
    planWorld({ host: 'claus', participants: [participant('away', { joined_at: null, left_at: null, status: 'registered' })] });
    const { createJobV2 } = await import(SERVICE);
    await expect(createJobV2('s1', 'claus', { ...send, includeNoShows: false })).rejects.toMatchObject({ statusCode: 409 });
  });

  describe('two sends at once: the unique active-job index lets one through', () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

    function lostTheRace(activeCreator: string | null) {
      planWorld({ host: 'claus', participants: [participant('a')] });
      mockTransaction.mockRejectedValueOnce(uniqueViolation);
      const base = mockQuery.getMockImplementation()!;
      mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
        if (/status IN \('pending', 'processing'\)/.test(String(sql).replace(/\s+/g, ' '))) {
          return { rows: activeCreator ? [{ created_by: activeCreator }] : [] };
        }
        return base(sql, params);
      });
    }

    it('another organiser got there first: told plainly, with a 409', async () => {
      lostTheRace('stefan');
      const { createJobV2 } = await import(SERVICE);
      await expect(createJobV2('s1', 'claus', send)).rejects.toMatchObject({
        statusCode: 409,
        message: "Another organiser's message is being sent; try again in a minute.",
      });
    });

    it('the same person pressed twice: told it is their own message that is going out', async () => {
      lostTheRace('claus');
      const { createJobV2 } = await import(SERVICE);
      await expect(createJobV2('s1', 'claus', send)).rejects.toMatchObject({
        statusCode: 409,
        message: 'Your message is already being sent.',
      });
    });

    it('the other send had finished by the time we looked: still a 409, never a 500', async () => {
      lostTheRace(null);
      const { createJobV2 } = await import(SERVICE);
      await expect(createJobV2('s1', 'claus', send)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('any other database error is not disguised as a conflict', async () => {
      planWorld({ host: 'claus', participants: [participant('a')] });
      mockTransaction.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
      const { createJobV2 } = await import(SERVICE);
      await expect(createJobV2('s1', 'claus', send)).rejects.toThrow('connection lost');
    });
  });
});

describe('conflictForActiveSend', () => {
  beforeEach(() => mockQuery.mockReset());

  it('says whose message is going out, from the job row', async () => {
    const { conflictForActiveSend } = await import(SERVICE);
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'claus' }] });
    expect((await conflictForActiveSend('s1', 'claus')).message).toBe('Your message is already being sent.');
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'stefan' }] });
    expect((await conflictForActiveSend('s1', 'claus')).message)
      .toBe("Another organiser's message is being sent; try again in a minute.");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect((await conflictForActiveSend('s1', 'claus')).statusCode).toBe(409);
  });
});

describe('createJob (version 1) is untouched', () => {
  it('still reads who was already sent to, and still inserts one recipient row at a time', async () => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockGetSessionParticipants.mockReset();
    mockGetSessionParticipants.mockResolvedValueOnce([makeParticipant('p1'), makeParticipant('p2')]);
    mockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'h', ended_at: ENDED, updated_at: ENDED, has_matches: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', role: 'member', first_name: 'P1' }, { id: 'p2', role: 'member', first_name: 'P2' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'p2' }] }); // p2 was already sent to

    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    mockTransaction.mockImplementationOnce(async (cb: any) => cb({
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params });
        if (/INSERT INTO post_event_message_jobs/.test(sql)) {
          return { rows: [{ id: 'job-v1', session_id: 's1', status: 'pending', total_recipients: 1, sent_count: 0, failed_count: 0, created_at: ENDED, completed_at: null }] };
        }
        return { rows: [] };
      }),
    }));

    const { createJob } = await import(SERVICE);
    await createJob('s1', 'admin');

    const jobInsert = statements.find((s) => /INSERT INTO post_event_message_jobs/.test(s.sql))!;
    expect(jobInsert.params).toEqual(['s1', 'admin', 1]); // no body, no audience choice: a template job
    expect(jobInsert.sql).not.toMatch(/\bbody\b/);
    const rows = statements.filter((s) => /INSERT INTO post_event_message_recipients/.test(s.sql));
    expect(rows.map((r) => r.params?.[1])).toEqual(['p1']);
  });
});
