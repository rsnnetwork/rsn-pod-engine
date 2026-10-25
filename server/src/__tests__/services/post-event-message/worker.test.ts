// ─── Post-event message worker tests ─────────────────────────────────────────
//
// Verifies the core behaviours of processPendingJobs:
//   1. Happy path — 3 pending recipients → all sent, job finalized 'completed'
//   2. Partial failure — 2nd recipient throws → marked failed, others sent,
//      job finalized 'completed_with_errors'
//   3. Resumability — the recipients SELECT only queries rows with status='pending'
// and, from 26 Oct 2026 (message everyone v2):
//   4. A job with a body sends that body verbatim, with the organiser's own bell title;
//      a job without one still sends the template, with the bell it always had
//   5. A recipient who is blocked or whose account is closed is skipped, not failed
//   6. The people running the event are told, after each batch and at the end, that the send moved on

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

const mockEmitEntities = jest.fn<any>();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
}));

const mockResolveOrganisers = jest.fn<any>();
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: (...args: unknown[]) => mockResolveOrganisers(...args),
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

interface RecipientFixture {
  id: string;
  user_id: string;
  bucket: string;
  first_name: string;
  account_status?: string;
  blocked?: boolean;
}

/** A recipient as the batch query returns them: an active account nobody has blocked, unless said otherwise. */
function recipient(over: Partial<RecipientFixture> & Pick<RecipientFixture, 'id' | 'user_id'>): RecipientFixture {
  return { bucket: 'stayed', first_name: over.user_id, account_status: 'active', blocked: false, ...over };
}

/**
 * Route query calls by SQL content rather than strict call order.
 * Registers a mockImplementation that inspects the SQL string and picks
 * the right response so test code doesn't have to count every DB round-trip.
 */
function setupRouteBySQL(opts: {
  job: { id: string; session_id: string; created_by: string; body?: string | null } | null;
  sessionRow: { title: string; ended_at: Date | null; scheduled_at: Date };
  senderRow: { first_name: string; display_name: string };
  /** First batch of pending recipients. Return [] on the second call. */
  recipientRows: RecipientFixture[];
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

    // Recipient status UPDATE (sent, failed or skipped)
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

const sessionRow = {
  title: 'Test Event',
  ended_at: new Date('2026-05-27T18:00:00Z'),
  scheduled_at: new Date('2026-05-27T17:00:00Z'),
};
const senderRow = { first_name: 'Stefan', display_name: 'Stefan Host' };

/** The SQL (squeezed to one line) and parameters of every query that contains `needle`. */
function callsMatching(needle: string | RegExp): Array<{ sql: string; params: unknown[] }> {
  return mockQuery.mock.calls
    .map((c: unknown[]) => ({ sql: String(c[0]).replace(/\s+/g, ' '), params: (c[1] ?? []) as unknown[] }))
    .filter((c: { sql: string }) => (typeof needle === 'string' ? c.sql.includes(needle) : needle.test(c.sql)));
}

/** Every recipient row the worker wrote as skipped, as its [status, error, id] parameters. */
function skippedWrites() {
  return callsMatching(/UPDATE post_event_message_recipients SET status='skipped'/);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('processPendingJobs', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSendBroadcastMessage.mockReset();
    mockBroadcastDmMessage.mockReset();
    mockEmitEntities.mockReset();
    mockEmitEntities.mockResolvedValue(undefined);
    mockResolveOrganisers.mockReset();
    mockResolveOrganisers.mockResolvedValue([]);
  });

  // ── 1. Happy path ────────────────────────────────────────────────────────────
  it('sends to all 3 recipients and finalizes job as completed', async () => {
    const recipients = [
      recipient({ id: 'r1', user_id: 'u1', bucket: 'stayed', first_name: 'Alice' }),
      recipient({ id: 'r2', user_id: 'u2', bucket: 'left_early', first_name: 'Bob' }),
      recipient({ id: 'r3', user_id: 'u3', bucket: 'no_show', first_name: 'Carol' }),
    ];

    setupRouteBySQL({
      job: { id: 'job-1', session_id: 'sess-1', created_by: 'sender-1' },
      sessionRow,
      senderRow,
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
      recipient({ id: 'r1', user_id: 'u1', first_name: 'Alice' }),
      recipient({ id: 'r2', user_id: 'u2', first_name: 'Bob' }),
      recipient({ id: 'r3', user_id: 'u3', first_name: 'Carol' }),
    ];

    setupRouteBySQL({
      job: { id: 'job-2', session_id: 'sess-2', created_by: 'sender-1' },
      sessionRow: { title: 'Another Event', ended_at: null, scheduled_at: new Date('2026-05-28T17:00:00Z') },
      senderRow,
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

  // ── 4. The organiser's own words ─────────────────────────────────────────────
  describe('a job that carries the organiser\'s words (version 2)', () => {
    const body = 'Thank you all for coming.\n\nThe recording is on its way, and so is the next date.';

    function v2Job(extra: Partial<{ body: string | null }> = {}) {
      setupRouteBySQL({
        job: { id: 'job-v2', session_id: 'sess-v2', created_by: 'claus', body, ...extra },
        sessionRow,
        senderRow: { first_name: 'Claus', display_name: 'Claus Test' },
        recipientRows: [
          recipient({ id: 'r1', user_id: 'stefan', bucket: 'stayed', first_name: 'Stefan' }),
          recipient({ id: 'r2', user_id: 'ian', bucket: 'left_early', first_name: 'Ian' }),
          recipient({ id: 'r3', user_id: 'zoe', bucket: 'no_show', first_name: 'Zoe' }),
        ],
        finalJobRow: { failed_count: 0 },
      });
      mockSendBroadcastMessage.mockImplementation((_from: string, to: string) =>
        Promise.resolve({ message: fakeMessage(`msg-${to}`), conversationId: `conv-${to}` }));
      mockBroadcastDmMessage.mockResolvedValue(undefined);
    }

    it('sends exactly that text to everyone, whatever their bucket: no template, no greeting, no sign-off', async () => {
      v2Job();
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(3);
      for (const call of mockSendBroadcastMessage.mock.calls) {
        expect(call[0]).toBe('claus');
        expect(call[2]).toBe(body);
      }
      const sentText = mockSendBroadcastMessage.mock.calls.map((c: unknown[]) => String(c[2])).join('\n');
      expect(sentText).not.toMatch(/weren't able to get into the conversations/);
      expect(sentText).not.toMatch(/Hi /);
    });

    it('rings the bell with the organiser\'s name and the event: "<name> messaged everyone from ‘<event>’"', async () => {
      v2Job();
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockBroadcastDmMessage).toHaveBeenCalledTimes(3);
      for (const call of mockBroadcastDmMessage.mock.calls) {
        expect(call[1]).toBe('claus');
        expect(call[5]).toEqual({ bellTitle: 'Claus Test messaged everyone from ‘Test Event’' });
      }
    });

    it('names the organiser by first name when they have no display name, and as "The team" when they have neither', async () => {
      v2Job();
      setupRouteBySQL({
        job: { id: 'job-v2', session_id: 'sess-v2', created_by: 'claus', body },
        sessionRow,
        senderRow: { first_name: 'Claus', display_name: '' },
        recipientRows: [recipient({ id: 'r1', user_id: 'stefan' })],
        finalJobRow: { failed_count: 0 },
      });
      mockSendBroadcastMessage.mockResolvedValue({ message: fakeMessage('m'), conversationId: 'c' });
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      expect(mockBroadcastDmMessage.mock.calls[0][5]).toEqual({ bellTitle: 'Claus messaged everyone from ‘Test Event’' });

      mockBroadcastDmMessage.mockClear();
      setupRouteBySQL({
        job: { id: 'job-v2b', session_id: 'sess-v2', created_by: 'claus', body },
        sessionRow,
        senderRow: { first_name: '', display_name: '' },
        recipientRows: [recipient({ id: 'r1', user_id: 'stefan' })],
        finalJobRow: { failed_count: 0 },
      });
      await processPendingJobs(fakeIo);
      expect(mockBroadcastDmMessage.mock.calls[0][5]).toEqual({ bellTitle: 'The team messaged everyone from ‘Test Event’' });
    });

    it('marks each as sent and the job completed', async () => {
      v2Job();
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      expect(callsMatching("status='sent'")).toHaveLength(3);
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-v2']);
    });
  });

  describe('a job without a body (version 1) is exactly what it was', () => {
    it('sends the template for the person\'s bucket, and rings the ordinary bell', async () => {
      setupRouteBySQL({
        job: { id: 'job-v1', session_id: 'sess-v1', created_by: 'sender-1', body: null },
        sessionRow,
        senderRow,
        recipientRows: [recipient({ id: 'r1', user_id: 'u1', bucket: 'could_not_join', first_name: 'Alice' })],
        finalJobRow: { failed_count: 0 },
      });
      mockSendBroadcastMessage.mockResolvedValue({ message: fakeMessage('m'), conversationId: 'c' });
      mockBroadcastDmMessage.mockResolvedValue(undefined);

      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      const text = String(mockSendBroadcastMessage.mock.calls[0][2]);
      expect(text).toContain('Hi Alice,');
      expect(text).toContain("weren't able to get into the conversations");
      expect(text).toContain('Test Event');
      expect(text).toContain('— Stefan');
      // No bell title: the DM bell says "<name> sent you a message", as it always did.
      expect(mockBroadcastDmMessage.mock.calls[0][5]).toEqual({});
    });

    it('a job row with no body column at all (an older row) is a template job too', async () => {
      setupRouteBySQL({
        job: { id: 'job-old', session_id: 'sess-v1', created_by: 'sender-1' },
        sessionRow,
        senderRow,
        recipientRows: [recipient({ id: 'r1', user_id: 'u1', bucket: 'stayed', first_name: 'Alice' })],
        finalJobRow: { failed_count: 0 },
      });
      mockSendBroadcastMessage.mockResolvedValue({ message: fakeMessage('m'), conversationId: 'c' });
      mockBroadcastDmMessage.mockResolvedValue(undefined);

      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(String(mockSendBroadcastMessage.mock.calls[0][2])).toContain('Hi Alice,');
    });

    it('picks the job with its body in the same read', async () => {
      setupRouteBySQL({
        job: { id: 'job-v1', session_id: 'sess-v1', created_by: 'sender-1', body: null },
        sessionRow, senderRow, recipientRows: [], finalJobRow: { failed_count: 0 },
      });
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      const pick = callsMatching(/FROM post_event_message_jobs WHERE status = 'pending'/).pop()!;
      expect(pick.sql).toMatch(/SELECT id, session_id, created_by, body/);
    });
  });

  // ── 5. Skipped, not failed ───────────────────────────────────────────────────
  describe('a recipient who must not be messaged any more', () => {
    function world(recipientRows: RecipientFixture[], body: string | null = 'Thank you all.') {
      setupRouteBySQL({
        job: { id: 'job-s', session_id: 'sess-s', created_by: 'claus', body },
        sessionRow,
        senderRow: { first_name: 'Claus', display_name: 'Claus Test' },
        recipientRows,
        finalJobRow: { failed_count: 0 },
      });
      mockSendBroadcastMessage.mockImplementation((_f: string, to: string) =>
        Promise.resolve({ message: fakeMessage(`msg-${to}`), conversationId: `conv-${to}` }));
      mockBroadcastDmMessage.mockResolvedValue(undefined);
    }

    it('a blocked pair is skipped: nothing is sent, the row says why, and the job is not counted as having errors', async () => {
      world([
        recipient({ id: 'r1', user_id: 'fine' }),
        recipient({ id: 'r2', user_id: 'blocked-pair', blocked: true }),
      ]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockSendBroadcastMessage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['fine']);
      expect(mockBroadcastDmMessage).toHaveBeenCalledTimes(1);
      expect(skippedWrites()).toHaveLength(1);
      expect(skippedWrites()[0].params).toEqual(['blocked', 'r2']);
      expect(callsMatching("status='failed'")).toHaveLength(0);
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-s']);
    });

    it.each(['deactivated', 'suspended', 'banned'])('a %s account is skipped, whatever its recipient row says', async (account_status) => {
      world([recipient({ id: 'r1', user_id: 'gone', account_status })]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
      expect(skippedWrites()[0].params).toEqual(['inactive', 'r1']);
    });

    it('a recipient whose account status is unknown is not messaged either (fail closed)', async () => {
      world([{ id: 'r1', user_id: 'mystery', bucket: 'stayed', first_name: 'M' }]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
      expect(skippedWrites()).toHaveLength(1);
    });

    it('takes a skipped person off the job\'s total, so "x of y" can reach y', async () => {
      world([
        recipient({ id: 'r1', user_id: 'fine' }),
        recipient({ id: 'r2', user_id: 'blocked-pair', blocked: true }),
      ]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      const decrement = callsMatching('SET total_recipients = total_recipients - 1');
      expect(decrement).toHaveLength(1);
      expect(decrement[0].params).toEqual(['job-s']);
    });

    it('applies to the template path too: a version 1 job never messages a blocked pair', async () => {
      world([recipient({ id: 'r1', user_id: 'blocked-pair', blocked: true })], null);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
      expect(skippedWrites()).toHaveLength(1);
    });

    it('reads blocks and account status in the batch query itself, for this job\'s sender, parameterised', async () => {
      world([recipient({ id: 'r1', user_id: 'fine' })]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      const batch = callsMatching(/FROM post_event_message_recipients r/).find((c) => /LIMIT 25/.test(c.sql))!;
      expect(batch.params).toEqual(['job-s', 'claus']);
      expect(batch.sql).toMatch(/u\.status AS account_status/);
      expect(batch.sql).toMatch(/\(b\.blocker_id = \$2 AND b\.blocked_id = r\.user_id\)/);
      expect(batch.sql).toMatch(/\(b\.blocker_id = r\.user_id AND b\.blocked_id = \$2\)/);
      expect(batch.sql).toMatch(/r\.status = 'pending'/);
    });

    it('a block that lands between the read and the send makes the send refuse; that one is recorded failed, and nothing was sent', async () => {
      world([recipient({ id: 'r1', user_id: 'late-blocker' })]);
      mockSendBroadcastMessage.mockRejectedValue(
        Object.assign(new Error('You can no longer message this user'), { statusCode: 403 }),
      );
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

      expect(mockBroadcastDmMessage).not.toHaveBeenCalled();
      expect(callsMatching("status='failed'")).toHaveLength(1);
    });
  });

  // ── 6. Telling the organisers it moved ───────────────────────────────────────
  describe('progress', () => {
    function world(recipientRows: RecipientFixture[]) {
      setupRouteBySQL({
        job: { id: 'job-p', session_id: 'sess-p', created_by: 'claus', body: 'Thanks' },
        sessionRow,
        senderRow: { first_name: 'Claus', display_name: 'Claus Test' },
        recipientRows,
        finalJobRow: { failed_count: 0 },
      });
      mockSendBroadcastMessage.mockResolvedValue({ message: fakeMessage('m'), conversationId: 'c' });
      mockBroadcastDmMessage.mockResolvedValue(undefined);
    }

    it('tells the sender and the people running the event after the batch and again at the end, with the event\'s tag', async () => {
      mockResolveOrganisers.mockResolvedValue(['host-1', 'director-1', 'claus']);
      world([recipient({ id: 'r1', user_id: 'a' }), recipient({ id: 'r2', user_id: 'b' })]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockResolveOrganisers).toHaveBeenCalledWith('sess-p');
      expect(mockEmitEntities).toHaveBeenCalledTimes(2); // one batch, then the end
      for (const call of mockEmitEntities.mock.calls) {
        expect(call[0]).toBe(fakeIo);
        expect(new Set(call[1] as string[])).toEqual(new Set(['host-1', 'director-1', 'claus']));
        expect(call[2]).toEqual(['session:sess-p']);
      }
    });

    it('always includes the sender, even when they are an admin with no tie to the event', async () => {
      mockResolveOrganisers.mockResolvedValue(['host-1']);
      world([recipient({ id: 'r1', user_id: 'a' })]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      expect(new Set(mockEmitEntities.mock.calls[0][1] as string[])).toEqual(new Set(['host-1', 'claus']));
    });

    it('the end is told after the job is finalised, so a screen that refetches sees it finished', async () => {
      world([recipient({ id: 'r1', user_id: 'a' })]);
      const order: string[] = [];
      const base = mockQuery.getMockImplementation()!;
      mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (/SET status = \$1, completed_at = NOW\(\)/.test(String(sql).replace(/\s+/g, ' '))) order.push('finalise');
        return base(sql, params);
      });
      mockEmitEntities.mockImplementation(async () => { order.push('emit'); });

      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(order).toEqual(['emit', 'finalise', 'emit']);
    });

    it('a job with no recipients left still tells them it finished', async () => {
      world([]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      expect(mockEmitEntities).toHaveBeenCalledTimes(1);
    });

    it('does not fail a send because the organisers could not be looked up', async () => {
      mockResolveOrganisers.mockRejectedValue(new Error('db blip'));
      world([recipient({ id: 'r1', user_id: 'a' })]);
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

      expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(1);
      expect(mockEmitEntities.mock.calls[0][1]).toEqual(['claus']); // the sender still hears
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-p']);
    });

    it('does not fail a send because a tell failed', async () => {
      world([recipient({ id: 'r1', user_id: 'a' })]);
      mockEmitEntities.mockRejectedValue(new Error('socket down'));
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-p']);
    });
  });
});
