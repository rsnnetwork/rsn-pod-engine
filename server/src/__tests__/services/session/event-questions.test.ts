// ─── An event's extra matching questions: entry, registration, the organiser's save, privacy (Part 3 Task 5; K5) ─────
//
// The real event-questions service and the real call-entry service run against the Call link's in-memory world
// (fixtures/call-link-world.ts, which now keeps questions and answers). registerParticipant is the world's model of it,
// with the same rule the real one applies through applyRegistrationAnswers (tested directly below on a recording
// client): a required question refuses only a person's own first self-registration; an approval, an invite, a returning
// place, an organiser's add and a promotion pass and stay neutral. The organiser's save runs on a recording database.
// Every statement here is executed for real on PGlite in the task's report.

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
/** A test that wants its own database answers here; everything else is the Call link world. */
let mockOverride: ((sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) | null = null;
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/call-link-world');
  const run = (sql: string, params?: unknown[]) => Promise.resolve().then(() => (mockOverride ? mockOverride(sql, params ?? []) : w.answer(sql, params)));
  return { query: run, transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: run }), __esModule: true };
});
const mockEmit = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => { mockEmit(...a); return Promise.resolve(); }, getRealtimeIo: () => ({}), __esModule: true,
}));
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
jest.mock('../../../services/session/registration-email', () => ({ sendRegistrationEmail: jest.fn(), __esModule: true }));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: (userId: string) => Promise.resolve({ allowed: userId === '00000000-0000-4000-8000-000000000001', effectiveRole: 'participant' }),
  __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: jest.fn().mockResolvedValue(['00000000-0000-4000-8000-000000000001']),
  __esModule: true,
}));
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  const w = jest.requireActual('../../fixtures/call-link-world');
  return { ...actual, readEventAccessFacts: (sessionId: string, userId: string) => Promise.resolve(w.factsOf(sessionId, userId)) };
});
jest.mock('../../../services/session/event-groups.service', () => ({
  getEventGroupRules: () => Promise.resolve(null), setParticipantGroups: jest.fn(), fanoutEventGroups: jest.fn(),
  __esModule: true,
}));
const mockRequestToJoin = jest.fn();
jest.mock('../../../services/session/event-requests.service', () => ({
  requestToJoin: (...a: unknown[]) => mockRequestToJoin(...a),
  __esModule: true,
}));
jest.mock('../../../services/session/event-admission.service', () => {
  const actual = jest.requireActual('../../../services/session/event-admission.service');
  return { ...actual, redeemAdmissionCode: jest.fn(), fanoutAdmissionChanged: jest.fn(), __esModule: true };
});
const mockRegister = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  registerParticipant: (...a: unknown[]) => mockRegister(...a),
  lineStalled: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/session/event-waitlist.service', () =>
  jest.requireActual('../../fixtures/waitlist-passthrough').passThroughWaitlist((...a: unknown[]) => mockRegister(...a)));

import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { ErrorCodes, UserRole, type EventMatchingQuestion } from '@rsn/shared';
import { enterCall, readCallEntry } from '../../../services/session/call-entry.service';
import { getCallLanding } from '../../../services/session/call-link.service';
import {
  applyRegistrationAnswers, readEventQuestions, saveAnswersWithRequest, saveEventQuestions, saveMyAnswers, saveMyAnswersAs,
} from '../../../services/session/event-questions.service';
import { admittedViaOf, canRegister } from '../../../services/session/event-access';
import { guestMayRegister } from '../../../services/session/guest-registration';
import { eventRoomRefusal } from '../../../services/orchestration/event-room-entry';
import { addEvent, addUser, key, modelRegister, resetWorld, uuid, world } from '../../fixtures/call-link-world';

const HOST = uuid(1);
const MEMBER = uuid(2);
const GUEST = uuid(3);
const EVENT = uuid(100);
const CODE = 'k7m2x9q4ra';
const QUESTIONS_TAG = `session:${EVENT}:questions`;

const SECTOR: EventMatchingQuestion = {
  key: 'sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: true,
  options: [{ key: 'fintech', label: 'Fintech' }, { key: 'health', label: 'Health' }],
};
const STAGE: EventMatchingQuestion = {
  key: 'stage', prompt: 'Which stage?', kind: 'single', prefer: 'different', required: false,
  options: [{ key: 'idea', label: 'Idea' }, { key: 'growth', label: 'Growth' }],
};

async function refusal(p: Promise<unknown>) {
  try { await p; return 'ok'; } catch (e) { const x = e as { statusCode?: number; code?: string; message?: string }; return { status: x.statusCode, code: x.code, message: x.message }; }
}

beforeEach(() => {
  mockOverride = null;
  resetWorld();
  addUser({ id: HOST, email: 'host@example.org', display_name: 'Stefan Host' });
  addUser({ id: MEMBER, email: 'member@example.org', display_name: 'Ana Member' });
  mockEmit.mockReset();
  mockRequestToJoin.mockReset().mockImplementation((sessionId: string, userId: string) => {
    world.requests.set(key(sessionId, userId), 'pending');
    return Promise.resolve({});
  });
  mockRegister.mockReset().mockImplementation(modelRegister({
    guestMayRegister: guestMayRegister as never, canRegister: canRegister as never, admittedViaOf: admittedViaOf as never,
  }));
});

const flush = () => new Promise((r) => setImmediate(r));
const answersTagSentTo = () => mockEmit.mock.calls
  .filter(([, , tags]) => (tags as string[]).includes(QUESTIONS_TAG))
  .map(([, people]) => [...(people as string[])].sort());

// ─── The call link ───────────────────────────────────────────────────────────

describe('the call link asks the event\'s questions', () => {
  it('a required question is missing until answered; answered at entry it is kept and the place is given', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [STAGE, SECTOR]);

    const before = await readCallEntry(CODE, MEMBER, UserRole.MEMBER);
    expect(before).toMatchObject({ step: 'details', missing: { displayName: false, group: false, admissionCode: false, questions: true } });
    const landing = await getCallLanding(CODE, { userId: MEMBER, role: UserRole.MEMBER });
    expect(landing.asks.questions?.map((q) => q.key)).toEqual(['sector', 'stage']);

    // Without the answer: nothing is given, the step still asks.
    const unanswered = await enterCall(CODE, MEMBER, UserRole.MEMBER, {});
    expect(unanswered).toMatchObject({ step: 'details', missing: { questions: true } });
    expect(world.places.has(key(EVENT, MEMBER))).toBe(false);

    const entered = await enterCall(CODE, MEMBER, UserRole.MEMBER, { answers: { sector: ['fintech'], stage: ['idea'], gone: ['x'] } });
    expect(entered.step).toBe('wait_for_start');
    expect(world.answers.get(key(EVENT, MEMBER))).toEqual({ sector: ['fintech'], stage: ['idea'] });
    expect(world.places.get(key(EVENT, MEMBER))?.status).toBe('registered');
    await flush();
    // The answer change is told to the organisers and the person only.
    expect(answersTagSentTo()).toEqual([[HOST, MEMBER].sort()]);
  });

  it('entering again changes nothing (no write, no second registration)', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [SECTOR]);
    await enterCall(CODE, MEMBER, UserRole.MEMBER, { answers: { sector: ['health'] } });
    const writes = [...world.writes];
    const registrations = mockRegister.mock.calls.length;
    const again = await enterCall(CODE, MEMBER, UserRole.MEMBER, { answers: { sector: ['fintech'] } });
    expect(again.step).toBe('wait_for_start');
    expect(world.writes).toEqual(writes);
    expect(mockRegister.mock.calls.length).toBe(registrations);
    expect(world.answers.get(key(EVENT, MEMBER))).toEqual({ sector: ['health'] });
  });

  it('an approval event still asks the required question, and keeps the answers with the request', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'public_with_approval' });
    world.questions.set(EVENT, [SECTOR]);
    const before = await readCallEntry(CODE, MEMBER, UserRole.MEMBER);
    expect(before).toMatchObject({ step: 'details', missing: { questions: true, group: false } });
    expect(mockRequestToJoin).not.toHaveBeenCalled();
    const requested = await enterCall(CODE, MEMBER, UserRole.MEMBER, { answers: { sector: ['fintech'] } });
    expect(mockRequestToJoin).toHaveBeenCalledWith(EVENT, MEMBER, UserRole.MEMBER, null, { arrivedThroughCallLink: true });
    expect(requested.step).toBe('pending_approval');
    expect(world.answers.get(key(EVENT, MEMBER))).toEqual({ sector: ['fintech'] });
    expect(world.places.has(key(EVENT, MEMBER))).toBe(false);
  });

  it('an approval event with only optional questions sends the request straight away', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'public_with_approval' });
    world.questions.set(EVENT, [STAGE]);
    expect(await readCallEntry(CODE, MEMBER, UserRole.MEMBER)).toMatchObject({ step: 'request', missing: { questions: false } });
  });

  it('an optional question is never missing: the place is given without it, and it is neutral', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [STAGE]);
    const entry = await readCallEntry(CODE, MEMBER, UserRole.MEMBER);
    expect(entry.missing.questions).toBe(false);
    expect((await getCallLanding(CODE, { userId: MEMBER, role: UserRole.MEMBER })).asks.questions?.map((q) => q.key)).toEqual(['stage']);
    expect((await enterCall(CODE, MEMBER, UserRole.MEMBER, {})).step).toBe('wait_for_start');
  });

  it('a guest of this event answers through the link as a member does', async () => {
    addUser({ id: GUEST, email: 'guest@example.org', display_name: 'Guest', first_name: '', account_kind: 'event_guest', guest_first_session_id: EVENT });
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [SECTOR]);
    const entered = await enterCall(CODE, GUEST, UserRole.MEMBER, { displayName: 'Gita Guest', answers: { sector: ['health'] } });
    expect(entered.step).toBe('wait_for_start');
    expect(world.answers.get(key(EVENT, GUEST))).toEqual({ sector: ['health'] });
  });

  it('once the event is live nothing is asked, answers sent are left alone, and the place is given', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public', status: 'lobby_open' });
    world.questions.set(EVENT, [SECTOR]);
    expect((await readCallEntry(CODE, MEMBER, UserRole.MEMBER)).missing.questions).toBe(false);
    expect((await getCallLanding(CODE, { userId: MEMBER, role: UserRole.MEMBER })).asks.questions).toBeNull();
    expect((await getCallLanding(CODE, null)).asks.questions).toBeNull();
    const entered = await enterCall(CODE, MEMBER, UserRole.MEMBER, { answers: { sector: ['fintech'] } });
    expect(entered.step).toBe('enter');
    expect(world.answers.get(key(EVENT, MEMBER))).toBeUndefined();
  });

  it('the landing lists the questions, required first, signed out; never an answer; nothing once answered', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [STAGE, SECTOR]);
    world.answers.set(key(EVENT, HOST), { sector: ['fintech'], stage: ['growth'] });
    const out = await getCallLanding(CODE, null);
    expect(out.asks.questions?.map((q) => q.key)).toEqual(['sector', 'stage']);
    expect(JSON.stringify(out)).not.toMatch(/"(mine|answers|option_keys)"/);
    world.answers.set(key(EVENT, MEMBER), { sector: ['health'], stage: ['idea'] });
    const answered = await getCallLanding(CODE, { userId: MEMBER, role: UserRole.MEMBER });
    expect(answered.asks.questions).toBeNull();
    expect(JSON.stringify(answered)).not.toContain('"health"');
  });

  it('an event without questions asks nothing and reads the questions table once', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.sql = [];
    const entry = await readCallEntry(CODE, MEMBER, UserRole.MEMBER);
    expect(entry.missing.questions).toBe(false);
    expect(world.sql.filter((s) => s.includes('FROM event_matching_questions'))).toHaveLength(1);
    expect(world.sql.some((s) => s.includes('event_question_answers'))).toBe(false);
  });
});

// ─── Registration's rule, on a recording client ──────────────────────────────

function recordingClient(opts: { status?: string; questions?: EventMatchingQuestion[]; mine?: Record<string, string[]> }) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: flat, params });
      if (flat.startsWith('SELECT id, key, prompt')) {
        return { rows: (opts.questions ?? []).map((q) => ({ id: `q:${q.key}`, ...q })), rowCount: 0 };
      }
      if (flat === 'SELECT status FROM sessions WHERE id = $1') return { rows: [{ status: opts.status ?? 'scheduled' }], rowCount: 1 };
      if (flat.startsWith('SELECT q.key, a.option_keys')) {
        return { rows: Object.entries(opts.mine ?? {}).map(([k, v]) => ({ key: k, option_keys: v })), rowCount: 0 };
      }
      if (flat.startsWith('INSERT INTO event_question_answers')) {
        opts.mine = { ...(opts.mine ?? {}) };
        (params[2] as string[]).forEach((k, i) => { opts.mine![k] = String((params[3] as string[])[i]).split(','); });
        return { rows: [], rowCount: (params[2] as string[]).length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client: client as unknown as PoolClient, statements };
}

describe('applyRegistrationAnswers: only a person\'s own first self-registration waits for a required answer', () => {
  it('refuses the own first registration with 409 EVENT_ANSWERS_REQUIRED, in words', async () => {
    const { client } = recordingClient({ questions: [SECTOR, STAGE] });
    expect(await refusal(applyRegistrationAnswers(client, EVENT, MEMBER, UserRole.MEMBER, undefined, true))).toEqual({
      status: 409, code: ErrorCodes.EVENT_ANSWERS_REQUIRED, message: "Answer this event's questions first.",
    });
  });

  it('lets in an approval, an invite, a returning place, an organiser\'s add or a promotion (not own first), neutral', async () => {
    const { client, statements } = recordingClient({ questions: [SECTOR] });
    expect(await applyRegistrationAnswers(client, EVENT, MEMBER, UserRole.MEMBER, undefined, false)).toBe(false);
    expect(statements.some((s) => s.sql.includes('event_question_answers'))).toBe(false);
  });

  it('lets in the people who run the event', async () => {
    const { client } = recordingClient({ questions: [SECTOR] });
    expect(await refusal(applyRegistrationAnswers(client, EVENT, HOST, UserRole.MEMBER, undefined, true))).toBe('ok');
  });

  it('writes the answers given with it and then lets them in; an optional question alone never refuses', async () => {
    const answered = recordingClient({ questions: [SECTOR, STAGE] });
    expect(await applyRegistrationAnswers(answered.client, EVENT, MEMBER, UserRole.MEMBER, { sector: ['health'] }, true)).toBe(true);
    expect(answered.statements.find((s) => s.sql.startsWith('INSERT INTO event_question_answers'))?.params)
      .toEqual([EVENT, MEMBER, ['sector'], ['health']]);
    const optional = recordingClient({ questions: [STAGE] });
    expect(await refusal(applyRegistrationAnswers(optional.client, EVENT, MEMBER, UserRole.MEMBER, undefined, true))).toBe('ok');
  });

  it('refuses a malformed answer (two answers to a one-answer question) with a 400', async () => {
    const { client } = recordingClient({ questions: [SECTOR] });
    expect(await refusal(applyRegistrationAnswers(client, EVENT, MEMBER, UserRole.MEMBER, { sector: ['fintech', 'health'] }, true)))
      .toMatchObject({ status: 400 });
  });

  it('asks nothing and writes nothing once the event is live', async () => {
    const { client, statements } = recordingClient({ questions: [SECTOR], status: 'round_active' });
    expect(await applyRegistrationAnswers(client, EVENT, MEMBER, UserRole.MEMBER, { sector: ['health'] }, true)).toBe(false);
    expect(statements.some((s) => s.sql.includes('event_question_answers'))).toBe(false);
  });

  it('an event without questions: one read, nothing else', async () => {
    const { client, statements } = recordingClient({ questions: [] });
    expect(await applyRegistrationAnswers(client, EVENT, MEMBER, UserRole.MEMBER, { sector: ['x'] }, true)).toBe(false);
    expect(statements).toHaveLength(1);
  });

  it('the live page tells someone refused for it to answer on the event page', () => {
    expect(eventRoomRefusal('lobby_open', ErrorCodes.EVENT_ANSWERS_REQUIRED)).toEqual({
      code: ErrorCodes.EVENT_ANSWERS_REQUIRED, message: "Answer this event's questions first, on the event page.",
    });
  });
});

describe('registration wiring (source)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');
  const session = read('services/session/session.service.ts');
  const tx = session.slice(session.indexOf('async function registerParticipantTx('), session.indexOf('export { registerParticipantTx };'));

  it('reads whether the event asks a required question in the same row as the event, and only then reads further', () => {
    expect(tx).toContain('EXISTS (SELECT 1 FROM event_matching_questions emq WHERE emq.session_id = sessions.id AND emq.required) AS "hasRequiredQuestions"');
    expect(tx).toMatch(/if \(session\.hasRequiredQuestions \|\| \(options\.answers && Object\.keys\(options\.answers\)\.length > 0\)\) \{\s*await applyRegistrationAnswers\(client, sessionId, userId, userRole, options\.answers, ownFirstPlace\);/);
  });

  it('a held place is never asked; a new place only on a person\'s own first self-registration', () => {
    expect(tx).toContain('await writeGroups(false);');
    expect(tx).toContain('await writeGroups(!viaInvite && !options.approvedRequest && !options.fromWaitlist);');
  });

  it('the waiting list keeps answers given and asks the same rule when the person queues', () => {
    const w = read('services/session/event-waitlist.service.ts');
    const queue = w.slice(w.indexOf('async function placeOrQueue('), w.indexOf('export async function leaveWaitlist('));
    expect(queue.indexOf('applyRegistrationAnswers(')).toBeGreaterThan(queue.indexOf("ROLLBACK TO SAVEPOINT before_place"));
    expect(queue.indexOf('applyRegistrationAnswers(')).toBeLessThan(queue.indexOf('joinWaitlist('));
  });

  it('the event page\'s registration takes answers and tells the screens', () => {
    const route = read('routes/sessions.ts');
    expect(route).toContain('answers: eventAnswersSchema.optional(),');
    expect(route).toContain('if (options?.answers) void fanoutMyAnswers(req.params.id, req.user!.userId);');
  });
});

// ─── The person's own answers ────────────────────────────────────────────────

describe('saveMyAnswers', () => {
  beforeEach(() => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [SECTOR, STAGE]);
  });

  it('saves, changes and clears an optional answer; tells the organisers and the person', async () => {
    const saved = await saveMyAnswersAs(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['fintech'], stage: ['idea'] });
    expect(saved).toMatchObject({ mine: { sector: ['fintech'], stage: ['idea'] }, missingRequired: [], changed: true });
    const cleared = await saveMyAnswers(EVENT, MEMBER, { stage: [] });
    expect(cleared.mine).toEqual({ sector: ['fintech'] });
    await flush();
    expect(answersTagSentTo()).toEqual([[HOST, MEMBER].sort(), [HOST, MEMBER].sort()]);
  });

  it('a required question cannot be cleared', async () => {
    await saveMyAnswers(EVENT, MEMBER, { sector: ['fintech'] });
    expect(await refusal(saveMyAnswers(EVENT, MEMBER, { sector: [] }))).toMatchObject({ status: 400, message: 'This question needs an answer.' });
    expect(world.answers.get(key(EVENT, MEMBER))).toEqual({ sector: ['fintech'] });
  });

  it('answers lock once the event is live and once it is over', async () => {
    world.events[0].status = 'round_active';
    expect(await refusal(saveMyAnswers(EVENT, MEMBER, { sector: ['fintech'] }))).toMatchObject({ status: 409, code: ErrorCodes.SESSION_IN_PROGRESS });
    world.events[0].status = 'completed';
    expect(await refusal(saveMyAnswers(EVENT, MEMBER, { sector: ['fintech'] }))).toMatchObject({ status: 409, code: ErrorCodes.EVENT_ENDED });
  });

  it('an event the person cannot see reads as unknown', async () => {
    world.events[0].visibility = 'private';
    world.events[0].admission_mode = null;
    expect(await refusal(saveMyAnswersAs(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['fintech'] })))
      .toMatchObject({ status: 404 });
  });
});

describe('fix round 1: a tie to the event lets a person read and answer even where the page is closed to them (review M4)', () => {
  beforeEach(() => {
    // A private approval event: the page is closed to someone with no tie to it.
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'private' });
    world.questions.set(EVENT, [SECTOR]);
  });

  it('without a place, a request or a waiting row: unknown (404) to read and to answer', async () => {
    expect(await refusal(readEventQuestions(EVENT, { userId: MEMBER, role: UserRole.MEMBER }))).toMatchObject({ status: 404 });
    expect(await refusal(saveMyAnswersAs(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['health'] }))).toMatchObject({ status: 404 });
  });

  it('with a pending request (a guest who came in by the link alone): reads the questions and answers them', async () => {
    world.requests.set(key(EVENT, MEMBER), 'pending');
    expect((await readEventQuestions(EVENT, { userId: MEMBER, role: UserRole.MEMBER })).missingRequired).toEqual(['sector']);
    await saveMyAnswersAs(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['health'] });
    expect(world.answers.get(key(EVENT, MEMBER))).toEqual({ sector: ['health'] });
  });

  it('with a place: the same', async () => {
    world.places.set(key(EVENT, MEMBER), { status: 'registered', admitted_via: null });
    expect((await readEventQuestions(EVENT, { userId: MEMBER, role: UserRole.MEMBER })).questions).toEqual([SECTOR]);
  });

  it('never on a draft the person does not run', async () => {
    world.events[0].publication = 'draft';
    world.requests.set(key(EVENT, MEMBER), 'pending');
    expect(await refusal(readEventQuestions(EVENT, { userId: MEMBER, role: UserRole.MEMBER }))).toMatchObject({ status: 404 });
  });
});

describe('fix round 1: a request to join carries the answers (POST /:id/requests)', () => {
  it('saves them for someone who may answer, before the request', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'public_with_approval' });
    world.questions.set(EVENT, [SECTOR]);
    await saveAnswersWithRequest(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['fintech'] });
    expect(world.answers.get(key(EVENT, MEMBER))).toEqual({ sector: ['fintech'] });
    await flush();
    expect(answersTagSentTo()).toEqual([[HOST, MEMBER].sort()]);
  });

  it('leaves someone who may not answer to the request\'s own refusal: nothing saved, nothing thrown', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'private' });
    world.questions.set(EVENT, [SECTOR]);
    await saveAnswersWithRequest(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['fintech'] });
    expect(world.answers.get(key(EVENT, MEMBER))).toBeUndefined();
  });

  it('once the event is live, leaves the answers alone without a refusal', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'approval', visibility: 'public_with_approval', status: 'round_active' });
    world.questions.set(EVENT, [SECTOR]);
    await saveAnswersWithRequest(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, { sector: ['fintech'] });
    expect(world.answers.get(key(EVENT, MEMBER))).toBeUndefined();
  });

  it('the route takes `answers` with the same rule as the call link and saves them before requestToJoin (source)', () => {
    const route = fs.readFileSync(path.join(__dirname, '../../../routes/sessions.ts'), 'utf8');
    expect(route).toContain('const joinRequestSchema = z.object({ message: z.string().trim().max(500).optional(), answers: eventAnswersSchema.optional() });');
    const handler = route.slice(route.indexOf("'/:id/requests',"), route.indexOf("'/:id/requests/mine',"));
    expect(handler.indexOf('saveAnswersWithRequest(')).toBeGreaterThan(0);
    expect(handler.indexOf('saveAnswersWithRequest(')).toBeLessThan(handler.indexOf('eventRequests.requestToJoin('));
  });
});

describe('readEventQuestions: answers are the person\'s own and the organisers\'', () => {
  beforeEach(() => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    world.questions.set(EVENT, [SECTOR]);
    world.answers.set(key(EVENT, MEMBER), { sector: ['health'] });
  });

  it('a participant reads the questions, their own answers and what they still owe; never anyone else\'s', async () => {
    const view = await readEventQuestions(EVENT, { userId: MEMBER, role: UserRole.MEMBER });
    expect(view).toEqual({ questions: [SECTOR], mine: { sector: ['health'] }, missingRequired: [] });
    addUser({ id: uuid(4), email: 'other@example.org', display_name: 'Other' });
    const other = await readEventQuestions(EVENT, { userId: uuid(4), role: UserRole.MEMBER });
    expect(other).toEqual({ questions: [SECTOR], mine: {}, missingRequired: ['sector'] });
  });

  it('an organiser also reads every answer and the counts', async () => {
    mockOverride = (sql, params) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (flat.startsWith('SELECT a.user_id, q.key, a.option_keys FROM event_question_answers')) {
        return { rows: [{ user_id: MEMBER, key: 'sector', option_keys: ['health'] }, { user_id: GUEST, key: 'sector', option_keys: ['fintech'] }] };
      }
      return jest.requireActual('../../fixtures/call-link-world').answer(sql, params);
    };
    const view = await readEventQuestions(EVENT, { userId: HOST, role: UserRole.MEMBER });
    expect(view.answers).toEqual([{ userId: MEMBER, answers: { sector: ['health'] } }, { userId: GUEST, answers: { sector: ['fintech'] } }]);
    expect(view.counts).toEqual({ sector: { fintech: 1, health: 1 } });
  });

  it('the organisers list and count only people tied to the event: a place, a waiting row, a pending request (review M1)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../services/session/event-questions.service.ts'), 'utf8').replace(/\s+/g, ' ');
    const read = src.slice(src.indexOf('export async function readEventQuestions('));
    expect(read).toContain("EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = a.session_id AND sp.user_id = a.user_id AND sp.status <> 'removed')");
    expect(read).toContain("EXISTS (SELECT 1 FROM event_waitlist w WHERE w.session_id = a.session_id AND w.user_id = a.user_id AND w.status = 'waiting')");
    expect(read).toContain("EXISTS (SELECT 1 FROM event_join_requests r WHERE r.session_id = a.session_id AND r.user_id = a.user_id AND r.status = 'pending')");
  });
});

// ─── The organiser's save, on a recording database ───────────────────────────

describe('saveEventQuestions', () => {
  function recordingDb(status: string, current: EventMatchingQuestion[] = [SECTOR]) {
    const statements: string[] = [];
    mockOverride = (sql, params) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      statements.push(flat);
      if (flat === 'SELECT id FROM sessions WHERE id = $1') return { rows: [{ id: params[0] }] };
      if (flat === 'SELECT status FROM sessions WHERE id = $1 FOR UPDATE') return { rows: [{ status }] };
      if (flat.startsWith('SELECT id, key, prompt')) return { rows: current.map((q) => ({ id: `q:${q.key}`, ...q })) };
      if (flat.startsWith('DELETE FROM event_question_answers a USING event_matching_questions q WHERE q.id = a.question_id AND a.session_id = $1 AND (NOT EXISTS')) {
        return { rows: [{ user_id: MEMBER }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    return statements;
  }
  const host = { userId: HOST, role: UserRole.MEMBER };

  it('a save that changes nothing writes, audits and tells nobody (review M3)', async () => {
    const statements = recordingDb('scheduled', [SECTOR]);
    expect(await saveEventQuestions(EVENT, host, [SECTOR])).toEqual([SECTOR]);
    expect(statements.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
    await flush();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('is refused while the event is live, in words, and writes nothing', async () => {
    const statements = recordingDb('round_active');
    expect(await refusal(saveEventQuestions(EVENT, host, [SECTOR]))).toEqual({
      status: 409, code: ErrorCodes.SESSION_IN_PROGRESS, message: "Matching questions can't change while the event is live.",
    });
    expect(statements.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
  });

  it('is refused once the event is over', async () => {
    recordingDb('completed');
    expect(await refusal(saveEventQuestions(EVENT, host, [SECTOR]))).toMatchObject({ status: 409, code: ErrorCodes.EVENT_ENDED });
  });

  it('is the organisers\' only', async () => {
    addEvent({ id: EVENT, call_code: CODE, admission_mode: 'open', visibility: 'public' });
    recordingDb('scheduled');
    expect(await refusal(saveEventQuestions(EVENT, { userId: MEMBER, role: UserRole.MEMBER }, [SECTOR]))).toMatchObject({ status: 403 });
  });

  it('refuses a sixth question and one answer to choose from', async () => {
    recordingDb('scheduled');
    const six = Array.from({ length: 6 }, (_, i) => ({ ...STAGE, key: `q${i}` }));
    expect(await refusal(saveEventQuestions(EVENT, host, six))).toMatchObject({ status: 400 });
    expect(await refusal(saveEventQuestions(EVENT, host, [{ ...SECTOR, options: [SECTOR.options[0]] }]))).toMatchObject({ status: 400 });
  });

  it('removing an answer strips it from everyone\'s answers: empties go first, then the rest keep what is still offered', async () => {
    const statements = recordingDb('scheduled');
    const narrowed = { ...SECTOR, options: [SECTOR.options[0], { key: 'climate', label: 'Climate' }] };
    await saveEventQuestions(EVENT, host, [narrowed]);
    const order = [
      statements.findIndex((s) => s.startsWith('DELETE FROM event_question_answers a USING event_matching_questions q WHERE q.id = a.question_id AND q.session_id = $1 AND NOT (q.key = ANY')),
      statements.findIndex((s) => s.startsWith('DELETE FROM event_matching_questions WHERE session_id = $1 AND NOT (key = ANY')),
      statements.findIndex((s) => s.startsWith('INSERT INTO event_matching_questions')),
      statements.findIndex((s) => s.startsWith('DELETE FROM event_question_answers a USING event_matching_questions q WHERE q.id = a.question_id AND a.session_id = $1 AND (NOT EXISTS')),
      statements.findIndex((s) => s.startsWith('UPDATE event_question_answers a SET option_keys = ARRAY(')),
      statements.findIndex((s) => s.startsWith('INSERT INTO audit_log')),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await flush();
    // The organisers and every participant and answerer are told; the audit trail too.
    expect(mockEmit.mock.calls.some(([, , tags]) => (tags as string[]).includes(QUESTIONS_TAG))).toBe(true);
    expect(mockEmit.mock.calls.some(([, , tags]) => (tags as string[]).includes(`session:${EVENT}:audit`))).toBe(true);
  });
});

// ─── Privacy: answers are read in one place only ─────────────────────────────

describe('privacy (source)', () => {
  it('no file but the questions service reads event_question_answers (not /schedule/mine, profiles, Everyone or the landing)', () => {
    const root = path.join(__dirname, '../../..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'migrations') walk(full);
        } else if (/\.ts$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('event_question_answers')) {
          found.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(root);
    expect(found).toEqual(['services/session/event-questions.service.ts']);
  });
});
