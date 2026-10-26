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
// and, from the review of 26 Oct (fix round 1):
//   7. A job a stopped server left "processing" is carried on once it has been silent for 5 minutes,
//      from the people still pending, without messaging anyone twice; one that is more than a day old
//      is failed instead. Either way the event can send again.
//   8. A block that lands after the batch was read makes the send refuse; that person is skipped, not failed

import { jest } from '@jest/globals';
import { BroadcastBlockedError } from '../../../services/dm/broadcast-errors';
import { CLAIM_SQL, PICK_SQL, PROBE_SQL, STALE_AFTER_MINUTES } from '../../../services/post-event-message/job-queue-sql';

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
interface JobFixture {
  id: string;
  session_id: string;
  created_by: string;
  body?: string | null;
  /** 'pending' for a new job; 'processing' for one a stopped server left half sent. Absent = pending. */
  previous_status?: 'pending' | 'processing';
  created_at?: Date;
}

function setupRouteBySQL(opts: {
  job: JobFixture | null;
  /** 'lost': another instance took the job between the pick and the claim. */
  claim?: 'won' | 'lost';
  sessionRow: { title: string; ended_at: Date | null; scheduled_at: Date };
  senderRow: { first_name: string; display_name: string };
  /** First batch of pending recipients. Return [] on the second call. */
  recipientRows: RecipientFixture[];
  /** Final job row with failed_count to compute status */
  finalJobRow: { failed_count: number };
  /** Recipients (by user id) whose message an earlier run had already written: the id of that message. */
  earlierCopies?: Record<string, string>;
}) {
  let batchCallCount = 0;

  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql).replace(/\s+/g, ' ');

    // Probe: is there any job that needs a worker? (one cheap read on every tick)
    if (/^SELECT TRUE AS exists FROM post_event_message_jobs j/.test(s)) {
      return Promise.resolve({ rows: opts.job ? [{ exists: true }] : [] });
    }

    // Claim: UPDATE post_event_message_jobs j SET status = 'processing' ... RETURNING j.id
    if (/^UPDATE post_event_message_jobs j SET status = 'processing'/.test(s)) {
      return Promise.resolve({ rows: opts.job && opts.claim !== 'lost' ? [{ id: opts.job.id }] : [] });
    }

    // Pick: SELECT j.id, j.session_id, ... FROM post_event_message_jobs j WHERE <pending or silent>
    if (/^SELECT j\.id, j\.session_id/.test(s)) {
      return Promise.resolve({ rows: opts.job ? [opts.job] : [] });
    }

    // Has an earlier run already written this person's message? (only asked when a job is being carried on)
    if (s.includes('FROM direct_messages dm')) {
      const copy = opts.earlierCopies?.[(params ?? [])[3] as string];
      return Promise.resolve({ rows: copy ? [{ id: copy }] : [] });
    }

    // Session query
    if (s.includes('FROM sessions') && s.includes('title')) {
      return Promise.resolve({ rows: [opts.sessionRow] });
    }

    // Sender query
    if (s.includes('FROM users WHERE id') && s.includes('first_name') && s.includes('display_name')) {
      return Promise.resolve({ rows: [opts.senderRow] });
    }

    // Recipient batch query
    if (s.includes('FROM post_event_message_recipients r') && s.includes('LIMIT 25')) {
      batchCallCount += 1;
      return Promise.resolve({ rows: batchCallCount === 1 ? opts.recipientRows : [] });
    }

    // Recipient status UPDATE (sent, failed or skipped)
    if (/^UPDATE post_event_message_recipients/.test(s)) {
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
      const pick = callsMatching(/^SELECT j\.id, j\.session_id/).pop()!;
      expect(pick.sql).toMatch(/SELECT j\.id, j\.session_id, j\.created_by, j\.body, /);
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

    // The batch is read once for up to 25 people, so a block can land after the read and before this
    // person's turn. sendBroadcastMessage then refuses (nothing is written). That is a skip, like any other
    // block, and not a failure: the job must not end "with errors" because somebody used the block button.
    it('a block that lands between the read and the send makes the send refuse; that person is skipped, not failed, and nothing was sent', async () => {
      world([recipient({ id: 'r1', user_id: 'late-blocker' }), recipient({ id: 'r2', user_id: 'fine' })]);
      mockSendBroadcastMessage.mockImplementation((_from: string, to: string) =>
        to === 'late-blocker'
          ? Promise.reject(new BroadcastBlockedError())
          : Promise.resolve({ message: fakeMessage(`msg-${to}`), conversationId: `conv-${to}` }));
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

      expect(mockBroadcastDmMessage).toHaveBeenCalledTimes(1); // only the person who had not blocked
      expect(mockBroadcastDmMessage.mock.calls[0][2]).toBe('fine');
      expect(skippedWrites().map((c) => c.params)).toEqual([['blocked', 'r1']]);
      expect(callsMatching('SET total_recipients = total_recipients - 1')).toHaveLength(1);
      expect(callsMatching("status='failed'")).toHaveLength(0);
      expect(callsMatching("status='sent'")).toHaveLength(1);
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-s']); // not completed_with_errors
    });

    it('any other refusal or fault is still a failure: only a block is a skip', async () => {
      world([recipient({ id: 'r1', user_id: 'unlucky' })]);
      mockSendBroadcastMessage.mockRejectedValue(
        Object.assign(new Error('You can no longer message this user'), { statusCode: 403 }), // looks like a block, is not the typed refusal
      );
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

      expect(skippedWrites()).toHaveLength(0);
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

  // ── 7. A server that stopped mid-send ────────────────────────────────────────
  //
  // A job is "processing" while a worker drains it. A deploy or a crash leaves it so, and the unique index
  // (one pending-or-processing job per event) then refused every later send for that event, while the
  // organisers' panel read "Sending… x of y." for ever. A processing job that has shown no sign of life for
  // 5 minutes is carried on from the people still pending, or, if it is more than a day old, failed.
  describe('a send a stopped server left half done', () => {
    const body = 'Thank you all for coming.';
    const HOUR = 60 * 60 * 1000;
    const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

    function interrupted(over: Partial<JobFixture> = {}, extra: Partial<Parameters<typeof setupRouteBySQL>[0]> = {}) {
      setupRouteBySQL({
        job: { id: 'job-r', session_id: 'sess-r', created_by: 'claus', body, previous_status: 'processing', created_at: hoursAgo(1), ...over },
        sessionRow,
        senderRow: { first_name: 'Claus', display_name: 'Claus Test' },
        // The two people the stopped run had not reached; the rest are already 'sent' and never come back.
        recipientRows: [recipient({ id: 'r3', user_id: 'u3' }), recipient({ id: 'r4', user_id: 'u4' })],
        finalJobRow: { failed_count: 0 },
        ...extra,
      });
      mockSendBroadcastMessage.mockImplementation((_from: string, to: string) =>
        Promise.resolve({ message: fakeMessage(`msg-${to}`), conversationId: `conv-${to}` }));
      mockBroadcastDmMessage.mockResolvedValue(undefined);
    }

    it('is picked up, sent to the people still pending, and finished', async () => {
      interrupted();
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockSendBroadcastMessage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['u3', 'u4']);
      for (const call of mockSendBroadcastMessage.mock.calls) expect(call[2]).toBe(body); // still the organiser's words
      expect(callsMatching("status='sent'")).toHaveLength(2);
      expect(mockBroadcastDmMessage.mock.calls[0][5]).toEqual({ bellTitle: 'Claus Test messaged everyone from ‘Test Event’' });
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-r']); // the job leaves 'processing', so the index is free
    });

    it('keeps the failures counted before the stop: they still end it "with errors"', async () => {
      interrupted({}, { finalJobRow: { failed_count: 1 } });
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed_with_errors', 'job-r']);
    });

    it('with nobody left pending it is simply finished', async () => {
      interrupted({}, { recipientRows: [] });
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);

      expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
      const finalize = callsMatching('completed_at').filter((c) => c.params.length === 2).pop()!;
      expect(finalize.params).toEqual(['completed', 'job-r']);
    });

    it('tells the people running the event when it is finished, so their panel stops saying "Sending…"', async () => {
      mockResolveOrganisers.mockResolvedValue(['host-1']);
      interrupted();
      const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
      await processPendingJobs(fakeIo);
      const last = mockEmitEntities.mock.calls[mockEmitEntities.mock.calls.length - 1];
      expect(new Set(last[1] as string[])).toEqual(new Set(['claus', 'host-1']));
      expect(last[2]).toEqual(['session:sess-r']);
    });

    describe('what counts as "silent", and who may take the job', () => {
      it('asks for pending jobs and for processing jobs with no sign of life for 5 minutes; a sign of life is a recipient sent to OR a worker taking the job', async () => {
        interrupted();
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);
        expect(STALE_AFTER_MINUTES).toBe(5);

        const pick = callsMatching(/^SELECT j\.id, j\.session_id/)[0];
        expect(pick.params).toEqual([5]);
        expect(pick.sql).toMatch(/FROM post_event_message_jobs j WHERE j\.status = 'pending' OR \(j\.status = 'processing'/);
        // The later of the latest send and the latest (re)start, never started_at alone: a long job that is
        // still sending has an old started_at and a fresh sent_at.
        expect(pick.sql).toMatch(/GREATEST\(j\.started_at, \(SELECT MAX\(r\.sent_at\) FROM post_event_message_recipients r WHERE r\.job_id = j\.id\)\)/);
        expect(pick.sql).toMatch(/< NOW\(\) - \(\$1::int \* INTERVAL '1 minute'\)/);
        expect(pick.sql).toMatch(/ORDER BY j\.created_at LIMIT 1$/);
        expect(pick.sql).toMatch(/j\.status AS previous_status/);
      });

      it('takes the job in one statement that asks the same question again, so two instances cannot both have it', async () => {
        interrupted();
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);

        const claim = callsMatching(/^UPDATE post_event_message_jobs j SET status = 'processing'/)[0];
        expect(claim.params).toEqual(['job-r', 5]);
        expect(claim.sql).toMatch(/WHERE j\.id = \$1 AND \(j\.status = 'pending' OR \(j\.status = 'processing'/);
        expect(claim.sql).toMatch(/MAX\(r\.sent_at\)/);
        expect(claim.sql).toMatch(/< NOW\(\) - \(\$2::int \* INTERVAL '1 minute'\)/);
        expect(claim.sql).toMatch(/RETURNING j\.id$/);
      });

      it('taking the job starts the clock again (started_at is set to now, not kept), so the next tick leaves it to this run', async () => {
        interrupted();
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);
        const claim = callsMatching(/^UPDATE post_event_message_jobs j SET status = 'processing'/)[0];
        expect(claim.sql).toMatch(/started_at = NOW\(\)/);
        expect(claim.sql).not.toMatch(/COALESCE\(started_at/);
      });

      it('the probe, the pick and the claim all use the one definition of silent', () => {
        for (const sql of [PROBE_SQL, PICK_SQL, CLAIM_SQL]) {
          const flat = String(sql).replace(/\s+/g, ' ');
          expect(flat).toMatch(/COALESCE\(GREATEST\(j\.started_at, \(SELECT MAX\(r\.sent_at\) FROM post_event_message_recipients r WHERE r\.job_id = j\.id\)\), j\.created_at\)/);
        }
      });

      it('losing the claim to another instance means doing nothing at all', async () => {
        interrupted({}, { claim: 'lost' });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

        expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
        expect(callsMatching(/FROM sessions/)).toHaveLength(0);
        expect(callsMatching(/FROM post_event_message_recipients r/).filter((c) => /LIMIT 25/.test(c.sql))).toHaveLength(0);
        expect(callsMatching("status='failed'")).toHaveLength(0);
        expect(mockEmitEntities).not.toHaveBeenCalled();
      });

      it('a job that is not silent never reaches the worker at all: nothing is picked, nothing is sent', async () => {
        // The database answers the pick with no row for a job that is processing and recently alive.
        setupRouteBySQL({ job: null, sessionRow, senderRow, recipientRows: [], finalJobRow: { failed_count: 0 } });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);
        expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
        expect(callsMatching(/^UPDATE post_event_message_jobs j SET status/)).toHaveLength(0);
      });
    });

    describe('nobody is messaged twice', () => {
      it('someone whose message was written just before the stop is marked sent, not sent to again', async () => {
        interrupted({}, { earlierCopies: { u3: 'dm-written-before-the-stop' } });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);

        expect(mockSendBroadcastMessage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['u4']); // u3 is not messaged again
        expect(mockBroadcastDmMessage).toHaveBeenCalledTimes(1);
        const marked = callsMatching("status='sent'").map((c) => c.params);
        expect(marked).toEqual([['dm-written-before-the-stop', 'r3'], ['msg-u4', 'r4']]);
        expect(callsMatching('SET sent_count = sent_count + 1')).toHaveLength(2); // the job counts both
      });

      it('looks for the same words, from the same sender, to that person, written since the job was made', async () => {
        const createdAt = hoursAgo(2);
        interrupted({ created_at: createdAt });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);

        const lookups = callsMatching(/FROM direct_messages dm/);
        expect(lookups).toHaveLength(2);
        expect(lookups[0].params).toEqual(['claus', body, createdAt, 'u3']);
        expect(lookups[0].sql).toMatch(/dm\.from_user_id = \$1 AND dm\.content = \$2 AND dm\.created_at >= \$3/);
        expect(lookups[0].sql).toMatch(/\(c\.user_a_id = \$4 OR c\.user_b_id = \$4\)/);
      });

      it('asks only when a job is being carried on: a new job makes no such lookups', async () => {
        interrupted({ previous_status: 'pending' });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);

        expect(callsMatching(/FROM direct_messages dm/)).toHaveLength(0);
        expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(2);
      });

      it('a template job looks for the template words built for that person', async () => {
        interrupted({ body: null }, { recipientRows: [recipient({ id: 'r3', user_id: 'u3', bucket: 'stayed', first_name: 'Una' })] });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);

        const lookup = callsMatching(/FROM direct_messages dm/)[0];
        expect(String(lookup.params[1])).toContain('Hi Una,');
        expect(String(lookup.params[1])).toContain('Test Event');
      });
    });

    describe('when it cannot be carried on, it is failed, which frees the event to send again', () => {
      const failures = () => callsMatching(/^UPDATE post_event_message_jobs SET status = 'failed'/);

      it('a job stopped more than a day ago is failed, with a sentence that says why, and nobody is messaged', async () => {
        interrupted({ created_at: hoursAgo(72) });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);

        expect(mockSendBroadcastMessage).not.toHaveBeenCalled();
        expect(failures()).toHaveLength(1);
        expect(failures()[0].params[1]).toBe('job-r');
        expect(String(failures()[0].params[0])).toMatch(/stopped/i);
        expect(failures()[0].sql).toMatch(/completed_at = NOW\(\)/);
        expect(callsMatching('completed_at').filter((c) => /SET status = \$1/.test(c.sql))).toHaveLength(0); // not "completed"
      });

      it('tells the people running the event, so the panel stops saying "Sending…"', async () => {
        mockResolveOrganisers.mockResolvedValue(['host-1']);
        interrupted({ created_at: hoursAgo(72) });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);
        expect(mockEmitEntities).toHaveBeenCalledTimes(1);
        expect(new Set(mockEmitEntities.mock.calls[0][1] as string[])).toEqual(new Set(['claus', 'host-1']));
        expect(mockEmitEntities.mock.calls[0][2]).toEqual(['session:sess-r']);
      });

      it('a job stopped 23 hours ago is still carried on', async () => {
        interrupted({ created_at: hoursAgo(23) });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);
        expect(failures()).toHaveLength(0);
        expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(2);
      });

      it('a NEW job is never failed for its age: only one that was already half done', async () => {
        interrupted({ previous_status: 'pending', created_at: hoursAgo(72) });
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await processPendingJobs(fakeIo);
        expect(failures()).toHaveLength(0);
        expect(mockSendBroadcastMessage).toHaveBeenCalledTimes(2);
      });

      it('if carrying it on throws, it is failed with the reason, not left "processing" again', async () => {
        interrupted();
        const route = mockQuery.getMockImplementation()!;
        mockQuery.mockImplementation((sql: string, params?: unknown[]) =>
          /FROM sessions/.test(String(sql)) ? Promise.reject(new Error('database went away')) : route(sql, params));
        const { processPendingJobs } = await import('../../../services/post-event-message/post-event-message.worker');
        await expect(processPendingJobs(fakeIo)).resolves.toBeUndefined();

        const failed = callsMatching(/SET status = 'failed', error = \$1, completed_at = NOW\(\) WHERE id = \$2/);
        expect(failed).toHaveLength(1);
        expect(failed[0].params).toEqual(['database went away', 'job-r']);
      });
    });
  });
});
