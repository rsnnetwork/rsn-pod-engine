// ─── Event reminders, 24 hours and 1 hour before (Part 2 foundation, Task 10) ────────────────────────────────────
//
// The database is a small in-memory stand-in that follows the worker's statements: the due-events read, the claim
// (an INSERT ... ON CONFLICT DO NOTHING RETURNING into a unique key, with a pause between choosing the people and
// inserting them, so two "instances" really race), the bell INSERT and the emailed flag. The statements themselves
// are run against a real Postgres by the task's probe (the report names it); the text the rules rest on is asserted
// here too.
//
// Nothing here sends anything: the email service is a stand-in.

const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: (...a: unknown[]) => mockInfo(...a), debug: jest.fn() },
}));

jest.mock('../../../config', () => {
  const config = { clientUrl: 'https://app.rsn.network', eventComms: 'off' };
  return { __esModule: true, default: config, config };
});

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: jest.fn(),
}));

const mockEmits: Array<[string, string, unknown]> = [];
const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => ({ to: (room: string) => ({ emit: (event: string, payload: unknown) => { mockEmits.push([room, event, payload]); } }) }),
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
}));

const mockSendReminder = jest.fn();
const mockEmailEnabled = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  isEmailTypeEnabled: (...a: unknown[]) => mockEmailEnabled(...a),
  asBulkEmail: <T,>(send: () => Promise<T>) => send(),
  sendEventReminderEmail: (...a: unknown[]) => mockSendReminder(...a),
}));

import config from '../../../config';
import {
  CLAIM_SQL, DUE_EVENTS_SQL, EVENT_REMINDERS_PER_TICK, EVENT_REMINDER_INTERVAL_MS, EVENT_REPORT_REPEAT_MS,
  OWED_SQL, processEventReminders, reminderKindFor, resetEventReminderReport,
} from '../../../services/session/event-reminder.worker';
import { relativeEventTime } from '@rsn/shared';

const mutableConfig = config as unknown as { eventComms: 'off' | 'report' | 'on' };

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-11-12T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const EVENT_ID = 'aaaaaaaa-0000-4000-8000-00000000e001';
const HOST = 'hhhhhhhh-0000-4000-8000-000000000001';
const COHOST = 'cccccccc-0000-4000-8000-000000000002';
const uid = (n: number) => `uuuuuuuu-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface FakeEvent {
  id: string; title: string; scheduled_at: Date | null; status: string; publication: string;
  archived_at: Date | null; registration_opens_at: Date | null;
  timezone: string | null; has_image: boolean; image_updated_at: Date | null;
}
interface FakeUser {
  id: string; email: string | null; timezone: string | null; status: string; notify_email: boolean; notify_event_reminders: boolean;
}
interface FakeParticipant { session_id: string; user_id: string; status: string; created_at: Date }

const world = {
  dbNow: NOW,
  events: [] as FakeEvent[],
  users: [] as FakeUser[],
  participants: [] as FakeParticipant[],
  cohosts: [] as Array<{ session_id: string; user_id: string }>,
  sends: new Map<string, { emailed: boolean }>(),
  bells: [] as Array<{ user_id: string; type: string; title: string; body: string; link: string }>,
  claimStatements: 0,
};

const sendKey = (sessionId: string, userId: string, kind: string, scheduledFor: Date) => `${sessionId}|${userId}|${kind}|${scheduledFor.getTime()}`;

const event = (extra: Partial<FakeEvent> = {}): FakeEvent => ({
  id: EVENT_ID, title: 'Founders evening', scheduled_at: at(23 * HOUR), status: 'scheduled', publication: 'published',
  archived_at: null, registration_opens_at: null, timezone: null, has_image: false, image_updated_at: null, ...extra,
});
const user = (id: string, extra: Partial<FakeUser> = {}): FakeUser => ({
  id, email: `${id}@example.test`, timezone: null, status: 'active', notify_email: true, notify_event_reminders: true, ...extra,
});
const registered = (userId: string, agoMs: number, status = 'registered'): FakeParticipant => ({
  session_id: EVENT_ID, user_id: userId, status, created_at: at(-agoMs),
});

/** The people the OWED statement would choose, as its SQL reads: held a place for long enough, host, co-hosts, switches on. */
function owedFor(params: unknown[]) {
  const [sessionId, kind, scheduledFor, nowAt, minMinutes, limit] = params as [string, string, Date, Date, number, number];
  const cutoff = nowAt.getTime() - minMinutes * MIN;
  const ids = new Set<string>();
  for (const p of world.participants) {
    if (p.session_id !== sessionId || ['removed', 'left', 'no_show'].includes(p.status) || p.created_at.getTime() > cutoff) continue;
    ids.add(p.user_id);
  }
  for (const c of world.cohosts) if (c.session_id === sessionId) ids.add(c.user_id);
  const host = world.events.find((e) => e.id === sessionId);
  if (host) ids.add(HOST);
  return world.users
    .filter((u) => ids.has(u.id) && u.status === 'active' && u.notify_event_reminders)
    .filter((u) => !world.sends.has(sendKey(sessionId, u.id, kind, scheduledFor)))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((u) => ({ user_id: u.id, email: u.email, timezone: u.timezone, notify_email: u.notify_email }));
}

function arm() {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql === DUE_EVENTS_SQL) {
      const nowAt = (params[0] as Date | null) ?? world.dbNow;
      return {
        rows: world.events
          .filter((e) => e.scheduled_at && e.scheduled_at > nowAt && e.scheduled_at.getTime() <= nowAt.getTime() + 24 * HOUR)
          .map((e) => ({ ...e, now_at: nowAt })),
      };
    }
    if (sql === OWED_SQL) return { rows: owedFor(params) };
    if (sql === CLAIM_SQL) {
      world.claimStatements += 1;
      const owed = owedFor(params);
      await Promise.resolve(); // the other instance's statement runs here
      await new Promise((resolve) => setImmediate(resolve));
      const [sessionId, kind, scheduledFor] = params as [string, string, Date];
      const won = owed.filter((o) => {
        const key = sendKey(sessionId, o.user_id, kind, scheduledFor);
        if (world.sends.has(key)) return false;
        world.sends.set(key, { emailed: false });
        return true;
      });
      return { rows: won };
    }
    if (/INSERT INTO notifications/.test(sql)) {
      const [ids, titles, type, body, link] = params as [string[], string[], string, string, string];
      const rows = ids.map((id, i) => ({ id: `n-${world.bells.length + i}`, user_id: id, title: titles[i], created_at: NOW }));
      ids.forEach((id, i) => world.bells.push({ user_id: id, type, title: titles[i], body, link }));
      return { rows };
    }
    if (/UPDATE event_reminder_sends SET emailed = TRUE/.test(sql)) {
      const [sessionId, kind, scheduledFor, ids] = params as [string, string, Date, string[]];
      for (const id of ids) {
        const row = world.sends.get(sendKey(sessionId, id, kind, scheduledFor));
        if (row) row.emailed = true;
      }
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  });
}

const run = (overrides: { now?: Date; mode?: 'off' | 'report' | 'on' } = {}) =>
  processEventReminders(overrides.now ?? NOW, overrides.mode ?? 'on');

beforeEach(() => {
  world.dbNow = NOW;
  world.events = [event()];
  world.users = [user(HOST), user(COHOST), user(uid(1)), user(uid(2))];
  world.participants = [registered(uid(1), 5 * HOUR), registered(uid(2), 5 * HOUR)];
  world.cohosts = [{ session_id: EVENT_ID, user_id: COHOST }];
  world.sends.clear();
  world.bells = [];
  world.claimStatements = 0;
  mockQuery.mockReset();
  mockInfo.mockClear();
  mockWarn.mockClear();
  mockEmits.length = 0;
  mockEmitEntities.mockClear();
  mockSendReminder.mockReset().mockResolvedValue({ sent: true });
  mockEmailEnabled.mockReset().mockResolvedValue(true);
  mutableConfig.eventComms = 'off';
  resetEventReminderReport();
  arm();
});

describe('the statements the rules rest on', () => {
  it('reads only published, scheduled, unarchived events that have a start, within 24 hours, on the database clock', () => {
    expect(DUE_EVENTS_SQL).toMatch(/s\.status = 'scheduled' AND s\.publication = 'published' AND s\.archived_at IS NULL/);
    expect(DUE_EVENTS_SQL).toMatch(/s\.scheduled_at IS NOT NULL/);
    expect(DUE_EVENTS_SQL).toMatch(/COALESCE\(\$1::timestamptz, NOW\(\)\) \+ INTERVAL '24 hours'/);
  });

  it('claims with INSERT ... ON CONFLICT DO NOTHING RETURNING on the (event, person, kind, planned start) key', () => {
    expect(CLAIM_SQL).toMatch(/INSERT INTO event_reminder_sends \(session_id, user_id, kind, scheduled_for\)/);
    expect(CLAIM_SQL).toMatch(/ON CONFLICT \(session_id, user_id, kind, scheduled_for\) DO NOTHING\s+RETURNING user_id/);
  });

  it('owes a reminder only to an active person with the event-reminders switch on, who is not removed, left or no-show', () => {
    expect(OWED_SQL).toMatch(/u\.status = 'active' AND u\.notify_event_reminders = TRUE/);
    expect(OWED_SQL).toMatch(/sp\.status NOT IN \('removed', 'left', 'no_show'\)/);
    expect(OWED_SQL).toMatch(/session_cohosts/);
    expect(OWED_SQL).toMatch(/s\.host_user_id/);
  });

  it('runs every minute, at most 200 claims a tick', () => {
    expect(EVENT_REMINDER_INTERVAL_MS).toBe(60_000);
    expect(EVENT_REMINDERS_PER_TICK).toBe(200);
  });
});

describe('the window an event is in', () => {
  it('is 1h up to and including 60 minutes, 24h beyond that up to and including 24 hours, nothing outside', () => {
    expect(reminderKindFor(at(1), NOW)).toEqual({ kind: '1h', minRegisteredMinutes: 10 });
    expect(reminderKindFor(at(HOUR), NOW)).toEqual({ kind: '1h', minRegisteredMinutes: 10 });
    expect(reminderKindFor(at(HOUR + 1), NOW)).toEqual({ kind: '24h', minRegisteredMinutes: 30 });
    expect(reminderKindFor(at(24 * HOUR), NOW)).toEqual({ kind: '24h', minRegisteredMinutes: 30 });
    expect(reminderKindFor(at(24 * HOUR + 1), NOW)).toBeNull();
    expect(reminderKindFor(at(0), NOW)).toBeNull();
    expect(reminderKindFor(at(-MIN), NOW)).toBeNull();
  });
});

describe('processEventReminders: off', () => {
  it('selects and sends nothing: no query at all, whatever is due', async () => {
    const result = await processEventReminders(NOW, 'off');
    expect(result).toEqual({ due: 0, claimed: 0, belled: 0, emailed: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendReminder).not.toHaveBeenCalled();
    expect(mockEmailEnabled).not.toHaveBeenCalled();
  });

  it('is what the server does when EVENT_COMMS is not set: the config default is off', async () => {
    mutableConfig.eventComms = 'off';
    await processEventReminders(NOW);
    expect(mockQuery).not.toHaveBeenCalled();
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../../config/index.ts'), 'utf8') as string;
    expect(source).toMatch(/eventComms: \(\['off', 'report', 'on'\] as const\)\s+\.find\(m => m === process\.env\.EVENT_COMMS\) \?\? 'off'/);
  });

  it('takes its mode from config when none is passed', async () => {
    mutableConfig.eventComms = 'on';
    await processEventReminders(NOW);
    expect(world.sends.size).toBe(4);
  });
});

describe('processEventReminders: on, an event 23 hours away', () => {
  it('claims one 24h reminder for each eligible person (members, host, co-host), rings each once and emails each once', async () => {
    const result = await run();

    expect(result).toEqual({ due: 1, claimed: 4, belled: 4, emailed: 4 });
    expect([...world.sends.keys()].every((k) => k.includes('|24h|'))).toBe(true);
    expect(world.bells.map((b) => b.user_id).sort()).toEqual([HOST, COHOST, uid(1), uid(2)].sort());
    expect(world.bells.every((b) => b.type === 'event_reminder' && b.body === 'Join from the event page.' && b.link === `/sessions/${EVENT_ID}`)).toBe(true);
    expect(mockSendReminder).toHaveBeenCalledTimes(4);
    expect([...world.sends.values()].every((s) => s.emailed)).toBe(true);
  });

  it('writes every bell on the event\'s clock, naming its zone, whatever each person\'s own zone (Part 3 Task 1)', async () => {
    world.events = [event({ timezone: 'Asia/Karachi' })];
    world.users = [user(HOST, { timezone: 'Europe/Copenhagen' }), user(COHOST), user(uid(1)), user(uid(2))];
    await run();
    const bell = (id: string) => world.bells.find((b) => b.user_id === id)!.title;
    expect(bell(HOST)).toBe('Founders evening starts tomorrow at 16:00 (GMT+5)');
    expect(bell(uid(1))).toBe('Founders evening starts tomorrow at 16:00 (GMT+5)');
  });

  it('an event with no zone of its own reads UTC, and says so', async () => {
    await run();
    expect(world.bells.every((b) => b.title === 'Founders evening starts tomorrow at 11:00 (UTC)')).toBe(true);
  });

  it('emails "Reminder: ..." data with the relative time and the event page, through the bulk lane', async () => {
    await run();
    const [to, data] = mockSendReminder.mock.calls.find(([address]) => address === `${uid(1)}@example.test`)!;
    expect(to).toBe(`${uid(1)}@example.test`);
    expect(data).toEqual({ eventTitle: 'Founders evening', when: 'tomorrow at 11:00 (UTC)', link: `https://app.rsn.network/sessions/${EVENT_ID}`, imageUrl: null });
  });

  it('pushes each bell to the person\'s screens and tells them to refetch their notifications', async () => {
    await run();
    expect(mockEmits.filter(([, event]) => event === 'notification:new')).toHaveLength(4);
    expect(mockEmitEntities).toHaveBeenCalledTimes(4);
  });

  it('a second run claims nobody: the reminder is sent once', async () => {
    await run();
    mockSendReminder.mockClear();
    const again = await run();
    expect(again).toMatchObject({ claimed: 0, belled: 0, emailed: 0 });
    expect(mockSendReminder).not.toHaveBeenCalled();
    expect(world.bells).toHaveLength(4);
  });

  it('two runs at once (two server instances) tell each person once: the unique key decides, not memory', async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect(world.claimStatements).toBe(2);
    expect(a.claimed + b.claimed).toBe(4);
    expect(world.bells).toHaveLength(4);
    expect(mockSendReminder).toHaveBeenCalledTimes(4);
    expect(new Set(world.bells.map((x) => x.user_id)).size).toBe(4);
  });

  it('a person registered 5 minutes ago is not reminded (30 minutes needed for the 24h one); the others are', async () => {
    world.participants = [registered(uid(1), 5 * MIN), registered(uid(2), 31 * MIN)];
    await run();
    expect(world.bells.map((b) => b.user_id).sort()).toEqual([HOST, COHOST, uid(2)].sort());
  });

  it('is told only to people whose event-reminders switch is on and whose account is active', async () => {
    world.users = [user(HOST), user(COHOST, { status: 'deactivated' }), user(uid(1), { notify_event_reminders: false }), user(uid(2))];
    await run();
    expect(world.bells.map((b) => b.user_id).sort()).toEqual([HOST, uid(2)].sort());
    expect(mockSendReminder).toHaveBeenCalledTimes(2);
  });

  it.each(['removed', 'left', 'no_show'])('does not remind someone who is %s', async (status) => {
    world.participants = [registered(uid(1), 5 * HOUR, status), registered(uid(2), 5 * HOUR)];
    await run();
    expect(world.bells.map((b) => b.user_id)).not.toContain(uid(1));
    expect(world.bells.map((b) => b.user_id)).toContain(uid(2));
  });

  it('rings but does not email a person whose email switch is off, and nobody when the admin\'s switch is off', async () => {
    world.users = [user(HOST), user(COHOST), user(uid(1), { notify_email: false }), user(uid(2))];
    await run();
    expect(world.bells).toHaveLength(4);
    expect(mockSendReminder).toHaveBeenCalledTimes(3);
    expect(world.sends.get(sendKey(EVENT_ID, uid(1), '24h', world.events[0].scheduled_at as Date))!.emailed).toBe(false);

    world.sends.clear();
    world.bells = [];
    mockSendReminder.mockClear();
    mockEmailEnabled.mockResolvedValue(false);
    const result = await run();
    expect(result).toMatchObject({ belled: 4, emailed: 0 });
    expect(mockSendReminder).not.toHaveBeenCalled();
  });

  it('a failed email is not retried: the claim stands, the bell was rung, the next tick sends nothing', async () => {
    mockSendReminder.mockRejectedValue(new Error('provider down'));
    const first = await run();
    expect(first).toMatchObject({ claimed: 4, belled: 4, emailed: 0 });
    mockSendReminder.mockClear();
    const second = await run();
    expect(second.claimed).toBe(0);
    expect(mockSendReminder).not.toHaveBeenCalled();
  });

  it('claims at most 200 people in a tick; the rest are claimed on the next', async () => {
    world.users = [user(HOST)];
    world.participants = [];
    world.cohosts = [];
    for (let i = 1; i <= 250; i += 1) {
      world.users.push(user(uid(i)));
      world.participants.push(registered(uid(i), 5 * HOUR));
    }
    const first = await run();
    expect(first.claimed).toBe(200);
    const second = await run();
    expect(second.claimed).toBe(51);
    expect(world.bells).toHaveLength(251);
  });
});

describe('processEventReminders: an event 40 minutes away', () => {
  beforeEach(() => {
    world.events = [event({ scheduled_at: at(40 * MIN) })];
  });

  it('is the 1h reminder, for people registered at least 10 minutes ago', async () => {
    world.participants = [registered(uid(1), 5 * MIN), registered(uid(2), 15 * MIN)];
    await run();
    expect([...world.sends.keys()].every((k) => k.includes('|1h|'))).toBe(true);
    expect(world.bells.map((b) => b.user_id).sort()).toEqual([HOST, COHOST, uid(2)].sort());
    expect(world.bells[0].title).toBe('Founders evening starts in 40 minutes');
  });

  it('a person who had the 24h reminder is reminded again at the hour (a different kind)', async () => {
    world.events = [event({ scheduled_at: at(23 * HOUR) })];
    await run();
    world.bells = [];
    const later = at(22 * HOUR + 30 * MIN); // 30 minutes to go
    world.dbNow = later;
    await run({ now: later });
    expect(world.bells).toHaveLength(4);
    expect(world.bells[0].title).toBe('Founders evening starts in 30 minutes');
  });
});

describe('processEventReminders: events that must never be reminded', () => {
  it.each([
    ['a draft', { publication: 'draft' }],
    ['an archived event', { archived_at: at(-HOUR) }],
    ['a cancelled event', { status: 'cancelled' }],
    ['a completed event', { status: 'completed' }],
    ['a live event', { status: 'round_active' }],
    ['an event with no start', { scheduled_at: null }],
  ])('%s', async (_label, extra) => {
    world.events = [event(extra as Partial<FakeEvent>)];
    const result = await run();
    expect(result).toEqual({ due: 0, claimed: 0, belled: 0, emailed: 0 });
    expect(world.sends.size).toBe(0);
    expect(world.bells).toHaveLength(0);
    expect(mockSendReminder).not.toHaveBeenCalled();
    expect(world.claimStatements).toBe(0);
  });

  it('an event more than 24 hours away is not due yet', async () => {
    world.events = [event({ scheduled_at: at(25 * HOUR) })];
    expect((await run()).due).toBe(0);
  });
});

describe('processEventReminders: a moved event', () => {
  it('moved from tomorrow to the day after: reminded again at its new time, once', async () => {
    await run();
    expect(world.bells).toHaveLength(4);

    world.events = [event({ scheduled_at: at(47 * HOUR) })];
    const later = at(30 * HOUR); // 17 hours to the new start
    world.dbNow = later;
    const moved = await run({ now: later });
    expect(moved.claimed).toBe(4);
    expect(world.bells).toHaveLength(8);
    const again = await run({ now: later });
    expect(again.claimed).toBe(0);
  });

  it('moved back to a start it was already reminded for: nobody is told twice', async () => {
    await run();
    world.events = [event({ scheduled_at: at(47 * HOUR) })];
    await run({ now: at(30 * HOUR) });
    world.events = [event({ scheduled_at: at(23 * HOUR) })];
    const back = await run({ now: at(31 * MIN) });
    expect(back.claimed).toBe(0);
  });
});

describe('processEventReminders: report mode', () => {
  it('writes no row, rings no bell, sends no email, and logs how many people it would tell', async () => {
    const result = await run({ mode: 'report' });

    expect(result).toEqual({ due: 1, claimed: 0, belled: 0, emailed: 0 });
    expect(world.sends.size).toBe(0);
    expect(world.bells).toHaveLength(0);
    expect(mockSendReminder).not.toHaveBeenCalled();
    expect(mockEmailEnabled).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.every(([sql]) => !/\b(INSERT|UPDATE)\b/i.test(String(sql)))).toBe(true);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [fields, message] = mockInfo.mock.calls[0];
    expect(fields).toMatchObject({ mode: 'report', people: 4, events: [{ sessionId: EVENT_ID, kind: '24h', people: 4 }] });
    expect(message).toMatch(/would remind/);
  });

  it('logs an unchanged list again only after 30 minutes', async () => {
    await run({ mode: 'report' });
    await run({ mode: 'report', now: at(MIN) });
    expect(mockInfo).toHaveBeenCalledTimes(1);
    await run({ mode: 'report', now: at(EVENT_REPORT_REPEAT_MS) });
    expect(mockInfo).toHaveBeenCalledTimes(2);
  });

  it('logs nothing when nobody is due a reminder', async () => {
    world.events = [event({ publication: 'draft' })];
    await run({ mode: 'report' });
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe('the database\'s clock', () => {
  it('asks the database for now (null) when no clock is passed, and works from the time it answers with', async () => {
    world.dbNow = new Date('2026-11-12T14:00:00.000Z'); // two hours later than the machine's NOW
    world.events = [event({ scheduled_at: new Date('2026-11-12T14:40:00.000Z') })];
    await processEventReminders(undefined, 'on');
    expect(mockQuery.mock.calls[0][1]).toEqual([null]);
    expect(world.bells[0].title).toBe('Founders evening starts in 40 minutes');
  });
});

describe('relativeEventTime (shared, Part 3 Task 1: the event\'s clock, its zone named)', () => {
  const from = new Date('2026-11-12T12:00:00.000Z');
  it.each([
    [59 * MIN, null, 'in 59 minutes'],
    [60 * MIN, null, 'in 1 hour'],
    [MIN, null, 'in 1 minute'],
    [3 * HOUR, null, 'in 3 hours'],
    [6 * HOUR, null, 'today at 18:00 (UTC)'],
    [23 * HOUR, null, 'tomorrow at 11:00 (UTC)'],
    [23 * HOUR, 'Asia/Karachi', 'tomorrow at 16:00 (GMT+5)'],
    [23 * HOUR, 'Not/AZone', 'tomorrow at 11:00 (UTC)'],
    [-MIN, null, 'now'],
  ])('%i ms ahead in %s reads "%s"', (ahead, zone, expected) => {
    expect(relativeEventTime(new Date(from.getTime() + (ahead as number)), from, zone as string | null)).toBe(expected);
  });
});
