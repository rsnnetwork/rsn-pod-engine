// ─── Meetings: the list, the count, one meeting, cancel, attendance (26 Oct 2026) ─
//
// 25 Oct: "Now we've found a time to meet. What then? ... So we can't meet." A confirmed meeting
// is now a row of its own, and these are the reads Events draws from, the cancel the details page
// offers, and the attendance stamp the call room writes. Only the two participants ever see a
// meeting, a block hides it from both, and a closed account reads "Former member" (Review Focus 5).
// Cancel is a claim: pressing it twice, or both people pressing it at once, cancels once and tells
// each person once (Review Focus 2).
//
// The real service runs with the real calendar file; the database, the thread, the sockets and the
// email sender are stand-ins.

const mockQuery = jest.fn();
const mockTxSql: string[] = [];
const mockPoolSql: string[] = [];
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => { mockPoolSql.push(a[0] as string); return mockQuery(...a); },
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => { mockTxSql.push(a[0] as string); return mockQuery(...a); } }),
  __esModule: true,
}));
jest.mock('../../../config', () => ({ __esModule: true, default: { clientUrl: 'https://app.rsn.network' } }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockInsertOn = jest.fn();
jest.mock('../../../services/dm/dm.service', () => ({
  __esModule: true,
  insertDirectMessageOn: (...a: unknown[]) => mockInsertOn(...a),
}));
const mockBroadcastDm = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  __esModule: true,
  broadcastDmMessage: (...a: unknown[]) => mockBroadcastDm(...a),
}));
const mockEmits: Array<[string, string, unknown]> = [];
jest.mock('../../../index', () => ({
  __esModule: true,
  io: { to: (room: string) => ({ emit: (event: string, payload: unknown) => { mockEmits.push([room, event, payload]); } }) },
}));
const mockCancelEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  sendMeetingCancelledEmail: (...a: unknown[]) => mockCancelEmail(...a),
}));

import { meetingPhase, ErrorCodes } from '@rsn/shared';
import {
  listMeetings, getMeetingSummary, getMeeting, cancelMeeting, stampAttendance,
} from '../../../services/meetings/meeting.service';
import { meetingTime } from '../../../services/meetings/meeting-time';

const NOW = new Date('2026-11-05T12:00:00Z');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const MEETING = 'dddddddd-0000-4000-8000-000000000004';

/** A meeting row as the service's select returns it, seen by A: the partner columns are B's. */
function row(extra: Record<string, unknown> = {}) {
  return {
    id: MEETING, conversation_id: 'conv-1', user_a_id: A, user_b_id: B,
    start_at: new Date('2026-11-05T17:00:00Z'), duration_min: 30, kind: 'video', status: 'scheduled',
    context: 'Coffee about your seed round?', joined_a_at: null, joined_b_at: null,
    calendar_sequence: 0, confirmed_by: B,
    partner_id: B, partner_name: 'Bo Meyer', partner_avatar_url: 'https://cdn.example/bo.png', partner_status: 'active',
    ...extra,
  };
}

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
const calls = (pattern: RegExp) => mockQuery.mock.calls.filter((c) => pattern.test(flat(c[0])));

beforeEach(() => {
  mockQuery.mockReset();
  mockTxSql.length = 0;
  mockPoolSql.length = 0;
  mockEmits.length = 0;
  mockInsertOn.mockReset().mockResolvedValue({ conversationId: 'conv-1', message: { id: 'msg-1', content: 'x' } });
  mockBroadcastDm.mockClear();
  mockCancelEmail.mockClear();
});

// ── The phase rule ───────────────────────────────────────────────────────────

describe('the phase of a meeting', () => {
  const start = new Date('2026-11-05T17:00:00Z');
  const at = (iso: string) => meetingPhase({ status: 'scheduled', startAt: start, durationMin: 30 }, new Date(iso));

  it('is upcoming until 5 minutes before the start, then joinable', () => {
    expect(at('2026-11-05T16:54:59Z')).toBe('upcoming');
    expect(at('2026-11-05T16:55:00Z')).toBe('joinable');
    expect(at('2026-11-05T16:59:59Z')).toBe('joinable');
  });

  it('is live from the start to the end', () => {
    expect(at('2026-11-05T17:00:00Z')).toBe('live');
    expect(at('2026-11-05T17:30:00Z')).toBe('live');
  });

  it('can still be joined for 30 minutes after the end, and has ended after that', () => {
    expect(at('2026-11-05T17:30:01Z')).toBe('joinable');
    expect(at('2026-11-05T18:00:00Z')).toBe('joinable');
    expect(at('2026-11-05T18:00:01Z')).toBe('ended');
  });

  it('is cancelled whatever the time, once cancelled', () => {
    expect(meetingPhase({ status: 'cancelled', startAt: start, durationMin: 30 }, new Date('2026-11-05T17:10:00Z'))).toBe('cancelled');
  });
});

// ── An instant as a person reads it (Review Focus 1) ─────────────────────────

describe('meetingTime', () => {
  it('reads the meeting in the person\'s own zone, and names the zone, across the 25 Oct clock change', () => {
    // Copenhagen left summer time at 01:00 UTC on 25 Oct 2026.
    expect(meetingTime(new Date('2026-10-25T12:00:00Z'), 'Europe/Copenhagen')).toEqual(
      expect.objectContaining({ short: 'Sun 25 Oct, 13:00', long: 'Sunday 25 October, 13:00', zone: expect.stringMatching(/^(CET|GMT\+1)$/) }),
    );
    expect(meetingTime(new Date('2026-10-24T12:00:00Z'), 'Europe/Copenhagen')).toEqual(
      expect.objectContaining({ short: 'Sat 24 Oct, 14:00', zone: expect.stringMatching(/^(CEST|GMT\+2)$/) }),
    );
  });

  it('with no zone on file, or one no calendar knows, reads UTC and says so', () => {
    expect(meetingTime(new Date('2026-10-25T12:00:00Z'), null)).toEqual({ short: 'Sun 25 Oct, 12:00', long: 'Sunday 25 October, 12:00', zone: 'UTC' });
    expect(meetingTime(new Date('2026-10-25T12:00:00Z'), 'Mars/Olympus')).toEqual({ short: 'Sun 25 Oct, 12:00', long: 'Sunday 25 October, 12:00', zone: 'UTC' });
  });

  it('writes midnight as 00:00 and September as Sep', () => {
    expect(meetingTime(new Date('2026-09-09T00:00:00Z'), 'UTC').short).toBe('Wed 9 Sep, 00:00');
  });
});

// ── The lists under Events ───────────────────────────────────────────────────

describe('listMeetings', () => {
  it('upcoming: only the viewer\'s meetings, none with someone a block stands between, still to come, soonest first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });

    const list = await listMeetings(A, { scope: 'upcoming', limit: 20 }, NOW);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toMatch(/FROM meetings m JOIN users p ON p\.id = CASE WHEN m\.user_a_id = \$1 THEN m\.user_b_id ELSE m\.user_a_id END/);
    expect(flat(sql)).toMatch(/WHERE \(m\.user_a_id = \$1 OR m\.user_b_id = \$1\)/);
    expect(flat(sql)).toMatch(/NOT EXISTS \( SELECT 1 FROM user_blocks ub WHERE \(ub\.blocker_id = \$1 AND ub\.blocked_id = p\.id\) OR \(ub\.blocker_id = p\.id AND ub\.blocked_id = \$1\)\)/);
    expect(flat(sql)).toMatch(/m\.status = 'scheduled' AND m\.start_at \+ \(m\.duration_min \+ 30\) \* INTERVAL '1 minute' >= \$2/);
    expect(flat(sql)).toMatch(/ORDER BY m\.start_at ASC, m\.id ASC LIMIT \$3$/);
    expect(params).toEqual([A, NOW, 21]);
    expect(list).toEqual({
      items: [{
        id: MEETING, conversationId: 'conv-1',
        partner: { userId: B, displayName: 'Bo Meyer', avatarUrl: 'https://cdn.example/bo.png' },
        startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, kind: 'video', status: 'scheduled', phase: 'upcoming',
        context: 'Coffee about your seed round?', joinPath: '/meet/conv-1?scheduled=1&kind=video',
        attended: { me: false, them: false },
      }],
      nextBefore: null,
    });
  });

  it('past: the scheduled meetings that have ended, latest first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ start_at: new Date('2026-11-01T09:00:00Z'), joined_a_at: new Date(), joined_b_at: null })] });

    const list = await listMeetings(A, { scope: 'past', limit: 5 }, NOW);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toMatch(/m\.status = 'scheduled' AND m\.start_at \+ \(m\.duration_min \+ 30\) \* INTERVAL '1 minute' < \$2/);
    expect(flat(sql)).toMatch(/ORDER BY m\.start_at DESC, m\.id DESC LIMIT \$3$/);
    expect(params).toEqual([A, NOW, 6]);
    expect(list.items[0]).toMatchObject({ phase: 'ended', attended: { me: true, them: false } });
  });

  it('cancelled: the cancelled ones, latest first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'cancelled' })] });

    const list = await listMeetings(A, { scope: 'cancelled', limit: 20 }, NOW);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toMatch(/AND m\.status = 'cancelled' ORDER BY m\.start_at DESC, m\.id DESC LIMIT \$2$/);
    expect(params).toEqual([A, 21]);
    expect(list.items[0]).toMatchObject({ status: 'cancelled', phase: 'cancelled' });
  });

  it('the partner is always the other person, whichever side of the pair the viewer is', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ partner_id: A, partner_name: 'Ana Rivera', joined_a_at: new Date(), joined_b_at: null })] });

    const list = await listMeetings(B, { scope: 'upcoming', limit: 20 }, NOW);

    expect(list.items[0].partner).toMatchObject({ userId: A, displayName: 'Ana Rivera' });
    // B is side b: A joined, B did not.
    expect(list.items[0].attended).toEqual({ me: false, them: true });
  });

  it('a partner whose account is closed reads "Former member", with no picture', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ partner_status: 'deactivated' })] });

    const list = await listMeetings(A, { scope: 'upcoming', limit: 20 }, NOW);

    expect(list.items[0].partner).toEqual({ userId: B, displayName: 'Former member', avatarUrl: null });
  });

  it('a page that is full says where the next one starts; the next page continues after it', async () => {
    const rows = [1, 2, 3].map((d) => row({ id: `m-${d}`, start_at: new Date(`2026-11-0${d + 5}T09:00:00Z`) }));
    mockQuery.mockResolvedValueOnce({ rows });

    const first = await listMeetings(A, { scope: 'upcoming', limit: 2 }, NOW);

    expect(first.items.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(first.nextBefore).toBe('2026-11-07T09:00:00.000Z');

    mockQuery.mockResolvedValueOnce({ rows: [rows[2]] });
    const second = await listMeetings(A, { scope: 'upcoming', limit: 2, before: first.nextBefore! }, NOW);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(flat(sql)).toMatch(/AND m\.start_at > \$3 ORDER BY m\.start_at ASC, m\.id ASC LIMIT \$4$/);
    expect(params).toEqual([A, NOW, new Date('2026-11-07T09:00:00.000Z'), 3]);
    expect(second).toEqual({ items: [expect.objectContaining({ id: 'm-3' })], nextBefore: null });
  });

  it('past and cancelled pages continue earlier than the cursor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listMeetings(A, { scope: 'cancelled', limit: 10, before: '2026-11-01T09:00:00.000Z' }, NOW);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toMatch(/AND m\.start_at < \$2 ORDER BY m\.start_at DESC, m\.id DESC LIMIT \$3$/);
    expect(params).toEqual([A, new Date('2026-11-01T09:00:00.000Z'), 11]);
  });

  it('meetings at the same moment are never split across two pages, so the next page misses none', async () => {
    const at = new Date('2026-11-06T09:00:00Z');
    mockQuery
      .mockResolvedValueOnce({ rows: [row({ id: 'm-1', start_at: new Date('2026-11-05T15:00:00Z') }), row({ id: 'm-2', start_at: at }), row({ id: 'm-3', start_at: at })] })
      .mockResolvedValueOnce({ rows: [row({ id: 'm-3', start_at: at }), row({ id: 'm-4', start_at: at })] });

    const page = await listMeetings(A, { scope: 'upcoming', limit: 2 }, NOW);

    const [sql, params] = mockQuery.mock.calls[1];
    expect(flat(sql)).toMatch(/AND m\.start_at = \$3 AND NOT \(m\.id = ANY\(\$4\)\) ORDER BY m\.start_at ASC, m\.id ASC LIMIT 50$/);
    expect(params).toEqual([A, NOW, at, ['m-1', 'm-2']]);
    expect(page.items.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(page.nextBefore).toBe(at.toISOString());
  });
});

// ── The count on Events ──────────────────────────────────────────────────────

describe('getMeetingSummary', () => {
  it('counts the meetings still to come, says whether one can be joined now, and names the next', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: MEETING, start_at: new Date('2026-11-05T12:03:00Z'), partner_name: 'Bo Meyer', partner_status: 'active', upcoming_count: 2, live_now: true }] });

    const summary = await getMeetingSummary(A, NOW);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toMatch(/WHERE \(m\.user_a_id = \$1 OR m\.user_b_id = \$1\)/);
    expect(flat(sql)).toMatch(/FROM user_blocks ub/);
    expect(flat(sql)).toMatch(/CAST\(count\(\*\) OVER \(\) AS int\) AS upcoming_count/);
    expect(flat(sql)).toMatch(/bool_or\(m\.start_at <= \$2::timestamptz \+ INTERVAL '5 minutes'\) OVER \(\) AS live_now/);
    expect(flat(sql)).toMatch(/m\.status = 'scheduled' AND m\.start_at \+ \(m\.duration_min \+ 30\) \* INTERVAL '1 minute' >= \$2/);
    expect(flat(sql)).toMatch(/ORDER BY m\.start_at ASC, m\.id ASC LIMIT 1$/);
    expect(params).toEqual([A, NOW]);
    expect(summary).toEqual({
      upcomingCount: 2, liveNow: true,
      next: { id: MEETING, startAt: '2026-11-05T12:03:00.000Z', partnerName: 'Bo Meyer' },
    });
  });

  it('with nothing to come: zero, nothing live, no next meeting', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getMeetingSummary(A, NOW)).toEqual({ upcomingCount: 0, liveNow: false, next: null });
  });

  it('names a closed account "Former member"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: MEETING, start_at: new Date('2026-11-06T12:00:00Z'), partner_name: 'Bo Meyer', partner_status: 'suspended', upcoming_count: 1, live_now: false }] });
    expect((await getMeetingSummary(A, NOW)).next?.partnerName).toBe('Former member');
  });
});

// ── One meeting ──────────────────────────────────────────────────────────────

describe('getMeeting', () => {
  it('is the viewer\'s meeting, read through the same participant and block checks', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ start_at: new Date('2026-11-05T12:10:00Z') })] });

    const meeting = await getMeeting(A, MEETING, NOW);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toMatch(/WHERE \(m\.user_a_id = \$1 OR m\.user_b_id = \$1\)/);
    expect(flat(sql)).toMatch(/FROM user_blocks ub/);
    expect(flat(sql)).toMatch(/AND m\.id = \$2$/);
    expect(params).toEqual([A, MEETING]);
    expect(meeting).toMatchObject({ id: MEETING, phase: 'upcoming', partner: { userId: B } });
  });

  it('is not found for anyone else, and for a pair a block stands between: the two read the same', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getMeeting(C, MEETING, NOW)).rejects.toMatchObject({
      statusCode: 404, code: 'MEETING_NOT_FOUND', message: "We couldn't find that meeting.",
    });
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────────

describe('cancelMeeting', () => {
  /** The database for one cancel. `claims` is how many cancels the claim lets through. */
  function armCancel(opts: { meeting?: Record<string, unknown>; claims?: number; current?: string | null; window?: string | null; statusAfter?: string } = {}) {
    let claims = opts.claims ?? 1;
    const meeting = row(opts.meeting);
    mockQuery.mockImplementation((sql: string) => {
      const s = flat(sql);
      if (/FROM meetings m JOIN users p/.test(s)) return Promise.resolve({ rows: [meeting] });
      if (/FROM dm_conversations WHERE id = \$1 FOR UPDATE/.test(s)) {
        return Promise.resolve({ rows: [{ meeting_confirmed_window: opts.window === undefined ? '2026-11-05T17:00:00Z' : opts.window, current_meeting_id: opts.current === undefined ? MEETING : opts.current }] });
      }
      if (/UPDATE meetings SET status = 'cancelled'/.test(s)) {
        if (claims <= 0) return Promise.resolve({ rows: [] });
        claims -= 1;
        return Promise.resolve({ rows: [{ ...meeting, status: 'cancelled', calendar_sequence: 3, confirmed_by: B }] });
      }
      if (/FROM meetings WHERE id = \$1/.test(s)) return Promise.resolve({ rows: [{ ...meeting, status: opts.statusAfter ?? 'cancelled' }] });
      if (/FROM users WHERE id = ANY/.test(s)) {
        return Promise.resolve({ rows: [
          { id: A, display_name: 'Ana Rivera', email: 'ana@example.com', timezone: 'Asia/Karachi' },
          { id: B, display_name: 'Bo Meyer', email: 'bo@example.com', timezone: 'Europe/Berlin' },
        ] });
      }
      if (/INSERT INTO notifications/.test(s)) return Promise.resolve({ rows: [{ id: 'n-1', created_at: NOW }] });
      return Promise.resolve({ rows: [] });
    });
  }

  const bells = () => calls(/INSERT INTO notifications/).map((c) => c[1] as unknown[]);
  const tagsSentTo = (userId: string) => mockEmits
    .filter(([room, event]) => room === `user:${userId}` && event === 'entity:changed')
    .map(([, , payload]) => (payload as { entities: string[] }).entities);
  const icsOf = (n: number) => String((mockCancelEmail.mock.calls[n][2] as { icsContent: string }).icsContent).replace(/\r\n[ \t]/g, '');

  // 26 Oct 2026 (H2a): it was claimable until 30 minutes after its end, so a meeting that had been held
  // could be cancelled afterwards, with a cancellation email to both. Now only until it starts.
  it('claims the meeting only while it is scheduled and has not started, after locking the conversation as every booking does', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    const claim = calls(/UPDATE meetings SET status = 'cancelled'/);
    expect(claim).toHaveLength(1);
    expect(flat(claim[0][0])).toMatch(
      /SET status = 'cancelled', cancelled_by = \$2, cancelled_at = NOW\(\), calendar_sequence = calendar_sequence \+ 1, updated_at = NOW\(\) WHERE id = \$1 AND status = 'scheduled' AND start_at > \$3 RETURNING/,
    );
    expect(claim[0][1]).toEqual([MEETING, A, NOW]);
    // The conversation row is locked before the meeting row, the order a booking and a move use, so a
    // cancel and a move of the same meeting take turns instead of deadlocking.
    const lock = mockTxSql.findIndex((s) => /FROM dm_conversations WHERE id = \$1 FOR UPDATE/.test(flat(s)));
    const claimAt = mockTxSql.findIndex((s) => /UPDATE meetings SET status = 'cancelled'/.test(flat(s)));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(claimAt).toBeGreaterThan(lock);
  });

  it('takes the meeting off the conversation, so production\'s banner and Join disappear, and frees the time from the canceller\'s own list', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    const cleared = calls(/UPDATE dm_conversations SET meeting_confirmed_window = NULL/);
    expect(cleared).toHaveLength(1);
    expect(flat(cleared[0][0])).toMatch(
      /SET meeting_confirmed_window = NULL, meeting_confirmed_by = NULL, meeting_confirmed_at = NULL, meeting_start_at = NULL, meeting_duration_min = NULL, meeting_type = NULL, current_meeting_id = NULL WHERE id = \$1 AND current_meeting_id = \$2/,
    );
    expect(cleared[0][1]).toEqual(['conv-1', MEETING]);
    // The time they cancelled is no longer one they offered, so a later save cannot book it again behind their back.
    const freed = calls(/DELETE FROM meeting_availability/);
    expect(freed).toHaveLength(1);
    expect(flat(freed[0][0])).toMatch(/WHERE conversation_id = \$1 AND user_id = \$2 AND window_key = \$3/);
    expect(freed[0][1]).toEqual(['conv-1', A, '2026-11-05T17:00:00Z']);
    // All of it inside the cancel's transaction.
    expect(mockPoolSql.filter((s) => /UPDATE meetings|UPDATE dm_conversations|DELETE FROM meeting_availability/.test(s))).toEqual([]);
  });

  // 26 Oct 2026 (H2a): the old server can leave the pointer at a row that no longer describes the
  // conversation's meeting; cancelling that row must not clear the meeting the conversation stands on.
  it('reads the conversation\'s meeting through the guard: the pointer counts only while its row is scheduled at the conversation\'s time', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    const [read] = calls(/FROM dm_conversations WHERE id = \$1 FOR UPDATE/);
    expect(flat(read[0])).toMatch(/\(SELECT m\.id FROM meetings m WHERE m\.id = dm_conversations\.current_meeting_id AND m\.status = 'scheduled' AND m\.start_at = dm_conversations\.meeting_start_at\) AS current_meeting_id/);
  });

  it('leaves a conversation that has moved on to another meeting as it is', async () => {
    armCancel({ current: 'some-other-meeting' });

    await cancelMeeting(A, MEETING, NOW);

    expect(calls(/UPDATE dm_conversations SET meeting_confirmed_window = NULL/)).toHaveLength(0);
    expect(calls(/DELETE FROM meeting_availability/)).toHaveLength(0);
  });

  it('posts a "Meeting cancelled" card in the thread, in the same transaction, that each screen shows in its own time', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    expect(mockInsertOn).toHaveBeenCalledTimes(1);
    const [client, from, to, content, attachment, opts] = mockInsertOn.mock.calls[0];
    expect(client).toHaveProperty('query');
    expect([from, to, attachment]).toEqual([A, B, null]);
    // The instant, as the confirmed card writes it, so production's client renders it in the reader's time.
    expect(content).toBe('📅 Meeting cancelled: 2026-11-05T17:00:00Z');
    expect(opts).toEqual({
      kind: 'system',
      systemMeta: { type: 'meeting_cancelled', meetingId: MEETING, startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, meetingType: 'video' },
    });
    expect(mockBroadcastDm).toHaveBeenCalledWith(expect.anything(), A, B, 'conv-1', { id: 'msg-1', content: 'x' }, { notify: false });
  });

  it('rings only the other person: "{name} cancelled your meeting on {when}", in their own zone, linking the chat', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    // Bo reads Berlin time: 17:00 UTC on 5 Nov is 18:00 CET.
    expect(bells()).toEqual([[B, 'meeting_cancelled', expect.stringMatching(/^Ana Rivera cancelled your meeting on Thu 5 Nov, 18:00 (CET|GMT\+1)$/), 'Open the chat to pick a new time.', '/messages/conv-1']]);
    const live = mockEmits.filter(([, event]) => event === 'notification:new');
    expect(live).toEqual([[`user:${B}`, 'notification:new', expect.objectContaining({ type: 'meeting_cancelled', link: '/messages/conv-1', isRead: false })]]);
    expect(tagsSentTo(B)).toContainEqual([`user:${B}:notifications`]);
    expect(tagsSentTo(A).flat()).not.toContain(`user:${A}:notifications`);
  });

  it('emails both people a METHOD:CANCEL calendar file with the meeting\'s identity, the next SEQUENCE and its first organizer', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    expect(mockCancelEmail.mock.calls.map((c) => c[0]).sort()).toEqual(['ana@example.com', 'bo@example.com']);
    for (let n = 0; n < 2; n += 1) {
      const ics = icsOf(n);
      expect(ics).toContain('METHOD:CANCEL');
      expect(ics).toContain(`UID:meeting-${MEETING}@rsn.network`);
      expect(ics).toContain('SEQUENCE:3');
      expect(ics).toContain('STATUS:CANCELLED');
      expect(ics).toContain('ORGANIZER;CN=Bo Meyer:mailto:bo@example.com');
      expect(ics).toContain('DTSTART:20261105T170000Z');
    }
    const toAna = mockCancelEmail.mock.calls.find((c) => c[0] === 'ana@example.com')!;
    const toBo = mockCancelEmail.mock.calls.find((c) => c[0] === 'bo@example.com')!;
    expect(toAna[1]).toBe('Ana Rivera');
    expect(toAna[2]).toMatchObject({ partnerName: 'Bo Meyer', cancelledByMe: true, recipientTimezone: 'Asia/Karachi', threadUrl: 'https://app.rsn.network/messages/conv-1', kind: 'video', durationMin: 30 });
    expect(toBo[2]).toMatchObject({ partnerName: 'Ana Rivera', cancelledByMe: false, cancellerName: 'Ana Rivera', recipientTimezone: 'Europe/Berlin' });
  });

  it('tells both people\'s screens: their meetings, the meeting, the thread and their inboxes', async () => {
    armCancel();

    await cancelMeeting(A, MEETING, NOW);

    for (const user of [A, B]) {
      expect(tagsSentTo(user)).toContainEqual([`user:${user}:meetings`, `meeting:${MEETING}`]);
      expect(tagsSentTo(user).flat()).toEqual(expect.arrayContaining(['dm-conversation:conv-1', `user:${A}:dms`, `user:${B}:dms`]));
    }
  });

  it('answers with the meeting, now cancelled', async () => {
    armCancel();
    expect(await cancelMeeting(A, MEETING, NOW)).toMatchObject({ id: MEETING, status: 'cancelled', phase: 'cancelled', partner: { userId: B } });
  });

  it('cancel twice → 200 with the cancelled meeting, and nothing is said or sent again (Review Focus 2)', async () => {
    armCancel({ claims: 1 });
    await cancelMeeting(A, MEETING, NOW);
    mockInsertOn.mockClear();
    mockCancelEmail.mockClear();
    mockEmits.length = 0;
    const bellsBefore = bells().length;

    const again = await cancelMeeting(A, MEETING, NOW);

    expect(again).toMatchObject({ status: 'cancelled', phase: 'cancelled' });
    expect(mockInsertOn).not.toHaveBeenCalled();
    expect(mockCancelEmail).not.toHaveBeenCalled();
    expect(bells()).toHaveLength(bellsBefore);
    expect(mockEmits).toEqual([]);
  });

  it('both people cancelling at once: one cancels, the other is told it is cancelled, and each person is told once', async () => {
    armCancel({ claims: 1 });

    const [mine, theirs] = await Promise.all([cancelMeeting(A, MEETING, NOW), cancelMeeting(B, MEETING, NOW)]);

    expect(mine.status).toBe('cancelled');
    expect(theirs.status).toBe('cancelled');
    expect(mockInsertOn).toHaveBeenCalledTimes(1);
    expect(bells()).toHaveLength(1);
    expect(mockCancelEmail).toHaveBeenCalledTimes(2);
  });

  it('a meeting under way cannot be cancelled: 409 MEETING_ALREADY_STARTED, in words a member reads, and nothing changes', async () => {
    // Started 10 minutes ago, 30 minutes long.
    armCancel({ claims: 0, statusAfter: 'scheduled', meeting: { start_at: new Date(NOW.getTime() - 10 * 60_000) } });

    await expect(cancelMeeting(A, MEETING, NOW)).rejects.toMatchObject({
      statusCode: 409, code: 'MEETING_ALREADY_STARTED', message: 'This meeting has already started, so it can no longer be cancelled.',
    });
    expect(calls(/UPDATE dm_conversations|DELETE FROM meeting_availability/)).toHaveLength(0);
    expect(mockInsertOn).not.toHaveBeenCalled();
    expect(mockCancelEmail).not.toHaveBeenCalled();
  });

  it('in the 30 minutes after its end, when it can still be joined, it has ended and cannot be cancelled', async () => {
    // A 30-minute meeting that started 45 minutes ago ended 15 minutes ago.
    armCancel({ claims: 0, statusAfter: 'scheduled', meeting: { start_at: new Date(NOW.getTime() - 45 * 60_000) } });

    await expect(cancelMeeting(A, MEETING, NOW)).rejects.toMatchObject({
      statusCode: 409, code: ErrorCodes.MEETING_ALREADY_ENDED, message: 'This meeting has already ended.',
    });
    expect(mockCancelEmail).not.toHaveBeenCalled();
  });

  it('a meeting that has ended cannot be cancelled: 409 MEETING_ALREADY_ENDED, and nothing changes', async () => {
    armCancel({ claims: 0, statusAfter: 'scheduled', meeting: { start_at: new Date('2026-11-01T09:00:00Z') } });

    await expect(cancelMeeting(A, MEETING, NOW)).rejects.toMatchObject({
      statusCode: 409, code: ErrorCodes.MEETING_ALREADY_ENDED, message: 'This meeting has already ended.',
    });
    expect(calls(/UPDATE dm_conversations|DELETE FROM meeting_availability/)).toHaveLength(0);
    expect(mockInsertOn).not.toHaveBeenCalled();
    expect(mockCancelEmail).not.toHaveBeenCalled();
  });

  it('someone else\'s meeting, or one a block stands between, is not found, and no transaction starts', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(cancelMeeting(C, MEETING, NOW)).rejects.toMatchObject({ statusCode: 404, code: 'MEETING_NOT_FOUND' });
    expect(mockTxSql).toEqual([]);
  });
});

// ── Attendance ───────────────────────────────────────────────────────────────

describe('stampAttendance', () => {
  it('stamps the side that joined, once, on a scheduled meeting, and says whether this was the first time', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: MEETING }] }).mockResolvedValueOnce({ rows: [] }) };

    expect(await stampAttendance(client as never, MEETING, 'b')).toBe(true);
    expect(await stampAttendance(client as never, MEETING, 'b')).toBe(false);

    const [sql, params] = client.query.mock.calls[0];
    expect(flat(sql)).toBe("UPDATE meetings SET joined_b_at = NOW() WHERE id = $1 AND joined_b_at IS NULL AND status = 'scheduled' RETURNING id");
    expect(params).toEqual([MEETING]);
  });

  it('side a stamps joined_a_at', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await stampAttendance(client as never, MEETING, 'a');
    expect(flat(client.query.mock.calls[0][0])).toMatch(/SET joined_a_at = NOW\(\) WHERE id = \$1 AND joined_a_at IS NULL/);
  });
});
