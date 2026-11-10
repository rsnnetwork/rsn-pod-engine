// ─── The RSN Call link under attack: guessing and enumeration (Part 2 foundation, Task 6; Review Focus 4) ────
//
// Through express with the real Call link and auth routers, the real rate limiters, the real identity service and the
// real access rules; the database is the in-memory world (fixtures/call-link-world.ts). What must hold:
//   - a link that leads nowhere (malformed, unknown, a draft to someone who does not run it, a deleted event) answers
//     one byte-identical 404, so a code tells nothing about an event the asker may not see;
//   - the 21st such 404 from one network address in ten minutes is refused (429), while the same link keeps working
//     from every other address;
//   - the 6-digit entry code allows five tries, then it is dead with its link, even for the right code;
//   - an entry code is bound to its event: another event's code is simply wrong;
//   - an entry code is never a sign-in code and a sign-in code is never an entry code;
//   - admission codes typed while entering count toward the admission-code buckets.

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 60,
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test', googleClientId: '', googleClientSecret: '',
    env: 'test', isDev: false, isProd: false, isTest: true, resendApiKey: '',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 100000,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => {
  const w = jest.requireActual('../fixtures/call-link-world');
  const run = (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params));
  return { query: run, transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: run }), __esModule: true };
});
jest.mock('../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => ({}), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({
  fanoutSessionEntities: jest.fn().mockResolvedValue(undefined),
  fanoutProfileChange: jest.fn().mockResolvedValue(undefined),
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
const mockSendEntryEmail = jest.fn();
jest.mock('../../services/email/email.service', () => ({
  sendCallEntryCodeEmail: (...a: unknown[]) => mockSendEntryEmail(...a),
  isEmailTypeEnabled: () => Promise.resolve(true),
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/session/registration-email', () => ({ sendRegistrationEmail: jest.fn(), __esModule: true }));
jest.mock('../../services/roles/effective-role.service', () => ({
  canActAsHost: () => Promise.resolve({ allowed: false, effectiveRole: 'participant' }),
  __esModule: true,
}));
jest.mock('../../services/post-event-message/event-organisers', () => ({ resolveEventOrganiserIds: jest.fn().mockResolvedValue([]), __esModule: true }));
jest.mock('../../services/session/event-access', () => {
  const actual = jest.requireActual('../../services/session/event-access');
  const w = jest.requireActual('../fixtures/call-link-world');
  return { ...actual, readEventAccessFacts: (sessionId: string, userId: string) => Promise.resolve(w.factsOf(sessionId, userId)) };
});
jest.mock('../../services/session/event-groups.service', () => ({
  getEventGroupRules: () => Promise.resolve(null),
  setParticipantGroups: jest.fn(),
  fanoutEventGroups: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/session/event-requests.service', () => ({ requestToJoin: jest.fn(), __esModule: true }));
jest.mock('../../services/session/event-admission.service', () => {
  const actual = jest.requireActual('../../services/session/event-admission.service');
  const { AppError } = jest.requireActual('../../middleware/errors');
  return {
    normaliseAdmissionCode: actual.normaliseAdmissionCode,
    hashAdmissionCode: actual.hashAdmissionCode,
    redeemAdmissionCode: () => Promise.reject(new AppError(400, 'ADMISSION_CODE_INVALID', 'That admission code is not right.')),
    fanoutAdmissionChanged: jest.fn(),
    __esModule: true,
  };
});
jest.mock('../../services/session/session.service', () => ({ registerParticipant: jest.fn(), __esModule: true }));

import callLinkRoutes from '../../routes/call-links';
import authRoutes from '../../routes/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import {
  CALL_LINK_EMAILS_PER_LINK, CALL_LINK_MISSES_MAX, CALL_LINK_PROXY_MISSES_MAX, callLinkEmailTargetKey, callLinkEmailTargetLimiter,
  signInCodeEmailKey, signInCodeEmailLimiter,
} from '../../middleware/rateLimit';
import { hashSignInCode } from '../../services/identity/sign-in-code';
import { addEvent, addUser, resetWorld, uuid, world } from '../fixtures/call-link-world';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/call-links', callLinkRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const EVENT_A = uuid(100);
const EVENT_B = uuid(101);
const CODE_A = 'k7m2x9q4ra';
const CODE_B = 'hhhhhhhhhh';
const MEMBER = uuid(2);
const EMAIL = 'visitor@example.org';

let ipSeq = 0;
const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const token = (sub: string) => jwt.sign({ sub, email: 'x@example.org', role: 'member', sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });

beforeEach(() => {
  resetWorld();
  addUser({ id: MEMBER, email: 'member@example.org' });
  addEvent({ id: EVENT_A, call_code: CODE_A, admission_mode: 'open' });
  addEvent({ id: EVENT_B, call_code: CODE_B, admission_mode: 'open' });
  mockSendEntryEmail.mockReset().mockResolvedValue(undefined);
  void signInCodeEmailLimiter.resetKey(signInCodeEmailKey(EMAIL));
  // The per-link-and-address bucket outlives a test too (most tests ask the same link for the same address).
  for (const code of [CODE_A, CODE_B]) for (const email of [EMAIL, 'member@example.org']) {
    void callLinkEmailTargetLimiter.resetKey(callLinkEmailTargetKey({ params: { code }, body: { email } } as never));
  }
});

async function askCode(code: string, ip: string, email = EMAIL): Promise<string> {
  const res = await request(app).post(`/api/call-links/${code}/email`).set('cf-connecting-ip', ip).send({ email });
  if (res.status !== 200) throw new Error(`code request refused: ${res.status} ${res.text}`);
  return (mockSendEntryEmail.mock.calls.at(-1) as [string, { code: string }])[1].code;
}
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('one answer for every link that leads nowhere', () => {
  it('malformed, unknown, a draft and a deleted event answer byte-identical 404s, on the landing and on the code request', async () => {
    addEvent({ id: uuid(102), call_code: 'dddddddddd', publication: 'draft' });
    addEvent({ id: uuid(103), call_code: 'eeeeeeeeee' });
    const ip = nextIp();
    const get = (c: string, auth?: string) => {
      const r = request(app).get(`/api/call-links/${c}`).set('cf-connecting-ip', ip);
      return auth ? r.set('Authorization', `Bearer ${auth}`) : r;
    };
    const answers = [await get('not-a-code'), await get('zzzzzzzzzz'), await get('dddddddddd'), await get('dddddddddd', token(MEMBER))];
    world.events = world.events.filter((e) => e.call_code !== 'eeeeeeeeee'); // deleted for good
    answers.push(await get('eeeeeeeeee'));
    for (const r of answers) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(answers[0].text);
    }
    expect(JSON.parse(answers[0].text)).toEqual({ success: false, error: { code: 'SESSION_NOT_FOUND', message: "We couldn't find that event." } });
    const viaEmail = await request(app).post('/api/call-links/dddddddddd/email').set('cf-connecting-ip', ip).send({ email: EMAIL });
    expect(viaEmail.status).toBe(404);
    expect(viaEmail.text).toBe(answers[0].text);
  });
});

describe('guessing links', () => {
  it(`the ${CALL_LINK_MISSES_MAX + 1}st miss in ten minutes from one address is refused, while the link still opens from another`, async () => {
    const guesser = nextIp();
    for (let i = 0; i < CALL_LINK_MISSES_MAX; i++) {
      const r = await request(app).get(`/api/call-links/${crypto.randomBytes(5).toString('hex')}`).set('cf-connecting-ip', guesser);
      expect(r.status).toBe(404);
    }
    const blocked = await request(app).get('/api/call-links/zzzzzzzzzz').set('cf-connecting-ip', guesser);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    // Every link answer from that address now waits, a right one included.
    expect((await request(app).get(`/api/call-links/${CODE_A}`).set('cf-connecting-ip', guesser)).status).toBe(429);
    expect((await request(app).post(`/api/call-links/${CODE_A}/email`).set('cf-connecting-ip', guesser).send({ email: EMAIL })).status).toBe(429);
    // Anyone else opens it.
    const other = await request(app).get(`/api/call-links/${CODE_A}`).set('cf-connecting-ip', nextIp());
    expect(other.status).toBe(200);
    expect(other.body.data.code).toBe(CODE_A);
  });

  it('a link that works never counts as a miss', async () => {
    const ip = nextIp();
    for (let i = 0; i < CALL_LINK_MISSES_MAX + 5; i++) {
      expect((await request(app).get(`/api/call-links/${CODE_A}`).set('cf-connecting-ip', ip)).status).toBe(200);
    }
  });
});

describe('guessing the 6-digit entry code', () => {
  it('five tries: the fifth wrong one kills the code and its link, and a sixth (even the right code) is refused', async () => {
    const ip = nextIp();
    const code = await askCode(CODE_A, ip);
    const verify = (c: string) => request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: EMAIL, code: c });
    for (let i = 1; i <= 4; i++) {
      const r = await verify(wrong(code));
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'AUTH_SIGN_IN_CODE_WRONG', details: { attemptsLeft: 5 - i } });
    }
    const fifth = await verify(wrong(code));
    expect(fifth.body.error.code).toBe('AUTH_SIGN_IN_LOCKED');
    const sixth = await verify(code);
    expect(sixth.status).toBe(400);
    expect(sixth.body.error.code).toBe('AUTH_SIGN_IN_LOCKED');
    expect(world.users.some((u) => u.email === EMAIL)).toBe(false);
    // The email's button died with it.
    expect(world.links[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a code from another event\'s email is wrong here, and its own link is not touched', async () => {
    const ip = nextIp();
    const codeForA = await askCode(CODE_A, ip);
    const codeForB = await askCode(CODE_B, ip);
    // One chance in a million the two emails carry the same six digits; then the test proves nothing, so draw again.
    const codeHere = codeForB === codeForA ? await askCode(CODE_B, ip) : codeForB;
    expect(codeHere).not.toBe(codeForA);
    const r = await request(app).post(`/api/call-links/${CODE_B}/verify`).set('cf-connecting-ip', ip).send({ email: EMAIL, code: codeForA });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(world.links.find((l) => l.target_id === EVENT_A)).toMatchObject({ used_at: null, code_attempts: 0 });
    // And it still works where it belongs.
    const ok = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: EMAIL, code: codeForA });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ accountKind: 'event_guest', created: true });
  });
});

describe('an entry code is never a sign-in code, and the reverse', () => {
  it('an event entry code cannot sign in through /auth/magic-link/code', async () => {
    const ip = nextIp();
    const code = await askCode(CODE_A, ip);
    const r = await request(app).post('/api/auth/magic-link/code').set('cf-connecting-ip', ip).send({ email: EMAIL, code });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(world.links[0]).toMatchObject({ used_at: null, code_attempts: 0 });
    expect(world.users.some((u) => u.email === EMAIL)).toBe(false);
  });

  it('a sign-in code (a login link) cannot enter an event through /call-links/:code/verify', async () => {
    const ip = nextIp();
    const tokenHash = crypto.createHash('sha256').update('login-token').digest('hex');
    world.links.push({
      id: crypto.randomUUID(), email: 'member@example.org', token_hash: tokenHash, expires_at: new Date(Date.now() + 3600_000),
      used_at: null, created_at: new Date(), purpose: 'login', target_id: null, code_hash: hashSignInCode(tokenHash, '123456'), code_attempts: 0,
    });
    const byCode = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: 'member@example.org', code: '123456' });
    expect(byCode.status).toBe(400);
    expect(byCode.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    const byToken = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ token: 'login-token' });
    expect(byToken.status).toBe(401);
    expect(world.links[0]).toMatchObject({ used_at: null, code_attempts: 0 });
  });
});

describe('admission codes typed while entering', () => {
  it('count toward the admission-code bucket: the eleventh wrong one in an hour is refused', async () => {
    world.events.find((e) => e.id === EVENT_A)!.admission_mode = 'restricted';
    world.events.find((e) => e.id === EVENT_A)!.visibility = 'private';
    const ip = nextIp();
    const enter = () => request(app).post(`/api/call-links/${CODE_A}/enter`).set('cf-connecting-ip', ip)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ admissionCode: 'ZZZZ-ZZZZ-ZZZZ' });
    for (let i = 0; i < 10; i++) {
      const r = await enter();
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('ADMISSION_CODE_INVALID');
    }
    const eleventh = await enter();
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.message).toMatch(/Too many codes tried/);
  });
});

describe('no answer tells whether an address has an account (fix round 1)', () => {
  it('on an invitation-only event, /email answers a member and an unknown address byte for byte the same', async () => {
    world.events.find((e) => e.id === EVENT_A)!.admission_mode = 'restricted';
    world.events.find((e) => e.id === EVENT_A)!.visibility = 'private';
    const ip = nextIp();
    const known = await request(app).post(`/api/call-links/${CODE_A}/email`).set('cf-connecting-ip', ip).send({ email: 'member@example.org' });
    const unknown = await request(app).post(`/api/call-links/${CODE_A}/email`).set('cf-connecting-ip', ip).send({ email: EMAIL });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.text).toBe(unknown.text);
    expect(JSON.parse(known.text)).toEqual({ success: true, data: { sent: true } });
  });

  it('a wrong code at /verify is byte for byte the same for a member and an unknown address', async () => {
    world.events.find((e) => e.id === EVENT_A)!.admission_mode = 'restricted';
    world.events.find((e) => e.id === EVENT_A)!.visibility = 'private';
    const ip = nextIp();
    void signInCodeEmailLimiter.resetKey(signInCodeEmailKey('member@example.org'));
    const k = await askCode(CODE_A, ip, 'member@example.org');
    const u = await askCode(CODE_A, ip, EMAIL);
    const a = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: 'member@example.org', code: wrong(k) });
    const b = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: EMAIL, code: wrong(u) });
    expect(a.status).toBe(400);
    expect(a.text).toBe(b.text);
    // The right code tells the newcomer, and only them, why they cannot come in, and makes no account.
    const proved = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: EMAIL, code: u });
    expect(proved.status).toBe(403);
    expect(proved.body.error).toMatchObject({ code: 'EVENT_ADMISSION_REQUIRED', details: { admissionCode: true } });
    expect(proved.body.error.message).toMatch(/^This event is invitation only\./);
    expect(world.users.some((x) => x.email === EMAIL)).toBe(false);
  });
});

describe('buckets a caller cannot step around (fix round 1)', () => {
  it('a new cf-connecting-ip on every try does not escape the proxy\'s own address bucket', async () => {
    const realAddress = '203.0.113.77';
    let last = 0;
    for (let i = 0; i <= CALL_LINK_PROXY_MISSES_MAX; i++) {
      const r = await request(app).get(`/api/call-links/${crypto.randomBytes(5).toString('hex')}`)
        .set('x-forwarded-for', realAddress).set('cf-connecting-ip', `198.51.100.${i % 250}.${i}`);
      last = r.status;
      if (i < CALL_LINK_PROXY_MISSES_MAX) expect(r.status).toBe(404);
    }
    expect(last).toBe(429);
    const elsewhere = await request(app).get(`/api/call-links/${CODE_A}`).set('x-forwarded-for', '203.0.113.78').set('cf-connecting-ip', nextIp());
    expect(elsewhere.status).toBe(200);
  });

  it('one link takes a capped number of code requests, however many addresses and networks ask', async () => {
    addEvent({ id: uuid(110), call_code: 'pppppppppp', admission_mode: 'open' });
    for (let i = 0; i < CALL_LINK_EMAILS_PER_LINK; i++) {
      const r = await request(app).post('/api/call-links/pppppppppp/email')
        .set('x-forwarded-for', `192.0.2.${i % 250}`).set('cf-connecting-ip', `10.200.${Math.floor(i / 250)}.${i % 250}`)
        .send({ email: `cycle-${i}@example.org` });
      if (r.status !== 200) throw new Error(`at ${i}: ${r.status} ${r.text}`);
    }
    const over = await request(app).post('/api/call-links/pppppppppp/email')
      .set('x-forwarded-for', '192.0.2.251').set('cf-connecting-ip', nextIp()).send({ email: 'one-more@example.org' });
    expect(over.status).toBe(429);
  });

  it('the per-link-and-address key reads every spelling of a link as one (o→0, i/l→1, separators)', () => {
    const key = (code: string) => callLinkEmailTargetKey({ params: { code }, body: { email: EMAIL } } as never);
    expect(key('K7M2-X9Q4-RA')).toBe(key('k7m2x9q4ra'));
    expect(key('1o1o1o1o1o')).toBe(key('l0i0101010'));
  });
});

describe('the shape of what is sent', () => {
  it('a code that is not six digits, or a body with both shapes, is refused before any database read', async () => {
    const ip = nextIp();
    world.sql = [];
    for (const body of [{ email: EMAIL, code: '12345' }, { email: EMAIL, code: 'abcdef' }, { email: EMAIL, code: '123456', token: 't' }, {}]) {
      const r = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send(body);
      expect(r.status).toBe(400);
    }
    expect(world.sql.filter((s) => /magic_links/.test(s))).toEqual([]);
  });

  it('a guest token reaches its own entry (the guest allowlist names /api/call-links)', async () => {
    const ip = nextIp();
    const code = await askCode(CODE_A, ip);
    const signedIn = await request(app).post(`/api/call-links/${CODE_A}/verify`).set('cf-connecting-ip', ip).send({ email: EMAIL, code });
    const entry = await request(app).get(`/api/call-links/${CODE_A}/entry`).set('cf-connecting-ip', ip)
      .set('Authorization', `Bearer ${signedIn.body.data.accessToken}`);
    expect(entry.status).toBe(200);
    expect(entry.body.data).toMatchObject({ step: 'details', missing: { displayName: true } });
    const mine = await request(app).get('/api/call-links/me/events').set('cf-connecting-ip', ip)
      .set('Authorization', `Bearer ${signedIn.body.data.accessToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([]);
  });
});
