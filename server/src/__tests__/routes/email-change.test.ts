// ─── Change one's sign-in email (Part 3 Task 2, 11 Nov 2026) ─────────────────────────────────────────────────────
//
// A fresh change_email proof, then a code to the NEW address, then one change: the address moves, every live link of
// the old address dies, every session signs in again, the old address is told, and the record names nobody's address.
// Through express with the real routers, services, middleware and limiters; the database is an in-memory world
// answering the services' own statements.

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

import { resetWorld, world } from '../fixtures/account-security-world';
import { JWT_SECRET, app, as, freshBuckets, grantFor, person } from '../fixtures/account-security-app';
import { hashSignInCode } from '../../services/identity/sign-in-code';
import { generateTokenPair, getUserById } from '../../services/identity/identity.service';
import { sendEmailChangeCodeEmail, sendEmailChangedNoticeEmail, sendMagicLinkEmail } from '../../services/email/email.service';
import * as fanout from '../../realtime/fanout';

const ANA = person(1);
const BO = person(2);
const TEST_MEMBER = person(4, { email: 'p3t2-a@rsn-e2e.invalid' });
const NEW = 'ana.new@reason-members.org';

beforeEach(() => {
  resetWorld([ANA, BO, TEST_MEMBER]);
  freshBuckets([ANA, BO, TEST_MEMBER], [NEW, BO.email, ANA.email, 'p3t2-b@rsn-e2e.invalid', 'gone@rsn-e2e.invalid']);
  jest.clearAllMocks();
});

const userOf = (id: string) => world.users.find((u) => u.id === id)!;
const liveGrants = () => world.links.filter((l) => l.purpose === 'reauth' && l.used_at && l.expires_at.getTime() > Date.now());
const lastChangeCode = () => ((sendEmailChangeCodeEmail as jest.Mock).mock.calls.at(-1) as [string, { code: string }])[1].code;

/** Ask for the new address's code with a fresh proof, and answer the code the email to it carries. */
async function codeToNewAddress(u = ANA, newEmail = NEW): Promise<string> {
  const token = await grantFor(u, 'change_email');
  const res = await as(u).post('/api/users/me/email/code', { newEmail, reauthToken: token });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ sent: true });
  return lastChangeCode();
}

describe('asking for a code at the new address', () => {
  it('needs a fresh change_email proof first: 403 REAUTH_REQUIRED, and no code goes anywhere', async () => {
    const res = await as(ANA).post('/api/users/me/email/code', { newEmail: NEW });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { scope: 'change_email' } });
    expect(sendEmailChangeCodeEmail).not.toHaveBeenCalled();
  });

  it('sends the code to the NEW address only, bound to the member, and the proof is spent', async () => {
    const token = await grantFor(ANA, 'change_email');
    const res = await as(ANA).post('/api/users/me/email/code', { newEmail: '  Ana.New@Reason-Members.org ', reauthToken: token });
    expect(res.status).toBe(200);
    const [to, data] = (sendEmailChangeCodeEmail as jest.Mock).mock.calls[0] as [string, { code: string }];
    expect(to).toBe(NEW);
    expect(Object.keys(data)).toEqual(['code']);
    const row = world.links.find((l) => l.purpose === 'email_change')!;
    expect(row).toMatchObject({ email: NEW, target_user_id: ANA.id, used_at: null });
    expect(row.code_hash).toBe(hashSignInCode(row.token_hash, data.code));
    expect(userOf(ANA.id).email).toBe(ANA.email);
    const again = await as(ANA).post('/api/users/me/email/code', { newEmail: NEW, reauthToken: token });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('refuses the address the member already has (400) before the proof is spent, so the typo costs no code', async () => {
    const token = await grantFor(ANA, 'change_email');
    const same = await as(ANA).post('/api/users/me/email/code', { newEmail: ANA.email.toUpperCase(), reauthToken: token });
    expect(same.status).toBe(400);
    expect(same.body.error.message).toBe("That's already your email.");
    expect(liveGrants()).toHaveLength(1);
    // The same proof still works for a good address.
    expect((await as(ANA).post('/api/users/me/email/code', { newEmail: NEW, reauthToken: token })).status).toBe(200);
  });

  it('a proof-less request for the member\'s own or a reserved address is the plain 400, never a REAUTH_REQUIRED', async () => {
    expect((await as(ANA).post('/api/users/me/email/code', { newEmail: ANA.email })).body.error.message).toBe("That's already your email.");
    expect((await as(ANA).post('/api/users/me/email/code', { newEmail: 'gone@rsn-e2e.invalid' })).status).toBe(400);
    expect(sendEmailChangeCodeEmail).not.toHaveBeenCalled();
  });

  it('another account\'s address is asked about only after the proof is spent: unproven 403, proven 409 EMAIL_IN_USE', async () => {
    const unproven = await as(ANA).post('/api/users/me/email/code', { newEmail: BO.email });
    expect(unproven.status).toBe(403);
    expect(unproven.body.error.code).toBe('REAUTH_REQUIRED');
    const taken = await as(ANA).post('/api/users/me/email/code', { newEmail: BO.email, reauthToken: await grantFor(ANA, 'change_email') });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toEqual({ code: 'EMAIL_IN_USE', message: 'That email is already used by another account.' });
    expect(liveGrants()).toHaveLength(0);
    const nonsense = await as(ANA).post('/api/users/me/email/code', { newEmail: 'not an address', reauthToken: 'x' });
    expect(nonsense.status).toBe(400);
    expect(sendEmailChangeCodeEmail).not.toHaveBeenCalled();
  });

  it('an address stored in mixed case is still taken, at the request and again at the code', async () => {
    userOf(BO.id).email = 'Ana.New@Reason-Members.org';
    const taken = await as(ANA).post('/api/users/me/email/code', { newEmail: NEW, reauthToken: await grantFor(ANA, 'change_email') });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('EMAIL_IN_USE');
    // Taken in mixed case after the code went out: the code is refused and left unspent.
    userOf(BO.id).email = BO.email;
    const code = await codeToNewAddress();
    userOf(BO.id).email = 'ANA.NEW@reason-members.org';
    const res = await as(ANA).post('/api/users/me/email/verify', { code });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
    expect(userOf(ANA.id).email).toBe(ANA.email);
  });

  it("refuses an address no person can receive mail at, unless the account is itself one of the platform's test members", async () => {
    const token = await grantFor(ANA, 'change_email');
    const reserved = await as(ANA).post('/api/users/me/email/code', { newEmail: 'gone@rsn-e2e.invalid', reauthToken: token });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.message).toBe("That address can't receive email. Please use another one.");
    expect(liveGrants()).toHaveLength(1);
    expect(await codeToNewAddress(TEST_MEMBER, 'p3t2-b@rsn-e2e.invalid')).toMatch(/^\d{6}$/);
  });

  it('asking again kills the older code: only the newest works', async () => {
    const first = await codeToNewAddress();
    const second = await codeToNewAddress();
    if (first !== second) expect((await as(ANA).post('/api/users/me/email/verify', { code: first })).status).toBe(400);
    expect((await as(ANA).post('/api/users/me/email/verify', { code: second })).status).toBe(200);
  });

  it('a fourth code to one address in an hour is refused before the proof is spent; refusals never use up the address', async () => {
    for (let i = 0; i < 3; i += 1) expect((await as(BO).post('/api/users/me/email/code', { newEmail: NEW })).status).toBe(403);
    await codeToNewAddress();
    await codeToNewAddress();
    await codeToNewAddress();
    const token = await grantFor(ANA, 'change_email');
    const fourth = await as(ANA).post('/api/users/me/email/code', { newEmail: NEW, reauthToken: token });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toEqual({
      code: 'RATE_LIMIT_EXCEEDED', message: 'Too many codes asked for this address. Please wait an hour, then try again.',
    });
    expect(sendEmailChangeCodeEmail).toHaveBeenCalledTimes(3);
    const live = world.links.filter((l) => l.purpose === 'reauth' && l.used_at && l.expires_at.getTime() > Date.now());
    expect(live).toHaveLength(1);
  });
});

describe("typing the new address's code", () => {
  it('moves the address, kills the old links, ends every session, tells the old address, and answers a fresh pair', async () => {
    await request(app).post('/api/auth/magic-link').send({ email: ANA.email });
    const oldLink = ((sendMagicLinkEmail as jest.Mock).mock.calls.at(-1) as [string, string])[1];
    const oldToken = new URL(oldLink).searchParams.get('token');
    const phone = await generateTokenPair(await getUserById(ANA.id));
    const laptop = await generateTokenPair(await getUserById(ANA.id));

    const code = await codeToNewAddress();
    const res = await as(ANA).post('/api/users/me/email/verify', { code: `${code.slice(0, 3)}-${code.slice(3)}` });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken']);
    expect(jwt.verify(res.body.data.accessToken, JWT_SECRET)).toMatchObject({ sub: ANA.id, email: NEW });
    expect(userOf(ANA.id)).toMatchObject({ email: NEW, emailVerified: true });

    // The sign-in link in the old mailbox no longer signs anyone in.
    const used = await request(app).post('/api/auth/verify').send({ token: oldToken });
    expect(used.status).toBe(400);
    expect(used.body.error.code).toBe('AUTH_MAGIC_LINK_EXPIRED');
    // Every earlier session is over; the fresh one works.
    for (const pair of [phone, laptop]) {
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken: pair.refreshToken })).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: res.body.data.refreshToken })).status).toBe(200);

    expect(sendEmailChangedNoticeEmail).toHaveBeenCalledWith(ANA.email, { maskedNew: 'a•••@reason-members.org' });
    const record = world.audit.find((a) => a.action === 'user.email_changed')!;
    expect(record).toMatchObject({ actor_id: ANA.id, entity_type: 'user', entity_id: ANA.id, details: '{}' });
    expect(JSON.stringify(world.audit)).not.toContain('@');
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith(ANA.id);
    expect(fanout.fanoutAdminEntities).toHaveBeenCalledWith('users');
  });

  it("the code is bound to the member who asked: Bo typing Ana's code changes nothing and spends nothing", async () => {
    const code = await codeToNewAddress();
    const res = await as(BO).post('/api/users/me/email/verify', { code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect(userOf(BO.id).email).toBe(BO.email);
    expect(world.links.find((l) => l.purpose === 'email_change')).toMatchObject({ used_at: null, code_attempts: 0 });
    expect((await as(ANA).post('/api/users/me/email/verify', { code })).status).toBe(200);
  });

  it('five wrong codes lock it, and nothing changes', async () => {
    const code = await codeToNewAddress();
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 4; i += 1) {
      expect((await as(ANA).post('/api/users/me/email/verify', { code: wrong })).body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    }
    expect((await as(ANA).post('/api/users/me/email/verify', { code: wrong })).body.error.code).toBe('AUTH_SIGN_IN_LOCKED');
    expect((await as(ANA).post('/api/users/me/email/verify', { code })).body.error.code).toBe('AUTH_SIGN_IN_LOCKED');
    expect(userOf(ANA.id).email).toBe(ANA.email);
  });

  it('an address another account took in the meantime is refused 409, and the code is left unspent', async () => {
    const code = await codeToNewAddress();
    userOf(BO.id).email = NEW;
    const res = await as(ANA).post('/api/users/me/email/verify', { code });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
    expect(userOf(ANA.id).email).toBe(ANA.email);
    expect(world.links.find((l) => l.purpose === 'email_change')).toMatchObject({ used_at: null, code_attempts: 0 });
    expect(sendEmailChangedNoticeEmail).not.toHaveBeenCalled();
  });

  it('a race the check could not see (the unique index refuses the write) is the same 409, and nothing is recorded', async () => {
    const code = await codeToNewAddress();
    world.onStatement = (sql) => {
      if (sql === 'UPDATE users SET email = $2, email_verified = TRUE, updated_at = NOW() WHERE id = $1') userOf(BO.id).email = NEW;
    };
    const res = await as(ANA).post('/api/users/me/email/verify', { code });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
    expect(world.audit.filter((a) => a.action === 'user.email_changed')).toEqual([]);
    expect(sendEmailChangedNoticeEmail).not.toHaveBeenCalled();
  });

  it('with no code asked for any code is wrong; a malformed code is 400; someone not signed in is 401', async () => {
    expect((await as(ANA).post('/api/users/me/email/verify', { code: '123456' })).body.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
    expect((await as(ANA).post('/api/users/me/email/verify', { code: '12345' })).status).toBe(400);
    expect((await request(app).post('/api/users/me/email/verify').send({ code: '123456' })).status).toBe(401);
  });
});
