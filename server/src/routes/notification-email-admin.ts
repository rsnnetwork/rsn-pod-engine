// ─── An admin's sample of the digest emails (22 Nov 2026) ────────────────────────────────────────────────────
//
// POST /api/admin/notification-email/sample { kind: 'weekly' | 'daily' } sends ONE "Your week on REASON" or "Yesterday
// on REASON" to the signed-in admin's own address, built from their own account, whatever the email_config switches
// say. The weekly email ships switched off (migration 160); the owner reads a real one on production, then switches it
// on from the admin Email page. Admins only, six an hour. The answer names the address it went to and whether the
// content was an example (nothing of their own to show).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { UserRole, ApiResponse, ErrorCodes } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { digestSampleLimiter } from '../middleware/rateLimit';
import { AppError } from '../middleware/errors';
import { sendDigestSample } from '../services/notification-email/notification-digest.service';
import { maskAddress } from '../services/identity/reserved-address';

const router = Router();

export const sampleSchema = z.object({ kind: z.enum(['weekly', 'daily']) });

router.post(
  '/sample',
  authenticate,
  requireRole(UserRole.ADMIN),
  digestSampleLimiter,
  validate(sampleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await sendDigestSample(req.user!.userId, req.body.kind);
      if (!result.sent) {
        throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, 'The sample could not be sent just now. Please try again in a moment.');
      }
      const response: ApiResponse = { success: true, data: { sentTo: maskAddress(result.to), example: result.example } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
