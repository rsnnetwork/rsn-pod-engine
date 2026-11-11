// ─── The API as index.ts mounts it, for the reauth, email change, close and admin-role tests (Part 3 Task 2) ───────
//
// Import AFTER the test file's jest.mock calls (config, logger, db → account-security-world, the email senders, the
// fanout): this file imports the real routers, the real services and the real limiters.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { ReauthScope } from '@rsn/shared';
import authRoutes from '../../routes/auth';
import accountSecurityRoutes from '../../routes/account-security';
import userRoutes from '../../routes/users';
import adminRoutes from '../../routes/admin';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { __test__ as authCache } from '../../middleware/auth';
import {
  closeAccountLimiter, emailChangeCodeLimiter, emailChangeTargetLimiter, emailChangeVerifyLimiter, reauthCodeLimiter,
  reauthVerifyLimiter, signInCodeEmailKey,
} from '../../middleware/rateLimit';
import { sendReauthCodeEmail } from '../../services/email/email.service';
import { world, type WorldUser } from './account-security-world';

export const JWT_SECRET = 'test-jwt-secret';

export const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/users/me', accountSecurityRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

export const person = (n: number, over: Partial<WorldUser> = {}): WorldUser => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  email: `person${n}@reason-members.org`,
  displayName: `Person ${n}`, role: 'member', status: 'active', accountKind: 'member', emailVerified: true,
  ...over,
});

/** An access token for `u`, as generateTokenPair makes them (the role as the token says it). */
export const accessFor = (u: WorldUser) => jwt.sign(
  { sub: u.id, email: u.email, role: u.role, displayName: u.displayName, sessionId: 'sess-1' },
  JWT_SECRET, { expiresIn: '15m' },
);

export const as = (u: WorldUser) => ({
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', `Bearer ${accessFor(u)}`).send(body),
  put: (path: string, body: object = {}) => request(app).put(path).set('Authorization', `Bearer ${accessFor(u)}`).send(body),
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${accessFor(u)}`),
});

/** The code in the newest confirmation email, and who it went to. */
export function lastReauthEmail(): { to: string; code: string; purposeText: string } {
  const call = (sendReauthCodeEmail as jest.Mock).mock.calls.at(-1) as [string, { code: string; purposeText: string }];
  return { to: call[0], code: call[1].code, purposeText: call[1].purposeText };
}

/** Ask for a confirmation code for `scope` and type it: the reauth token the change sends. */
export async function grantFor(u: WorldUser, scope: ReauthScope): Promise<string> {
  const asked = await as(u).post('/api/auth/reauth/code', { scope });
  expect(asked.status).toBe(200);
  const { code } = lastReauthEmail();
  const verified = await as(u).post('/api/auth/reauth/verify', { scope, code });
  expect(verified.status).toBe(200);
  return verified.body.data.reauthToken as string;
}

export const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

/** Every bucket starts empty for these people and addresses, and the account gate forgets them. */
export function freshBuckets(people: WorldUser[], addresses: string[] = []): void {
  authCache.clearAll();
  for (const u of people) {
    for (const limiter of [reauthCodeLimiter, reauthVerifyLimiter, emailChangeCodeLimiter, emailChangeVerifyLimiter, closeAccountLimiter]) {
      void limiter.resetKey(`u:${u.id}`);
    }
  }
  for (const address of addresses) void emailChangeTargetLimiter.resetKey(signInCodeEmailKey(address));
}

export { world };
