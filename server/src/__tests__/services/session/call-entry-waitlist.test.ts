// ─── The RSN Call link on a full event: the waiting list (10 Nov 2026 spec, Part 3 Task 3) ─────────────────────────
//
// A guest who enters a full event by its link is put on its waiting list (step 'waitlisted', with their position),
// reading the entry again says the same, entering again changes nothing, and once they are promoted the entry says
// they hold a place. The real call-entry service and the real access rules run against the Call link's in-memory world
// (fixtures/call-link-world.ts). The waiting list here is the world's model of registerOrWaitlist (a full event queues,
// else the modelled registration gives the place); the real one is tested in event-waitlist.test.ts and
// capacity-rules.test.ts, and on real SQL in t3-pglite.mjs.

jest.mock('../../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 60,
    clientUrl: 'https://app.rsn.network', env: 'test', isDev: false, isProd: false, isTest: true, resendApiKey: '',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 100000,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/call-link-world');
  const run = (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params));
  return { query: run, transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: run }), __esModule: true };
});
jest.mock('../../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => ({}), __esModule: true }));
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: jest.fn().mockResolvedValue(undefined),
  fanoutProfileChange: jest.fn().mockResolvedValue(undefined),
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendCallEntryCodeEmail: jest.fn(), isEmailTypeEnabled: jest.fn().mockResolvedValue(true), sendMagicLinkEmail: jest.fn(),
  __esModule: true,
}));
const mockRegistrationEmail = jest.fn();
jest.mock('../../../services/session/registration-email', () => ({
  sendRegistrationEmail: (...a: unknown[]) => mockRegistrationEmail(...a), __esModule: true,
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: async () => ({ allowed: false, effectiveRole: 'participant' }), __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: jest.fn().mockResolvedValue([]), __esModule: true,
}));
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  const w = jest.requireActual('../../fixtures/call-link-world');
  return { ...actual, readEventAccessFacts: (sessionId: string, userId: string) => Promise.resolve(w.factsOf(sessionId, userId)) };
});
jest.mock('../../../services/session/event-groups.service', () => ({
  getEventGroupRules: async () => null, setParticipantGroups: jest.fn(), fanoutEventGroups: jest.fn(), __esModule: true,
}));
jest.mock('../../../services/session/event-requests.service', () => ({ requestToJoin: jest.fn(), __esModule: true }));
jest.mock('../../../services/session/event-admission.service', () => {
  const actual = jest.requireActual('../../../services/session/event-admission.service');
  return {
    normaliseAdmissionCode: actual.normaliseAdmissionCode, ADMISSION_CODE_USED_SENTENCE: actual.ADMISSION_CODE_USED_SENTENCE,
    hashAdmissionCode: actual.hashAdmissionCode, redeemAdmissionCode: jest.fn(), fanoutAdmissionChanged: jest.fn(), __esModule: true,
  };
});
const mockRegister = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  registerParticipant: (...a: unknown[]) => mockRegister(...a), __esModule: true,
}));
const mockPlace = jest.fn();
jest.mock('../../../services/session/event-waitlist.service', () => {
  const w = jest.requireActual('../../fixtures/call-link-world');
  return {
    registerOrWaitlist: (...a: unknown[]) => mockPlace(...a),
    leaveWaitlist: async (sessionId: string, userId: string) => {
      const entry = w.world.line.find((l: { session_id: string; user_id: string; status: string }) =>
        l.session_id === sessionId && l.user_id === userId && l.status === 'waiting');
      if (entry) entry.status = 'left';
      return { left: !!entry };
    },
    __esModule: true,
  };
});

import { UserRole } from '@rsn/shared';
import { enterCall, leaveCallWaitlist, listMyCallEvents, readCallEntry } from '../../../services/session/call-entry.service';
import { canRegister, admittedViaOf } from '../../../services/session/event-access';
import { guestMayRegister } from '../../../services/session/guest-registration';
import {
  addEvent, addUser, capacityOf, key, modelRegister, placesTakenIn, resetWorld, uuid, waitlistPositionOf, world,
} from '../../fixtures/call-link-world';

const HOST = uuid(1);
const A = uuid(2);
const B = uuid(3);
const GUEST = uuid(4);
const EVENT = uuid(100);
const CODE = 'k7m2x9q4ra';

/** registerOrWaitlist as the world models it: a full event queues a newcomer; otherwise the modelled registration. */
function modelPlace(register: ReturnType<typeof modelRegister>) {
  return async (sessionId: string, userId: string, role: UserRole | undefined, options: { joinedVia: string } & Record<string, unknown>) => {
    const { joinedVia: _joinedVia, ...rest } = options;
    const e = world.events.find((x) => x.id === sessionId)!;
    const cap = capacityOf(e);
    const holds = world.places.has(key(sessionId, userId));
    if (!holds && e.host_user_id !== userId && cap !== null && placesTakenIn(sessionId) >= cap) {
      const isNew = waitlistPositionOf(sessionId, userId) === null;
      if (isNew) world.line.push({ session_id: sessionId, user_id: userId, status: 'waiting' });
      return { kind: 'waitlisted', position: waitlistPositionOf(sessionId, userId), isNew };
    }
    const placed = await register(sessionId, userId, role, rest);
    return { kind: 'registered', participant: placed, isNewRegistration: placed.isNewRegistration };
  };
}

/** The world's promotion: the first in line takes the place. */
function promoteFirst(sessionId: string) {
  const first = world.line.find((l) => l.session_id === sessionId && l.status === 'waiting')!;
  first.status = 'promoted';
  world.places.set(key(sessionId, first.user_id), { status: 'registered', admitted_via: 'open' });
}

beforeEach(() => {
  resetWorld();
  addUser({ id: HOST, email: 'host@example.org', display_name: 'Stefan Host' });
  addUser({ id: A, email: 'a@example.org' });
  addUser({ id: B, email: 'b@example.org' });
  addUser({ id: GUEST, email: 'guest@example.org', account_kind: 'event_guest', display_name: 'Guest', first_name: '', guest_first_session_id: EVENT });
  addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'private', config: { maxParticipants: 2 } });
  world.places.set(key(EVENT, HOST), { status: 'registered', admitted_via: null });
  world.places.set(key(EVENT, A), { status: 'registered', admitted_via: 'open' });
  world.places.set(key(EVENT, B), { status: 'registered', admitted_via: 'open' });
  mockRegistrationEmail.mockReset();
  mockRegister.mockReset().mockImplementation(modelRegister({
    guestMayRegister: guestMayRegister as never, canRegister: canRegister as never, admittedViaOf: admittedViaOf as never,
  }));
  mockPlace.mockReset().mockImplementation(modelPlace(mockRegister as never));
});

describe('a guest entering a full event by its link', () => {
  it('is put on the waiting list: step waitlisted, with their position, and no place', async () => {
    const state = await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Grace Guest' });
    expect(state).toMatchObject({ step: 'waitlisted', sessionId: EVENT, waitlistPosition: 1, livePath: null, refusal: null });
    expect(mockPlace).toHaveBeenCalledWith(EVENT, GUEST, UserRole.MEMBER, { arrivedThroughCallLink: true, joinedVia: 'call_link' });
    expect(world.places.has(key(EVENT, GUEST))).toBe(false);
    expect(mockRegistrationEmail).not.toHaveBeenCalled();
  });

  it('reading the entry again says the same; entering again changes nothing', async () => {
    await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Grace Guest' });
    expect(await readCallEntry(CODE, GUEST, UserRole.MEMBER)).toMatchObject({ step: 'waitlisted', waitlistPosition: 1 });
    mockPlace.mockClear();
    const again = await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Someone Else' });
    expect(again).toMatchObject({ step: 'waitlisted', waitlistPosition: 1 });
    expect(mockPlace).not.toHaveBeenCalled();
    expect(world.users.find((u) => u.id === GUEST)!.display_name).toBe('Grace Guest');
  });

  it('once promoted, the entry says they hold a place (wait_for_start), and their events list says so too', async () => {
    await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Grace Guest' });
    expect((await listMyCallEvents(GUEST)).map((e) => e.step)).toEqual(['waitlisted']);
    world.places.delete(key(EVENT, A));
    promoteFirst(EVENT);
    expect(await readCallEntry(CODE, GUEST, UserRole.MEMBER)).toMatchObject({ step: 'wait_for_start', sessionId: EVENT, waitlistPosition: null });
    expect((await listMyCallEvents(GUEST)).map((e) => e.step)).toEqual(['wait_for_start']);
  });

  it('leaving the line by the link takes them off it and answers where they stand', async () => {
    await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Grace Guest' });
    const state = await leaveCallWaitlist(CODE, GUEST, UserRole.MEMBER);
    expect(state.step).toBe('details');
    expect(state.waitlistPosition).toBeNull();
    expect(world.line[0].status).toBe('left');
  });

  it('an event with room gives the place as before (step wait_for_start), and every state carries waitlistPosition null', async () => {
    world.places.delete(key(EVENT, B));
    const state = await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Grace Guest' });
    expect(state).toMatchObject({ step: 'wait_for_start', waitlistPosition: null });
    expect(world.places.get(key(EVENT, GUEST))?.status).toBe('registered');
    expect(mockRegistrationEmail).toHaveBeenCalledTimes(1);
  });
});
