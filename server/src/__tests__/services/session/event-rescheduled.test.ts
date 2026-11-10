// ─── The time-change notice (Part 2 foundation, Task 10) ─────────────────────────────────────────────────────────
//
// When a published, scheduled event's start moves, everyone with a place (and its host and co-hosts) but the person
// who moved it gets a bell and, with their switches on, an email: only while EVENT_COMMS is 'on'. A title change, or a
// draft, tells nobody. updateSession is the caller and is exercised here with a stand-in database; nothing is sent.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: jest.fn(),
}));
const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config', () => {
  const config = { clientUrl: 'https://app.rsn.network', eventComms: 'on' };
  return { __esModule: true, default: config, config };
});
const mockSocketEmit = jest.fn();
const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => ({ to: () => ({ emit: mockSocketEmit }) }),
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
  setRealtimeIo: jest.fn(),
}));
const mockSendMoved = jest.fn();
const mockEmailEnabled = jest.fn();
jest.mock('../../../services/email/email.service', () => new Proxy({}, {
  get: (_t, name) => {
    if (name === '__esModule') return true;
    if (name === 'isEmailTypeEnabled') return (...a: unknown[]) => mockEmailEnabled(...a);
    if (name === 'asBulkEmail') return (send: () => Promise<unknown>) => send();
    if (name === 'sendEventRescheduledEmail') return (...a: unknown[]) => mockSendMoved(...a);
    return () => Promise.resolve({ sent: false });
  },
}));
jest.mock('../../../services/pod/pod.service', () => ({
  __esModule: true,
  getPodById: jest.fn().mockResolvedValue({ id: 'pod', name: 'Pod', status: 'active', podType: 'speed_networking' }),
  getMemberRole: jest.fn().mockResolvedValue('director'),
}));

import { UserRole } from '@rsn/shared';
import config from '../../../config';
import { notifyEventRescheduled } from '../../../services/session/event-notices';
import { updateSession } from '../../../services/session/session.service';

const mutableConfig = config as unknown as { eventComms: 'off' | 'report' | 'on' };

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'user-actor-host';
const A = 'user-a';
const B = 'user-b';
const OLD = new Date('2026-11-17T13:00:00.000Z');
const NEW = new Date('2026-11-18T13:00:00.000Z');

let event: Record<string, unknown>;
let recipients: Array<Record<string, unknown>>;
let bells: Array<{ ids: string[]; titles: string[]; type: string; body: string; link: string }>;

const person = (id: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@example.test`, timezone: null, notify_email: true, ...extra,
});

function arm(session: Record<string, unknown> = {}) {
  const before = {
    id: SESSION_ID, podId: 'pod', title: 'Founders evening', status: 'scheduled', publication: 'published', hostUserId: ACTOR,
    scheduledAt: OLD, config: {}, ...session,
  };
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/^\s*UPDATE sessions SET/.test(sql)) {
      const next = params.find((p) => p instanceof Date || (typeof p === 'string' && /^2026-/.test(p)));
      return { rows: [{ ...before, title: before.title, scheduledAt: next ? new Date(next as string) : before.scheduledAt }], rowCount: 1 };
    }
    if (/SELECT s\.id, s\.title, s\.status::text AS status, s\.publication, s\.archived_at, s\.registration_opens_at\s+FROM sessions s WHERE s\.id = \$1/.test(sql)) {
      return { rows: [event], rowCount: 1 };
    }
    if (/FROM users u\s+WHERE u\.id <> \$2/.test(sql)) return { rows: recipients, rowCount: recipients.length };
    if (/INSERT INTO notifications/.test(sql)) {
      const [ids, titles, type, body, link] = params as [string[], string[], string, string, string];
      bells.push({ ids, titles, type, body, link });
      return { rows: ids.map((id, i) => ({ id: `n-${i}`, user_id: id, title: titles[i], created_at: new Date() })), rowCount: ids.length };
    }
    return { rows: [before], rowCount: 1 };
  });
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

beforeEach(() => {
  mutableConfig.eventComms = 'on';
  mockQuery.mockReset();
  mockWarn.mockClear();
  mockSocketEmit.mockClear();
  mockEmitEntities.mockClear();
  mockSendMoved.mockReset().mockResolvedValue({ sent: true });
  mockEmailEnabled.mockReset().mockResolvedValue(true);
  event = { id: SESSION_ID, title: 'Founders evening', status: 'scheduled', publication: 'published', archived_at: null, registration_opens_at: null };
  recipients = [person(A), person(B, { timezone: 'Asia/Karachi' })];
  bells = [];
  arm();
});

describe('notifyEventRescheduled', () => {
  it('on: each person gets one bell ("{title} has moved to {when}") in their own zone, and one email', async () => {
    const result = await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR);

    expect(result).toEqual({ notified: 2 });
    expect(bells).toHaveLength(1);
    expect(bells[0].type).toBe('event_rescheduled');
    expect(bells[0].ids).toEqual([A, B]);
    expect(bells[0].titles).toEqual([
      'Founders evening has moved to Wednesday 18 November, 13:00 (UTC)',
      'Founders evening has moved to Wednesday 18 November, 18:00 (GMT+5)',
    ]);
    expect(bells[0].link).toBe(`/sessions/${SESSION_ID}`);
    expect(mockSocketEmit).toHaveBeenCalledTimes(2);
    expect(mockSendMoved).toHaveBeenCalledTimes(2);
    expect(mockSendMoved.mock.calls[0]).toEqual([`${A}@example.test`, {
      eventTitle: 'Founders evening',
      previousWhen: 'Tuesday 17 November, 13:00 (UTC)',
      when: 'Wednesday 18 November, 13:00 (UTC)',
      link: `https://app.rsn.network/sessions/${SESSION_ID}`,
    }]);
  });

  it('the organiser who moved it is not told: the actor is excluded in the recipient statement', async () => {
    await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR);
    const recipientCall = mockQuery.mock.calls.find(([sql]) => /FROM users u\s+WHERE u\.id <> \$2/.test(String(sql)))!;
    expect(recipientCall[1]).toEqual([SESSION_ID, ACTOR]);
    const sql = String(recipientCall[0]);
    expect(sql).toMatch(/sp\.status NOT IN \('removed', 'left', 'no_show'\)/);
    expect(sql).toMatch(/session_cohosts/);
    expect(sql).toMatch(/u\.status = 'active'/);
  });

  it('rings but does not email a person whose email switch is off; nobody is emailed when the admin switch is off', async () => {
    recipients = [person(A, { notify_email: false }), person(B)];
    await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR);
    expect(mockSendMoved).toHaveBeenCalledTimes(1);

    mockSendMoved.mockClear();
    mockEmailEnabled.mockResolvedValue(false);
    const result = await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR);
    expect(result.notified).toBe(2);
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('off or report: nothing is read, rung or sent', async () => {
    for (const mode of ['off', 'report'] as const) {
      mutableConfig.eventComms = mode;
      expect(await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR)).toEqual({ notified: 0 });
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('the same time again tells nobody and reads nothing', async () => {
    expect(await notifyEventRescheduled(SESSION_ID, OLD, new Date(OLD.getTime()), ACTOR)).toEqual({ notified: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft', { publication: 'draft' }],
    ['an archived event', { archived_at: new Date() }],
    ['a cancelled event', { status: 'cancelled' }],
    ['a completed event', { status: 'completed' }],
    ['a live event', { status: 'lobby_open' }],
  ])('%s tells nobody', async (_label, extra) => {
    event = { ...event, ...extra };
    expect(await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR)).toEqual({ notified: 0 });
    expect(bells).toHaveLength(0);
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('an event with nobody to tell writes nothing', async () => {
    recipients = [];
    expect(await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR)).toEqual({ notified: 0 });
    expect(bells).toHaveLength(0);
  });

  it('never throws: a failing database is logged and the answer is nobody told', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    expect(await notifyEventRescheduled(SESSION_ID, OLD, NEW, ACTOR)).toEqual({ notified: 0 });
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('updateSession calls it only when the start moved on a published event', () => {
  const bellsRung = () => mockQuery.mock.calls.filter(([sql]) => /INSERT INTO notifications/.test(String(sql)));

  it('a new scheduledAt on a published, scheduled event tells the registrants, in the background', async () => {
    await updateSession(SESSION_ID, ACTOR, { scheduledAt: NEW.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(bellsRung()).toHaveLength(1);
    expect(mockSendMoved).toHaveBeenCalledTimes(2);
    const recipientCall = mockQuery.mock.calls.find(([sql]) => /FROM users u\s+WHERE u\.id <> \$2/.test(String(sql)))!;
    expect(recipientCall[1]).toEqual([SESSION_ID, ACTOR]);
  });

  it('a title change alone tells nobody', async () => {
    await updateSession(SESSION_ID, ACTOR, { title: 'Founders evening, renamed' }, UserRole.MEMBER);
    await settle();
    expect(bellsRung()).toHaveLength(0);
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('the same time sent again tells nobody', async () => {
    await updateSession(SESSION_ID, ACTOR, { scheduledAt: OLD.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(bellsRung()).toHaveLength(0);
  });

  it('a draft moves quietly: it has told nobody yet', async () => {
    arm({ publication: 'draft' });
    await updateSession(SESSION_ID, ACTOR, { scheduledAt: NEW.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(bellsRung()).toHaveLength(0);
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('with EVENT_COMMS off the edit goes through and nobody is told', async () => {
    mutableConfig.eventComms = 'off';
    const updated = await updateSession(SESSION_ID, ACTOR, { scheduledAt: NEW.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(updated.scheduledAt).toEqual(NEW);
    expect(bellsRung()).toHaveLength(0);
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('an event given its first time is not a move: nobody is told "it was ..."', async () => {
    arm({ scheduledAt: null });
    const updated = await updateSession(SESSION_ID, ACTOR, { scheduledAt: NEW.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(updated.scheduledAt).toEqual(NEW);
    expect(bellsRung()).toHaveLength(0);
    expect(mockSendMoved).not.toHaveBeenCalled();
    expect(mockSendMoved.mock.calls.flat().join(' ')).not.toMatch(/1970/);
  });

  it('the row read before the update carries publication, so a draft is known to be one', async () => {
    arm();
    await updateSession(SESSION_ID, ACTOR, { title: 'Renamed' }, UserRole.MEMBER);
    const read = mockQuery.mock.calls.find(([sql]) => /FROM sessions WHERE id = \$1/.test(String(sql)));
    expect(read).toBeDefined();
    expect(String(read![0])).toMatch(/publication,/);
  });

  it('a row that does not say it is published (no publication) never triggers a notice', async () => {
    arm({ publication: undefined });
    await updateSession(SESSION_ID, ACTOR, { scheduledAt: NEW.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(bellsRung()).toHaveLength(0);
    expect(mockSendMoved).not.toHaveBeenCalled();
  });

  it('a failing notice does not fail the edit', async () => {
    mockEmailEnabled.mockRejectedValue(new Error('config table down'));
    const updated = await updateSession(SESSION_ID, ACTOR, { scheduledAt: NEW.toISOString() }, UserRole.MEMBER);
    await settle();
    expect(updated.scheduledAt).toEqual(NEW);
  });
});
