// ─── A member's public profile link, through HTTP (Shirley pilot S6, D5) ─────────────────────────────────────────────
// The owner's routes (make, read, replace, turn off) and the signed-out page, over a small in-memory users table, so
// the real service and its SQL decide every answer. Every link that opens nothing must answer byte for byte what a token
// that never existed answers.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

interface Row { id: string; status: string; account_kind: string; profile_visible: boolean; token: string | null; created_at: Date | null }
const rows = new Map<string, Row>();
const audits: unknown[][] = [];
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const linkOf = (r: Row) => ({ token: r.token, created_at: r.created_at, profile_visible: r.profile_visible });
const mayShare = (r: Row | undefined): r is Row => !!r && r.status === 'active' && r.account_kind === 'member';

function fakeQuery(sqlRaw: string, params: unknown[] = []) {
  const sql = flat(sqlRaw);
  const ok = (out: unknown[]) => Promise.resolve({ rows: out, rowCount: out.length });
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') {
    const r = rows.get(String(params[0]));
    return ok(r ? [{ status: r.status, account_kind: r.account_kind }] : []);
  }
  if (sql.startsWith('SELECT public_profile_token AS token')) {
    const r = rows.get(String(params[0]));
    return ok(r ? [linkOf(r)] : []);
  }
  if (sql.includes('SET public_profile_token = COALESCE(public_profile_token, $2)')) {
    const r = rows.get(String(params[0]));
    if (!mayShare(r)) return ok([]);
    if (!r.token) { r.token = String(params[1]); r.created_at = new Date(); }
    return ok([linkOf(r)]);
  }
  if (sql.includes('SET public_profile_token = $2, public_profile_token_created_at = NOW()')) {
    const r = rows.get(String(params[0]));
    if (!mayShare(r) || !r.token) return ok([]);
    r.token = String(params[1]); r.created_at = new Date();
    return ok([linkOf(r)]);
  }
  if (sql.includes('SET public_profile_token = NULL, public_profile_token_created_at = NULL WHERE id = $1')) {
    const r = rows.get(String(params[0]));
    if (!r) return ok([]);
    r.token = null; r.created_at = null;
    return ok([linkOf(r)]);
  }
  if (sql.startsWith('SELECT id FROM users WHERE public_profile_token = $1')) {
    const r = [...rows.values()].find((x) => x.token === params[0] && mayShare(x) && x.profile_visible);
    return ok(r ? [{ id: r.id }] : []);
  }
  if (sql.startsWith('INSERT INTO audit_log')) { audits.push(params); return ok([]); }
  throw new Error(`public-profiles test: unknown statement ${sql}`);
}
jest.mock('../../db', () => ({ query: (sql: string, params?: unknown[]) => fakeQuery(sql, params), transaction: jest.fn(), __esModule: true }));

const blocks = new Set<string>();
jest.mock('../../services/block/block.service', () => ({
  __esModule: true,
  areBlocked: (a: string, b: string) => Promise.resolve(blocks.has(`${a}|${b}`) || blocks.has(`${b}|${a}`)),
}));
jest.mock('../../services/identity/identity.service', () => ({
  __esModule: true,
  getUserById: (id: string) => Promise.resolve({
    id, email: 'secret@example.com', phone: '+44', displayName: 'Shirley Palmer', firstName: 'Shirley', lastName: 'Palmer',
    avatarUrl: `https://api.example.test/api/users/${id}/avatar`, bannerUrl: null, bio: 'Curious about humans.',
    company: 'Curious Humans', jobTitle: 'Founder', industry: null, location: 'London', linkedinUrl: null,
    websiteUrl: null, instagramUrl: null, xUrl: null, facebookUrl: null, languages: [], professionalRole: [],
    expertiseText: null, whatICanHelpWith: 'Hosting circles', whoIWantToMeet: 'SECRET-WANT', myIntent: 'SECRET-INTENT',
    interests: ['SECRET'], status: 'active', profileVisible: true,
  }),
}));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({ __esModule: true, fanoutUserEntity: (...a: unknown[]) => mockFanout(...a) }));

import publicProfileRoutes, { publicLinkRoutes } from '../../routes/public-profiles';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { forgetAccountGate } from '../../middleware/auth';
import { PUBLIC_PROFILE_MISSES_MAX } from '../../middleware/rateLimit';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/users/me/public-link', publicLinkRoutes);
app.use('/api/public/profiles', publicProfileRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const READER = 'b0000000-0000-4000-8000-0000000000b2';
const GUEST = 'c0000000-0000-4000-8000-0000000000c3';
const NEVER = 'NeverMadeNeverMadeNeve';

const tokenFor = (sub: string) => jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', type: 'access' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string) => ({ Authorization: `Bearer ${tokenFor(sub)}` });
let ip = 0;
/** Each test reads from its own network address, so the miss bucket of one never spends another's. */
let from: { 'cf-connecting-ip': string };

const open = (token: string, headers: Record<string, string> = {}) =>
  request(app).get(`/api/public/profiles/${encodeURIComponent(token)}`).set({ ...from, ...headers });
const make = (sub = OWNER) => request(app).post('/api/users/me/public-link').set(as(sub));
const unknownBody = async () => (await open(NEVER)).body;

beforeEach(() => {
  rows.clear();
  blocks.clear();
  audits.length = 0;
  mockFanout.mockClear();
  for (const id of [OWNER, READER, GUEST]) forgetAccountGate(id);
  rows.set(OWNER, { id: OWNER, status: 'active', account_kind: 'member', profile_visible: true, token: null, created_at: null });
  rows.set(READER, { id: READER, status: 'active', account_kind: 'member', profile_visible: true, token: null, created_at: null });
  rows.set(GUEST, { id: GUEST, status: 'active', account_kind: 'event_guest', profile_visible: false, token: null, created_at: null });
  ip += 1;
  from = { 'cf-connecting-ip': `203.0.113.${ip}` };
});

describe('the owner makes a link, and anyone holding it sees the public card', () => {
  it('makes a 22-character link, only for its owner, tells their screens and writes the audit log without the token', async () => {
    expect((await request(app).get('/api/users/me/public-link').set(as(OWNER))).body.data).toEqual({ link: null, paused: null });
    const res = await make();
    expect(res.status).toBe(200);
    const { token, path } = res.body.data.link;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(path).toBe(`/p/${token}`);
    expect(mockFanout).toHaveBeenCalledWith(OWNER);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.arrayContaining([OWNER, 'user.public_link_created', 'user']));
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it('a second press answers the same link, never a new one', async () => {
    const first = (await make()).body.data.link.token;
    expect((await make()).body.data.link.token).toBe(first);
  });

  it('opens signed out: the public card only (no id, no private field), never indexed', async () => {
    const token = (await make()).body.data.link.token;
    const res = await open(token);
    expect(res.status).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.body.data).toMatchObject({ displayName: 'Shirley Palmer', company: 'Curious Humans', canBring: 'Hosting circles' });
    expect(res.body.data).not.toHaveProperty('id');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/SECRET|secret@example\.com|\+44|profileVisible|status/);
    expect(text).not.toContain(token);
  });

  it('opens for a signed-in member with no block', async () => {
    const token = (await make()).body.data.link.token;
    expect((await open(token, as(READER))).status).toBe(200);
  });
});

describe('a link that opens nothing answers what a never-made token answers', () => {
  it('a never-made token and a malformed one: 404, one body', async () => {
    const body = await unknownBody();
    expect(body).toEqual({ success: false, error: { code: 'PROFILE_NOT_FOUND', message: 'This profile link is not available.' } });
    expect((await open('not a token')).body).toEqual(body);
    expect((await open('x'.repeat(300))).body).toEqual(body);
  });

  it('turned off: the old link stops at once', async () => {
    const token = (await make()).body.data.link.token;
    const off = await request(app).delete('/api/users/me/public-link').set(as(OWNER));
    expect(off.body.data).toEqual({ link: null, paused: null });
    const res = await open(token);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(await unknownBody());
  });

  it('replaced: only the new token works', async () => {
    const old = (await make()).body.data.link.token;
    const res = await request(app).post('/api/users/me/public-link/regenerate').set(as(OWNER));
    const fresh = res.body.data.link.token;
    expect(fresh).not.toBe(old);
    expect((await open(old)).body).toEqual(await unknownBody());
    expect((await open(fresh)).status).toBe(200);
  });

  it('a new link with none to replace is refused (409), and makes none', async () => {
    const res = await request(app).post('/api/users/me/public-link/regenerate').set(as(OWNER));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PUBLIC_LINK_NONE');
    expect(rows.get(OWNER)!.token).toBeNull();
  });

  it('hidden from search: paused for the owner, and the same 404 for everyone else', async () => {
    const token = (await make()).body.data.link.token;
    rows.get(OWNER)!.profile_visible = false;
    expect((await request(app).get('/api/users/me/public-link').set(as(OWNER))).body.data.paused).toBe('hidden');
    expect((await open(token)).body).toEqual(await unknownBody());
  });

  it('a closed account: the same 404', async () => {
    const token = (await make()).body.data.link.token;
    rows.get(OWNER)!.status = 'deactivated';
    expect((await open(token)).body).toEqual(await unknownBody());
  });

  it('a blocked reader, either direction: the same 404; signing out does not read their block', async () => {
    const token = (await make()).body.data.link.token;
    blocks.add(`${OWNER}|${READER}`);
    expect((await open(token, as(READER))).body).toEqual(await unknownBody());
    blocks.clear();
    blocks.add(`${READER}|${OWNER}`);
    expect((await open(token, as(READER))).body).toEqual(await unknownBody());
  });
});

describe('who may hold a link', () => {
  it('an event guest cannot make one (members only) and a guest row never opens', async () => {
    const res = await make(GUEST);
    expect(res.status).toBe(403);
    rows.get(GUEST)!.token = 'GuestGuestGuestGuestGu';
    rows.get(GUEST)!.profile_visible = true;
    expect((await open('GuestGuestGuestGuestGu')).body).toEqual(await unknownBody());
  });

  it('every owner route needs sign-in', async () => {
    expect((await request(app).get('/api/users/me/public-link')).status).toBe(401);
    expect((await request(app).post('/api/users/me/public-link')).status).toBe(401);
    expect((await request(app).post('/api/users/me/public-link/regenerate')).status).toBe(401);
    expect((await request(app).delete('/api/users/me/public-link')).status).toBe(401);
  });
});

describe('the page\'s limits', () => {
  it(`counts only links that lead nowhere: after ${PUBLIC_PROFILE_MISSES_MAX} misses from one address the next is 429, and a real link read before then never counted`, async () => {
    const token = (await make()).body.data.link.token;
    for (let i = 0; i < 5; i += 1) expect((await open(token)).status).toBe(200);
    for (let i = 0; i < PUBLIC_PROFILE_MISSES_MAX; i += 1) expect((await open(NEVER)).status).toBe(404);
    const over = await open(NEVER);
    expect(over.status).toBe(429);
    expect(JSON.stringify(over.body)).not.toMatch(/Error|stack/);
  }, 60_000);
});
