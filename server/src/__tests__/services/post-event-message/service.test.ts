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

describe('sendBroadcastMessage', () => {
  it('is exported and takes (from, to, content)', () => {
    expect(typeof dm.sendBroadcastMessage).toBe('function');
    expect(dm.sendBroadcastMessage.length).toBeGreaterThanOrEqual(3);
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
        title: 'Test Event',
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
