// ─── The RSN Call link: entering an event (Part 2 foundation, Task 6, 11 Nov 2026; spec 02, 04, 11) ────────
//
// Open the link → email → 6-digit code → only what the event still needs → enter. The real call-entry service, the real
// identity service (the entry link, spendSignInCode, the account it signs in or makes) and the real access rules run
// against the in-memory world (fixtures/call-link-world.ts). registerParticipant is the world's model of it, built
// from the real guestMayRegister, canRegister and admittedViaOf; the groups, requests and admission-code stores are
// the world's.

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
const mockFanoutSession = jest.fn();
const mockFanoutProfile = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: (...a: unknown[]) => mockFanoutSession(...a),
  fanoutProfileChange: (...a: unknown[]) => mockFanoutProfile(...a),
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
const mockSendEntryEmail = jest.fn();
const mockEmailEnabled = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  sendCallEntryCodeEmail: (...a: unknown[]) => mockSendEntryEmail(...a),
  isEmailTypeEnabled: (...a: unknown[]) => mockEmailEnabled(...a),
  sendMagicLinkEmail: jest.fn(),
  __esModule: true,
}));
const mockRegistrationEmail = jest.fn();
jest.mock('../../../services/session/registration-email', () => ({
  sendRegistrationEmail: (...a: unknown[]) => mockRegistrationEmail(...a),
  __esModule: true,
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: (userId: string) => Promise.resolve({ allowed: userId === '00000000-0000-4000-8000-000000000001', effectiveRole: 'participant' }),
  __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: jest.fn().mockResolvedValue([]),
  __esModule: true,
}));
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  const w = jest.requireActual('../../fixtures/call-link-world');
  return { ...actual, readEventAccessFacts: (sessionId: string, userId: string) => Promise.resolve(w.factsOf(sessionId, userId)) };
});
const mockSetGroups = jest.fn();
const mockFanoutGroups = jest.fn();
jest.mock('../../../services/session/event-groups.service', () => {
  const w = jest.requireActual('../../fixtures/call-link-world');
  return {
    getEventGroupRules: (sessionId: string) => Promise.resolve(w.world.rules.get(sessionId) ?? null),
    setParticipantGroups: (sessionId: string, _actor: unknown, userId: string, keys: string[], by: string) => {
      mockSetGroups(sessionId, userId, keys, by);
      w.world.memberGroups.set(w.key(sessionId, userId), { keys, by });
      return Promise.resolve();
    },
    fanoutEventGroups: (...a: unknown[]) => mockFanoutGroups(...a),
    __esModule: true,
  };
});
const mockRequestToJoin = jest.fn();
jest.mock('../../../services/session/event-requests.service', () => ({
  requestToJoin: (...a: unknown[]) => mockRequestToJoin(...a),
  __esModule: true,
}));
const mockRedeem = jest.fn();
const mockFanoutAdmission = jest.fn();
jest.mock('../../../services/session/event-admission.service', () => {
  const actual = jest.requireActual('../../../services/session/event-admission.service');
  return {
    normaliseAdmissionCode: actual.normaliseAdmissionCode,
    hashAdmissionCode: actual.hashAdmissionCode,
    redeemAdmissionCode: (...a: unknown[]) => mockRedeem(...a),
    fanoutAdmissionChanged: (...a: unknown[]) => mockFanoutAdmission(...a),
    __esModule: true,
  };
});
const mockRegister = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  registerParticipant: (...a: unknown[]) => mockRegister(...a),
  __esModule: true,
}));

import fs from 'fs';
import path from 'path';
import { ErrorCodes, UserRole } from '@rsn/shared';
import {
  CALL_INVITATION_ONLY_SENTENCE, enterCall, listMyCallEvents, readCallEntry, sendCallEntryCode, verifyCallEntry,
} from '../../../services/session/call-entry.service';
import { getCallLanding } from '../../../services/session/call-link.service';
import { canRegister, admittedViaOf } from '../../../services/session/event-access';
import { guestMayRegister } from '../../../services/session/guest-registration';
import { hashAdmissionCode, normaliseAdmissionCode } from '../../../services/session/event-admission.service';
import { AppError } from '../../../middleware/errors';
import {
  addEvent, addUser, key, modelRegister, resetWorld, subjectOf, uuid, world,
} from '../../fixtures/call-link-world';

const HOST = uuid(1);
const MEMBER = uuid(2);
const EVENT = uuid(100);
const CODE = 'k7m2x9q4ra';
const NEW_EMAIL = 'newcomer@example.org';
const FOUNDERS_FUNDERS = {
  groups: [{ key: 'founder', label: 'Founders', description: null }, { key: 'funder', label: 'Funders', description: null }],
  question: 'Which are you?', allowMultiple: false, fallback: 'leave_unmatched' as const, rounds: [],
};

async function refusal(p: Promise<unknown>) {
  try { await p; return 'ok'; } catch (e) { const x = e as { statusCode?: number; code?: string; message?: string }; return { status: x.statusCode, code: x.code, message: x.message }; }
}

/** Ask for a code the way the link's page does, and return what the email carries. */
async function emailed(email: string) {
  await sendCallEntryCode(CODE, email);
  const [to, data] = mockSendEntryEmail.mock.calls.at(-1) as [string, { eventTitle: string; code: string; link: string }];
  return { to, ...data, token: new URL(data.link).searchParams.get('entry') ?? '' };
}

/** Email, verify, and answer the signed-in person. */
async function signIn(email: string) {
  const { code } = await emailed(email);
  const tokens = await verifyCallEntry(CODE, { email, code });
  return { ...tokens, userId: subjectOf(tokens.accessToken) };
}

beforeEach(() => {
  resetWorld();
  addUser({ id: HOST, email: 'host@example.org', display_name: 'Stefan Host' });
  addUser({ id: MEMBER, email: 'member@example.org', display_name: 'Ana Member' });
  mockSendEntryEmail.mockReset().mockResolvedValue(undefined);
  mockEmailEnabled.mockReset().mockResolvedValue(true);
  mockFanoutSession.mockReset().mockResolvedValue(undefined);
  mockFanoutProfile.mockReset().mockResolvedValue(undefined);
  mockRegistrationEmail.mockReset().mockResolvedValue(undefined);
  mockSetGroups.mockReset();
  mockFanoutGroups.mockReset().mockResolvedValue(undefined);
  mockFanoutAdmission.mockReset().mockResolvedValue(undefined);
  mockRequestToJoin.mockReset().mockImplementation((sessionId: string, userId: string) => {
    world.requests.set(key(sessionId, userId), 'pending');
    return Promise.resolve({});
  });
  mockRedeem.mockReset().mockImplementation((sessionId: string, userId: string, raw: string) => {
    const hash = hashAdmissionCode(sessionId, normaliseAdmissionCode(raw) ?? '');
    const c = world.codes.find((x) => x.session_id === sessionId && x.code_hash === hash && !x.revoked_at);
    if (!c || (c.redeemed_by && c.redeemed_by !== userId)) {
      return Promise.reject(new AppError(400, ErrorCodes.ADMISSION_CODE_INVALID, 'That admission code is not right.'));
    }
    c.redeemed_by = userId;
    return Promise.resolve({ codeId: 'code-1', groupKey: c.group_key });
  });
  mockRegister.mockReset().mockImplementation(modelRegister({
    guestMayRegister: guestMayRegister as never, canRegister: canRegister as never, admittedViaOf: admittedViaOf as never,
  }));
});

describe('a new address on an open event', () => {
  it('gets a code, becomes an event guest of this event, gives a name and takes a place admitted as open', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'private' });
    const mail = await emailed(NEW_EMAIL);
    expect(mail.to).toBe(NEW_EMAIL);
    expect(mail.eventTitle).toBe('Founders breakfast');
    expect(mail.code).toMatch(/^\d{6}$/);
    expect(mail.link).toMatch(new RegExp(`^https://app\\.rsn\\.network/call/${CODE}\\?entry=[0-9a-f]{64}$`));
    const [link] = world.links;
    expect(link).toMatchObject({ email: NEW_EMAIL, purpose: 'event_entry', target_id: EVENT, code_attempts: 0 });
    expect(link.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(link.code_hash).not.toContain(mail.code);
    expect(link.expires_at.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);

    const tokens = await verifyCallEntry(CODE, { email: NEW_EMAIL, code: mail.code });
    expect(tokens).toMatchObject({ accountKind: 'event_guest', created: true, accessToken: expect.any(String), refreshToken: expect.any(String) });
    const guest = world.users.find((u) => u.email === NEW_EMAIL)!;
    expect(guest).toMatchObject({
      account_kind: 'event_guest', onboarding_completed: false, profile_visible: false, email_verified: true,
      guest_first_session_id: EVENT, display_name: 'Guest',
    });
    expect(subjectOf(tokens.accessToken)).toBe(guest.id);

    const before = await readCallEntry(CODE, guest.id, UserRole.MEMBER);
    expect(before).toMatchObject({ step: 'details', missing: { displayName: true, group: false, admissionCode: false } });
    // Nothing given yet: nothing changes.
    expect(await enterCall(CODE, guest.id, UserRole.MEMBER, {})).toEqual(before);
    expect(mockRegister).not.toHaveBeenCalled();

    const after = await enterCall(CODE, guest.id, UserRole.MEMBER, { displayName: '  Ana   Guest ' });
    expect(after).toMatchObject({ step: 'wait_for_start', sessionId: EVENT, livePath: null, refusal: null });
    expect(guest.display_name).toBe('Ana Guest');
    expect(guest.first_name).toBe('Ana');
    expect(world.places.get(key(EVENT, guest.id))).toEqual({ status: 'registered', admitted_via: 'open' });
    expect(mockRegister).toHaveBeenCalledWith(EVENT, guest.id, UserRole.MEMBER, { arrivedThroughCallLink: true });
    expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT, [`user:${guest.id}:sessions`, `session:${EVENT}:participants`]);
    expect(mockRegistrationEmail).toHaveBeenCalledWith(EVENT, guest.id);
    expect(mockFanoutProfile).toHaveBeenCalledWith(guest.id);
  });

  it('asks nothing about onboarding anywhere on the way in', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'private' });
    const { userId } = await signIn(NEW_EMAIL);
    await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Ana' });
    expect(world.places.has(key(EVENT, userId))).toBe(true);
    // No statement decides anything on onboarding (the account getter reads the column; nothing filters on it).
    const reads = world.sql.filter((s) => /WHERE.*onboarding/.test(s));
    expect(reads).toEqual([]);
    for (const file of ['call-entry.service.ts', 'call-link.service.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services/session', file), 'utf8');
      expect(src).not.toMatch(/onboarding/i);
    }
  });

  it('a live event answers enter with the live room\'s path', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', status: 'lobby_open' });
    const { userId } = await signIn(NEW_EMAIL);
    expect(await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Ana' }))
      .toMatchObject({ step: 'enter', livePath: `/session/${EVENT}/live`, sessionId: EVENT });
  });

  it('a second enter changes nothing and answers the same', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    const { userId } = await signIn(NEW_EMAIL);
    const first = await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Ana' });
    const writes = world.writes.length;
    const second = await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Someone else' });
    expect(second).toEqual(first);
    expect(world.writes.length).toBe(writes);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(world.users.find((u) => u.id === userId)!.display_name).toBe('Ana');
  });

  it('a name that breaks the rule is refused before anything is written', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    const { userId } = await signIn(NEW_EMAIL);
    const writes = world.writes.length;
    expect(await refusal(enterCall(CODE, userId, UserRole.MEMBER, { displayName: '<script>' }))).toMatchObject({ status: 400 });
    expect(await refusal(enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'x'.repeat(61) }))).toMatchObject({ status: 400 });
    expect(world.writes.length).toBe(writes);
  });
});

describe('an existing account', () => {
  it('a member signs in as themselves: same account, kind unchanged, no name asked when they have one', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    const tokens = await signIn('MEMBER@example.org');
    expect(tokens).toMatchObject({ accountKind: 'member', created: false, userId: MEMBER });
    expect(world.users.filter((u) => u.email === 'member@example.org')).toHaveLength(1);
    expect(world.users.find((u) => u.id === MEMBER)!.account_kind).toBe('member');
    const state = await readCallEntry(CODE, MEMBER, UserRole.MEMBER);
    expect(state).toMatchObject({ step: 'details', missing: { displayName: false, group: false, admissionCode: false } });
    expect(await enterCall(CODE, MEMBER, UserRole.MEMBER, {})).toMatchObject({ step: 'wait_for_start' });
    expect(world.users.find((u) => u.id === MEMBER)!.display_name).toBe('Ana Member');
  });

  it('a closed account gets the same answer at /email, and is refused only once its code is proved', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    world.users.find((u) => u.id === MEMBER)!.status = 'deactivated';
    expect(await sendCallEntryCode(CODE, 'member@example.org')).toEqual({ sent: true });
    const { code } = mockSendEntryEmail.mock.calls.at(-1)![1] as { code: string };
    expect(await refusal(verifyCallEntry(CODE, { email: 'member@example.org', code }))).toMatchObject({ status: 403, code: ErrorCodes.ACCOUNT_CLOSED });
  });

  it('an existing account always gets a code, even on an invitation-only event it is not on', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    await emailed('member@example.org');
    expect(world.links).toHaveLength(1);
    // And then the entry asks for the admission code, in the event's own words.
    expect(await readCallEntry(CODE, MEMBER, UserRole.MEMBER)).toMatchObject({
      step: 'details', missing: { admissionCode: true },
      refusal: { code: ErrorCodes.EVENT_ADMISSION_REQUIRED, message: expect.stringContaining('admission code') },
    });
  });
});

describe('no answer tells whether an address has an account (fix round 1)', () => {
  const kinds = [
    ['invitation only', { admission_mode: 'restricted' as const, visibility: 'private' as const }],
    ['members only (no admission mode)', { admission_mode: null, visibility: 'private' as const }],
    ['the pod\'s rules (no visibility)', { admission_mode: null, visibility: null }],
    ['public with approval, no mode', { admission_mode: null, visibility: 'public_with_approval' as const }],
    ['open', { admission_mode: 'open' as const, visibility: 'private' as const }],
  ] as const;

  it.each(kinds)('%s: /email answers a member\'s address and an unknown one identically, and writes the same link', async (_label, over) => {
    addEvent({ id: EVENT, call_code: CODE, ...over });
    world.sql = [];
    const known = await sendCallEntryCode(CODE, 'member@example.org');
    const unknown = await sendCallEntryCode(CODE, NEW_EMAIL);
    expect(known).toEqual(unknown);
    expect(known).toEqual({ sent: true });
    expect(world.links.map((l) => [l.email, l.purpose, l.target_id])).toEqual([
      ['member@example.org', 'event_entry', EVENT], [NEW_EMAIL, 'event_entry', EVENT],
    ]);
    expect(mockSendEntryEmail.mock.calls.map(([to]) => to)).toEqual(['member@example.org', NEW_EMAIL]);
    // Nothing about the address is read before the answer: no account lookup, no list, no invite.
    expect(world.sql.some((s) => /FROM users WHERE email|event_admission_entries|FROM invites/.test(s))).toBe(false);
  });

  it.each(kinds)('%s: a wrong code is the same answer for a member\'s address and an unknown one', async (_label, over) => {
    addEvent({ id: EVENT, call_code: CODE, ...over });
    const k = await emailed('member@example.org');
    const u = await emailed(NEW_EMAIL);
    const wrongOf = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, '0');
    const a = await refusal(verifyCallEntry(CODE, { email: 'member@example.org', code: wrongOf(k.code) }));
    const b = await refusal(verifyCallEntry(CODE, { email: NEW_EMAIL, code: wrongOf(u.code) }));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 400, code: ErrorCodes.AUTH_SIGN_IN_CODE_WRONG });
  });

  it('with the admin switch off, every address gets the same 503, before anything about it is read or stored', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    mockEmailEnabled.mockResolvedValue(false);
    const a = await refusal(sendCallEntryCode(CODE, 'member@example.org'));
    const b = await refusal(sendCallEntryCode(CODE, NEW_EMAIL));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 503 });
    expect(mockEmailEnabled).toHaveBeenCalledWith('event_entry_code');
    expect(world.links).toEqual([]);
  });

  it('the send is off the request path: a provider that never answers does not hold the answer', async () => {
    addEvent({ id: EVENT, call_code: CODE });
    mockSendEntryEmail.mockReturnValue(new Promise(() => {}));
    expect(await sendCallEntryCode(CODE, NEW_EMAIL)).toEqual({ sent: true });
  });

  it('a provider failure is logged, never an answer', async () => {
    addEvent({ id: EVENT, call_code: CODE });
    mockSendEntryEmail.mockRejectedValue(new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, "We couldn't send the code just now."));
    expect(await sendCallEntryCode(CODE, NEW_EMAIL)).toEqual({ sent: true });
  });
});

describe('who may come in, decided after the code is proved', () => {
  it('invitation only + an address not on its list + no code: 403 in its words once proved; nothing spent, no account made', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    const { code } = await emailed(NEW_EMAIL);
    let caught: AppError | undefined;
    try { await verifyCallEntry(CODE, { email: NEW_EMAIL, code }); } catch (e) { caught = e as AppError; }
    expect(caught).toMatchObject({ statusCode: 403, code: ErrorCodes.EVENT_ADMISSION_REQUIRED, message: CALL_INVITATION_ONLY_SENTENCE });
    expect(caught!.details).toEqual({ admissionCode: true });
    expect(CALL_INVITATION_ONLY_SENTENCE).toMatch(/^This event is invitation only\./);
    expect(world.users.some((u) => u.email === NEW_EMAIL)).toBe(false);
    expect(world.links[0]).toMatchObject({ used_at: null, code_attempts: 0 });
  });

  it('the same code sent again with a redeemable admission code signs the newcomer in (checked, not spent)', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    world.codes.push({ session_id: EVENT, code_hash: hashAdmissionCode(EVENT, normaliseAdmissionCode('ABCD-EFGH-JKMN')!), group_key: null, redeemed_by: null, revoked_at: null, expires_at: null });
    const { code } = await emailed(NEW_EMAIL);
    expect(await refusal(verifyCallEntry(CODE, { email: NEW_EMAIL, code, admissionCode: 'ZZZZ-ZZZZ-ZZZZ' }))).toMatchObject({ status: 403 });
    const ok = await verifyCallEntry(CODE, { email: NEW_EMAIL, code, admissionCode: 'abcd efgh jkmn' });
    expect(ok).toMatchObject({ created: true, accountKind: 'event_guest' });
    expect(world.codes[0].redeemed_by).toBeNull();
  });

  it('invitation only: a listed address or a personal invite comes in; a revoked listing or a shared invite does not', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    world.entries.push({ session_id: EVENT, email: 'listed@example.org', group_key: null, revoked_at: null });
    world.invites.push({ session_id: EVENT, invitee_email: 'invited@example.org', max_uses: 1, status: 'pending', expires_at: null });
    world.invites.push({ session_id: EVENT, invitee_email: 'shared@example.org', max_uses: 50, status: 'pending', expires_at: null });
    for (const email of ['listed@example.org', 'invited@example.org']) {
      const { code } = await emailed(email);
      expect(await verifyCallEntry(CODE, { email, code })).toMatchObject({ created: true });
    }
    world.entries.push({ session_id: EVENT, email: 'revoked@example.org', group_key: null, revoked_at: new Date() });
    for (const email of ['revoked@example.org', 'shared@example.org']) {
      const { code } = await emailed(email);
      expect(await refusal(verifyCallEntry(CODE, { email, code }))).toMatchObject({ status: 403, code: ErrorCodes.EVENT_ADMISSION_REQUIRED });
    }
  });

  it('an event with no admission mode takes a new address when it is public, or by personal invite; else 403 after the code', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: null, visibility: 'private' });
    const first = await emailed(NEW_EMAIL);
    expect(await refusal(verifyCallEntry(CODE, { email: NEW_EMAIL, code: first.code }))).toMatchObject({ status: 403, code: ErrorCodes.EVENT_PRIVATE });
    world.invites.push({ session_id: EVENT, invitee_email: NEW_EMAIL, max_uses: 1, status: 'pending', expires_at: null });
    expect(await verifyCallEntry(CODE, { email: NEW_EMAIL, code: first.code })).toMatchObject({ created: true });
    world.events[0].visibility = 'public';
    const second = await emailed('someone@example.org');
    expect(await verifyCallEntry(CODE, { email: 'someone@example.org', code: second.code })).toMatchObject({ created: true });
    world.events[0].visibility = null; // the pod's rules
    const third = await emailed('third@example.org');
    expect(await refusal(verifyCallEntry(CODE, { email: 'third@example.org', code: third.code }))).toMatchObject({ status: 403, code: ErrorCodes.EVENT_PRIVATE });
  });

  it('the email\'s button is held to the same rule, and is not spent by a refusal', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    const { token } = await emailed(NEW_EMAIL);
    expect(await refusal(verifyCallEntry(CODE, { token }))).toMatchObject({ status: 403, code: ErrorCodes.EVENT_ADMISSION_REQUIRED });
    expect(world.links[0].used_at).toBeNull();
    expect(world.users.some((u) => u.email === NEW_EMAIL)).toBe(false);
  });

  it('ended, cancelled, draft and unknown events: 409 in words, or the link\'s one 404', async () => {
    addEvent({ id: EVENT, call_code: CODE, status: 'completed' });
    addEvent({ id: uuid(101), call_code: 'cccccccccc', status: 'cancelled' });
    addEvent({ id: uuid(102), call_code: 'dddddddddd', publication: 'draft' });
    expect(await refusal(sendCallEntryCode(CODE, NEW_EMAIL))).toEqual({ status: 409, code: ErrorCodes.EVENT_ENDED, message: 'This event has ended.' });
    expect(await refusal(sendCallEntryCode('cccccccccc', NEW_EMAIL))).toEqual({ status: 409, code: ErrorCodes.EVENT_CANCELLED, message: 'This event was cancelled.' });
    const draft = await refusal(sendCallEntryCode('dddddddddd', NEW_EMAIL));
    expect(draft).toEqual(await refusal(sendCallEntryCode('zzzzzzzzzz', NEW_EMAIL)));
    expect(draft).toMatchObject({ status: 404 });
    expect(world.links).toEqual([]);
  });


  it('asking again spends the older code: only the newest works', async () => {
    addEvent({ id: EVENT, call_code: CODE });
    const first = await emailed(NEW_EMAIL);
    const second = await emailed(NEW_EMAIL);
    expect(world.links[0].used_at).not.toBeNull();
    if (first.code !== second.code) {
      expect(await refusal(verifyCallEntry(CODE, { email: NEW_EMAIL, code: first.code }))).toMatchObject({ code: ErrorCodes.AUTH_SIGN_IN_CODE_WRONG });
    }
    expect(await verifyCallEntry(CODE, { email: NEW_EMAIL, code: second.code })).toMatchObject({ created: true });
  });
});

describe('the email\'s button (the entry token)', () => {
  it('signs in once, again within the scanner grace, and never for another event', async () => {
    addEvent({ id: EVENT, call_code: CODE });
    addEvent({ id: uuid(101), call_code: 'cccccccccc' });
    const { token } = await emailed(NEW_EMAIL);
    expect(await refusal(verifyCallEntry('cccccccccc', { token }))).toMatchObject({ status: 401 });
    const a = await verifyCallEntry(CODE, { token });
    const b = await verifyCallEntry(CODE, { token });
    expect(subjectOf(a.accessToken)).toBe(subjectOf(b.accessToken));
    expect(world.users.filter((u) => u.email === NEW_EMAIL)).toHaveLength(1);
    world.links[0].used_at = new Date(Date.now() - 3 * 60_000);
    expect(await refusal(verifyCallEntry(CODE, { token }))).toMatchObject({ code: ErrorCodes.AUTH_MAGIC_LINK_USED });
  });

  it('cannot sign anyone in once its code was used (fix round 1)', async () => {
    addEvent({ id: EVENT, call_code: CODE });
    const { code, token } = await emailed(NEW_EMAIL);
    await verifyCallEntry(CODE, { email: NEW_EMAIL, code });
    expect(await refusal(verifyCallEntry(CODE, { token }))).toMatchObject({ status: 400, code: ErrorCodes.AUTH_MAGIC_LINK_EXPIRED });
  });

  it('two verifies of a new address at once make one account (the 23505 race)', async () => {
    addEvent({ id: EVENT, call_code: CODE });
    const { token } = await emailed(NEW_EMAIL);
    const [a, b] = await Promise.all([verifyCallEntry(CODE, { token }), verifyCallEntry(CODE, { token })]);
    expect(subjectOf(a.accessToken)).toBe(subjectOf(b.accessToken));
    expect(world.users.filter((u) => u.email === NEW_EMAIL)).toHaveLength(1);
  });
});

describe('invitation only, and groups', () => {
  it('a listed address whose entry carries group_key funder is put in it by invitation, then takes its place', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    world.rules.set(EVENT, FOUNDERS_FUNDERS);
    world.entries.push({ session_id: EVENT, email: 'funder@example.org', group_key: 'funder', revoked_at: null });
    const { userId } = await signIn('funder@example.org');
    // The invitation answers the group question: only the name is missing.
    expect(await readCallEntry(CODE, userId, UserRole.MEMBER)).toMatchObject({ missing: { displayName: true, group: false, admissionCode: false } });
    const state = await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Fiona Funder', groupKeys: ['founder'] });
    expect(state.step).toBe('wait_for_start');
    expect(mockSetGroups).toHaveBeenCalledWith(EVENT, userId, ['funder'], 'invitation');
    expect(world.memberGroups.get(key(EVENT, userId))).toEqual({ keys: ['funder'], by: 'invitation' });
    expect(world.places.get(key(EVENT, userId))).toEqual({ status: 'registered', admitted_via: 'allow_list' });
  });

  it('a group event and a guest with no group: missing.group, then a key gives the place', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    world.rules.set(EVENT, FOUNDERS_FUNDERS);
    const { userId } = await signIn(NEW_EMAIL);
    const asked = await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Gus' });
    expect(asked).toMatchObject({ step: 'details', missing: { displayName: false, group: true } });
    expect(world.places.has(key(EVENT, userId))).toBe(false);
    const entered = await enterCall(CODE, userId, UserRole.MEMBER, { groupKeys: ['founder'] });
    expect(entered.step).toBe('wait_for_start');
    expect(mockRegister).toHaveBeenLastCalledWith(EVENT, userId, UserRole.MEMBER, { groupKeys: ['founder'], arrivedThroughCallLink: true });
    expect(world.memberGroups.get(key(EVENT, userId))).toEqual({ keys: ['founder'], by: 'self' });
  });

  it('an admission code typed on the details step is redeemed there (a guest cannot reach the redeem route) and carries its group', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    world.rules.set(EVENT, FOUNDERS_FUNDERS);
    world.codes.push({ session_id: EVENT, code_hash: hashAdmissionCode(EVENT, normaliseAdmissionCode('ABCD-EFGH-JKMN')!), group_key: 'founder', redeemed_by: null, revoked_at: null, expires_at: null });
    const { code } = await emailed(NEW_EMAIL);
    const { accessToken } = await verifyCallEntry(CODE, { email: NEW_EMAIL, code, admissionCode: 'ABCD-EFGH-JKMN' });
    const userId = subjectOf(accessToken);
    expect(await readCallEntry(CODE, userId, UserRole.MEMBER)).toMatchObject({ missing: { displayName: true, group: true, admissionCode: true } });
    const state = await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Cody', admissionCode: 'abcd-efgh-jkmn' });
    expect(state.step).toBe('wait_for_start');
    expect(mockRedeem).toHaveBeenCalledWith(EVENT, userId, 'abcd-efgh-jkmn', expect.anything());
    expect(world.memberGroups.get(key(EVENT, userId))).toEqual({ keys: ['founder'], by: 'invitation' });
    expect(world.places.get(key(EVENT, userId))).toEqual({ status: 'registered', admitted_via: 'code' });
    expect(mockFanoutAdmission).toHaveBeenCalledWith(EVENT, { everyone: true, podId: 'pod-1', people: [userId] });
  });

  it('an admission code is spent only when it is what lets the person in (fix round 1)', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    world.codes.push({ session_id: EVENT, code_hash: hashAdmissionCode(EVENT, normaliseAdmissionCode('ABCD-EFGH-JKMN')!), group_key: null, redeemed_by: null, revoked_at: null, expires_at: null });
    expect((await enterCall(CODE, MEMBER, UserRole.MEMBER, { admissionCode: 'ABCD-EFGH-JKMN' })).step).toBe('wait_for_start');
    expect(mockRedeem).not.toHaveBeenCalled();
    expect(world.codes[0].redeemed_by).toBeNull();
    // An invitation-only event a listed member is entitled to: the code is not needed, so not spent either.
    addEvent({ id: uuid(101), call_code: 'cccccccccc', admission_mode: 'restricted', visibility: 'private' });
    world.entries.push({ session_id: uuid(101), email: 'member@example.org', group_key: null, revoked_at: null });
    expect((await enterCall('cccccccccc', MEMBER, UserRole.MEMBER, { admissionCode: 'ABCD-EFGH-JKMN' })).step).toBe('wait_for_start');
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('a wrong admission code is refused (400) and gives no place', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'restricted', visibility: 'private' });
    expect(await refusal(enterCall(CODE, MEMBER, UserRole.MEMBER, { admissionCode: 'ZZZZ-ZZZZ-ZZZZ' }))).toMatchObject({
      status: 400, code: ErrorCodes.ADMISSION_CODE_INVALID,
    });
    expect(world.places.has(key(EVENT, MEMBER))).toBe(false);
  });
});

describe('approval, removal, and the guest\'s reach', () => {
  it('an approval event sends the request and waits; once approved the person waits for the start', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'public_with_approval' });
    const { userId } = await signIn(NEW_EMAIL);
    expect((await readCallEntry(CODE, userId, UserRole.MEMBER)).missing.displayName).toBe(true);
    const asked = await enterCall(CODE, userId, UserRole.MEMBER, { displayName: 'Rae' });
    expect(asked).toMatchObject({ step: 'pending_approval', sessionId: EVENT });
    expect(mockRequestToJoin).toHaveBeenCalledWith(EVENT, userId, UserRole.MEMBER, null, { arrivedThroughCallLink: true });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(await enterCall(CODE, userId, UserRole.MEMBER, {})).toEqual(asked);
    // The organiser approves (approveRequest registers them with approvedRequest).
    world.requests.set(key(EVENT, userId), 'approved');
    await mockRegister(EVENT, userId, UserRole.MEMBER, { approvedRequest: true });
    expect(await readCallEntry(CODE, userId, UserRole.MEMBER)).toMatchObject({ step: 'wait_for_start', sessionId: EVENT });
  });

  it('a declined request reads declined and enters nothing', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'public_with_approval' });
    world.requests.set(key(EVENT, MEMBER), 'declined');
    expect(await enterCall(CODE, MEMBER, UserRole.MEMBER, {})).toMatchObject({ step: 'declined' });
    expect(mockRequestToJoin).not.toHaveBeenCalled();
  });

  it('someone the host removed is refused by the link and never re-admitted', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    world.places.set(key(EVENT, MEMBER), { status: 'removed', admitted_via: 'open' });
    const state = await enterCall(CODE, MEMBER, UserRole.MEMBER, {});
    expect(state).toMatchObject({ step: 'refused', refusal: { code: 'REMOVED_FROM_EVENT' } });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(world.places.get(key(EVENT, MEMBER))!.status).toBe('removed');
  });

  it('an event guest from another event comes in by this event\'s link only where a newcomer would', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    addEvent({ id: uuid(101), call_code: 'pppppppppp', admission_mode: null, visibility: 'private' });
    const { userId } = await signIn(NEW_EMAIL); // a guest of EVENT
    expect(world.users.find((u) => u.id === userId)!.guest_first_session_id).toBe(EVENT);
    // A members' event with no admission mode: refused in words, never registered.
    const other = await enterCall('pppppppppp', userId, UserRole.MEMBER, { displayName: 'Gus' });
    expect(other).toMatchObject({ step: 'refused', refusal: { code: ErrorCodes.EVENT_PRIVATE } });
    expect(mockRegister).not.toHaveBeenCalled();
    // An open event they did not come in through: the link's own fact lets them ask, and canRegister gives the place.
    addEvent({ id: uuid(102), call_code: 'qqqqqqqqqq', admission_mode: 'open' });
    expect((await enterCall('qqqqqqqqqq', userId, UserRole.MEMBER, { displayName: 'Gus' })).step).toBe('wait_for_start');
    expect(mockRegister).toHaveBeenLastCalledWith(uuid(102), userId, UserRole.MEMBER, { arrivedThroughCallLink: true });
  });

  it('guestMayRegister: the link\'s fact admits the guest to ask; without it, as before', () => {
    const base = { sessionId: 'e', guestFirstSessionId: 'other', holdsPlace: false, admissionMode: null };
    expect(guestMayRegister(base)).toBe(false);
    expect(guestMayRegister({ ...base, arrivedThroughCallLink: true })).toBe(true);
    // Only enterCall says so.
    const root = path.join(__dirname, '..', '..', '..');
    const callers = ['services', 'routes'].flatMap((dir) => walk(path.join(root, dir)))
      .filter((f) => /arrivedThroughCallLink: true/.test(fs.readFileSync(f, 'utf8')));
    expect(callers.map((f) => path.basename(f))).toEqual(['call-entry.service.ts']);
  });
});

describe('the landing for a signed-in viewer, and their events', () => {
  it('shows their step and the event id only once they hold a place', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open' });
    const before = await getCallLanding(CODE, { userId: MEMBER, role: UserRole.MEMBER });
    expect(before.viewer).toEqual({ signedIn: true, accountKind: 'member', sessionId: null, step: 'details' });
    expect(before.asks).toEqual({ displayName: false, group: null, admissionCode: false });
    await enterCall(CODE, MEMBER, UserRole.MEMBER, {});
    const after = await getCallLanding(CODE, { userId: MEMBER, role: UserRole.MEMBER });
    expect(after.viewer).toEqual({ signedIn: true, accountKind: 'member', sessionId: EVENT, step: 'wait_for_start' });
  });

  it('a draft shows to its host, and is the link\'s 404 to everyone else', async () => {
    addEvent({ id: EVENT, call_code: CODE, publication: 'draft' });
    expect((await getCallLanding(CODE, { userId: HOST, role: UserRole.MEMBER })).lifecycle).toBe('draft');
    expect(await refusal(readCallEntry(CODE, MEMBER, UserRole.MEMBER))).toMatchObject({ status: 404 });
    expect(await refusal(enterCall(CODE, MEMBER, UserRole.MEMBER, {}))).toMatchObject({ status: 404 });
  });

  it('listMyCallEvents: places and requests, upcoming first, each with its code and step', async () => {
    const soon = new Date(Date.now() + 3600_000);
    const later = new Date(Date.now() + 7200_000);
    const past = new Date(Date.now() - 7200_000);
    addEvent({ id: EVENT, call_code: CODE, scheduled_at: later });
    addEvent({ id: uuid(101), call_code: 'cccccccccc', scheduled_at: soon, admission_mode: 'approval' });
    addEvent({ id: uuid(102), call_code: null as unknown as string, scheduled_at: past, status: 'completed' });
    world.events[2].call_code = null;
    addEvent({ id: uuid(103), call_code: 'eeeeeeeeee' }); // nothing to do with them
    world.places.set(key(EVENT, MEMBER), { status: 'registered', admitted_via: 'open' });
    world.requests.set(key(uuid(101), MEMBER), 'pending');
    world.places.set(key(uuid(102), MEMBER), { status: 'left', admitted_via: null });
    const list = await listMyCallEvents(MEMBER);
    expect(list.map((e) => [e.title && e.code.length, e.step, e.lifecycle])).toEqual([
      [10, 'pending_approval', 'registration_open'],
      [10, 'wait_for_start', 'registration_open'],
      [10, 'ended', 'completed'],
    ]);
    expect(list[0].code).toBe('cccccccccc');
    expect(world.events[2].call_code).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/); // an old event got its code
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return walk(full);
    return d.name.endsWith('.ts') ? [full] : [];
  });
}
