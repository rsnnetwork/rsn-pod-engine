// ─── The 6-digit sign-in code, through the real router (1 Nov 2026) ─────────────────────────────────
//
// The sign-in email now also carries a 6-digit code to type on the waiting screen (the plan's L14). These go
// through express with the real auth router, the real identity service and the real rate limiters; only the
// database (an in-memory magic_links table that answers the service's own statements), config, the logger and
// the email sender are stand-ins. The code is read where a member reads it: from the email.
//
// Also the compatibility pin production's client needs: its sign-in page posts { email, clientUrl } to
// /auth/magic-link and its verify page posts { token } to /auth/verify (origin/main client/src/stores/authStore.ts),
// and both answer exactly as before.

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 60,
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
    googleClientId: '', googleClientSecret: '',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({ sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined), __esModule: true }));

// ── An in-memory magic_links table that answers the statements the service sends ──
interface LinkRow {
  id: string; email: string; token_hash: string; expires_at: Date; used_at: Date | null; created_at: Date;
  purpose: string; code_hash: string | null; code_attempts: number;
}
interface UserRow { id: string; email: string; displayName: string; role: string; status: string; emailVerified: boolean }
let links: LinkRow[] = [];
let users: UserRow[] = [];
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: jest.fn(),
  __esModule: true,
}));

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const now = () => Date.now();
const MIN = 60_000;

function answer(sqlRaw: string, params: unknown[] = []) {
  const sql = flat(sqlRaw);
  const byId = (id: unknown) => links.find((l) => l.id === id);
  if (/FROM users WHERE email = \$1/.test(sql)) {
    return { rows: users.filter((u) => u.email === params[0]), rowCount: 1 };
  }
  // sendMagicLink: the older short-lived login links of this email die when a new one is asked for.
  if (/^UPDATE magic_links SET used_at = NOW\(\) WHERE email = \$1 AND purpose = 'login' AND used_at IS NULL/.test(sql)) {
    for (const l of links) {
      if (l.email === params[0] && l.purpose === 'login' && !l.used_at && l.expires_at.getTime() > now()
        && l.expires_at.getTime() <= now() + 120 * MIN) l.used_at = new Date();
    }
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO magic_links \(email, token_hash, expires_at, code_hash\) VALUES \(\$1, \$2, \$3, \$4\)$/.test(sql)) {
    links.push({
      id: crypto.randomUUID(), email: String(params[0]), token_hash: String(params[1]), expires_at: params[2] as Date,
      used_at: null, created_at: new Date(), purpose: 'login', code_hash: String(params[3]), code_attempts: 0,
    });
    return { rows: [], rowCount: 1 };
  }
  // verifyMagicLink
  if (/FROM magic_links WHERE token_hash = \$1 AND purpose = 'login'$/.test(sql)) {
    const l = links.find((x) => x.token_hash === params[0] && x.purpose === 'login');
    return { rows: l ? [{ id: l.id, email: l.email, expires_at: l.expires_at, used_at: l.used_at }] : [], rowCount: l ? 1 : 0 };
  }
  if (/^UPDATE magic_links SET used_at = NOW\(\) WHERE id = \$1$/.test(sql)) {
    const l = byId(params[0]); if (l) l.used_at = new Date();
    return { rows: [], rowCount: l ? 1 : 0 };
  }
  // verifySignInCode: the newest login link of this email that carries a code (or that one link again, by id).
  const codeRow = (l: LinkRow) => ({
    id: l.id, email: l.email, token_hash: l.token_hash, code_hash: l.code_hash, used_at: l.used_at, code_attempts: l.code_attempts,
    code_live: l.created_at.getTime() > now() - Number(params[1]) * MIN,
    link_live: l.expires_at.getTime() > now(),
  });
  if (/FROM magic_links WHERE email = \$1 AND purpose = 'login' AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1$/.test(sql)) {
    const mine = links.filter((l) => l.email === params[0] && l.purpose === 'login' && l.code_hash)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { rows: mine.slice(0, 1).map(codeRow), rowCount: Math.min(1, mine.length) };
  }
  if (/FROM magic_links WHERE id = \$1$/.test(sql) && /code_live/.test(sql)) {
    const l = byId(params[0]);
    return { rows: l ? [codeRow(l)] : [], rowCount: l ? 1 : 0 };
  }
  if (/^UPDATE magic_links SET code_attempts = code_attempts \+ 1 WHERE id = \$1 AND used_at IS NULL AND code_attempts < \$2 RETURNING code_attempts$/.test(sql)) {
    const l = byId(params[0]);
    if (!l || l.used_at || l.code_attempts >= Number(params[1])) return { rows: [], rowCount: 0 };
    l.code_attempts += 1;
    return { rows: [{ code_attempts: l.code_attempts }], rowCount: 1 };
  }
  if (/^UPDATE magic_links SET used_at = COALESCE\(used_at, NOW\(\)\), expires_at = LEAST\(expires_at, NOW\(\)\) WHERE id = \$1$/.test(sql)) {
    const l = byId(params[0]);
    if (l) { l.used_at = l.used_at ?? new Date(); l.expires_at = new Date(Math.min(l.expires_at.getTime(), now())); }
    return { rows: [], rowCount: l ? 1 : 0 };
  }
  if (/^UPDATE magic_links SET used_at = NOW\(\), code_attempts = code_attempts - 1 WHERE id = \$1 AND used_at IS NULL RETURNING id$/.test(sql)) {
    const l = byId(params[0]);
    if (!l || l.used_at) return { rows: [], rowCount: 0 };
    l.used_at = new Date(); l.code_attempts -= 1;
    return { rows: [{ id: l.id }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
}

import authRoutes from '../../routes/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { sendMagicLinkEmail } from '../../services/email/email.service';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/auth', authRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const MEMBER: UserRow = { id: '11111111-1111-1111-1111-111111111111', email: 'stefan@example.com', displayName: 'Stefan', role: 'member', status: 'active', emailVerified: true };

// Every test signs in from an address of its own, so the per-address limits never reach across tests.
let ip = 0;
let myIp = '';
const post = (path: string, body: object) => request(app).post(path).set('cf-connecting-ip', myIp).send(body);

beforeEach(() => {
  links = [];
  users = [{ ...MEMBER }];
  ip += 1;
  myIp = `10.0.0.${ip}`;
  mockQuery.mockReset().mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(answer(sql, params)));
  (sendMagicLinkEmail as jest.Mock).mockClear();
});

/** Ask for a sign-in email the way the sign-in page does, and return what the email carries. */
async function emailed(email = MEMBER.email, extra: object = {}) {
  const res = await post('/auth/magic-link', { email, clientUrl: 'https://preview.rsn.network', ...extra });
  expect(res.status).toBe(200);
  const call = (sendMagicLinkEmail as jest.Mock).mock.calls.at(-1) as [string, string, string];
  const [to, link, code] = call;
  return { to, link, code, token: new URL(link).searchParams.get('token') ?? '', body: res.body };
}
const sessionsWritten = () => mockQuery.mock.calls.filter((c) => /INSERT INTO refresh_tokens/.test(String(c[0]))).length;
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('the sign-in email carries a 6-digit code', () => {
  it('a fresh crypto-random code goes into the email beside the link, and only its keyed hash is stored', async () => {
    const { to, code, token } = await emailed();
    expect(to).toBe(MEMBER.email);
    expect(code).toMatch(/^\d{6}$/);
    const [row] = links;
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).not.toBe(crypto.createHash('sha256').update(code).digest('hex'));
    expect(row.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    const again = await emailed();
    expect(links[1].code_hash).not.toBe(row.code_hash);
    expect(again.code).toMatch(/^\d{6}$/);
  });

  it('the right code signs in: the same tokens /auth/verify gives, for the member who asked', async () => {
    const { code } = await emailed();
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken']);
    const access = jwt.verify(res.body.data.accessToken, JWT_SECRET) as { sub: string; email: string };
    expect(access.sub).toBe(MEMBER.id);
    expect(access.email).toBe(MEMBER.email);
    expect(sessionsWritten()).toBe(1);
  });

  it('takes the email in any case and the code with a space or a dash in it, as people paste it', async () => {
    const { code } = await emailed();
    const res = await post('/auth/magic-link/code', { email: '  Stefan@Example.com ', code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(res.status).toBe(200);
    const second = await emailed();
    expect((await post('/auth/magic-link/code', { email: MEMBER.email, code: `${second.code.slice(0, 3)}-${second.code.slice(3)}` })).status).toBe(200);
  });

  it('a code that is not six digits is refused in words before the database is asked', async () => {
    await emailed();
    const before = mockQuery.mock.calls.length;
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Enter the 6-digit code from the email.');
    expect(mockQuery.mock.calls.length).toBe(before);
  });

  it('a wrong code says how many tries are left and signs nobody in', async () => {
    const { code } = await emailed();
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code: wrongCode(code) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(res.body.error.details).toEqual({ attemptsLeft: 4 });
    expect(sessionsWritten()).toBe(0);
  });

  it('five wrong codes kill the code AND the link: the right code and the link both stop working', async () => {
    const { code, token } = await emailed();
    const left: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await post('/auth/magic-link/code', { email: MEMBER.email, code: wrongCode(code) });
      expect(r.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
      left.push(r.body.error.details.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await post('/auth/magic-link/code', { email: MEMBER.email, code: wrongCode(code) });
    expect(fifth.status).toBe(400);
    expect(fifth.body.error.code).toBe('AUTH_SIGN_IN_LOCKED');

    const right = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(right.status).toBe(400);
    expect(right.body.error.code).toBe('AUTH_SIGN_IN_LOCKED');

    // The link dies at once, not after the 2-minute grace a scanner's early click gets.
    const link = await post('/auth/verify', { token });
    expect(link.status).toBe(400);
    expect(link.body.error.code).toBe('AUTH_MAGIC_LINK_EXPIRED');
    expect(sessionsWritten()).toBe(0);
  });

  it('the right code on the fifth try still signs in (only wrong tries count against it)', async () => {
    const { code } = await emailed();
    for (let i = 0; i < 4; i++) await post('/auth/magic-link/code', { email: MEMBER.email, code: wrongCode(code) });
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(res.status).toBe(200);
    expect(links[0].code_attempts).toBe(4);
  });

  it('a code older than 15 minutes is refused as expired, while the 60-minute link still signs in', async () => {
    const { code, token } = await emailed();
    links[0].created_at = new Date(now() - 16 * MIN);
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_EXPIRED');
    expect(links[0].code_attempts).toBe(0);
    expect((await post('/auth/verify', { token })).status).toBe(200);
  });

  it('a code whose link has expired is refused as expired', async () => {
    const { code } = await emailed();
    links[0].expires_at = new Date(now() - 1000);
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_EXPIRED');
  });

  it('using the code spends the link, and using the link spends the code', async () => {
    const first = await emailed();
    expect((await post('/auth/magic-link/code', { email: MEMBER.email, code: first.code })).status).toBe(200);
    links[0].used_at = new Date(now() - 3 * MIN); // past the link's 2-minute scanner grace
    const link = await post('/auth/verify', { token: first.token });
    expect(link.body.error.code).toBe('AUTH_MAGIC_LINK_USED');

    const second = await emailed();
    expect((await post('/auth/verify', { token: second.token })).status).toBe(200);
    const code = await post('/auth/magic-link/code', { email: MEMBER.email, code: second.code });
    expect(code.status).toBe(400);
    expect(code.body.error.code).toBe('AUTH_MAGIC_LINK_USED');
    expect(sessionsWritten()).toBe(2);
  });

  it('a new email makes the older code useless (only the newest code works)', async () => {
    const older = await emailed();
    await emailed();
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code: older.code });
    expect(res.status).toBe(400);
    expect(['AUTH_SIGN_IN_CODE_WRONG', 'AUTH_MAGIC_LINK_USED']).toContain(res.body.error.code);
    expect(sessionsWritten()).toBe(0);
  });

  it('a code only works for the email it was sent to', async () => {
    users.push({ ...MEMBER, id: '33333333-3333-3333-3333-333333333333', email: 'claus@example.com' });
    const { code } = await emailed();
    const res = await post('/auth/magic-link/code', { email: 'claus@example.com', code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(sessionsWritten()).toBe(0);
  });

  it('a closed account gets no session from a code, and is told why', async () => {
    const { code } = await emailed();
    users[0].status = 'deactivated';
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_CLOSED');
    expect(sessionsWritten()).toBe(0);
  });

  it('a join-request review link (another purpose) is never a code the member can type', async () => {
    links.push({
      id: 'review-1', email: MEMBER.email, token_hash: 'f'.repeat(64), expires_at: new Date(now() + 7 * 24 * 60 * MIN),
      used_at: null, created_at: new Date(), purpose: 'join_request_review', code_hash: 'a'.repeat(64), code_attempts: 0,
    });
    const res = await post('/auth/magic-link/code', { email: MEMBER.email, code: '123456' });
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(links[0].code_attempts).toBe(0);
  });

  it('allows 10 tries per address per 15 minutes, then answers 429 in words', async () => {
    const { code } = await emailed();
    links[0].code_attempts = -100; // keep the link alive, so only the address limit is measured
    for (let i = 0; i < 10; i++) {
      const r = await post('/auth/magic-link/code', { email: MEMBER.email, code: wrongCode(code) });
      expect(r.status).toBe(400);
    }
    const eleventh = await post('/auth/magic-link/code', { email: MEMBER.email, code });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(eleventh.body.error.message).toBe('Too many codes tried. Please wait 15 minutes, then try again.');
  });
});

describe('the page a member was going to rides in the link', () => {
  it('a same-site path is carried, encoded, after the token', async () => {
    const { link } = await emailed(MEMBER.email, { redirect: '/meet/abc-123?scheduled=1&kind=video' });
    const url = new URL(link);
    expect(url.origin).toBe('https://preview.rsn.network');
    expect(url.pathname).toBe('/auth/verify');
    expect(url.searchParams.get('redirect')).toBe('/meet/abc-123?scheduled=1&kind=video');
  });

  it.each(['//evil.example/x', 'https://evil.example', '/\\evil.example', 'meet/abc', '/login?redirect=/x', '/auth/verify?token=1'])(
    'a path that is not a page of this site (%s) is left out',
    async (redirect) => {
      const { link } = await emailed(MEMBER.email, { redirect });
      expect(new URL(link).searchParams.has('redirect')).toBe(false);
    },
  );
});

describe("production's client (origin/main) signs in exactly as before", () => {
  it('POST /auth/magic-link { email, clientUrl } answers { message, sent } and nothing else', async () => {
    const res = await post('/auth/magic-link', { email: MEMBER.email, clientUrl: 'https://app.rsn.network' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { message: 'If an account exists, a magic link has been sent.', sent: true } });
    const [, link] = (sendMagicLinkEmail as jest.Mock).mock.calls[0] as [string, string];
    expect(link).toMatch(/^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  it('POST /auth/verify { token } from that email signs in once, as before', async () => {
    await post('/auth/magic-link', { email: MEMBER.email, clientUrl: 'https://app.rsn.network' });
    const [, link] = (sendMagicLinkEmail as jest.Mock).mock.calls[0] as [string, string];
    const token = new URL(link).searchParams.get('token');
    const res = await post('/auth/verify', { token });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken']);
    expect(links[0].used_at).not.toBeNull();
    expect(links[0].code_attempts).toBe(0);
  });

  it('a link made before migration 131 (no code) still signs in, and no code can be typed for it', async () => {
    const token = 'b'.repeat(64);
    links.push({
      id: 'legacy-1', email: MEMBER.email, token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      expires_at: new Date(now() + 30 * MIN), used_at: null, created_at: new Date(), purpose: 'login', code_hash: null, code_attempts: 0,
    });
    const typed = await post('/auth/magic-link/code', { email: MEMBER.email, code: '000000' });
    expect(typed.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect((await post('/auth/verify', { token })).status).toBe(200);
  });
});
