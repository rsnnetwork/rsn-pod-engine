// ─── Calendar free/busy through HTTP, with both providers mocked (Shirley pilot S8, 12 Nov 2026; D7) ──────────────────
// The real routes and the real service over an in-memory calendar_connections table and an in-memory Redis, with
// fetch answering for Google and Microsoft. Covers: the switch (every route a 404 while off, failing closed without a
// key), the whole connect (PKCE, the sealed state, the browser's nonce cookie, the ticket finished only by the member
// who started, spent once), consent refused or the permission unticked, busy times merged across both providers and
// cached, a refresh (Microsoft rotates its token), a revoked grant (reconnect), a provider down (the picker goes on),
// a key that cannot open a token, disconnect, an account closing, and booking untouched.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

const JWT_SECRET = 'test-jwt-secret';
const KEY_B64 = randomBytes(32).toString('base64');
const mockConfig: Record<string, unknown> = {};
const baseConfig = {
  jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true,
  rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
  apiBaseUrl: 'https://api.example.test', clientUrl: 'https://app.rsn.network',
  calendarSync: 'on', calendarTokenKey: KEY_B64, calendarRedirectBase: '',
  googleCalendarClientId: 'g-id', googleCalendarClientSecret: 'g-secret',
  microsoftCalendarClientId: 'm-id', microsoftCalendarClientSecret: 'm-secret',
};
Object.assign(mockConfig, baseConfig);
jest.mock('../../config', () => ({ __esModule: true, default: mockConfig }));
jest.mock('../../config/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ── An in-memory calendar_connections table ─────────────────────────────────
interface Row {
  id: string; user_id: string; provider: 'google' | 'microsoft'; account_email: string | null; scopes: string[];
  refresh_token_enc: Buffer; access_token_enc: Buffer | null; access_expires_at: Date | null;
  status: 'active' | 'needs_reconnect'; last_error: string | null; last_used_at: Date | null; connected_at: Date;
}
const table = new Map<string, Row>();
const audits: unknown[][] = [];
const kinds = new Map<string, string>();
let nextId = 1;
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const ok = (rows: unknown[], rowCount = rows.length) => Promise.resolve({ rows, rowCount });
const rowsOf = (userId: string) => [...table.values()].filter((r) => r.user_id === userId).sort((a, b) => a.provider.localeCompare(b.provider));
const find = (userId: string, provider: string) => [...table.values()].find((r) => r.user_id === userId && r.provider === provider);

function fakeQuery(sqlRaw: string, p: unknown[] = []) {
  const sql = flat(sqlRaw);
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') {
    return ok([{ status: 'active', account_kind: kinds.get(String(p[0])) ?? 'member' }]);
  }
  if (sql.startsWith('SELECT id, user_id, provider') && sql.endsWith('WHERE user_id = $1 ORDER BY provider')) return ok(rowsOf(String(p[0])));
  if (sql.startsWith('SELECT id, user_id, provider') && sql.endsWith('WHERE user_id = $1 AND provider = $2')) {
    const r = find(String(p[0]), String(p[1]));
    return ok(r ? [r] : []);
  }
  if (sql.startsWith('SELECT provider, account_email, status, connected_at FROM calendar_connections')) return ok(rowsOf(String(p[0])));
  if (sql.startsWith('INSERT INTO calendar_connections')) {
    const existing = find(String(p[0]), String(p[1]));
    const row: Row = {
      id: existing?.id ?? `c${nextId++}`, user_id: String(p[0]), provider: p[1] as Row['provider'], account_email: p[2] as string | null,
      scopes: p[3] as string[], refresh_token_enc: p[4] as Buffer, access_token_enc: p[5] as Buffer, access_expires_at: p[6] as Date,
      status: 'active', last_error: null, last_used_at: null, connected_at: new Date(Date.now() + nextId),
    };
    table.set(row.id, row);
    return ok([row]);
  }
  if (sql.startsWith('UPDATE calendar_connections SET refresh_token_enc = $3')) {
    const r = table.get(String(p[0]));
    if (!r || r.status !== 'active' || !r.refresh_token_enc.equals(p[1] as Buffer)) return ok([], 0);
    Object.assign(r, { refresh_token_enc: p[2], access_token_enc: p[3], access_expires_at: p[4], last_error: null });
    return ok([], 1);
  }
  if (sql.startsWith('UPDATE calendar_connections SET last_used_at')) return ok([], 1);
  if (sql.startsWith("UPDATE calendar_connections SET status = 'needs_reconnect'")) {
    const r = table.get(String(p[0]));
    if (!r || r.status !== 'active') return ok([], 0);
    Object.assign(r, { status: 'needs_reconnect', last_error: p[1], access_token_enc: null, access_expires_at: null });
    return ok([], 1);
  }
  if (sql === 'DELETE FROM calendar_connections WHERE user_id = $1 AND provider = $2') {
    const r = find(String(p[0]), String(p[1]));
    if (r) table.delete(r.id);
    return ok([], r ? 1 : 0);
  }
  if (sql === 'DELETE FROM calendar_connections WHERE user_id = $1') {
    const gone = rowsOf(String(p[0]));
    for (const r of gone) table.delete(r.id);
    return ok([], gone.length);
  }
  if (sql.startsWith('INSERT INTO audit_log')) { audits.push(p); return ok([]); }
  throw new Error(`calendar test: unknown statement ${sql}`);
}
jest.mock('../../db', () => ({ __esModule: true, query: (sql: string, p?: unknown[]) => fakeQuery(sql, p), transaction: jest.fn() }));

// ── An in-memory Redis ──────────────────────────────────────────────────────
const strings = new Map<string, string>();
const ttls = new Map<string, number>();
const busyKeys = () => [...strings.keys()].filter((k) => k.startsWith('rsn:calendar:busy:')).sort();
let redisOn = true;
const fakeRedis = {
  get: async (k: string) => strings.get(k) ?? null,
  expire: async () => 1,
  del: async (...keys: string[]) => { let n = 0; for (const k of keys) n += strings.delete(k) ? 1 : 0; return n; },
  set: async (k: string, v: string, ...rest: unknown[]) => {
    if (rest.includes('NX') && strings.has(k)) return null;
    strings.set(k, v);
    const ex = rest.indexOf('EX');
    if (ex >= 0) ttls.set(k, Number(rest[ex + 1]));
    return 'OK';
  },
};
jest.mock('../../services/redis/redis.client', () => ({ __esModule: true, getRedisClient: () => (redisOn ? fakeRedis : null) }));

const fanouts: string[] = [];
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutUserCalendars: async (userId: string) => { fanouts.push(userId); },
}));

// ── Google and Microsoft ────────────────────────────────────────────────────
interface Sent { url: URL; form: URLSearchParams | null; json: unknown; headers: Record<string, string> }
let sent: Sent[] = [];
const signals: AbortSignal[] = [];
type Answer = { status: number; body: unknown };
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
let provider: {
  googleToken: (form: URLSearchParams) => Answer;
  googleBusy: () => Answer;
  msToken: (form: URLSearchParams) => Answer;
  msView: () => Answer;
  revoke: () => Answer;
};
const realFetch = global.fetch;
const defaultBusy = (): Answer => ({ status: 200, body: { calendars: { primary: { busy: [{ start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' }] } } } });
function defaultProviders() {
  let msRefresh = 0;
  provider = {
    googleToken: (form) => (form.get('grant_type') === 'authorization_code'
      ? { status: 200, body: { access_token: 'g-at-1', expires_in: 3600, refresh_token: 'g-rt-1', scope: `openid email ${GOOGLE_SCOPE}`, id_token: idToken({ email: 'shirley@gmail.example' }) } }
      : { status: 200, body: { access_token: 'g-at-2', expires_in: 3600, scope: GOOGLE_SCOPE } }),
    googleBusy: defaultBusy,
    msToken: (form) => (form.get('grant_type') === 'authorization_code'
      ? { status: 200, body: { access_token: 'm-at-1', expires_in: 3600, refresh_token: 'm-rt-1', scope: 'openid email offline_access https://graph.microsoft.com/Calendars.ReadBasic', id_token: idToken({ preferred_username: 'shirley@outlook.example' }) } }
      : { status: 200, body: { access_token: `m-at-r${++msRefresh}`, expires_in: 3600, refresh_token: `m-rt-r${msRefresh}` } }),
    msView: () => ({ status: 200, body: { value: [
      { start: { dateTime: '2026-12-01T09:30:00.0000000' }, end: { dateTime: '2026-12-01T11:00:00.0000000' }, showAs: 'busy' },
      { start: { dateTime: '2026-12-02T14:00:00.0000000' }, end: { dateTime: '2026-12-02T15:00:00.0000000' }, showAs: 'tentative' },
    ] } }),
    revoke: () => ({ status: 200, body: {} }),
  };
}
function fakeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const body = typeof init.body === 'string' ? init.body : '';
  const headers = (init.headers ?? {}) as Record<string, string>;
  const isForm = (headers['Content-Type'] ?? '').includes('urlencoded');
  const form = isForm ? new URLSearchParams(body) : null;
  sent.push({ url, form, json: !isForm && body ? JSON.parse(body) : null, headers });
  if (init.signal) signals.push(init.signal);
  const where = `${url.origin}${url.pathname}`;
  let a: Answer;
  if (where === 'https://oauth2.googleapis.com/token') a = provider.googleToken(form!);
  else if (where === 'https://oauth2.googleapis.com/revoke') a = provider.revoke();
  else if (where === 'https://www.googleapis.com/calendar/v3/freeBusy') a = provider.googleBusy();
  else if (where === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') a = provider.msToken(form!);
  else if (where === 'https://graph.microsoft.com/v1.0/me/calendar/calendarView') a = provider.msView();
  else throw new Error(`calendar test: unexpected fetch ${where}`);
  return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } }));
}
const sentTo = (where: string) => sent.filter((s) => `${s.url.origin}${s.url.pathname}` === where);

import calendarRoutes from '../../routes/calendar-sync';
import publicConfigRoutes from '../../routes/public-config';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { forgetAccountGate } from '../../middleware/auth';
import { pkceChallenge } from '../../services/calendar-sync/oauth-envelope';
import { open, seal, tokenAad } from '../../services/calendar-sync/secret-box';
import logger from '../../config/logger';
import { beginConnect, forgetCalendarConnections, outcomeUrl, safeReturnPath } from '../../services/calendar-sync/calendar-sync.service';

const ch = (code: number) => String.fromCharCode(code);
const BACKSLASH = ch(92);
/** Return paths that must never leave the app (S8 review C1): control characters, whitespace, backslashes, // and the like. */
const BAD_RETURNS = [
  `/${ch(9)}/evil.example`, `/${ch(10)}/evil.example`, `/${ch(13)}/evil.example`, `/${ch(9)}${BACKSLASH}evil.example`,
  `/${BACKSLASH}evil.example`, `/${BACKSLASH}${BACKSLASH}evil.example`, '//evil.example/x', '///evil.example', '/ /evil.example',
  `/${ch(0)}/evil.example`, `/${ch(0x2028)}/evil.example`, `/${ch(0xa0)}/evil.example`, 'https://evil.example/x',
  'javascript:alert(1)', 'evil.example', '', `/${'a'.repeat(300)}`,
];

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/public/config', publicConfigRoutes);
app.use('/api/calendar', calendarRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// Fresh members for every test: the connect limiter allows ten an hour per member, and these tests connect often.
let run = 0;
let ME = '';
let SOMEONE = '';
const GUEST = 'c0000000-0000-4000-8000-0000000000c3';
const KEY = Buffer.from(KEY_B64, 'base64');
const token = (sub: string) => jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', type: 'access' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string) => ({ Authorization: `Bearer ${token(sub)}` });
const RANGE = { from: '2026-12-01T00:00:00.000Z', to: '2026-12-08T00:00:00.000Z', tz: 'Europe/London' };
const NOW = Date.parse('2026-11-30T12:00:00Z');

let ip = 0;
const from = () => ({ 'cf-connecting-ip': `10.9.${Math.floor(ip / 250)}.${ip % 250}` });

/** The browser's whole walk to the app: start address, start, provider, callback. */
async function walkToApp(p: 'google' | 'microsoft', who = ME, opts: { cookie?: 'mine' | 'none' | 'other'; returnTo?: string } = {}) {
  const begin = await request(app).post(`/api/calendar/connect/${p}`).set(as(who)).set('Origin', 'https://app.rsn.network')
    .send({ returnTo: opts.returnTo ?? '/messages/c1?schedule=1' });
  expect(begin.status).toBe(200);
  const startUrl = new URL(begin.body.data.url);
  expect(startUrl.origin + startUrl.pathname).toBe(`https://api.example.test/api/calendar/${p}/start`);
  const start = await request(app).get(`${startUrl.pathname}${startUrl.search}`).set(from());
  expect(start.status).toBe(302);
  const consent = new URL(start.headers.location);
  const cookie = String(start.headers['set-cookie']?.[0] ?? '');
  expect(cookie).toMatch(/^__Host-rsn_cal_nonce=[0-9a-f]{64};/);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/Secure/);
  expect(cookie).toMatch(/SameSite=Lax/);
  expect(cookie).toMatch(/Path=\//);
  const nonce = cookie.split(';')[0];
  const sendCookie = opts.cookie === 'none' ? undefined : opts.cookie === 'other' ? `__Host-rsn_cal_nonce=${'0'.repeat(64)}` : nonce;
  const back = request(app).get(`/api/calendar/${p}/callback?code=THE-CODE&state=${encodeURIComponent(consent.searchParams.get('state')!)}`).set(from());
  const cb = await (sendCookie ? back.set('Cookie', sendCookie) : back);
  expect(cb.status).toBe(302);
  return { consent, landing: new URL(cb.headers.location), clearCookie: String(cb.headers['set-cookie']?.[0] ?? '') };
}

async function connect(p: 'google' | 'microsoft', who = ME) {
  const { landing } = await walkToApp(p, who);
  const res = await request(app).post(`/api/calendar/connections/${p}/finish`).set(as(who)).send({ ticket: landing.searchParams.get('calendarTicket') });
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeEach(() => {
  Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  Object.assign(mockConfig, baseConfig);
  table.clear(); audits.length = 0; fanouts.length = 0; strings.clear(); ttls.clear(); kinds.clear();
  redisOn = true; sent = []; ip++; run++;
  ME = `a0000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  SOMEONE = `b0000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  kinds.set(GUEST, 'event_guest');
  for (const id of [ME, SOMEONE, GUEST]) forgetAccountGate(id);
  defaultProviders();
  global.fetch = fakeFetch as typeof fetch;
  // One clock for every test, so the fixed December range below stays "around now" whenever the suite runs.
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterAll(() => { global.fetch = realFetch; });

describe('switched off: no calendar anywhere', () => {
  const routes: Array<[string, string]> = [
    ['post', '/api/calendar/connect/google'], ['get', '/api/calendar/google/start?t=x'], ['get', '/api/calendar/google/callback?code=c&state=s'],
    ['post', '/api/calendar/connections/google/finish'], ['get', '/api/calendar/connections'],
    ['get', `/api/calendar/busy?from=${RANGE.from}&to=${RANGE.to}`],
  ];

  it.each([
    ['CALENDAR_SYNC=off', { calendarSync: 'off' }],
    ['on without a key (fails closed)', { calendarTokenKey: '' }],
    ['on with a key that is not 32 bytes', { calendarTokenKey: randomBytes(16).toString('base64') }],
    ['on with no provider credentials', { googleCalendarClientSecret: '', microsoftCalendarClientId: '' }],
  ])('%s: every route answers the 404 of a route that does not exist (the list too, with nothing connected), and the config says off', async (_label, over) => {
    Object.assign(mockConfig, over);
    for (const [method, url] of routes) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).set(as(ME)).set(from());
      const pathOnly = url.split('?')[0];
      expect([method, url, res.status]).toEqual([method, url, 404]);
      expect(res.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: `Route ${method.toUpperCase()} ${pathOnly} not found` } });
    }
    const cfg = await request(app).get('/api/public/config');
    expect(cfg.body).toEqual({ success: true, data: { calendar: { enabled: false, providers: [] } } });
    // Disconnecting is never switched off (S8 review M5): with nothing connected it simply says so.
    expect((await request(app).delete('/api/calendar/connections/google').set(as(ME))).body).toEqual({ success: true, data: { disconnected: true, revokedAtProvider: false } });
    expect((await request(app).delete('/api/calendar/connections/google')).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('switched off again, a member still sees and removes what they connected (revoked at Google while its keys are set)', async () => {
    await connect('google');
    await connect('microsoft', SOMEONE);
    mockConfig.calendarSync = 'off';
    sent = []; fanouts.length = 0;
    const list = await request(app).get('/api/calendar/connections').set(as(ME));
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { provider: string }) => c.provider)).toEqual(['google']);
    expect((await request(app).get('/api/calendar/busy').query(RANGE).set(as(ME))).status).toBe(404);
    expect((await request(app).post('/api/calendar/connect/google').set(as(ME)).send({})).status).toBe(404);
    const gone = await request(app).delete('/api/calendar/connections/google').set(as(ME));
    expect(gone.body.data).toEqual({ disconnected: true, revokedAtProvider: true });
    expect(sentTo('https://oauth2.googleapis.com/revoke')).toHaveLength(1);
    expect(find(ME, 'google')).toBeUndefined();
    expect(fanouts).toEqual([ME]);
    expect((await request(app).get('/api/calendar/connections').set(as(ME))).status).toBe(404);
    // With no key left at all, the row still goes (nothing can be revoked without it).
    mockConfig.calendarTokenKey = '';
    expect((await request(app).delete('/api/calendar/connections/microsoft').set(as(SOMEONE))).body.data).toEqual({ disconnected: true, revokedAtProvider: false });
    expect(table.size).toBe(0);
  });

  it('says on, and which providers, once the switch, the key and a provider are all there', async () => {
    expect((await request(app).get('/api/public/config')).body.data).toEqual({ calendar: { enabled: true, providers: ['google', 'microsoft'] } });
    mockConfig.microsoftCalendarClientSecret = '';
    expect((await request(app).get('/api/public/config')).body.data).toEqual({ calendar: { enabled: true, providers: ['google'] } });
    const res = await request(app).post('/api/calendar/connect/microsoft').set(as(ME)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CALENDAR_PROVIDER_NOT_OFFERED');
  });
});

describe('connecting', () => {
  it('Google: PKCE, a sealed state, the browser\'s cookie, a ticket the member finishes, tokens kept sealed', async () => {
    const { consent, landing, clearCookie } = await walkToApp('google');
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(consent.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/calendar/google/callback');
    expect(consent.searchParams.get('scope')).toBe(`openid email ${GOOGLE_SCOPE}`);
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(clearCookie).toMatch(/^__Host-rsn_cal_nonce=;/);
    // Back on the page it started from, the scheduler's own ?schedule=1 kept.
    expect(landing.origin + landing.pathname).toBe('https://app.rsn.network/messages/c1');
    expect(landing.searchParams.get('schedule')).toBe('1');
    expect(landing.searchParams.get('calendar')).toBe('finish');
    expect(landing.searchParams.get('calendarProvider')).toBe('google');
    expect(sent).toHaveLength(0); // nothing is exchanged until the signed-in member finishes

    const res = await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket: landing.searchParams.get('calendarTicket') });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ provider: 'google', accountEmail: 'shirley@gmail.example', status: 'active', connectedAt: expect.any(String) });
    const exchange = sentTo('https://oauth2.googleapis.com/token')[0].form!;
    expect(exchange.get('code')).toBe('THE-CODE');
    expect(pkceChallenge(exchange.get('code_verifier')!)).toBe(consent.searchParams.get('code_challenge'));

    const row = find(ME, 'google')!;
    expect(row.refresh_token_enc.toString('latin1')).not.toContain('g-rt-1');
    expect(row.access_token_enc!.toString('latin1')).not.toContain('g-at-1');
    expect(open(KEY, row.refresh_token_enc, tokenAad(ME, 'google', 'refresh'))).toBe('g-rt-1');
    expect(fanouts).toEqual([ME]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual([ME, 'calendar.connected', 'user', ME, JSON.stringify({ provider: 'google' }), expect.anything()]);

    const list = await request(app).get('/api/calendar/connections').set(as(ME));
    expect(list.body.data).toEqual([{ provider: 'google', accountEmail: 'shirley@gmail.example', status: 'active', connectedAt: expect.any(String) }]);
    expect(JSON.stringify(list.body)).not.toMatch(/g-rt|g-at|token/i);
  });

  it('Microsoft: the same walk, with its own scopes', async () => {
    const data = await connect('microsoft');
    expect(data).toMatchObject({ provider: 'microsoft', accountEmail: 'shirley@outlook.example', status: 'active' });
    const exchange = sentTo('https://login.microsoftonline.com/common/oauth2/v2.0/token')[0].form!;
    expect(exchange.get('scope')).toBe('openid email offline_access https://graph.microsoft.com/Calendars.ReadBasic');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a ticket finished by another member connects nothing (a start address sent to a victim cannot borrow their calendar)', async () => {
    const { landing } = await walkToApp('google', ME);
    const ticket = landing.searchParams.get('calendarTicket');
    const wrong = await request(app).post('/api/calendar/connections/google/finish').set(as(SOMEONE)).send({ ticket });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('CALENDAR_WRONG_ACCOUNT');
    expect(table.size).toBe(0);
    expect(sent).toHaveLength(0);
    // The member who started can still finish it.
    expect((await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket })).status).toBe(200);
  });

  it('a ticket is spent once, with or without Redis', async () => {
    for (const withRedis of [true, false]) {
      redisOn = withRedis;
      table.clear(); sent = [];
      const { landing } = await walkToApp('google');
      const ticket = landing.searchParams.get('calendarTicket');
      expect((await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket })).status).toBe(200);
      const again = await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('CALENDAR_LINK_EXPIRED');
      expect(sentTo('https://oauth2.googleapis.com/token')).toHaveLength(1);
    }
  });

  it('a ticket for another provider, an edited ticket, and an expired one are refused', async () => {
    const { landing } = await walkToApp('google');
    const ticket = landing.searchParams.get('calendarTicket')!;
    const cross = await request(app).post('/api/calendar/connections/microsoft/finish').set(as(ME)).send({ ticket });
    expect(cross.body.error.code).toBe('CALENDAR_LINK_EXPIRED');
    const edited = `${ticket.slice(0, -2)}${ticket.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket: edited })).body.error.code).toBe('CALENDAR_LINK_EXPIRED');
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    expect((await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket })).body.error.code).toBe('CALENDAR_LINK_EXPIRED');
    expect(table.size).toBe(0);
  });

  it('a callback in another browser, or with no cookie, goes back to try again with no ticket', async () => {
    for (const cookie of ['none', 'other'] as const) {
      const { landing } = await walkToApp('google', ME, { cookie });
      expect(landing.searchParams.get('calendar')).toBe('try_again');
      expect(landing.searchParams.get('calendarTicket')).toBeNull();
    }
  });

  it('a state that is not ours, or a start address that is not ours, lands on Settings saying it failed', async () => {
    const cb = await request(app).get('/api/calendar/google/callback?code=c&state=forged').set(from());
    expect(cb.headers.location).toBe('https://app.rsn.network/settings?calendar=failed&calendarProvider=google');
    const start = await request(app).get('/api/calendar/google/start?t=forged').set(from());
    expect(start.status).toBe(302);
    expect(start.headers.location).toBe('https://app.rsn.network/settings?calendar=failed&calendarProvider=google');
    expect(start.headers['set-cookie']).toBeUndefined();
  });

  it('a start address for one provider cannot start the other', async () => {
    const begin = await request(app).post('/api/calendar/connect/google').set(as(ME)).send({});
    const t = new URL(begin.body.data.url).searchParams.get('t')!;
    const res = await request(app).get(`/api/calendar/microsoft/start?t=${encodeURIComponent(t)}`).set(from());
    expect(res.headers.location).toMatch(/calendar=failed/);
  });

  it('declining consent says so; a work account that needs its admin says that', async () => {
    const begin = await request(app).post('/api/calendar/connect/microsoft').set(as(ME)).send({ returnTo: '/settings' });
    const start = await request(app).get(new URL(begin.body.data.url).pathname + new URL(begin.body.data.url).search).set(from());
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const cookie = String(start.headers['set-cookie'][0]).split(';')[0];
    const declined = await request(app).get(`/api/calendar/microsoft/callback?error=access_denied&state=${encodeURIComponent(state)}`).set('Cookie', cookie);
    expect(new URL(declined.headers.location).searchParams.get('calendar')).toBe('cancelled');
    const admin = await request(app).get(`/api/calendar/microsoft/callback?error=access_denied&error_description=${encodeURIComponent('AADSTS90094: Admin consent is required')}&state=${encodeURIComponent(state)}`).set('Cookie', cookie);
    expect(new URL(admin.headers.location).searchParams.get('calendar')).toBe('admin');
    expect(table.size).toBe(0);
  });

  it('an unticked calendar permission connects nothing, and the grant is handed back', async () => {
    provider.googleToken = () => ({ status: 200, body: { access_token: 'g-at', expires_in: 3600, refresh_token: 'g-rt', scope: 'openid email' } });
    const { landing } = await walkToApp('google');
    const res = await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket: landing.searchParams.get('calendarTicket') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CALENDAR_SCOPE_MISSING');
    expect(table.size).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(sentTo('https://oauth2.googleapis.com/revoke')).toHaveLength(1);
  });

  it('a provider that fails the exchange is a friendly 502, nothing stored', async () => {
    provider.googleToken = () => ({ status: 503, body: {} });
    const { landing } = await walkToApp('google');
    const res = await request(app).post('/api/calendar/connections/google/finish').set(as(ME)).send({ ticket: landing.searchParams.get('calendarTicket') });
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'CALENDAR_PROVIDER_FAILED', message: 'We could not connect your calendar just now. Please try again in a moment.' });
    expect(table.size).toBe(0);
  });

  it('a return path that is not a plain path on our site is refused at connect (400), never sealed', async () => {
    for (const [i, returnTo] of BAD_RETURNS.entries()) {
      // A member each: the connect limiter allows ten an hour per member.
      const who = `e0000000-0000-4000-8000-${String(run * 100 + i).padStart(12, '0')}`;
      const res = await request(app).post('/api/calendar/connect/google').set(as(who)).send({ returnTo });
      expect([JSON.stringify(returnTo), res.status]).toEqual([JSON.stringify(returnTo), 400]);
    }
    expect((await request(app).post('/api/calendar/connect/google').set(as(ME)).send({ returnTo: '/messages/c1?schedule=1' })).status).toBe(200);
  });

  it('even a bad return path sealed into a start (bypassing the route) lands on the app, never another site (S8 review C1)', async () => {
    for (const returnTo of BAD_RETURNS) {
      const start = new URL(beginConnect(ME, 'google', 'https://evil.example', returnTo));
      const begun = await request(app).get(start.pathname + start.search).set(from());
      const state = new URL(begun.headers.location).searchParams.get('state')!;
      const cookie = String(begun.headers['set-cookie'][0]).split(';')[0];
      for (const q of [`code=c&state=${encodeURIComponent(state)}`, `error=access_denied&state=${encodeURIComponent(state)}`]) {
        const cb = await request(app).get(`/api/calendar/google/callback?${q}`).set('Cookie', cookie);
        const landing = new URL(cb.headers.location);
        expect([JSON.stringify(returnTo), landing.origin]).toEqual([JSON.stringify(returnTo), 'https://app.rsn.network']);
      }
    }
  });

  it('safeReturnPath and outcomeUrl: tab, CR, LF, backslash, protocol-relative, encoded and dot-segment variants', () => {
    for (const bad of BAD_RETURNS) {
      expect([JSON.stringify(bad), safeReturnPath(bad)]).toEqual([JSON.stringify(bad), '/settings']);
      const u = new URL(outcomeUrl('https://app.rsn.network', bad, 'finish', 'google', 'T'));
      expect([JSON.stringify(bad), u.origin, u.pathname]).toEqual([JSON.stringify(bad), 'https://app.rsn.network', '/settings']);
    }
    // Encoded tricks stay a path on our site (percent-encoding is never decoded into a host).
    for (const encoded of ['/%2F%2Fevil.example', '/%09/evil.example', '/%5C%5Cevil.example', '/%0d%0a/evil.example']) {
      const u = new URL(outcomeUrl('https://app.rsn.network', encoded, 'failed', 'google'));
      expect([encoded, u.origin]).toEqual([encoded, 'https://app.rsn.network']);
      expect(u.pathname.startsWith('//')).toBe(false);
    }
    expect(safeReturnPath('/messages/c1?schedule=1')).toBe('/messages/c1?schedule=1');
    expect(safeReturnPath('/a/../settings?x=1')).toBe('/settings?x=1');
    expect(safeReturnPath('/a/..//evil.example')).toBe('/settings');
  });

  it('an event guest cannot connect, and no route answers without signing in', async () => {
    expect((await request(app).post('/api/calendar/connect/google').set(as(GUEST)).send({})).status).toBe(403);
    expect((await request(app).get('/api/calendar/connections')).status).toBe(401);
    expect((await request(app).post('/api/calendar/connect/google').send({})).status).toBe(401);
    expect((await request(app).get(`/api/calendar/busy?from=${RANGE.from}&to=${RANGE.to}`)).status).toBe(401);
  });
});

describe('busy times', () => {
  const busy = (who = ME, q = RANGE) => request(app).get('/api/calendar/busy').query(q).set(as(who));

  it('with nothing connected, answers nothing and asks no provider', async () => {
    const res = await busy();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ from: RANGE.from, to: RANGE.to, connected: [], busy: [], errors: [] });
    expect(sent).toHaveLength(0);
  });

  it('merges both providers\' busy times for the caller, and caches them for five minutes', async () => {
    await connect('google');
    await connect('microsoft');
    sent = [];
    const first = await busy();
    expect(first.status).toBe(200);
    expect(first.body.data.busy).toEqual([
      { start: '2026-12-01T09:00:00.000Z', end: '2026-12-01T11:00:00.000Z' },
      { start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T15:00:00.000Z' },
    ]);
    expect(first.body.data.connected).toEqual([{ provider: 'google', status: 'active' }, { provider: 'microsoft', status: 'active' }]);
    expect(first.body.data.errors).toEqual([]);
    const reads = sent.length;
    expect(reads).toBeGreaterThanOrEqual(2);
    // Only times are cached: never a title or anyone else.
    expect(busyKeys()).toEqual([`rsn:calendar:busy:${ME}:google`, `rsn:calendar:busy:${ME}:microsoft`]);
    for (const k of busyKeys()) {
      for (const e of JSON.parse(strings.get(k)!).entries) expect(Object.keys(e).sort()).toEqual(['at', 'busy', 'field']);
      expect(ttls.get(k)).toBe(1800); // 30 minutes from the fetch, never more
    }

    const second = await busy();
    expect(second.body.data.busy).toEqual(first.body.data.busy);
    expect(sent.length).toBe(reads); // served from the cache
  });

  it('refreshes a token that ran out, and keeps Microsoft\'s new refresh token (rotation)', async () => {
    await connect('microsoft');
    find(ME, 'microsoft')!.access_expires_at = new Date(Date.now() - 1000);
    sent = [];
    const res = await busy();
    expect(res.body.data.errors).toEqual([]);
    expect(sentTo('https://login.microsoftonline.com/common/oauth2/v2.0/token')[0].form!.get('refresh_token')).toBe('m-rt-1');
    const row = find(ME, 'microsoft')!;
    expect(open(KEY, row.refresh_token_enc, tokenAad(ME, 'microsoft', 'refresh'))).toBe('m-rt-r1');
    expect(open(KEY, row.access_token_enc!, tokenAad(ME, 'microsoft', 'access'))).toBe('m-at-r1');
    expect(sentTo('https://graph.microsoft.com/v1.0/me/calendar/calendarView')[0].headers.Authorization).toBe('Bearer m-at-r1');
  });

  it('a refused access token is refreshed once and the read tried again', async () => {
    await connect('google');
    let calls = 0;
    provider.googleBusy = () => (++calls === 1 ? { status: 401, body: {} } : { status: 200, body: { calendars: { primary: { busy: [] } } } });
    const res = await busy();
    expect(res.body.data.errors).toEqual([]);
    expect(calls).toBe(2);
    expect(open(KEY, find(ME, 'google')!.refresh_token_enc, tokenAad(ME, 'google', 'refresh'))).toBe('g-rt-1'); // Google keeps its token, sealed again
  });

  it('a revoked grant (invalid_grant) asks the member to reconnect, tells their screens, and never fails the picker', async () => {
    await connect('google');
    await connect('microsoft');
    fanouts.length = 0;
    find(ME, 'google')!.access_expires_at = new Date(Date.now() - 1000);
    provider.googleToken = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const res = await busy();
    expect(res.status).toBe(200);
    expect(res.body.data.errors).toEqual([{ provider: 'google', code: 'reconnect' }]);
    expect(res.body.data.connected).toEqual([{ provider: 'google', status: 'needs_reconnect' }, { provider: 'microsoft', status: 'active' }]);
    expect(res.body.data.busy.length).toBeGreaterThan(0); // Microsoft still answers
    expect(find(ME, 'google')).toMatchObject({ status: 'needs_reconnect', last_error: 'invalid_grant', access_token_enc: null });
    expect(fanouts).toEqual([ME]);
    const list = await request(app).get('/api/calendar/connections').set(as(ME));
    expect(list.body.data.find((c: { provider: string }) => c.provider === 'google').status).toBe('needs_reconnect');
    // Connecting again makes it active.
    defaultProviders();
    await connect('google');
    expect(find(ME, 'google')!.status).toBe('active');
  });

  it('a provider that is down or limiting us: the picker goes on (200), with a stale answer when there is one', async () => {
    await connect('google');
    provider.googleBusy = () => ({ status: 503, body: {} });
    const down = await busy();
    expect(down.status).toBe(200);
    expect(down.body.data).toMatchObject({ busy: [], errors: [{ provider: 'google', code: 'unavailable' }] });
    expect(find(ME, 'google')!.status).toBe('active');

    defaultProviders();
    const t0 = Date.now();
    expect((await busy()).body.data.busy).toHaveLength(1);
    (Date.now as jest.Mock).mockReturnValue(t0 + 6 * 60 * 1000); // stale, not fresh
    provider.googleBusy = () => ({ status: 429, body: {} });
    const limited = await busy();
    expect(limited.body.data).toMatchObject({ busy: [{ start: '2026-12-01T09:00:00.000Z' }], errors: [] });
  });

  it('our own setup refused (Calendar API not enabled): unavailable for the member, never a reconnect, logged loudly once (S8 review I3)', async () => {
    await connect('google');
    const notEnabled = { error: { code: 403, errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }],
      message: 'Google Calendar API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED',
      details: [{ reason: 'SERVICE_DISABLED' }] } };
    provider.googleBusy = () => ({ status: 403, body: notEnabled });
    fanouts.length = 0;
    const first = await busy();
    expect(first.status).toBe(200);
    expect(first.body.data.errors).toEqual([{ provider: 'google', code: 'unavailable' }]);
    expect(first.body.data.connected).toEqual([{ provider: 'google', status: 'active' }]);
    expect(find(ME, 'google')!.status).toBe('active');
    expect(fanouts).toEqual([]);
    await busy();
    const loud = (logger.error as jest.Mock).mock.calls.filter((c) => String(c[1]).includes('refused REASON itself'));
    expect(loud).toHaveLength(1);
    // A client id or secret the provider refuses at refresh is the same: not the member's grant.
    find(ME, 'google')!.access_expires_at = new Date(Date.now() - 1000);
    provider.googleToken = () => ({ status: 401, body: { error: 'invalid_client' } });
    provider.googleBusy = defaultBusy;
    expect((await busy()).body.data.errors).toEqual([{ provider: 'google', code: 'unavailable' }]);
    expect(find(ME, 'google')!.status).toBe('active');
  });

  it('every provider call carries the busy read\'s overall deadline (S8 review M6)', async () => {
    await connect('microsoft');
    find(ME, 'microsoft')!.access_expires_at = new Date(Date.now() - 1000);
    signals.length = 0;
    await busy();
    expect(signals.length).toBeGreaterThanOrEqual(2); // the refresh and the calendar view
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('a token the key cannot open (a lost or changed key) asks to reconnect, never a 500', async () => {
    await connect('google');
    const other = randomBytes(32);
    const row = find(ME, 'google')!;
    row.refresh_token_enc = seal(other, 'g-rt-1', tokenAad(ME, 'google', 'refresh'));
    row.access_token_enc = seal(other, 'g-at-1', tokenAad(ME, 'google', 'access'));
    const res = await busy();
    expect(res.status).toBe(200);
    expect(res.body.data.errors).toEqual([{ provider: 'google', code: 'reconnect' }]);
    expect(find(ME, 'google')!.last_error).toBe('key');
  });

  it('works without Redis: nothing cached, every read asks', async () => {
    redisOn = false;
    await connect('google');
    sent = [];
    await busy();
    await busy();
    expect(sentTo('https://www.googleapis.com/calendar/v3/freeBusy')).toHaveLength(2);
  });

  it('only ever the caller\'s own: another member\'s calendar is not in their answer', async () => {
    await connect('google', SOMEONE);
    const mine = await busy(ME);
    expect(mine.body.data).toMatchObject({ connected: [], busy: [] });
    expect(sentTo('https://www.googleapis.com/calendar/v3/freeBusy')).toHaveLength(0);
  });

  it('refuses a range that is backwards, longer than 31 days, far from now, or not a time', async () => {
    for (const q of [
      { from: RANGE.to, to: RANGE.from },
      { from: '2026-12-01T00:00:00Z', to: '2027-01-05T00:00:00Z' },
      { from: '2028-01-01T00:00:00Z', to: '2028-01-02T00:00:00Z' },
      { from: 'tomorrow', to: RANGE.to },
    ]) {
      const res = await busy(ME, q as typeof RANGE);
      expect([q, res.status]).toEqual([q, 400]);
    }
  });
});

describe('disconnecting', () => {
  it('revokes at Google, deletes the row and its cached times, tells the member\'s screens, logs the provider only', async () => {
    await connect('google');
    await request(app).get('/api/calendar/busy').query(RANGE).set(as(ME));
    expect(busyKeys()).toHaveLength(1);
    fanouts.length = 0; audits.length = 0;
    const res = await request(app).delete('/api/calendar/connections/google').set(as(ME));
    expect(res.body.data).toEqual({ disconnected: true, revokedAtProvider: true });
    expect(sentTo('https://oauth2.googleapis.com/revoke')[0].form!.get('token')).toBe('g-rt-1');
    expect(table.size).toBe(0);
    expect(busyKeys()).toHaveLength(0);
    expect(fanouts).toEqual([ME]);
    expect(audits[0].slice(0, 5)).toEqual([ME, 'calendar.disconnected', 'user', ME, JSON.stringify({ provider: 'google', revokedAtProvider: true })]);
    // Twice is harmless.
    expect((await request(app).delete('/api/calendar/connections/google').set(as(ME))).status).toBe(200);
  });

  it('connecting again hands the replaced grant back to Google, never the new one (S8 review M1)', async () => {
    await connect('google');
    let n = 1;
    provider.googleToken = (form) => (form.get('grant_type') === 'authorization_code'
      ? { status: 200, body: { access_token: `g-at-new${++n}`, expires_in: 3600, refresh_token: `g-rt-new${n}`, scope: `openid email ${GOOGLE_SCOPE}` } }
      : { status: 200, body: { access_token: 'g-at-x', expires_in: 3600 } });
    sent = [];
    await connect('google');
    await new Promise((r) => setImmediate(r));
    expect(sentTo('https://oauth2.googleapis.com/revoke').map((x) => x.form!.get('token'))).toEqual(['g-rt-1']);
    expect(open(KEY, find(ME, 'google')!.refresh_token_enc, tokenAad(ME, 'google', 'refresh'))).toBe('g-rt-new2');
  });

  it('still disconnects when the provider\'s revoke fails, and Microsoft (no revoke call) says it was not revoked there', async () => {
    await connect('google');
    await connect('microsoft');
    provider.revoke = () => ({ status: 500, body: {} });
    expect((await request(app).delete('/api/calendar/connections/google').set(as(ME))).body.data).toEqual({ disconnected: true, revokedAtProvider: false });
    expect((await request(app).delete('/api/calendar/connections/microsoft').set(as(ME))).body.data).toEqual({ disconnected: true, revokedAtProvider: false });
    expect(table.size).toBe(0);
  });

  it('closing an account forgets every calendar of it (revoked where possible), and never throws', async () => {
    await connect('google');
    await connect('microsoft');
    await connect('google', SOMEONE);
    sent = []; fanouts.length = 0;
    await forgetCalendarConnections(ME);
    expect(rowsOf(ME)).toHaveLength(0);
    expect(rowsOf(SOMEONE)).toHaveLength(1);
    expect(sentTo('https://oauth2.googleapis.com/revoke')).toHaveLength(1);
    expect(fanouts).toEqual([ME]);
    provider.revoke = () => { throw new Error('network'); };
    await expect(forgetCalendarConnections(SOMEONE)).resolves.toBeUndefined();
  });
});

describe('booking never needs a calendar', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

  it('the meeting scheduler\'s routes and service do not read calendars at all', () => {
    for (const rel of ['routes/meeting.ts', 'services/dm/meeting-windows.service.ts']) {
      expect(src(rel)).not.toMatch(/calendar-sync|calendar_connections|calendarSync/);
    }
  });

  it('closing an account forgets its calendars, after everything else, without waiting on a provider\'s failure', () => {
    const identity = src('services/identity/identity.service.ts');
    expect(identity).toMatch(/await forgetCalendarsOf\(userId\);\r?\n\}/);
    expect(identity).toContain("await import('../calendar-sync/calendar-sync.service')");
  });
});
