// ─── An event's waiting list (10 Nov 2026 spec, Part 3 Task 3; plan K3, Review Focus #1 and #2) ────────────────
//
// The real waiting-list service, the real registration (registerParticipantTx), the real approval and the real invite
// accept run against the in-memory world (fixtures/waitlist-world.ts), which answers their own statements as Postgres
// would for its rows. What leaves the process is mocked and recorded: tags, bells' pushes, emails. The two concurrent
// cases (two people at the last place; two promotions after one release) run on real SQL in t3-pglite.mjs.

jest.mock('../../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.rsn.network', env: 'test',
    isDev: false, isProd: false, isTest: true, eventComms: 'on',
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/waitlist-world');
  return { query: w.run, transaction: w.inTransaction, __esModule: true };
});
jest.mock('../../../middleware/auth', () => {
  const actual = jest.requireActual('../../../middleware/auth');
  const w = jest.requireActual('../../fixtures/waitlist-world');
  return {
    ...actual,
    // The account gate, read fresh (the real one caches for 60 seconds across tests).
    readAccountGate: async (id: string) => {
      const u = w.world.rows.users.find((x: { id: string }) => x.id === id);
      return { status: u?.status ?? 'inactive', kind: u?.account_kind ?? 'event_guest' };
    },
  };
});
const mockEmit = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => { mockEmit(...a); return Promise.resolve(); },
  getRealtimeIo: () => ({ to: () => ({ emit: jest.fn() }) }),
  __esModule: true,
}));
const mockFanout = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: (...a: unknown[]) => { mockFanout(...a); return Promise.resolve(); },
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
const mockPromotedEmail = jest.fn();
const mockEmailEnabled = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  sendWaitlistPromotedEmail: (...a: unknown[]) => { mockPromotedEmail(...a); return Promise.resolve({ sent: true }); },
  isEmailTypeEnabled: (...a: unknown[]) => mockEmailEnabled(...a),
  asBulkEmail: <T>(send: () => Promise<T>) => send(),
  sendInviteEmail: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/calendar/calendar.service', () => ({
  buildSessionCalendarEvent: async (sessionId: string) => ({ title: 'Founders breakfast', startTime: new Date(), durationMinutes: 60, sessionId }),
  __esModule: true,
}));
jest.mock('../../../services/session/call-link.service', () => ({
  ensureCallCode: async () => 'k7m2x9q4ra',
  __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: async () => ['00000000-0000-4000-8000-000000000001'],
  __esModule: true,
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: async () => ({ allowed: false, effectiveRole: 'participant' }),
  __esModule: true,
}));
jest.mock('../../../services/pod/pod.service', () => ({
  addMember: jest.fn(async () => ({})), GUEST_POD_REFUSAL: 'Guests do not join pods.', __esModule: true,
}));
jest.mock('../../../services/circle/circle.service', () => ({ joinCircle: jest.fn(), __esModule: true }));

import * as fs from 'fs';
import * as path from 'path';
import type { Socket } from 'socket.io';
import { ErrorCodes, UserRole, formatEventTime } from '@rsn/shared';
import {
  addEvent, addPlace, addUser, lineOf, placeOf, positionOf, resetWaitlistWorld, wid, world, type WwEvent,
} from '../../fixtures/waitlist-world';
import {
  admitFromWaitlist, afterPlaceFreed, eventsHeldByActiveAccounts, leaveWaitlist, listWaitlist, moveWaitlistsOn, promoteFromWaitlist,
  registerOrWaitlist, removeFromWaitlist,
} from '../../../services/session/event-waitlist.service';
import { lineLooksStalled, readEventAccessFacts, summariseEventAccess } from '../../../services/session/event-access';
import { lineStalled, registerParticipant, unregisterParticipant } from '../../../services/session/session.service';
import * as waitlistService from '../../../services/session/event-waitlist.service';
import { approveRequest } from '../../../services/session/event-requests.service';
import { acceptInvite } from '../../../services/invite/invite.service';
import { decideRoomEntry, EVENT_FULL_ROOM_SENTENCE } from '../../../services/orchestration/event-room-entry';

const HOST = wid(1);
const A = wid(2);
const B = wid(3);
const C = wid(4);
const D = wid(5);
const E = wid(6);
const EVENT = wid(100);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const bellsOf = (userId: string) => world.rows.bells.filter((b) => b.user_id === userId);
const auditActions = () => world.rows.audit.map((r) => r.action);

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try { await p; return 'ok'; } catch (e) { const err = e as { statusCode?: number; code?: string; message?: string }; return { status: err.statusCode, code: err.code, message: err.message }; }
}

/** A full event of two: A and B hold the places, C and D wait (1 and 2). */
async function fullEventWithLine(over: Partial<WwEvent> = {}) {
  addEvent({ id: EVENT, host_user_id: HOST, ...over });
  await registerParticipant(EVENT, A, UserRole.MEMBER);
  await registerParticipant(EVENT, B, UserRole.MEMBER);
  const c = await registerOrWaitlist(EVENT, C, UserRole.MEMBER, { joinedVia: 'register' });
  const d = await registerOrWaitlist(EVENT, D, UserRole.MEMBER, { joinedVia: 'register' });
  return { c, d };
}

beforeEach(() => {
  resetWaitlistWorld();
  for (const id of [HOST, A, B, C, D, E]) addUser({ id });
  mockEmit.mockReset();
  mockFanout.mockReset();
  mockPromotedEmail.mockReset();
  mockEmailEnabled.mockReset();
  mockEmailEnabled.mockResolvedValue(true);
});

describe('a full event puts the next person on its waiting list, and a freed place goes to the first in line', () => {
  it('cap 2: A and B hold the places (the host holds none); C and D wait at 1 and 2', async () => {
    const { c, d } = await fullEventWithLine();
    expect(c).toEqual({ kind: 'waitlisted', position: 1, isNew: true });
    expect(d).toEqual({ kind: 'waitlisted', position: 2, isNew: true });
    expect(placeOf(EVENT, C)).toBeUndefined();
    expect(placeOf(EVENT, D)).toBeUndefined();
    expect(auditActions().filter((a) => a === 'waitlist.joined')).toHaveLength(2);
  });

  it('asking again keeps the same place in the line and writes nothing new', async () => {
    await fullEventWithLine();
    const again = await registerOrWaitlist(EVENT, C, UserRole.MEMBER, { joinedVia: 'register' });
    expect(again).toEqual({ kind: 'waitlisted', position: 1, isNew: false });
    expect(auditActions().filter((a) => a === 'waitlist.joined')).toHaveLength(2);
  });

  it('A unregisters: C is promoted (one bell, one email, tags to C), D is now first', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    await flush();

    expect(placeOf(EVENT, C)?.status).toBe('registered');
    expect(lineOf(EVENT, C)?.status).toBe('promoted');
    expect(positionOf(EVENT, D)).toBe(1);
    expect(placeOf(EVENT, D)).toBeUndefined();

    const bells = bellsOf(C);
    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({
      type: 'event_waitlist_promoted',
      title: "A place opened in Founders breakfast: it's yours",
      body: "Starts in 3 hours. Can't make it? Unregister so the next person gets it.",
      link: `/sessions/${EVENT}`,
    });
    expect(world.rows.bells.filter((b) => b.user_id !== C)).toEqual([]);

    expect(mockPromotedEmail).toHaveBeenCalledTimes(1);
    const event = world.rows.events[0];
    expect(mockPromotedEmail).toHaveBeenCalledWith(world.rows.users.find((u) => u.id === C)!.email, expect.objectContaining({
      eventTitle: 'Founders breakfast', when: formatEventTime(event.scheduled_at!, 'Europe/Copenhagen', 'long'),
      link: `https://app.rsn.network/sessions/${EVENT}`, live: false,
    }));

    const toC = mockEmit.mock.calls.filter(([, people]) => (people as string[]).length === 1 && (people as string[])[0] === C)
      .flatMap(([, , tags]) => tags as string[]);
    expect(toC).toEqual(expect.arrayContaining([`session:${EVENT}`, `user:${C}:sessions`, `session:${EVENT}:participants`]));
    expect(mockFanout).toHaveBeenCalledWith('pod-1', EVENT, expect.arrayContaining([`session:${EVENT}:waitlist`, `user:${C}:sessions`]));
    expect(world.rows.audit.find((r) => r.action === 'waitlist.promoted')).toMatchObject({ details: { automatic: true, subjectUserIds: [C] } });
  });

  it('the organiser raises the capacity to 4: D is promoted too', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    world.rows.events[0].config = { maxParticipants: 4 };
    await afterPlaceFreed(EVENT, 'capacity');
    await flush();
    expect(placeOf(EVENT, D)?.status).toBe('registered');
    expect(positionOf(EVENT, D)).toBeNull();
    expect(world.rows.line.filter((l) => l.status === 'waiting')).toEqual([]);
    expect(mockPromotedEmail).toHaveBeenCalledTimes(2);
  });

  it('never more holders than places: a release with nobody new to place promotes nobody, and a second pass changes nothing', async () => {
    await fullEventWithLine();
    await afterPlaceFreed(EVENT, 'unregister');
    expect(positionOf(EVENT, C)).toBe(1);
    await unregisterParticipant(EVENT, A);
    expect(await promoteFromWaitlist(EVENT)).toEqual([C]);
    expect(await promoteFromWaitlist(EVENT)).toEqual([]);
    expect(world.rows.places.filter((p) => p.session_id === EVENT && p.user_id !== HOST && p.status !== 'removed')).toHaveLength(2);
  });

  it('the line is first in, first out: a place freed before its promotion runs goes to the first in line, never a newcomer', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A); // a place is free; its promotion has not run (a restart, a failed pass)
    expect(await refusal(registerParticipant(EVENT, D, UserRole.MEMBER))).toMatchObject({ code: 'SESSION_FULL' }); // second in line
    await expect(registerParticipant(EVENT, C, UserRole.MEMBER)).resolves.toMatchObject({ isNewRegistration: true }); // first in line
    expect(lineOf(EVENT, C)?.status).toBe('promoted');
    expect(positionOf(EVENT, D)).toBe(1);
  });

  it('a stalled line heals itself: a newcomer refused only because people wait while a place is free moves the line on (fix round 1, I-1a)', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A); // nobody called afterPlaceFreed
    expect(await refusal(registerParticipant(EVENT, E, UserRole.MEMBER))).toMatchObject({ status: 409, code: 'SESSION_FULL' });
    await flush();
    expect(placeOf(EVENT, C)?.status).toBe('registered');
    expect(bellsOf(C)).toHaveLength(1);
    expect(positionOf(EVENT, D)).toBe(1);
    // The same through the queueing path: E joins behind D, and a second stall heals the same way.
    await unregisterParticipant(EVENT, B);
    expect(await registerOrWaitlist(EVENT, E, UserRole.MEMBER, { joinedVia: 'register' })).toMatchObject({ kind: 'waitlisted', position: 2 });
    await flush();
    expect(placeOf(EVENT, D)?.status).toBe('registered');
    expect(positionOf(EVENT, E)).toBe(1);
  });

  it('the page says "full" exactly when the door does: with people waiting, a free place is the first in line\'s (fix round 1, I-1b)', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A);
    const summary = async (who: string) => summariseEventAccess((await readEventAccessFacts(EVENT, who))!, UserRole.MEMBER).waitlist;
    expect(await summary(E)).toEqual({ full: true, position: null }); // a newcomer: 1 taken + 2 waiting ahead >= 2
    expect(await refusal(registerParticipant(EVENT, E, UserRole.MEMBER))).toMatchObject({ code: 'SESSION_FULL' });
    world.rows.line.filter((l) => l.status === 'waiting').forEach((l) => { l.status = 'left'; });
    expect(await summary(E)).toEqual({ full: false, position: null }); // nobody waits: the free place is anyone's
    await expect(registerParticipant(EVENT, E, UserRole.MEMBER)).resolves.toMatchObject({ isNewRegistration: true });
    expect(await summary(D)).toEqual({ full: true, position: null });
  });

  it('a pass that lapses someone releases its savepoint: no savepoint is left nested (fix round 1, M-3)', async () => {
    await fullEventWithLine();
    world.rows.users.find((u) => u.id === C)!.status = 'suspended';
    await unregisterParticipant(EVENT, A);
    const from = world.sql.length;
    await promoteFromWaitlist(EVENT);
    const sql = world.sql.slice(from);
    const rolledBack = sql.indexOf('ROLLBACK TO SAVEPOINT promote_one');
    expect(rolledBack).toBeGreaterThan(-1);
    expect(sql[rolledBack + 1]).toBe('RELEASE SAVEPOINT promote_one');
    expect(sql.filter((s) => s === 'SAVEPOINT promote_one')).toHaveLength(sql.filter((s) => s === 'RELEASE SAVEPOINT promote_one').length);
  });

  it('a completed event promotes nobody', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A);
    world.rows.events[0].status = 'completed';
    await afterPlaceFreed(EVENT, 'unregister');
    await flush();
    expect(positionOf(EVENT, C)).toBe(1);
    expect(placeOf(EVENT, C)).toBeUndefined();
    expect(world.rows.bells).toEqual([]);
    expect(mockPromotedEmail).not.toHaveBeenCalled();
  });

  it('a live event goes on promoting, and the bell says it is on now', async () => {
    await fullEventWithLine();
    world.rows.events[0].status = 'lobby_open';
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    await flush();
    expect(placeOf(EVENT, C)?.status).toBe('registered');
    expect(bellsOf(C)[0]).toMatchObject({ body: "It's on now. Join from the event page." });
    expect(mockPromotedEmail).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ live: true, when: "It's on now." }));
  });

  it('the email ignores the person\'s own email switch (transactional) but not the admin\'s switch', async () => {
    await fullEventWithLine();
    mockEmailEnabled.mockResolvedValue(false);
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    await flush();
    expect(mockEmailEnabled).toHaveBeenCalledWith('event_waitlist_promoted');
    expect(mockPromotedEmail).not.toHaveBeenCalled();
    expect(bellsOf(C)).toHaveLength(1);
  });
});

describe('every admission rule is re-run at promotion', () => {
  it('restricted: C\'s allowed email is revoked while waiting, so C lapses (EVENT_ADMISSION_REQUIRED) and D is promoted', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, visibility: 'private', admission_mode: 'restricted' });
    for (const id of [A, B, C, D]) {
      world.rows.entries.push({ session_id: EVENT, email: world.rows.users.find((u) => u.id === id)!.email, revoked_at: null });
    }
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    expect(await registerOrWaitlist(EVENT, C, UserRole.MEMBER, { joinedVia: 'register' })).toMatchObject({ kind: 'waitlisted', position: 1 });
    expect(await registerOrWaitlist(EVENT, D, UserRole.MEMBER, { joinedVia: 'register' })).toMatchObject({ kind: 'waitlisted', position: 2 });

    const cEmail = world.rows.users.find((u) => u.id === C)!.email;
    world.rows.entries.find((x) => x.email === cEmail)!.revoked_at = new Date();
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    await flush();

    expect(lineOf(EVENT, C)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.EVENT_ADMISSION_REQUIRED });
    expect(placeOf(EVENT, C)).toBeUndefined();
    expect(placeOf(EVENT, D)?.status).toBe('registered');
    expect(world.rows.audit.find((r) => r.action === 'waitlist.lapsed')).toMatchObject({
      details: { subjectUserIds: [C], reason: ErrorCodes.EVENT_ADMISSION_REQUIRED, automatic: true },
    });
    expect(bellsOf(C)).toEqual([]);
  });

  it('a suspended account lapses at its turn', async () => {
    await fullEventWithLine();
    world.rows.users.find((u) => u.id === C)!.status = 'suspended';
    expect(positionOf(EVENT, D)).toBe(1); // nobody inactive is counted ahead
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, C)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.AUTH_FORBIDDEN });
    expect(placeOf(EVENT, D)?.status).toBe('registered');
  });

  it('approval event, full: approving keeps the request approved and puts the person on the line, and says where', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, admission_mode: 'approval' });
    world.rows.podMembers.push({ pod_id: 'pod-1', user_id: A, role: 'member' }, { pod_id: 'pod-1', user_id: B, role: 'member' });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    world.rows.requests.push({ id: 'req-c', session_id: EVENT, user_id: C, status: 'pending' });

    const outcome = await approveRequest(EVENT, C, HOST, UserRole.MEMBER);
    expect(outcome.request.status).toBe('approved');
    expect(outcome.waitlistPosition).toBe(1);
    expect(outcome.isNewRegistration).toBe(false);
    expect(placeOf(EVENT, C)).toBeUndefined();
    expect(lineOf(EVENT, C)).toMatchObject({ status: 'waiting', joined_via: 'approval' });
    expect(bellsOf(C)[0]).toMatchObject({
      type: 'approval', body: "Founders breakfast is full, so you're number 1 on the waiting list. We'll tell you the moment a place opens.",
    });

    // The approval comes with them: a freed place is theirs.
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(placeOf(EVENT, C)?.status).toBe('registered');
  });

  it('an invite entry is promoted through its invite only while the invite stands; a revoked one lapses it (ruling, M-2)', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, visibility: 'private', admission_mode: null });
    world.rows.podMembers.push({ pod_id: 'pod-1', user_id: A, role: 'member' }, { pod_id: 'pod-1', user_id: B, role: 'member' });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    const invite = (id: string, user: string, status: string) => world.rows.invites.push({
      id, code: id, session_id: EVENT, invitee_email: world.rows.users.find((u) => u.id === user)!.email, status, max_uses: 1,
      use_count: 1, inviter_id: HOST, created_at: new Date(), accepted_by_user_id: user,
    });
    invite('inv-c', C, 'accepted');
    invite('inv-d', D, 'accepted');
    for (const u of [C, D]) await registerOrWaitlist(EVENT, u, UserRole.MEMBER, { viaInvite: true, joinedVia: 'invite' });
    world.rows.invites.find((i) => i.id === 'inv-c')!.status = 'revoked';
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, C)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.INVITE_REVOKED });
    expect(placeOf(EVENT, D)?.status).toBe('registered'); // D's invite still stands
  });

  it('an expired invite lapses with INVITE_EXPIRED, and an approval entry whose request is no longer approved with EVENT_NEEDS_APPROVAL', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, visibility: 'public_with_approval', admission_mode: null, config: { maxParticipants: 1 } });
    world.rows.podMembers.push({ pod_id: 'pod-1', user_id: A, role: 'member' });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    world.rows.invites.push({
      id: 'inv-c', code: 'inv-c', session_id: EVENT, invitee_email: world.rows.users.find((u) => u.id === C)!.email, status: 'pending',
      max_uses: 1, use_count: 0, inviter_id: HOST, created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
    });
    await registerOrWaitlist(EVENT, C, UserRole.MEMBER, { viaInvite: true, joinedVia: 'invite' });
    world.rows.requests.push({ id: 'req-d', session_id: EVENT, user_id: D, status: 'approved' });
    await registerOrWaitlist(EVENT, D, UserRole.MEMBER, { approvedRequest: true, joinedVia: 'approval' });
    world.rows.invites[0].expires_at = new Date(Date.now() - 1000);
    world.rows.requests[0].status = 'withdrawn';
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, C)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.INVITE_EXPIRED });
    expect(lineOf(EVENT, D)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.EVENT_NEEDS_APPROVAL });
  });

  it('an invite accepted on a full event puts them on the line: the accept succeeds, no defensive insert gives a place', async () => {
    addEvent({ id: EVENT, host_user_id: HOST });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    world.rows.invites.push({
      id: 'inv-1', code: 'CODE123', session_id: EVENT, invitee_email: null, status: 'pending', max_uses: 10, use_count: 0,
      inviter_id: HOST, created_at: new Date(),
    });
    const result = await acceptInvite('CODE123', E);
    expect(result).toMatchObject({ redirectTo: `/sessions/${EVENT}`, registeredFor: { sessionId: EVENT }, waitlistPosition: 1 });
    expect(result.participantStatus).toBeUndefined();
    expect(placeOf(EVENT, E)).toBeUndefined();
    expect(lineOf(EVENT, E)).toMatchObject({ status: 'waiting', joined_via: 'invite' });
    expect(world.sql.some((s) => s.startsWith('INSERT INTO session_participants (session_id, user_id, status) VALUES'))).toBe(false);
  });
});

describe('leaving, rejoining and the organisers', () => {
  it('leaving the line: left, and the next one moves up; rejoining goes to the back', async () => {
    await fullEventWithLine();
    expect(await leaveWaitlist(EVENT, C)).toEqual({ left: true });
    expect(lineOf(EVENT, C)?.status).toBe('left');
    expect(positionOf(EVENT, D)).toBe(1);
    expect(await leaveWaitlist(EVENT, C)).toEqual({ left: false });
    expect(await registerOrWaitlist(EVENT, C, UserRole.MEMBER, { joinedVia: 'register' })).toEqual({ kind: 'waitlisted', position: 2, isNew: true });
    expect(auditActions()).toContain('waitlist.left');
  });

  it('the organisers list the line in order, never with an email; members are refused it', async () => {
    await fullEventWithLine();
    const list = await listWaitlist(EVENT, { userId: HOST, role: UserRole.MEMBER });
    expect(list.map((e) => [e.userId, e.position, e.joinedVia, e.accountKind])).toEqual([[C, 1, 'register', 'member'], [D, 2, 'register', 'member']]);
    expect(JSON.stringify(list)).not.toContain('@');
    expect(await refusal(listWaitlist(EVENT, { userId: A, role: UserRole.MEMBER }))).toMatchObject({ status: 403 });
  });

  it('an organiser takes someone off the line; they cannot rejoin it; someone not waiting is a 404', async () => {
    await fullEventWithLine();
    await removeFromWaitlist(EVENT, { userId: HOST, role: UserRole.MEMBER }, C);
    expect(lineOf(EVENT, C)?.status).toBe('removed');
    expect(positionOf(EVENT, D)).toBe(1);
    expect(await refusal(registerOrWaitlist(EVENT, C, UserRole.MEMBER, { joinedVia: 'register' }))).toMatchObject({ status: 403 });
    expect(await refusal(removeFromWaitlist(EVENT, { userId: HOST, role: UserRole.MEMBER }, A))).toMatchObject({
      status: 404, code: ErrorCodes.WAITLIST_ENTRY_NOT_FOUND,
    });
    expect(await refusal(removeFromWaitlist(EVENT, { userId: B, role: UserRole.MEMBER }, D))).toMatchObject({ status: 403 });
    expect(auditActions()).toContain('waitlist.removed');
  });

  it('"Let in now" gives a place over capacity, audited, and the person is told', async () => {
    await fullEventWithLine();
    await admitFromWaitlist(EVENT, { userId: HOST, role: UserRole.MEMBER }, D);
    await flush();
    expect(placeOf(EVENT, D)?.status).toBe('registered');
    expect(lineOf(EVENT, D)?.status).toBe('promoted');
    expect(world.rows.places.filter((p) => p.session_id === EVENT && p.user_id !== HOST)).toHaveLength(3);
    expect(auditActions()).toContain('waitlist.admitted_over_capacity');
    expect(bellsOf(D)).toHaveLength(1);
    expect(positionOf(EVENT, C)).toBe(1);
  });
});

describe('a waiting person reaches no attendee surface (Review Focus #2)', () => {
  const socket = (rooms: string[] = []) => ({ rooms: new Set(rooms) }) as unknown as Socket;

  it('the live door refuses a full event\'s newcomer with the waiting-list sentence', async () => {
    await fullEventWithLine();
    world.rows.events[0].status = 'lobby_open';
    expect(await refusal(registerParticipant(EVENT, E, UserRole.MEMBER))).toMatchObject({ status: 409, code: 'SESSION_FULL' });
    const entry = await decideRoomEntry({
      socket: socket(), sessionId: EVENT, userId: E, role: UserRole.MEMBER, eventStatus: 'lobby_open',
      registration: { registered: false, refusalCode: 'SESSION_FULL' },
    });
    expect(entry).toEqual({ kind: 'refuse', refusal: { code: 'SESSION_FULL', message: EVENT_FULL_ROOM_SENTENCE } });
    expect(EVENT_FULL_ROOM_SENTENCE).toBe('This event is full. Join the waiting list on the event page.');
    // C, on the line, is the same newcomer at the door.
    const waiting = await decideRoomEntry({
      socket: socket(), sessionId: EVENT, userId: C, role: UserRole.MEMBER, eventStatus: 'lobby_open',
      registration: { registered: false, refusalCode: 'SESSION_FULL' },
    });
    expect(waiting.kind).toBe('refuse');
  });

  it('someone who left a full event keeps their place: they re-register with no lock and are let in', async () => {
    await fullEventWithLine();
    world.rows.events[0].status = 'lobby_open';
    placeOf(EVENT, A)!.status = 'left';
    const before = world.sql.length;
    const back = await registerParticipant(EVENT, A, UserRole.MEMBER);
    expect(back).toMatchObject({ status: 'registered', isNewRegistration: false });
    expect(world.sql.slice(before).some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
    const entry = await decideRoomEntry({
      socket: socket(), sessionId: EVENT, userId: A, role: UserRole.MEMBER, eventStatus: 'lobby_open', registration: { registered: true },
    });
    expect(entry).toEqual({ kind: 'enter' });
    expect(positionOf(EVENT, C)).toBe(1);
  });

  it('a cancellation and a time change reach the people waiting; a reminder does not', () => {
    const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8').replace(/\s+/g, ' ');
    const line = "u.id IN (SELECT w.user_id FROM event_waitlist w WHERE w.session_id = $1 AND w.status = 'waiting')";
    const cancel = src('services/session/event-lifecycle.service.ts');
    const notice = cancel.slice(cancel.indexOf('async function noticeOfCancellation'), cancel.indexOf('export async function emailCancellation'));
    expect(notice).toContain(line);
    const moved = src('services/session/event-notices.ts');
    expect(moved.slice(moved.indexOf('export async function notifyEventRescheduled'))).toContain(line);
    expect(src('services/session/event-reminder.worker.ts')).not.toContain('event_waitlist');
  });
});

describe('the stalled-line move-on is coalesced and only for events it can move (fix round 2, N-1)', () => {
  it('a refetch wave of N page reads starts one promotion per event at a time', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A); // a place free, nobody told the line
    const spy = jest.spyOn(waitlistService, 'afterPlaceFreed');
    for (let i = 0; i < 12; i += 1) lineStalled(EVENT);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(EVENT, 'stalled');
    expect(placeOf(EVENT, C)?.status).toBe('registered');
    // Once that one is over, the next ask runs again (nothing is stuck in the in-flight set).
    lineStalled(EVENT);
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('it never queues behind a promotion running elsewhere: with the capacity lock held, it does nothing', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A);
    world.lockHeldBy.add(EVENT); // another instance is registering or promoting for this event
    const from = world.sql.length;
    await afterPlaceFreed(EVENT, 'stalled');
    expect(placeOf(EVENT, C)).toBeUndefined();
    expect(world.sql.slice(from).some((s) => s.startsWith('SELECT pg_advisory_xact_lock'))).toBe(false);
    expect(world.sql.slice(from).some((s) => s.startsWith('SELECT pg_try_advisory_xact_lock'))).toBe(true);
    world.lockHeldBy.clear();
    await afterPlaceFreed(EVENT, 'stalled');
    expect(placeOf(EVENT, C)?.status).toBe('registered');
  });

  it('a completed, cancelled or draft event with waiters and a free place reads as not stalled: no trigger', async () => {
    await fullEventWithLine();
    await unregisterParticipant(EVENT, A);
    const stalledFor = async (who: string) => lineLooksStalled((await readEventAccessFacts(EVENT, who))!);
    expect(await stalledFor(E)).toBe(true); // upcoming and published: it is
    for (const status of ['completed', 'cancelled']) {
      world.rows.events[0].status = status;
      expect(await stalledFor(E)).toBe(false);
      expect(await stalledFor(C)).toBe(false);
    }
    world.rows.events[0].status = 'scheduled';
    world.rows.events[0].publication = 'draft';
    expect(await stalledFor(E)).toBe(false);
    world.rows.events[0].publication = 'published';
    world.rows.events[0].status = 'lobby_open';
    expect(await stalledFor(E)).toBe(true); // live: it is
  });
});

describe('the say-so at promotion (fix round 2, N-2 and N-3)', () => {
  const sharedLink = (sessionId: string, firstAccepter: string) => world.rows.invites.push({
    id: 'link-1', code: 'LINK1', session_id: sessionId, invitee_email: null, status: 'accepted', max_uses: 25, use_count: 2,
    inviter_id: HOST, created_at: new Date(), accepted_by_user_id: firstAccepter,
  });
  const queueDirect = (sessionId: string, userId: string, joinedVia: string) => world.rows.line.push({
    id: `20000000-0000-4000-8000-${userId.slice(-12)}`, session_id: sessionId, user_id: userId, status: 'waiting', joined_via: joinedVia,
    group_keys: [], lapsed_reason: null, queued_at: ++world.clock, decided_by: null,
  });

  it('a shared link\'s later accepter (no invite names them) is decided by the rules: promoted on a public event', async () => {
    await fullEventWithLine();
    sharedLink(EVENT, D);
    expect(await registerOrWaitlist(EVENT, E, UserRole.MEMBER, { viaInvite: true, joinedVia: 'invite' })).toMatchObject({ position: 3 });
    for (const u of [C, D]) await leaveWaitlist(EVENT, u);
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(placeOf(EVENT, E)?.status).toBe('registered');
    expect(lineOf(EVENT, E)?.status).toBe('promoted');
  });

  it('on an invitation-only event a shared link never admits: the later accepter lapses with the admission code', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, visibility: 'private', admission_mode: 'restricted' });
    for (const id of [A, B]) {
      world.rows.entries.push({ session_id: EVENT, email: world.rows.users.find((u) => u.id === id)!.email, revoked_at: null });
    }
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    sharedLink(EVENT, D);
    queueDirect(EVENT, E, 'invite');
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, E)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.EVENT_ADMISSION_REQUIRED });
    expect(placeOf(EVENT, E)).toBeUndefined();
  });

  it('an approval entry whose request is still pending (approve has not committed yet) is promoted, not lapsed', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, visibility: 'public_with_approval', admission_mode: null, config: { maxParticipants: 1 } });
    world.rows.podMembers.push({ pod_id: 'pod-1', user_id: A, role: 'member' });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    world.rows.requests.push({ id: 'req-c', session_id: EVENT, user_id: C, status: 'pending' });
    queueDirect(EVENT, C, 'approval');
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(placeOf(EVENT, C)?.status).toBe('registered');
  });
});

describe('a shared link remembered on the waiting row (fix round 3, controller ruling)', () => {
  const link = () => world.rows.invites.push({
    id: 'link-1', code: 'LINK1', session_id: EVENT, invitee_email: null, status: 'accepted', max_uses: 25, use_count: 1,
    inviter_id: HOST, created_at: new Date(), accepted_by_user_id: D, // the link's first accepter is someone else
  });
  /** A full event of two that only its pod's members and its invitees join: A and B (pod members) hold the places. */
  async function fullFor(over: Partial<WwEvent>) {
    addEvent({ id: EVENT, host_user_id: HOST, ...over });
    world.rows.podMembers.push({ pod_id: 'pod-1', user_id: A, role: 'member' }, { pod_id: 'pod-1', user_id: B, role: 'member' });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    link();
  }

  it.each([
    ['a private (members-only) event', { visibility: 'private', admission_mode: null }],
    ['an approval event', { visibility: 'public', admission_mode: 'approval' }],
  ] as const)('%s: a later accepter of the link is queued with the invite, and promoted through it when a place frees', async (_label, over) => {
    await fullFor(over as Partial<WwEvent>);
    const accepted = await acceptInvite('LINK1', E);
    expect(accepted).toMatchObject({ waitlistPosition: 1 });
    expect(lineOf(EVENT, E)).toMatchObject({ status: 'waiting', joined_via: 'invite', invite_id: 'link-1' });
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(placeOf(EVENT, E)?.status).toBe('registered');
    expect(lineOf(EVENT, E)?.status).toBe('promoted');
  });

  it('the link revoked while they wait: they lapse with INVITE_REVOKED', async () => {
    await fullFor({ visibility: 'private', admission_mode: null });
    await acceptInvite('LINK1', E);
    world.rows.invites.find((i) => i.id === 'link-1')!.status = 'revoked';
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, E)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.INVITE_REVOKED });
    expect(placeOf(EVENT, E)).toBeUndefined();
  });

  it('the link past its expiry: they lapse with INVITE_EXPIRED', async () => {
    await fullFor({ visibility: 'private', admission_mode: null });
    await acceptInvite('LINK1', E);
    world.rows.invites.find((i) => i.id === 'link-1')!.expires_at = new Date(Date.now() - 1000);
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, E)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.INVITE_EXPIRED });
  });

  it('an invitation-only event never admits through a shared link: a row that remembers one lapses with the admission code', async () => {
    addEvent({ id: EVENT, host_user_id: HOST, visibility: 'private', admission_mode: 'restricted' });
    for (const id of [A, B]) world.rows.entries.push({ session_id: EVENT, email: world.rows.users.find((u) => u.id === id)!.email, revoked_at: null });
    await registerParticipant(EVENT, A, UserRole.MEMBER);
    await registerParticipant(EVENT, B, UserRole.MEMBER);
    link();
    // (Accepting the link cannot queue anyone here: the registration refuses before capacity. The row stands in for one
    // written before the event became invitation only.)
    world.rows.line.push({
      id: '20000000-0000-4000-8000-000000000006', session_id: EVENT, user_id: E, status: 'waiting', joined_via: 'invite',
      group_keys: [], lapsed_reason: null, queued_at: ++world.clock, decided_by: null, invite_id: 'link-1',
    });
    await unregisterParticipant(EVENT, A);
    await afterPlaceFreed(EVENT, 'unregister');
    expect(lineOf(EVENT, E)).toMatchObject({ status: 'lapsed', lapsed_reason: ErrorCodes.EVENT_ADMISSION_REQUIRED });
    expect(placeOf(EVENT, E)).toBeUndefined();
  });
});

describe('the admin\'s own status writes (fix round 1, I-2)', () => {
  it('eventsHeldByActiveAccounts reads the upcoming and live events active accounts hold a place in; moveWaitlistsOn moves each line on', async () => {
    await fullEventWithLine();
    const OTHER = wid(101);
    addEvent({ id: OTHER, host_user_id: HOST, status: 'completed' });
    addPlace(OTHER, A);
    expect(await eventsHeldByActiveAccounts([A, B])).toEqual([EVENT]);
    world.rows.users.find((u) => u.id === A)!.status = 'banned'; // the admin's own write, after the read
    moveWaitlistsOn([EVENT, EVENT]);
    await flush();
    expect(placeOf(EVENT, C)?.status).toBe('registered');
    expect(bellsOf(C)).toHaveLength(1);
    expect(await eventsHeldByActiveAccounts([A])).toEqual([]); // a banned account holds no place
  });
});

describe('every deliberate release moves the line on (wiring)', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8').split(String.fromCharCode(13)).join('');

  it('unregister, a capacity raised and a co-host made (REST) call afterPlaceFreed after their write', () => {
    const routes = src('routes/sessions.ts');
    const unregister = routes.slice(routes.indexOf("router.delete(\n  '/:id/register'"), routes.indexOf('// ─── GET /sessions/:id/participants '));
    expect(unregister.indexOf('unregisterParticipant(')).toBeLessThan(unregister.indexOf("afterPlaceFreed(req.params.id, 'unregister')"));
    expect(routes).toMatch(/if \(body\.config\?\.maxParticipants !== undefined \|\| body\.format !== undefined\) void afterPlaceFreed\(session\.id, 'capacity'\)/);
    expect(routes).toMatch(/if \(action === 'assign'\) void afterPlaceFreed\(sessionId, 'cohost'\)/);
  });

  it('the live kick and the live co-host assignment call it too, and an admin closing or suspending an account', () => {
    const hostActions = src('services/orchestration/handlers/host-actions.ts');
    expect(hostActions).toContain("w.afterPlaceFreed(data.sessionId, 'removed')");
    expect(hostActions).toContain("w.afterPlaceFreed(sessionId, 'cohost')");
    const identity = src('services/identity/identity.service.ts');
    const del = identity.slice(identity.indexOf('export async function deleteUser'));
    expect(del.indexOf('eventsWithPlace(userId)')).toBeLessThan(del.indexOf("UPDATE session_participants SET status = 'removed'"));
    expect(del).toContain('await freePlacesOf(userId, freedEvents)');
    expect(identity).toMatch(/if \(status !== 'active' && user\.status === 'active'\) await freePlacesOf\(userId, await eventsWithPlace\(userId\)\)/);
    expect(identity).toContain("afterPlaceFreed(sessionId, 'account')");
  });

  it('a read of the event page or the call link entry moves a stalled line on (fix round 1, I-1)', () => {
    expect(src('routes/sessions.ts')).toContain('if (facts && lineLooksStalled(facts)) sessionService.lineStalled(req.params.id);');
    expect(src('services/session/call-entry.service.ts')).toContain('if (lineLooksStalled(facts)) lineStalled(event.id);');
    const f = { capacity: 2, placesTaken: 1, waitlistAhead: 0, waitlistPosition: null, eventStatus: 'scheduled', publication: 'published' as const };
    expect(lineLooksStalled(f)).toBe(false);
    expect(lineLooksStalled({ ...f, waitlistAhead: 2 })).toBe(true);
    expect(lineLooksStalled({ ...f, waitlistPosition: 1 })).toBe(true);
    expect(lineLooksStalled({ ...f, placesTaken: 2, waitlistAhead: 2 })).toBe(false);
    expect(lineLooksStalled({ ...f, capacity: null, waitlistAhead: 2 })).toBe(false);
  });

  it('the paths that queue are the call link, an approval, an invite and the page asking for it; the live join never queues', () => {
    expect(src('services/session/call-entry.service.ts')).toContain("joinedVia: 'call_link'");
    expect(src('services/session/event-requests.service.ts')).toContain("joinedVia: 'approval'");
    expect(src('services/invite/invite.service.ts')).toContain("joinedVia: 'invite'");
    expect(src('routes/sessions.ts')).toContain("joinedVia: 'register'");
    expect(src('services/orchestration/handlers/participant-flow.ts')).not.toContain('registerOrWaitlist');
  });
});
