// ─── Confirm it's you before a sensitive change: the code and the proof (Part 3 Task 2, 11 Nov 2026) ───────────────
//
// Through express with the real auth router, the real account routes, the real reauth service, middleware and limiters.
// Only the database (an in-memory world answering the services' own statements), config, the logger, the email senders
// and the fanout are stand-ins. The code is read where a member reads it: from the email.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

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
jest.mock('../../db', () => {
  const w = jest.requireActual('../fixtures/account-security-world');
  const run = (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params));
  return { query: run, transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: run }), __esModule: true };
});
jest.mock('../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  sendReauthCodeEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailChangeCodeEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailChangedNoticeEmail: jest.fn().mockResolvedValue({ sent: true }),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  accountAudience: jest.fn(async () => ({ podIds: [], events: [], people: [], groupIds: [], circleIds: [] })),
  fanoutAccountAudience: jest.fn(async () => {}),
  fanoutAccountStatusChange: jest.fn(async () => {}),
  fanoutAdminEntities: jest.fn(async () => {}),
  fanoutPodEntities: jest.fn(async () => {}),
  fanoutProfileChange: jest.fn(async () => {}),
  fanoutUserBlocks: jest.fn(async () => {}),
  fanoutUserEntity: jest.fn(async () => {}),
}));
jest.mock('../../services/onboarding/avatar.service', () => ({ __esModule: true, getAvatarBlob: jest.fn(), captureAvatar: jest.fn(), hasAvatar: jest.fn(), tryGravatar: jest.fn() }));
jest.mock('../../services/user/user-search.service', () => ({ __esModule: true, searchMembers: jest.fn() }));
jest.mock('../../services/invite/connected-users', () => ({ __esModule: true, searchConnectedUsers: jest.fn() }));

import { addLink, resetWorld, world } from '../fixtures/account-security-world';
import { JWT_SECRET, app, as, freshBuckets, grantFor, lastReauthEmail, person, wrongCode } from '../fixtures/account-security-app';
import { hashSignInCode } from '../../services/identity/sign-in-code';
import { sendMagicLinkEmail, sendReauthCodeEmail } from '../../services/email/email.service';
import { forgetAccountGate } from '../../middleware/auth';

const ANA = person(1);
const BO = person(2);
const GUEST = person(3, { accountKind: 'event_guest', email: 'guest3@reason-members.org' });

beforeEach(() => {
  resetWorld([ANA, BO, GUEST]);
  freshBuckets([ANA, BO, GUEST], ['ana.new@reason-members.org']);
  (sendReauthCodeEmail as jest.Mock).mockClear();
  (sendMagicLinkEmail as jest.Mock).mockClear();
});

const reauthRows = () => world.links.filter((l) => l.purpose === 'reauth');

describe('asking for a confirmation code', () => {
  it('emails a code to the member\'s CURRENT address only, keeps only its keyed hash, and answers just { sent: true }', async () => {
    const res = await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true });
    expect(sendReauthCodeEmail).toHaveBeenCalledTimes(1);
    const { to, code, purposeText } = lastReauthEmail();
    expect(to).toBe(ANA.email);
    expect(code).toMatch(/^\d{6}$/);
    expect(purposeText).toBe('change your sign-in email');
    // Code only: the email is given nothing to make a button from.
    expect(Object.keys((sendReauthCodeEmail as jest.Mock).mock.calls[0][1]).sort()).toEqual(['code', 'purposeText']);
    const [row] = reauthRows();
    expect(row).toMatchObject({ email: ANA.email, purpose: 'reauth', target_user_id: ANA.id, action: 'change_email', used_at: null });
    expect(row.code_hash).toBe(hashSignInCode(row.token_hash, code));
    expect(row.code_hash).not.toContain(code);
    expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(row.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  it('says what each kind of code confirms', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'close_account' });
    expect(lastReauthEmail().purposeText).toBe('close your account');
    await as(ANA).post('/api/auth/reauth/code', { scope: 'admin_role' });
    expect(lastReauthEmail().purposeText).toBe('change an admin role');
  });

  it('refuses a kind of change it does not know, and someone not signed in', async () => {
    const odd = await as(ANA).post('/api/auth/reauth/code', { scope: 'everything' });
    expect(odd.status).toBe(400);
    expect(sendReauthCodeEmail).not.toHaveBeenCalled();
    const anon = await request(app).post('/api/auth/reauth/code').send({ scope: 'change_email' });
    expect(anon.status).toBe(401);
  });

  it('an event guest has nothing to confirm: 403 GUEST_MEMBERSHIP_REQUIRED, and no email', async () => {
    const res = await as(GUEST).post('/api/auth/reauth/code', { scope: 'change_email' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GUEST_MEMBERSHIP_REQUIRED');
    expect(sendReauthCodeEmail).not.toHaveBeenCalled();
    expect(reauthRows()).toEqual([]);
  });

  it('the sixth code asked for in 15 minutes is refused with a 429 in words, and no email goes out', async () => {
    for (let i = 0; i < 5; i += 1) expect((await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' })).status).toBe(200);
    const sixth = await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toEqual({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many codes asked for. Please wait 15 minutes, then try again.' });
    expect(sendReauthCodeEmail).toHaveBeenCalledTimes(5);
    // Another member's bucket is their own.
    expect((await as(BO).post('/api/auth/reauth/code', { scope: 'change_email' })).status).toBe(200);
  });
});

describe('typing the code', () => {
  it('the right code answers a reauth token that names its member, scope and grant, for 10 minutes', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'close_account' });
    const { code } = lastReauthEmail();
    const res = await as(ANA).post('/api/auth/reauth/verify', { scope: 'close_account', code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['expiresAt', 'reauthToken']);
    const claims = jwt.verify(res.body.data.reauthToken, JWT_SECRET) as Record<string, unknown>;
    const [row] = reauthRows();
    expect(claims).toMatchObject({ sub: ANA.id, purpose: 'reauth', act: 'close_account', jti: row.id });
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
    expect(row.used_at).not.toBeNull();
    const left = new Date(res.body.data.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);
  });

  it('five wrong tries lock the code: the right one is refused after', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    const { code } = lastReauthEmail();
    for (let left = 4; left >= 1; left -= 1) {
      const res = await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: wrongCode(code) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'AUTH_SIGN_IN_CODE_WRONG', details: { attemptsLeft: left } });
    }
    const fifth = await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: wrongCode(code) });
    expect(fifth.body.error.code).toBe('AUTH_SIGN_IN_LOCKED');
    const right = await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code });
    expect(right.status).toBe(400);
    expect(right.body.error.code).toBe('AUTH_SIGN_IN_LOCKED');
  });

  it('only the newest code works, a code is typed once, and a code for one kind is wrong for another', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    const first = lastReauthEmail().code;
    await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    const second = lastReauthEmail().code;
    if (first !== second) {
      expect((await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: first })).status).toBe(400);
    }
    expect((await as(ANA).post('/api/auth/reauth/verify', { scope: 'close_account', code: second })).body.error.code)
      .toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect((await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: second })).status).toBe(200);
    const again = await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: second });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('AUTH_MAGIC_LINK_USED');
  });

  it('another member\'s code is never theirs: Bo typing Ana\'s code tries nothing of Ana\'s', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    const { code } = lastReauthEmail();
    expect((await as(BO).post('/api/auth/reauth/verify', { scope: 'change_email', code })).body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(reauthRows()[0].code_attempts).toBe(0);
    expect((await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code })).status).toBe(200);
  });
});

describe('codes never cross purposes', () => {
  it('a sign-in code is never a confirmation code', async () => {
    await request(app).post('/api/auth/magic-link').send({ email: ANA.email });
    const signInCode = ((sendMagicLinkEmail as jest.Mock).mock.calls.at(-1) as [string, string, string])[2];
    const res = await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: signInCode });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    const login = world.links.find((l) => l.purpose === 'login')!;
    expect(login).toMatchObject({ used_at: null, code_attempts: 0 });
  });

  it('an event entry code is never a confirmation code', async () => {
    const entry = addLink({ email: ANA.email, purpose: 'event_entry', target_id: '9f0e0e0e-0000-4000-8000-000000000001' });
    entry.code_hash = hashSignInCode(entry.token_hash, '246810');
    const res = await as(ANA).post('/api/auth/reauth/verify', { scope: 'change_email', code: '246810' });
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(entry).toMatchObject({ used_at: null, code_attempts: 0 });
  });

  it('a confirmation code is never a sign-in code', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    const { code } = lastReauthEmail();
    const res = await request(app).post('/api/auth/magic-link/code').set('cf-connecting-ip', '10.9.9.9').send({ email: ANA.email, code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(reauthRows()[0]).toMatchObject({ used_at: null, code_attempts: 0 });
  });
});

describe('the reauth token is a proof for one change, never a session', () => {
  it('authenticate refuses a reauth token as a bearer token', async () => {
    const token = await grantFor(ANA, 'close_account');
    const res = await request(app).post('/api/users/me/close').set('Authorization', `Bearer ${token}`).send({ reauthToken: token });
    expect(res.status).toBe(401);
    expect(world.users.find((u) => u.id === ANA.id)!.status).toBe('active');
  });

  it('a change sent without a proof, or with an access token, a forged, an expired or another member\'s token, is 403 REAUTH_REQUIRED', async () => {
    const anasGrant = await grantFor(ANA, 'close_account');
    const row = reauthRows()[0];
    const access = jwt.sign({ sub: ANA.id, email: ANA.email, role: 'member', displayName: 'Ana', sessionId: 's' }, JWT_SECRET);
    const forged = jwt.sign({ sub: ANA.id, purpose: 'reauth', act: 'close_account', jti: row.id }, 'not-our-secret', { expiresIn: '10m' });
    const expired = jwt.sign({ sub: ANA.id, purpose: 'reauth', act: 'close_account', jti: row.id, exp: Math.floor(Date.now() / 1000) - 5 }, JWT_SECRET);
    const notAnId = jwt.sign({ sub: ANA.id, purpose: 'reauth', act: 'close_account', jti: 'x; DROP TABLE users' }, JWT_SECRET, { expiresIn: '10m' });
    for (const reauthToken of [undefined, '', access, forged, expired, notAnId, 'nonsense']) {
      const res = await as(ANA).post('/api/users/me/close', reauthToken === undefined ? {} : { reauthToken });
      expect(res.status).toBe(403);
      expect(res.body.error).toEqual({
        code: 'REAUTH_REQUIRED', message: "Confirm it's you first. We'll email you a code.", details: { scope: 'close_account' },
      });
    }
    // Ana's own token, used by Bo, proves nothing for Bo, and Ana's grant is still hers afterwards.
    expect((await as(BO).post('/api/users/me/close', { reauthToken: anasGrant })).status).toBe(403);
    expect(world.users.find((u) => u.id === BO.id)!.status).toBe('active');
    expect((await as(ANA).post('/api/users/me/close', { reauthToken: anasGrant })).status).toBe(200);
  });

  it('a grant for one kind of change is refused for another, and stays good for its own', async () => {
    const emailGrant = await grantFor(ANA, 'change_email');
    const refused = await as(ANA).post('/api/users/me/close', { reauthToken: emailGrant });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toEqual({ scope: 'close_account' });
    expect(world.users.find((u) => u.id === ANA.id)!.status).toBe('active');
    expect((await as(ANA).post('/api/users/me/email/code', { newEmail: 'ana.new@reason-members.org', reauthToken: emailGrant })).status).toBe(200);
  });

  it('a grant is single use: the same token on a second close (the account reopened in between) is 403 REAUTH_REQUIRED', async () => {
    const token = await grantFor(ANA, 'close_account');
    expect((await as(ANA).post('/api/users/me/close', { reauthToken: token })).status).toBe(200);
    // An approval reopens a closed account (account-access.ts); the old proof must not close it again.
    world.users.find((u) => u.id === ANA.id)!.status = 'active';
    forgetAccountGate(ANA.id);
    const second = await as(ANA).post('/api/users/me/close', { reauthToken: token });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('REAUTH_REQUIRED');
    expect(world.users.find((u) => u.id === ANA.id)!.status).toBe('active');
  });

  it('two requests racing with one token: exactly one change goes through', async () => {
    const token = await grantFor(ANA, 'change_email');
    const [a, b] = await Promise.all([
      as(ANA).post('/api/users/me/email/code', { newEmail: 'ana.new@reason-members.org', reauthToken: token }),
      as(ANA).post('/api/users/me/email/code', { newEmail: 'ana.new@reason-members.org', reauthToken: token }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
  });

  it('a grant dies once the account\'s email has changed', async () => {
    const closeGrant = await grantFor(ANA, 'close_account');
    // A second grant, made the same way, moves Ana to a new address.
    const emailGrant = await grantFor(ANA, 'change_email');
    expect((await as(ANA).post('/api/users/me/email/code', { newEmail: 'ana.new@reason-members.org', reauthToken: emailGrant })).status).toBe(200);
    const changeRow = world.links.find((l) => l.purpose === 'email_change')!;
    changeRow.code_hash = hashSignInCode(changeRow.token_hash, '135790');
    expect((await as(ANA).post('/api/users/me/email/verify', { code: '135790' })).status).toBe(200);
    const res = await as(ANA).post('/api/users/me/close', { reauthToken: closeGrant });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    expect(world.users.find((u) => u.id === ANA.id)!.status).toBe('active');
  });

  it('a code asked for before the email changed cannot be typed after it', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'close_account' });
    const { code } = lastReauthEmail();
    world.users.find((u) => u.id === ANA.id)!.email = 'moved@reason-members.org';
    const res = await as(ANA).post('/api/auth/reauth/verify', { scope: 'close_account', code });
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
  });

  it('the stored row holds neither the code nor its plain hash', async () => {
    await as(ANA).post('/api/auth/reauth/code', { scope: 'change_email' });
    const { code } = lastReauthEmail();
    const sha = crypto.createHash('sha256').update(code).digest('hex');
    expect(JSON.stringify(world.links)).not.toContain(sha);
  });
});
