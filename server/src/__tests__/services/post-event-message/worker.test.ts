// ─── Post-event message worker tests ─────────────────────────────────────────
//
// Verifies the three core behaviours of processPendingJobs:
//   1. Happy path — 3 pending recipients → all sent, job finalized 'completed'
//   2. Partial failure — 2nd recipient throws → marked failed, others sent,
//      job finalized 'completed_with_errors'
//   3. Resumability — the recipients SELECT only queries rows with status='pending'

import { jest } from '@jest/globals';

// ─── Module-level mocks ───────────────────────────────────────────────────────

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery, transaction: jest.fn() }));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockSendBroadcastMessage = jest.fn<any>();
jest.mock('../../../services/dm/dm.service', () => ({
  sendBroadcastMessage: (...args: unknown[]) => mockSendBroadcastMessage(...args),
}));

const mockBroadcastDmMessage = jest.fn<any>();
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  broadcastDmMessage: (...args: unknown[]) => mockBroadcastDmMessage(...args),
}));

// Redis disabled in tests — single-instance path, no locking
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => null,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fakeIo = {} as any;

/** Fake message returned by sendBroadcastMessage */
function fakeMessage(id: string) {
  return {
    id,
    conversationId: `conv-${id}`,
    fromUserId: 'sender-1',
    content: 'Hello there,\n\nTest message.',
    readAt: null,
    createdAt: new Date('2026-05-27T10:00:00Z'),
  };
}

/**
 * Route query calls by SQL content rather than strict call order.
 * Registers a mockImplementation that inspects the SQL string and picks
 * the right response so test code doesn't have to count every DB round-trip.
 */
function setupRouteBySQL(opts: {
  job: { id: string; session_id: string; created_by: string } | null;
  sessionRow: { title: string; ended_at: Date | null; scheduled_at: Date };
  senderRow: { first_name: string; display_name: string };
  /** First batch of pending recipients. Return [] on the second call. */
  recipientRows: Array<{ id: string; user_id: string; bucket: string; first_name: string }>;
  /** Final job row with failed_count to compute status */
  finalJobRow: { failed_count: number };
}) {
  let batchCallCount = 0;

  mockQuery.mockImplementation((sql: string, _params?: unknown[]) => {
    const s = String(sql);

    // Pick-job: SELECT from post_event_message_jobs WHERE status = 'pending'
    if (s.includes('post_event_message_jobs') && s.includes("status = 'pending'") && s.includes('SELECT')) {
      return Promise.resolve({ rows: opts.job ? [opts.job] : [] });
    }

    // Mark-processing: UPDATE ... SET status='processing'
    if (s.includes('post_event_message_jobs') && s.includes("status='processing'")) {
      return Promise.resolve({ rows: [] });
    }

    // Session query
    if (s.includes('sessions') && s.includes('title')) {
      return Promise.resolve({ rows: [opts.sessionRow] });
    }

    // Sender query
    if (s.includes('users') && s.includes('first_name') && s.includes('display_name') && !s.includes('post_event_message_recipients')) {
      return Promise.resolve({ rows: [opts.senderRow] });
    }

    // Recipient batch query
    if (s.includes('post_event_message_recipients') && s.includes('SELECT') && s.includes('LIMIT 25')) {
      batchCallCount += 1;
      return Promise.resolve({ rows: batchCallCount === 1 ? opts.recipientRows : [] });
    }

    // Recipient status UPDATE (sent or failed)
    if (s.includes('post_event_message_recipients') && s.includes('UPDATE')) {
      return Promise.resolve({ rows: [] });
    }

    // Final job status SELECT (re-read failed_count) — must be checked BEFORE
    // the generic UPDATE catch below, because the SELECT SQL also contains
    // 'failed_count' and would otherwise be swallowed by the UPDATE branch.
    if (s.includes('post_event_message_jobs') && s.includes('failed_count') && s.includes('SELECT')) {
      return Promise.resolve({ rows: [opts.finalJobRow] });
    }

    // Job sent_count / failed_count UPDATE (non-SELECT)
    if (s.includes('post_event_message_jobs') && (s.includes('sent_count') || s.includes('failed_count'))) {
      return Promise.resolve({ rows: [] });
    }

    // Final status UPDATE (completed / completed_with_errors / failed)
    if (s.includes('post_event_message_jobs') && s.includes('completed_at')) {
      return Promise.resolve({ rows: [] });
    }

    // Default fallback — catch-all so unrecognised SQL doesn't blow up
    return Promise.resolve({ rows: [] });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('processPendingJobs', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSendBroadcastMessage.mockReset();
    mockBroadcastDmMessage.mockReset();
  });

  // ── 1. Happy path ────────────────────────────────────────────────────────────
  it('sends to all 3 recipients and finalizes job as completed', async () => {
    const recipients = [
      { id: 'r1', user_id: 'u1', bucket: 'stayed', first_name: 'Alice' },
      { id: 'r2', user_id: 'u2', bucket: 'left_early', first_name: 'Bob' },
      { id: 'r3', user_id: 'u3', bucket: 'no_show', first_name: 'Carol' },
    ];

    setupRouteBySQL({
      job: { id: 'job-1', session_id: 'sess-1', created_by: 'sender-1' },
      sessionRow: { title: 'Test Event', ended_at: new Date('2026-05-27T18:00:00Z'), scheduled_at: new Date('2026-05-27T17:00:00Z') },
      senderRow: { first_name: 'Stefan', display_name: 'Stefan Host' },
      recipientRows: recipients,
      finalJobRow: { failed_count: 0 },
    });

    mockSendBroadcastMessage.mockImplementation((_from: string, to: string, _content: string) =>
      Promise.resolve({
        message: fakeMessage(`msg-${to}`),
        conversationId: `conv-${to}`,
      }),
    );
    mockBroadcastDmMessage.mockResolvedValue(undefined);

    const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
    await processPendingJobs(fakeIo);

    // sendBroadcastMessage called exactly 3 times
    expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(3);
    // broadcastDmMessage called exactly 3 times
    expect(mockBroadcastDmMessage).toHaveBeenCalledTimes(3);

    // Each recipient marked 'sent'
    const updateCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('post_event_message_recipients') && String(c[0]).includes("status='sent'"),
    );
    expect(updateCalls).toHaveLength(3);

    // Job finalized as 'completed' (not 'completed_with_errors')
    const finalizeCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).includes('post_event_message_jobs') &&
        String(c[0]).includes('completed_at'),
    );
    expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);
    const finalizeParams = finalizeCalls[finalizeCalls.length - 1][1] as unknown[];
    expect(finalizeParams).toContain('completed');
    expect(finalizeParams).not.toContain('completed_with_errors');
  });

  // ── 2. Partial failure ───────────────────────────────────────────────────────
  it('marks 2nd recipient failed, finalizes completed_with_errors, does not throw', async () => {
    const recipients = [
      { id: 'r1', user_id: 'u1', bucket: 'stayed', first_name: 'Alice' },
      { id: 'r2', user_id: 'u2', bucket: 'stayed', first_name: 'Bob' },
      { id: 'r3', user_id: 'u3', bucket: 'stayed', first_name: 'Carol' },
    ];

    setupRouteBySQL({
      job: { id: 'job-2', session_id: 'sess-2', created_by: 'sender-1' },
      sessionRow: { title: 'Another Event', ended_at: null, scheduled_at: new Date('2026-05-28T17:00:00Z') },
      senderRow: { first_name: 'Stefan', display_name: 'Stefan Host' },
      recipientRows: recipients,
      finalJobRow: { failed_count: 1 },
    });

    let callCount = 0;
    mockSendBroadcastMessage.mockImplementation(() => {
      callCount += 1;
      if (callCount === 2) return Promise.reject(new Error('DM send failed'));
      return Promise.resolve({
        message: fakeMessage(`msg-${callCount}`),
        conversationId: `conv-${callCount}`,
      });
    });
    mockBroadcastDmMessage.mockResolvedValue(undefined);

    const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');

    // Must NOT throw — the worker absorbs per-recipient errors
    await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

    // sendBroadcastMessage attempted for all 3 recipients
    expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(3);

    // 2 marked 'sent', 1 marked 'failed'
    const sentUpdates = mockQuery.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('post_event_message_recipients') && String(c[0]).includes("status='sent'"),
    );
    const failedUpdates = mockQuery.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('post_event_message_recipients') && String(c[0]).includes("status='failed'"),
    );
    expect(sentUpdates).toHaveLength(2);
    expect(failedUpdates).toHaveLength(1);

    // Job finalized as 'completed_with_errors'
    const finalizeCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).includes('post_event_message_jobs') &&
        String(c[0]).includes('completed_at'),
    );
    expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);
    const finalizeParams = finalizeCalls[finalizeCalls.length - 1][1] as unknown[];
    expect(finalizeParams).toContain('completed_with_errors');
  });

  // ── 3. Resumability ──────────────────────────────────────────────────────────
  it("only selects recipients with status = 'pending' — never reprocesses sent rows", async () => {
    setupRouteBySQL({
      job: { id: 'job-3', session_id: 'sess-3', created_by: 'sender-1' },
      sessionRow: { title: 'Resume Event', ended_at: new Date('2026-05-29T18:00:00Z'), scheduled_at: new Date('2026-05-29T17:00:00Z') },
      senderRow: { first_name: 'Ali', display_name: 'Ali Hamza' },
      recipientRows: [],   // zero pending — simulates a fully-resumed job
      finalJobRow: { failed_count: 0 },
    });

    mockSendBroadcastMessage.mockResolvedValue({
      message: fakeMessage('x'),
      conversationId: 'conv-x',
    });

    const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
    await processPendingJobs(fakeIo);

    // Find the recipients batch SQL call and assert it filters on 'pending'
    const recipientSelects = mockQuery.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).includes('post_event_message_recipients') &&
        String(c[0]).includes('SELECT') &&
        String(c[0]).includes('LIMIT 25'),
    );
    expect(recipientSelects.length).toBeGreaterThanOrEqual(1);
    const batchSql = String(recipientSelects[0][0]);
    expect(batchSql).toMatch(/status\s*=\s*'pending'/);

    // No sends happened
    expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
  });
});
