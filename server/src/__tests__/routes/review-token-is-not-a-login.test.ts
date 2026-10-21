// ─── An admin's Approve or Reject link is not a sign-in link (21 Oct 2026) ───
//
// The Approve and Reject buttons in the email an admin gets about a new join request are
// one-time tokens kept in magic_links with purpose 'join_request_review', bound to that admin
// (admin-action-tokens.service.ts). POST /auth/verify looked a token up by its hash alone, so
// anyone holding one of those links (forwarded, read by a mail filter, left in a mailbox) could
// post its token to the sign-in route and be signed in as the admin, spending the link on the
// way. The sign-in lookup now takes login links only: a link of any other purpose is refused
// exactly like a token nobody issued, and is neither spent nor turned into an account.
//
// These go through express with the real routers and services; only the database is a
// stand-in: a small magic_links table that applies the purpose a query asks for, as Postgres
// would. (The auth limiter allows 50 requests a file, so keep the calls here well under that.)

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.test', apiBaseUrl: 'https://api.test',
    googleClientId: 'gid', googleClientSecret: 'gsecret',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestDeclineEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

// ── The stand-in database ────────────────────────────────────────────────────

interface LinkRow {
  id: string; email: string; token_hash: string; expires_at: Date; used_at: Date | null;
  purpose: string; target_user_id: string | null; target_id: string | null; action: string | null;
}

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@rsn.test', displayName: 'Ada Admin', role: 'admin', status: 'active', emailVerified: true };
const APPLICANT = { id: '22222222-2222-4222-8222-222222222222', email: 'sam@example.com', displayName: 'Sam Applicant', role: 'member', status: 'active', emailVerified: true };
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

let links: LinkRow[];
let joinRequest: { status: string };
let sessions: string[]; // the user ids a session (refresh token) was written for
let accountsMade: number;

/** The purpose a query's WHERE asks for: a literal ('login') or a bound parameter. Null when it does not ask. */
function purposeAskedFor(text: string, params: unknown[]): string | null {
  const literal = /purpose\s*=\s*'([a-z_]+)'/.exec(text);
  if (literal) return literal[1];
  const bound = /purpose\s*=\s*\$(\d+)/.exec(text);
  return bound ? String(params[Number(bound[1]) - 1]) : null;
}

/** A row from `INSERT INTO magic_links (columns) VALUES (values)`; the columns left out take the table's defaults. */
function insertedLink(text: string, params: unknown[]): LinkRow {
  const parts = /INSERT INTO magic_links \(([^)]*)\) VALUES \(([^)]*)\)/.exec(text)!;
  const columns = parts[1].split(',').map((c) => c.trim());
  const values = parts[2].split(',').map((v) => v.trim());
  const given: Record<string, unknown> = {};
  columns.forEach((column, i) => {
    given[column] = values[i].startsWith('$') ? params[Number(values[i].slice(1)) - 1] : values[i].replace(/'/g, '');
  });
  return { id: `ml-${links.length + 1}`, used_at: null, purpose: 'login', target_user_id: null, target_id: null, action: null, ...given } as LinkRow;
}

const answer = (rows: unknown[]) => Promise.resolve({ rows, rowCount: rows.length });

function database(sql: string, params: unknown[] = []) {
  const text = sql.replace(/\s+/g, ' ').trim();

  if (/^INSERT INTO magic_links/.test(text)) { links.push(insertedLink(text, params)); return answer([]); }
  if (/FROM magic_links WHERE token_hash = \$1/.test(text)) {
    const purpose = purposeAskedFor(text, params);
    return answer(links.filter((l) => l.token_hash === params[0] && (purpose === null || l.purpose === purpose)));
  }
  if (/^UPDATE magic_links SET used_at = NOW\(\) WHERE/.test(text)) {
    const spend = (l: LinkRow) => {
      if (/WHERE id = \$1/.test(text)) return l.id === params[0];
      if (/WHERE token_hash = \$1/.test(text)) return l.token_hash === params[0];
      return l.email === params[0] && l.purpose === 'login' && l.used_at === null; // a new link retires the earlier ones
    };
    links.filter(spend).forEach((l) => { l.used_at = new Date(); });
    return answer([]);
  }

  if (/FROM users WHERE email = \$1/.test(text)) return answer([ADMIN, APPLICANT].filter((u) => u.email === params[0]));
  if (/^INSERT INTO users/.test(text)) { accountsMade += 1; return answer([]); }
  if (/^INSERT INTO refresh_tokens/.test(text)) { sessions.push(String(params[0])); return answer([]); }

  if (/FROM join_requests jr LEFT JOIN users u ON u.id = jr.reviewed_by WHERE jr.id = \$1/.test(text)) {
    return answer([{
      id: REQUEST_ID, full_name: APPLICANT.displayName, email: APPLICANT.email, linkedin_url: null, reason: 'I run a studio',
      status: joinRequest.status, created_at: new Date(), reviewed_at: null, reviewer_name: null,
    }]);
  }
  if (/^UPDATE join_requests SET status = \$1/.test(text)) {
    if (joinRequest.status !== 'pending') return answer([]); // the claim only takes a pending request
    joinRequest.status = String(params[0]);
    return answer([{ id: REQUEST_ID, full_name: APPLICANT.displayName, email: APPLICANT.email, sign_in_origin: null }]);
  }
  return answer([]);
}

jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => database(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => database(sql, params) }),
  __esModule: true,
}));

import authRoutes from '../../routes/auth';
import adminActionRoutes from '../../routes/admin-actions';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { issueReviewTokens } from '../../services/join-request/admin-action-tokens.service';
import { sendMagicLinkEmail, sendJoinRequestWelcomeEmail } from '../../services/email/email.service';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/admin/join-request-action', adminActionRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const linkFor = (token: string) => links.find((l) => l.token_hash === sha(token))!;

beforeEach(() => {
  links = [];
  joinRequest = { status: 'pending' };
  sessions = [];
  accountsMade = 0;
  (sendMagicLinkEmail as jest.Mock).mockClear();
  (sendJoinRequestWelcomeEmail as jest.Mock).mockClear();
});

/** The two buttons of the email the admin gets about a new join request, as the service makes them. */
async function theAdminsEmail(): Promise<{ approve: string; reject: string }> {
  const issued = await issueReviewTokens(REQUEST_ID, [{ id: ADMIN.id, email: ADMIN.email }]);
  const pair = issued.get(ADMIN.id)!;
  return { approve: pair.approveToken, reject: pair.rejectToken };
}

/** Asks for a sign-in link the way the login page does, and reads the token out of the email that would be sent. */
async function askForASignInLink(email: string): Promise<string> {
  const res = await request(app).post('/auth/magic-link').send({ email });
  expect(res.status).toBe(200);
  const url = String((sendMagicLinkEmail as jest.Mock).mock.calls[0][1]);
  return new URL(url).searchParams.get('token')!;
}

const verify = (token: string) => request(app).post('/auth/verify').send({ token });
const peek = (token: string) => request(app).get(`/admin/join-request-action/${token}`);
const confirm = (token: string) => request(app).post(`/admin/join-request-action/${token}/confirm`);

// ── An admin's Approve and Reject links ──────────────────────────────────────

describe("an admin's Approve and Reject links are not sign-in links", () => {
  it.each(['approve', 'reject'] as const)('the %s token, posted to /auth/verify, is refused like a token nobody issued', async (action) => {
    const email = await theAdminsEmail();
    const nobodys = await verify('f'.repeat(64));
    expect(nobodys.status).toBe(401);

    const res = await verify(email[action]);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(nobodys.body); // it reveals nothing the unknown token would not
    expect(res.body.error.message).toBe('Invalid magic link');
    expect(res.body.data).toBeUndefined();
  });

  it.each(['approve', 'reject'] as const)('signs nobody in with the %s token: no session, no account, and the token is not spent', async (action) => {
    const email = await theAdminsEmail();
    await verify(email[action]);

    expect(sessions).toEqual([]);
    expect(accountsMade).toBe(0);
    expect(linkFor(email[action]).used_at).toBeNull();
  });

  it.each([
    ['spent', { used_at: new Date(Date.now() - 60 * 60 * 1000) }],
    ['expired', { expires_at: new Date(Date.now() - 1000) }],
  ])('a review token that is %s reads as an unknown token too (the old answers said the link existed)', async (_state, change) => {
    const email = await theAdminsEmail();
    Object.assign(linkFor(email.approve), change);
    const nobodys = await verify('f'.repeat(64));

    const res = await verify(email.approve);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(nobodys.body);
  });

  it('a link of any purpose but login is refused, not only the one kept today', async () => {
    const email = await theAdminsEmail();
    const other = linkFor(email.approve);
    other.purpose = 'some_future_purpose';

    const res = await verify(email.approve);
    expect(res.status).toBe(401);
    expect(sessions).toEqual([]);
  });

  it.each([['approve', 'approved'], ['reject', 'declined']] as const)(
    'the %s token, refused as a sign-in, still reviews the request through the Approve page',
    async (action, decision) => {
      const email = await theAdminsEmail();
      expect((await verify(email[action])).status).toBe(401);

      const opened = await peek(email[action]);
      expect(opened.body.data).toMatchObject({ kind: 'ready', action, adminUserId: ADMIN.id });
      const done = await confirm(email[action]);
      expect(done.body.data).toMatchObject({ kind: 'success', action });
      expect(joinRequest.status).toBe(decision);
      expect(sessions).toEqual([]);
    },
  );

  it('a sign-in link is not an Approve link either: the review pages take review tokens only', async () => {
    const loginToken = await askForASignInLink(ADMIN.email);

    expect((await peek(loginToken)).body.data).toEqual({ kind: 'invalid' });
    expect((await confirm(loginToken)).body.data).toEqual({ kind: 'invalid' });
    expect(joinRequest.status).toBe('pending');
    expect(linkFor(loginToken).used_at).toBeNull();
  });
});

// ── Sign-in links still sign in ──────────────────────────────────────────────

describe('a sign-in link still signs in', () => {
  it('asking for a link and opening it signs the member in, once', async () => {
    const token = await askForASignInLink(ADMIN.email);
    expect(linkFor(token).purpose).toBe('login'); // written with no purpose: the table's default

    const res = await verify(token);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(sessions).toEqual([ADMIN.id]);
    expect(linkFor(token).used_at).not.toBeNull();
  });

  it("the one-click link in the applicant's approval email signs the applicant in, not the admin", async () => {
    const email = await theAdminsEmail();
    expect((await confirm(email.approve)).body.data.kind).toBe('success');
    await flush();

    const welcome = (sendJoinRequestWelcomeEmail as jest.Mock).mock.calls[0];
    expect(welcome[0]).toBe(APPLICANT.email);
    const token = new URL(String(welcome[2])).searchParams.get('token')!;
    expect(linkFor(token).purpose).toBe('login');

    const res = await verify(token);
    expect(res.status).toBe(200);
    expect(sessions).toEqual([APPLICANT.id]);
  });
});
