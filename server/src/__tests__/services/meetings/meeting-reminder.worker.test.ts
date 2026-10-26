// ─── The reminder 10 minutes before a meeting (26 Oct 2026) ──────────────────
//
// Every 60 seconds the worker claims the meetings that start within 10 minutes and have not been
// reminded. The claim is one UPDATE over a FOR UPDATE SKIP LOCKED subquery, so with several server
// instances each meeting is claimed by exactly one of them, once. Both people get a bell, "Your
// meeting with {name} starts in 10 minutes", and an email when their notify_email switch (and the
// admin email switch) allow it. A meeting booked inside those 10 minutes was just confirmed in front
// of them, so it is claimed without a reminder; so is one with a closed account or a block between.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config', () => ({ __esModule: true, default: { clientUrl: 'https://app.rsn.network' } }));
const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() },
}));
const mockEmits: Array<[string, string, unknown]> = [];
jest.mock('../../../index', () => ({
  __esModule: true,
  io: { to: (room: string) => ({ emit: (event: string, payload: unknown) => { mockEmits.push([room, event, payload]); } }) },
}));
const mockAreBlocked = jest.fn().mockResolvedValue(false);
jest.mock('../../../services/block/block.service', () => ({ __esModule: true, areBlocked: (...a: unknown[]) => mockAreBlocked(...a) }));
const mockReminderEmail = jest.fn().mockResolvedValue(undefined);
const mockEmailEnabled = jest.fn().mockResolvedValue(true);
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  sendMeetingReminderEmail: (...a: unknown[]) => mockReminderEmail(...a),
  isEmailTypeEnabled: (...a: unknown[]) => mockEmailEnabled(...a),
}));

import { processMeetingReminders } from '../../../services/meetings/meeting-reminder.worker';

const NOW = new Date('2026-11-05T16:50:30Z');
const START = new Date('2026-11-05T17:00:00Z'); // 9.5 minutes away
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const due = (extra: Record<string, unknown> = {}) => ({
  id: 'mtg-1', conversation_id: 'conv-1', user_a_id: A, user_b_id: B,
  start_at: START, duration_min: 30, kind: 'video', updated_at: new Date('2026-11-04T09:00:00Z'),
  ...extra,
});

const person = (id: string, extra: Record<string, unknown> = {}) => ({
  id, display_name: id === A ? 'Ana Rivera' : 'Bo Meyer', email: id === A ? 'ana@example.com' : 'bo@example.com',
  timezone: id === A ? 'Asia/Karachi' : 'Europe/Berlin', status: 'active', notify_email: true, ...extra,
});

/** The database: each run's claim hands out what `claims` holds next; people as given. */
function arm(claims: Array<Array<Record<string, unknown>>>, people: Array<Record<string, unknown>> = [person(A), person(B)]) {
  mockQuery.mockImplementation((sql: string) => {
    if (/UPDATE meetings SET reminder_sent_at/.test(sql)) return Promise.resolve({ rows: claims.shift() ?? [] });
    if (/FROM users WHERE id = ANY/.test(sql)) return Promise.resolve({ rows: people });
    if (/INSERT INTO notifications/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'n-a', user_id: A, created_at: NOW }, { id: 'n-b', user_id: B, created_at: NOW }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const bellRows = () => mockQuery.mock.calls.filter((c) => /INSERT INTO notifications/.test(c[0] as string));
const tagsSentTo = (userId: string) => mockEmits
  .filter(([room, event]) => room === `user:${userId}` && event === 'entity:changed')
  .map(([, , payload]) => (payload as { entities: string[] }).entities);

beforeEach(() => {
  mockQuery.mockReset();
  mockEmits.length = 0;
  mockWarn.mockClear();
  mockAreBlocked.mockReset().mockResolvedValue(false);
  mockReminderEmail.mockClear();
  mockEmailEnabled.mockReset().mockResolvedValue(true);
});

describe('processMeetingReminders', () => {
  it('claims due meetings with one UPDATE over FOR UPDATE SKIP LOCKED: scheduled, not yet reminded, starting within 10 minutes', async () => {
    arm([[]]);

    expect(await processMeetingReminders(NOW)).toBe(0);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toBe(
      'UPDATE meetings SET reminder_sent_at = NOW() WHERE id IN ( SELECT id FROM meetings'
      + " WHERE status = 'scheduled' AND reminder_sent_at IS NULL"
      + " AND start_at > $1 AND start_at <= $1::timestamptz + INTERVAL '10 minutes'"
      + ' ORDER BY start_at LIMIT 50 FOR UPDATE SKIP LOCKED)'
      + ' RETURNING id, conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, updated_at',
    );
    expect(params).toEqual([NOW]);
  });

  it('rings both people, each about the other: "Your meeting with {name} starts in 10 minutes", in their own time, linking the chat', async () => {
    arm([[due()]]);

    expect(await processMeetingReminders(NOW)).toBe(1);

    const inserts = bellRows();
    expect(inserts).toHaveLength(1); // one statement for both rows
    expect(flat(inserts[0][0])).toMatch(/VALUES \(gen_random_uuid\(\), \$1, 'meeting_reminder', \$2, \$3, \$4\), \(gen_random_uuid\(\), \$5, 'meeting_reminder', \$6, \$7, \$8\)/);
    expect(inserts[0][1]).toEqual([
      A, 'Your meeting with Bo Meyer starts in 10 minutes', expect.stringMatching(/^Thu 5 Nov, 22:00 (PKT|GMT\+5) · 30 min video call$/), '/messages/conv-1',
      B, 'Your meeting with Ana Rivera starts in 10 minutes', expect.stringMatching(/^Thu 5 Nov, 18:00 (CET|GMT\+1) · 30 min video call$/), '/messages/conv-1',
    ]);
    const live = mockEmits.filter(([, event]) => event === 'notification:new');
    expect(live.map(([room]) => room).sort()).toEqual([`user:${A}`, `user:${B}`]);
    expect(live[0][2]).toMatchObject({ type: 'meeting_reminder', link: '/messages/conv-1', isRead: false });
    expect(tagsSentTo(A)).toContainEqual([`user:${A}:notifications`]);
    expect(tagsSentTo(B)).toContainEqual([`user:${B}:notifications`]);
  });

  it('tells both people\'s screens: their meetings and the meeting', async () => {
    arm([[due()]]);
    await processMeetingReminders(NOW);
    expect(tagsSentTo(A)).toContainEqual([`user:${A}:meetings`, 'meeting:mtg-1']);
    expect(tagsSentTo(B)).toContainEqual([`user:${B}:meetings`, 'meeting:mtg-1']);
  });

  it('emails each person whose notify_email switch is on, and only them', async () => {
    arm([[due()]], [person(A), person(B, { notify_email: false })]);

    await processMeetingReminders(NOW);

    expect(mockEmailEnabled).toHaveBeenCalledWith('meeting_reminder');
    expect(mockReminderEmail).toHaveBeenCalledTimes(1);
    const [to, name, data] = mockReminderEmail.mock.calls[0];
    expect([to, name]).toEqual(['ana@example.com', 'Ana Rivera']);
    expect(data).toEqual({
      partnerName: 'Bo Meyer', startAt: START, durationMin: 30, kind: 'video', recipientTimezone: 'Asia/Karachi',
      minutesToGo: 10, joinUrl: 'https://app.rsn.network/meet/conv-1?scheduled=1&kind=video', eventsUrl: 'https://app.rsn.network/sessions',
    });
  });

  it('sends no reminder emails while the admin switch for them is off; the bells still ring', async () => {
    arm([[due()]]);
    mockEmailEnabled.mockResolvedValue(false);

    await processMeetingReminders(NOW);

    expect(mockReminderEmail).not.toHaveBeenCalled();
    expect(bellRows()).toHaveLength(1);
  });

  it('reminds once: the next run finds the meeting already claimed and sends nothing', async () => {
    arm([[due()], []]);

    await processMeetingReminders(NOW);
    await processMeetingReminders(new Date(NOW.getTime() + 60_000));

    expect(bellRows()).toHaveLength(1);
    expect(mockReminderEmail).toHaveBeenCalledTimes(2);
  });

  it('two instances running at the same moment: the one whose claim gets the row reminds; the other sends nothing', async () => {
    arm([[due()], []]);

    const counts = await Promise.all([processMeetingReminders(NOW), processMeetingReminders(NOW)]);

    expect(counts.sort()).toEqual([0, 1]);
    expect(bellRows()).toHaveLength(1);
    expect(mockReminderEmail).toHaveBeenCalledTimes(2);
  });

  it('a meeting booked or moved inside the last 10 minutes was just confirmed in front of them: claimed, not reminded', async () => {
    arm([[due({ updated_at: new Date('2026-11-05T16:52:00Z') })]]);

    expect(await processMeetingReminders(NOW)).toBe(1);

    expect(bellRows()).toHaveLength(0);
    expect(mockReminderEmail).not.toHaveBeenCalled();
  });

  it('a reminder that goes out late (the server was restarting) says how long is really left', async () => {
    arm([[due()]]);

    await processMeetingReminders(new Date('2026-11-05T16:57:10Z'));

    expect((bellRows()[0][1] as string[])[1]).toBe('Your meeting with Bo Meyer starts in 3 minutes');
    expect(mockReminderEmail.mock.calls[0][2]).toMatchObject({ minutesToGo: 3 });
  });

  it('nobody is reminded of a meeting with a closed account, or with someone a block stands between', async () => {
    arm([[due()]], [person(A), person(B, { status: 'deactivated' })]);
    await processMeetingReminders(NOW);
    expect(bellRows()).toHaveLength(0);

    mockQuery.mockReset();
    arm([[due()]]);
    mockAreBlocked.mockResolvedValue(true);
    await processMeetingReminders(NOW);
    expect(mockAreBlocked).toHaveBeenCalledWith(A, B);
    expect(bellRows()).toHaveLength(0);
    expect(mockReminderEmail).not.toHaveBeenCalled();
  });

  it('one meeting that fails to send does not stop the next one', async () => {
    arm([[due({ id: 'mtg-broken' }), due({ id: 'mtg-2', conversation_id: 'conv-2' })]]);
    let first = true;
    const answer = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/INSERT INTO notifications/.test(sql) && first) { first = false; return Promise.reject(new Error('db hiccup')); }
      return answer(sql, params);
    });

    expect(await processMeetingReminders(NOW)).toBe(2);

    expect(bellRows()).toHaveLength(2);
    expect((bellRows()[1][1] as string[])[3]).toBe('/messages/conv-2');
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ meetingId: 'mtg-broken' }), expect.any(String));
  });
});
