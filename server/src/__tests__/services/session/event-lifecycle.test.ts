// ─── An event's lifecycle: publish, unpublish, cancel with notice, archive, delete for good (Part 2 Task 2) ───────
//
// The service against an in-memory event: each step is held to the shared rule (404 for a draft the person does not
// run, 403 for someone who could never take the step, 409 in words for a state that does not allow it), writes its
// guarded UPDATE and its audit row in one transaction, then tells every screen. Cancelling rings everyone who held a
// place (not removed) and every co-host once, emails those whose switches are on, and never twice. Deleting for good
// needs the event's name and writes the event.deleted snapshot with the deletes. The real SQL is probed against
// Postgres for the task report; this file holds the behaviour.

import { UserRole, eventAllowedActions } from '@rsn/shared';

// ── The event, in memory ────────────────────────────────────────────────────

interface Participant { user_id: string; status: string }
interface Ev {
  id: string; title: string; status: string; publication: 'draft' | 'published'; archived_at: Date | null;
  registration_opens_at: Date | null; scheduled_at: Date | null; pod_id: string | null; circle_id: string | null;
  timezone: string | null;
  host: string; cohosts: string[]; participants: Participant[]; cancel_reason: string | null; cancelled_by: string | null;
}
interface Person { id: string; email: string | null; timezone: string | null; notify_email: boolean; active: boolean; name: string }

const EVENT_ID = '5e550000-0000-4000-8000-000000000001';
const HOST = 'u-host';
const COHOST = 'u-cohost';
const MEMBER = 'u-member';
const OTHER = 'u-other';
const REMOVED = 'u-removed';
const QUIET = 'u-quiet';
const ADMIN = 'u-admin';
const SUPER = 'u-super';

let ev: Ev | null;
let people: Record<string, Person>;
let podAdmins: string[];
let beforeNextWrite: (() => void) | null = null;
const bells: Array<{ user_id: string; type: string; title: string; body: string; link: string }> = [];
const updates: string[] = [];

function freshEvent(over: Partial<Ev> = {}): Ev {
  return {
    id: EVENT_ID, title: 'Founders breakfast', status: 'scheduled', publication: 'published', archived_at: null,
    registration_opens_at: null, scheduled_at: new Date('2026-11-20T08:00:00.000Z'), pod_id: 'pod-1', circle_id: null,
    timezone: 'Europe/Copenhagen',
    host: HOST, cohosts: [COHOST], participants: [{ user_id: HOST, status: 'registered' }],
    cancel_reason: null, cancelled_by: null, ...over,
  };
}

const LIVE = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'];
const placesHeld = (e: Ev) => e.participants.filter((p) => p.status !== 'removed' && p.user_id !== e.host && !e.cohosts.includes(p.user_id)).length;

/** One client statement, answered from the event in memory the way Postgres would. */
async function clientQuery(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  if (sql.includes('FOR UPDATE OF s')) {
    if (!ev || params[0] !== ev.id) return { rows: [], rowCount: 0 };
    const actor = params[1] as string;
    return {
      rows: [{
        id: ev.id, title: ev.title, status: ev.status, publication: ev.publication, archived_at: ev.archived_at,
        registration_opens_at: ev.registration_opens_at, scheduled_at: ev.scheduled_at, timezone: ev.timezone,
        pod_id: ev.pod_id, circle_id: ev.circle_id,
        is_owner: ev.host === actor, is_cohost: ev.cohosts.includes(actor), is_pod_admin: podAdmins.includes(actor),
        places_held: placesHeld(ev),
      }],
      rowCount: 1,
    };
  }
  if (!ev) return { rows: [], rowCount: 0 };
  // Something another request does between the step's read and its write (a place is not held by the row lock).
  if (beforeNextWrite) { const act = beforeNextWrite; beforeNextWrite = null; act(); }
  const done = (ok: boolean, apply: () => void) => {
    if (ok) apply();
    updates.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: ok ? [{ id: ev!.id }] : [], rowCount: ok ? 1 : 0 };
  };
  if (/SET publication = 'published'/.test(sql)) return done(ev.publication === 'draft', () => { ev!.publication = 'published'; });
  if (/SET publication = 'draft'/.test(sql)) {
    expect(sql).toContain('= 0');
    return done(ev.publication === 'published' && ev.status === 'scheduled' && !ev.archived_at && placesHeld(ev) === 0,
      () => { ev!.publication = 'draft'; });
  }
  if (/SET status = 'cancelled'/.test(sql)) {
    return done(!['cancelled', 'completed', ...LIVE].includes(ev.status), () => {
      ev!.status = 'cancelled'; ev!.cancelled_by = params[1] as string; ev!.cancel_reason = params[2] as string | null;
    });
  }
  if (/SET archived_at = NOW\(\)/.test(sql)) {
    return done(!ev.archived_at && ['completed', 'cancelled'].includes(ev.status), () => { ev!.archived_at = new Date(); });
  }
  if (/SET archived_at = NULL/.test(sql)) return done(!!ev.archived_at, () => { ev!.archived_at = null; });
  throw new Error(`unexpected client statement: ${sql}`);
}

/** A statement outside the step's transaction: the cancel notice's reads and its bells. */
async function poolQuery(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  if (/FROM users u\s+WHERE u.id <> \$2/.test(sql)) {
    const actor = params[1] as string;
    const ids = new Set([
      ...ev!.participants.filter((p) => p.status !== 'removed').map((p) => p.user_id),
      ...ev!.cohosts,
    ]);
    const rows = [...ids].filter((id) => id !== actor && people[id]?.active)
      .map((id) => ({ id, email: people[id].email, timezone: people[id].timezone, notify_email: people[id].notify_email }));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('INSERT INTO notifications')) {
    expect(sql).toContain("'event_cancelled'");
    const ids = params[0] as string[];
    const rows = ids.map((user_id, i) => {
      bells.push({ user_id, type: 'event_cancelled', title: params[1] as string, body: params[2] as string, link: params[3] as string });
      return { id: `bell-${bells.length}-${i}`, user_id, created_at: new Date() };
    });
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith('SELECT pod_id, publication FROM sessions')) {
    return { rows: ev ? [{ pod_id: ev.pod_id, publication: ev.publication }] : [], rowCount: ev ? 1 : 0 };
  }
  if (sql.startsWith('SELECT display_name FROM users')) {
    return { rows: [{ display_name: people[params[0] as string]?.name ?? null }], rowCount: 1 };
  }
  throw new Error(`unexpected statement: ${sql}`);
}

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockClient = { query: (sql: string, params: unknown[]) => clientQuery(sql, params) };
jest.mock('../../../db', () => ({
  query: (sql: string, params: unknown[]) => poolQuery(sql, params),
  transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../config', () => {
  const config = { clientUrl: 'https://app.rsn.network' };
  return { config, default: config, __esModule: true };
});

// The real guard is a per-event promise chain; this one is the same idea in a few lines, so concurrent steps queue.
const mockLocks = new Map<string, Promise<unknown>>();
jest.mock('../../../services/orchestration/state/session-state', () => ({
  withSessionGuard: async (id: string, fn: () => Promise<unknown>) => {
    const before = mockLocks.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(fn);
    mockLocks.set(id, run.catch(() => undefined));
    return run;
  },
  __esModule: true,
}));

const mockAudit = jest.fn();
const mockAuditChanged = jest.fn();
jest.mock('../../../services/audit/event-audit', () => ({
  recordEventAudit: (...args: unknown[]) => mockAudit(...args),
  emitEventAuditChanged: (...args: unknown[]) => mockAuditChanged(...args),
  __esModule: true,
}));

const mockFanoutSession = jest.fn().mockResolvedValue(undefined);
const mockFanoutLists = jest.fn().mockResolvedValue(undefined);
const mockListAudience = jest.fn().mockResolvedValue(['u-host', 'u-member']);
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: (...args: unknown[]) => mockFanoutSession(...args),
  fanoutSessionListEntities: (...args: unknown[]) => mockFanoutLists(...args),
  resolveSessionListAudience: (...args: unknown[]) => mockListAudience(...args),
  __esModule: true,
}));

const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
const mockSocketEmit = jest.fn();
const mockIo = { to: jest.fn(() => ({ emit: mockSocketEmit })) };
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  __esModule: true,
}));

const mockAnnounce = jest.fn().mockResolvedValue(undefined);
const mockReadCircle = jest.fn();
jest.mock('../../../services/circle/circle-events.service', () => ({
  announceCircleEvent: (...args: unknown[]) => mockAnnounce(...args),
  readEventCircle: (...args: unknown[]) => mockReadCircle(...args),
  __esModule: true,
}));

let mockEmailSwitch = true;
const mockSendCancelled = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../../../services/email/email.service', () => ({
  isEmailTypeEnabled: async (type: string) => (type === 'event_cancelled' ? mockEmailSwitch : true),
  asBulkEmail: <T>(send: () => Promise<T>) => send(),
  sendEventCancelledEmail: (...args: unknown[]) => mockSendCancelled(...args),
  __esModule: true,
}));

const mockHardDelete = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/session/session.service', () => ({
  hardDeleteSession: (...args: unknown[]) => mockHardDelete(...args),
  __esModule: true,
}));

import {
  publishEvent, unpublishEvent, cancelEvent, archiveEvent, unarchiveEvent, deleteEventPermanently,
  summariseEventLifecycle,
} from '../../../services/session/event-lifecycle.service';
import type { Actor } from '../../../services/roles/actor';

const as = (userId: string, role: UserRole = UserRole.MEMBER): Actor => ({ userId, role });
const host = as(HOST);
const cohost = as(COHOST);
const member = as(MEMBER);
const admin = as(ADMIN, UserRole.ADMIN);
const superAdmin = as(SUPER, UserRole.SUPER_ADMIN);

/** Lets the emails sent in the background (after the step returned) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  ev = freshEvent();
  podAdmins = [];
  people = Object.fromEntries([
    [HOST, 'Hana Host', 'Europe/Berlin'], [COHOST, 'Cody Cohost', null], [MEMBER, 'Mia Member', 'Asia/Karachi'],
    [OTHER, 'Otto Other', null], [REMOVED, 'Remy Removed', null], [QUIET, 'Quinn Quiet', null],
    [ADMIN, 'Ada Admin', null], [SUPER, 'Sam Super', null],
  ].map(([id, name, timezone]) => [id, {
    id: id as string, name: name as string, timezone: timezone as string | null,
    email: `${id}@example.org`, notify_email: id !== QUIET, active: true,
  }]));
  bells.length = 0;
  updates.length = 0;
  beforeNextWrite = null;
  mockLocks.clear();
  mockEmailSwitch = true;
  jest.clearAllMocks();
  mockSendCancelled.mockResolvedValue({ sent: true });
  mockListAudience.mockResolvedValue(['u-host', 'u-member']);
});

function expectToldEveryone(listAudience?: string[]): void {
  expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT_ID);
  expect(mockFanoutLists).toHaveBeenCalledWith('pod-1', EVENT_ID, listAudience);
  expect(mockAuditChanged).toHaveBeenCalledWith(EVENT_ID);
}

function auditActions(): string[] {
  return mockAudit.mock.calls.map(([entry]) => (entry as { action: string }).action);
}

// ── Publish / unpublish ─────────────────────────────────────────────────────

describe('publish and unpublish', () => {
  it('the host publishes a draft: one guarded UPDATE, the audit row in the same transaction, every screen told', async () => {
    ev = freshEvent({ publication: 'draft' });
    await publishEvent(EVENT_ID, host);
    expect(ev.publication).toBe('published');
    expect(updates[0]).toContain("published_at = COALESCE(published_at, NOW())");
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: EVENT_ID, actorId: HOST, action: 'event.published', automatic: false }), mockClient,
    );
    expectToldEveryone();
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it('a draft for a circle rings the circle when it is published (creating it as a draft rang nobody)', async () => {
    ev = freshEvent({ publication: 'draft', circle_id: 'circle-1' });
    mockReadCircle.mockResolvedValue({ id: 'circle-1', name: 'Founding Circle' });
    await publishEvent(EVENT_ID, cohost);
    expect(mockAnnounce).toHaveBeenCalledWith({ sessionId: EVENT_ID, actorId: COHOST, circle: { id: 'circle-1', name: 'Founding Circle' } });
  });

  it('a member is answered 404 for someone else\'s draft, with the words an unknown id gets, and nothing is written', async () => {
    ev = freshEvent({ publication: 'draft' });
    await expect(publishEvent(EVENT_ID, member)).rejects.toMatchObject({ statusCode: 404, message: "We couldn't find that event." });
    ev = null;
    await expect(publishEvent(EVENT_ID, member)).rejects.toMatchObject({ statusCode: 404, message: "We couldn't find that event." });
    expect(updates).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('publishing what is already published is 409 in words', async () => {
    await expect(publishEvent(EVENT_ID, host)).rejects.toMatchObject({
      statusCode: 409, code: 'EVENT_LIFECYCLE_NOT_ALLOWED', message: 'This event is already published.',
    });
  });

  it('a published event nobody registered for goes back to a draft', async () => {
    await unpublishEvent(EVENT_ID, cohost);
    expect(ev!.publication).toBe('draft');
    expect(auditActions()).toEqual(['event.unpublished']);
    // Fix round 1: the lists that showed it are read while it is still published (afterwards a draft's fan-outs reach
    // its organisers only) and told with their own list tags; its own tags go through the draft-aware fan-out.
    expect(mockListAudience).toHaveBeenCalledWith('pod-1', EVENT_ID);
    expectToldEveryone(['u-host', 'u-member']);
  });

  it('once anyone holds a place, unpublishing is refused: cancel instead', async () => {
    ev!.participants.push({ user_id: MEMBER, status: 'registered' });
    await expect(unpublishEvent(EVENT_ID, host)).rejects.toMatchObject({
      statusCode: 409, code: 'EVENT_HAS_REGISTRATIONS', message: 'People have already registered. Cancel the event instead.',
    });
    expect(ev!.publication).toBe('published');
  });

  it('someone who registers between the read and the write still stops the unpublish, in the same words', async () => {
    beforeNextWrite = () => { ev!.participants.push({ user_id: MEMBER, status: 'registered' }); };
    await expect(unpublishEvent(EVENT_ID, host)).rejects.toMatchObject({ statusCode: 409, code: 'EVENT_HAS_REGISTRATIONS' });
    expect(ev!.publication).toBe('published');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('a removed participant holds no place, so the event can still be unpublished', async () => {
    ev!.participants.push({ user_id: REMOVED, status: 'removed' });
    await unpublishEvent(EVENT_ID, host);
    expect(ev!.publication).toBe('draft');
  });

  it('a member who could never publish is 403', async () => {
    await expect(unpublishEvent(EVENT_ID, member)).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── Cancel ──────────────────────────────────────────────────────────────────

describe('cancel with notice', () => {
  beforeEach(() => {
    ev!.participants.push(
      { user_id: MEMBER, status: 'registered' }, { user_id: OTHER, status: 'left' },
      { user_id: REMOVED, status: 'removed' }, { user_id: QUIET, status: 'registered' },
    );
  });

  it('rings every participant who was not removed and every co-host once, but not the person cancelling', async () => {
    const result = await cancelEvent(EVENT_ID, host, 'The venue closed.');
    await settle();
    expect(ev!.status).toBe('cancelled');
    expect(ev!.cancel_reason).toBe('The venue closed.');
    expect(ev!.cancelled_by).toBe(HOST);
    const rung = bells.map((b) => b.user_id).sort();
    expect(rung).toEqual([COHOST, MEMBER, OTHER, QUIET].sort());
    expect(result).toEqual({ notified: 4 });
    expect(bells[0]).toMatchObject({
      type: 'event_cancelled', title: 'Founders breakfast was cancelled', body: 'The venue closed.', link: `/sessions/${EVENT_ID}`,
    });
    for (const id of rung) expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, [id], [`user:${id}:notifications`]);
  });

  it('emails each of them once whose email switch is on, on the event\'s clock (Part 3 Task 1), naming who cancelled; the removed get nothing', async () => {
    await cancelEvent(EVENT_ID, host, 'The venue closed.');
    await settle();
    const to = mockSendCancelled.mock.calls.map(([address]) => address).sort();
    expect(to).toEqual([`${COHOST}@example.org`, `${MEMBER}@example.org`, `${OTHER}@example.org`].sort());
    const toMember = mockSendCancelled.mock.calls.find(([address]) => address === `${MEMBER}@example.org`)!;
    expect(toMember[1]).toEqual({
      eventTitle: 'Founders breakfast', hostName: 'Hana Host', when: 'Friday 20 November, 09:00 (CET)',
      reason: 'The venue closed.', link: `https://app.rsn.network/sessions/${EVENT_ID}`,
    });
  });

  it('with no reason the bell says the organiser cancelled it, and the email carries none', async () => {
    await cancelEvent(EVENT_ID, host, '   ');
    await settle();
    expect(bells[0].body).toBe('The organiser cancelled it.');
    expect(ev!.cancel_reason).toBeNull();
    expect(mockSendCancelled.mock.calls[0][1]).toMatchObject({ reason: null });
  });

  it('the admin switch for event_cancelled off: the bells still ring, no email goes', async () => {
    mockEmailSwitch = false;
    await cancelEvent(EVENT_ID, host, null);
    await settle();
    expect(bells).toHaveLength(4);
    expect(mockSendCancelled).not.toHaveBeenCalled();
  });

  it('two cancels pressed at once: one cancels and notifies, the other is told it is already cancelled', async () => {
    const outcomes = await Promise.allSettled([cancelEvent(EVENT_ID, host, 'First'), cancelEvent(EVENT_ID, admin, 'Second')]);
    await settle();
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
    expect(outcomes[1]).toMatchObject({
      status: 'rejected', reason: expect.objectContaining({ statusCode: 409, code: 'EVENT_ALREADY_CANCELLED', message: 'This event is already cancelled.' }),
    });
    expect(bells).toHaveLength(4);
    expect(mockSendCancelled).toHaveBeenCalledTimes(3);
    expect(auditActions()).toEqual(['event.cancelled']);
  });

  it('a second cancel later is refused and sends no second notice', async () => {
    await cancelEvent(EVENT_ID, host, null);
    await settle();
    await expect(cancelEvent(EVENT_ID, host, null)).rejects.toMatchObject({ statusCode: 409, message: 'This event is already cancelled.' });
    await settle();
    expect(bells).toHaveLength(4);
  });

  it('a live event is refused: end it from the live event instead', async () => {
    ev!.status = 'round_active';
    await expect(cancelEvent(EVENT_ID, host, null)).rejects.toMatchObject({
      statusCode: 409, code: 'SESSION_IN_PROGRESS', message: 'This event is live. End it from the live event instead.',
    });
    expect(updates).toEqual([]);
    expect(bells).toHaveLength(0);
  });

  it('a co-host may not cancel (403); an admin may', async () => {
    await expect(cancelEvent(EVENT_ID, cohost, null)).rejects.toMatchObject({
      statusCode: 403, message: "Only the event's host or an admin can cancel it.",
    });
    await cancelEvent(EVENT_ID, admin, null);
    expect(ev!.status).toBe('cancelled');
  });

  it('the audit row carries the actor and the reason, in the step\'s transaction', async () => {
    await cancelEvent(EVENT_ID, admin, 'Speaker ill');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: EVENT_ID, actorId: ADMIN, action: 'event.cancelled', reason: 'Speaker ill' }), mockClient,
    );
  });

  it('the cancel UPDATE is guarded against a cancelled, completed or live event, and clears the room', async () => {
    await cancelEvent(EVENT_ID, host, null);
    expect(updates[0]).toContain("status NOT IN ('cancelled', 'completed')");
    expect(updates[0]).toContain("status NOT IN ('lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby')");
    expect(updates[0]).toContain('lobby_room_id = NULL');
    expect(updates[0]).toContain('RETURNING id');
  });
});

// ── Archive ─────────────────────────────────────────────────────────────────

describe('archive and unarchive', () => {
  it('only an event that ended or was cancelled is archived', async () => {
    await expect(archiveEvent(EVENT_ID, host)).rejects.toMatchObject({
      statusCode: 409, message: 'Only an event that has ended or was cancelled can be archived.',
    });
    ev!.status = 'completed';
    await archiveEvent(EVENT_ID, cohost);
    expect(ev!.archived_at).not.toBeNull();
    expect(auditActions()).toEqual(['event.archived']);
    expectToldEveryone();
  });

  it('a cancelled event that was archived offers Unarchive, and comes back', async () => {
    ev!.status = 'cancelled';
    await archiveEvent(EVENT_ID, host);
    await expect(archiveEvent(EVENT_ID, host)).rejects.toMatchObject({ statusCode: 409, message: 'This event is already archived.' });
    await unarchiveEvent(EVENT_ID, host);
    expect(ev!.archived_at).toBeNull();
    expect(auditActions()).toEqual(['event.archived', 'event.unarchived']);
  });

  it('a member who only attended may not archive', async () => {
    ev!.status = 'completed';
    await expect(archiveEvent(EVENT_ID, member)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('the shared eventAllowedActions (the step check reads it): a cancelled+archived event offers unarchive, not archive', () => {
    const who = { isOwner: true, isCohost: false, isAdmin: false, isSuperAdmin: false };
    expect(eventAllowedActions({ status: 'cancelled', publication: 'published', archivedAt: new Date(), registrationOpensAt: null }, who, 0))
      .toEqual(['unarchive']);
    expect(eventAllowedActions({ status: 'cancelled', publication: 'published', archivedAt: null, registrationOpensAt: null }, who, 0))
      .toEqual(['archive']);
  });
});

// ── Delete for good ─────────────────────────────────────────────────────────

describe('delete for good', () => {
  it('a wrong title is 400 in words, and nothing is deleted', async () => {
    await expect(deleteEventPermanently(EVENT_ID, superAdmin, 'Founders lunch')).rejects.toMatchObject({
      statusCode: 400, message: "Type the event's name to delete it.",
    });
    expect(mockHardDelete).not.toHaveBeenCalled();
  });

  it('the right title (trimmed, any case) deletes it with the audit snapshot, telling everyone before and after', async () => {
    await deleteEventPermanently(EVENT_ID, superAdmin, '  founders BREAKFAST ');
    expect(mockHardDelete).toHaveBeenCalledWith(EVENT_ID, { actorId: SUPER, refuseWhileLive: true });
    expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT_ID);
    expect(mockListAudience.mock.invocationCallOrder[0]).toBeLessThan(mockHardDelete.mock.invocationCallOrder[0]);
    expect(mockFanoutLists).toHaveBeenCalledWith('pod-1', EVENT_ID, ['u-host', 'u-member']);
    expect(mockFanoutLists.mock.invocationCallOrder[0]).toBeGreaterThan(mockHardDelete.mock.invocationCallOrder[0]);
  });

  it('only a super admin: the host and an admin are 403', async () => {
    await expect(deleteEventPermanently(EVENT_ID, host, 'Founders breakfast')).rejects.toMatchObject({
      statusCode: 403, message: 'Only a super admin can delete an event for good.',
    });
    await expect(deleteEventPermanently(EVENT_ID, admin, 'Founders breakfast')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refused while the event is live', async () => {
    ev!.status = 'lobby_open';
    await expect(deleteEventPermanently(EVENT_ID, superAdmin, 'Founders breakfast')).rejects.toMatchObject({
      statusCode: 409, code: 'SESSION_IN_PROGRESS',
    });
  });

  it('a super admin who only attends may delete a draft too (they run every event)', async () => {
    ev = freshEvent({ publication: 'draft' });
    await deleteEventPermanently(EVENT_ID, superAdmin, 'Founders breakfast');
    expect(mockHardDelete).toHaveBeenCalled();
  });
});

// ── GET /sessions/:id's lifecycle block ─────────────────────────────────────

describe('summariseEventLifecycle', () => {
  const facts = {
    visibility: null, podId: 'pod-1', podVisibility: 'public', isHost: false, isCohost: false, isPodOrganiser: false,
    inAudience: true, isInvited: false, participantStatus: 'registered', accountActive: true, myRequest: null,
    outsideClosedCircle: false, publication: 'published' as const, archived: false, registrationOpensAt: null,
    eventTimezone: null, isPodAdmin: false, placesHeld: 3, admissionMode: null, entitled: false, entitledVia: null,
  };

  it('a production-shaped event (no lifecycle columns read) is open for registration, and a member may do nothing', () => {
    expect(summariseEventLifecycle({ status: 'scheduled' as never }, facts, UserRole.MEMBER))
      .toEqual({ lifecycle: 'registration_open', allowedActions: [] });
  });

  it('the host of an event people registered for may cancel, not unpublish; a super admin may also delete', () => {
    expect(summariseEventLifecycle({ status: 'scheduled' as never }, { ...facts, isHost: true }, UserRole.MEMBER).allowedActions)
      .toEqual(['cancel']);
    expect(summariseEventLifecycle({ status: 'scheduled' as never }, facts, UserRole.SUPER_ADMIN).allowedActions)
      .toEqual(['cancel', 'delete_permanently']);
  });

  it('a pod admin (its creator or a director) counts as an admin', () => {
    expect(summariseEventLifecycle({ status: 'completed' as never }, { ...facts, isPodAdmin: true }, UserRole.MEMBER).allowedActions)
      .toEqual(['archive']);
  });

  it('no facts (the read found nothing): the state, and no steps', () => {
    expect(summariseEventLifecycle({ status: 'cancelled' as never }, null, UserRole.ADMIN))
      .toEqual({ lifecycle: 'cancelled', allowedActions: [] });
  });
});
