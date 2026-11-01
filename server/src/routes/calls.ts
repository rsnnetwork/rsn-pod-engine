// ─── Calls Routes (1 Nov 2026, 30 Oct review item 4, L12) ────────────────────
//
// POST /calls/user/:userId → ring a connection for a video call, from a screen that knows a person and not
// their conversation (the profile). The service checks the connection before it finds or makes the pair's
// conversation, then rings exactly as the thread's call request does; the answer is that request. The thread
// keeps POST /dm/conversations/:id/call/request; the two share one limit (10 rings per 10 minutes).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { callRequestLimiter } from '../middleware/rateLimit';
import { memberIdInPath } from '../middleware/dm-path-ids';
import * as callService from '../services/dm/meeting-call.service';

const router = Router();

/** A call is 30 minutes when the ring does not say (the preview's dialog offers 15). Same bounds as a meeting. */
export const DEFAULT_CALL_MIN = 30;

const callUserBodySchema = z.object({
  kind: z.literal('video').optional(),
  durationMin: z.number().int().min(5).max(240).optional(),
});

router.post(
  '/user/:userId',
  authenticate,
  memberIdInPath,
  callRequestLimiter,
  validate(callUserBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.requestCallToUser(
        req.user!.userId, req.params.userId, req.body.durationMin ?? DEFAULT_CALL_MIN,
      );
      res.status(201).json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

export default router;
