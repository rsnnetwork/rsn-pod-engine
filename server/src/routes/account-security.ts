// ─── The member's own sensitive account changes (Part 3 Task 2, 11 Nov 2026) ──────────────────────────────────────
//
// Mounted at /api/users/me, ahead of routes/users.ts, so /me/email/* and /me/close are served here.
//   POST /email/code   { newEmail, reauthToken }  the address checked (not their own, not reserved), a change_email
//                                                 proof spent, then the address checked free and a code sent to it
//   POST /email/verify { code }                   the new address's code: the change, and a fresh token pair
//   POST /close        { reauthToken }            a close_account proof spent, then the account closed as an admin's
//                                                 DELETE /users/:id closes it
// Members only: none of these is in GUEST_ROUTES (middleware/guest-scope.ts), so an event guest gets 403
// GUEST_MEMBERSHIP_REQUIRED from `authenticate`.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { recordAudit } from '../middleware/audit';
import { requireRecentReauth } from '../middleware/reauth';
import {
  closeAccountLimiter, emailChangeCodeLimiter, emailChangeTargetLimiter, emailChangeVerifyLimiter,
} from '../middleware/rateLimit';
import * as identityService from '../services/identity/identity.service';
import {
  assertNewAddressAcceptable, confirmEmailChange, requestEmailChange,
} from '../services/identity/email-change.service';
import { accountAudience, fanoutAccountAudience, fanoutAdminEntities, fanoutUserEntity } from '../realtime/fanout';

const router = Router();

const CODE_MESSAGE = 'Enter the 6-digit code from the email.';
const reauthToken = z.string().max(4096).optional();

const emailCodeSchema = z.object({
  newEmail: z.string().trim().email('Enter a valid email address.').max(255).transform((e) => e.toLowerCase()),
  reauthToken,
});
const emailVerifySchema = z.object({
  code: z.string().max(32).transform((c) => c.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{6}$/, CODE_MESSAGE)),
});
const closeSchema = z.object({ reauthToken });

/** The new address is not the member's own nor one no person can receive mail at: checked before the proof is spent. */
const newAddressChecks = (req: Request, _res: Response, next: NextFunction): void => {
  assertNewAddressAcceptable(req.user!.userId, req.body.newEmail).then(() => next(), next);
};

router.post(
  '/email/code',
  authenticate,
  emailChangeCodeLimiter,
  validate(emailCodeSchema),
  emailChangeTargetLimiter,
  newAddressChecks,
  requireRecentReauth('change_email'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await requestEmailChange(req.user!.userId, req.body.newEmail);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/email/verify',
  authenticate,
  emailChangeVerifyLimiter,
  validate(emailVerifySchema, 'body', CODE_MESSAGE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const tokens = await confirmEmailChange(userId, req.body.code, req.ip);
      const response: ApiResponse = { success: true, data: tokens };
      res.json(response);
      // The member's own screens (Settings shows the address) and the admin users list.
      fanoutUserEntity(userId).catch(() => {});
      fanoutAdminEntities('users').catch(() => {});
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/close',
  authenticate,
  closeAccountLimiter,
  validate(closeSchema),
  requireRecentReauth('close_account'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      // The same close as DELETE /users/:id (deleteUser: out of every pod and event, tokens revoked, deactivated). The
      // people around them are read before it takes them out of their pods and events, and told after; the member's
      // other tabs and the admin list are told once it is done (their next read finds the account closed).
      const around = await accountAudience(userId).catch(() => null);
      await identityService.deleteUser(userId);
      await recordAudit({ actorId: userId, action: 'user.closed_self', entityType: 'user', entityId: userId, ipAddress: req.ip });
      const response: ApiResponse = { success: true, data: { closed: true } };
      res.json(response);
      fanoutAdminEntities('users').catch(() => {});
      fanoutUserEntity(userId).catch(() => {});
      if (around) fanoutAccountAudience(around, userId).catch(() => {});
    } catch (err) {
      next(err);
    }
  }
);

export default router;
