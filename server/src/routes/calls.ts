// ─── Calls Routes (1 Nov 2026, 30 Oct review item 4, L12) ────────────────────
//
// POST /calls/user/:userId → ring a connection for a video call, from a screen that knows a person and not
// their conversation (the profile). The service checks the connection before it finds or makes the pair's
// conversation, then rings exactly as the thread's call request does; the answer is that request. The thread
// keeps POST /dm/conversations/:id/call/request; the two share one limit (10 rings per 10 minutes).
// GET /calls/user/:userId/presence → where that connection is now, for the profile's call button (11 Nov 2026).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { callRequestLimiter, presenceReadLimiter } from '../middleware/rateLimit';
import { memberIdInPath } from '../middleware/dm-path-ids';
import * as callService from '../services/dm/meeting-call.service';
import { requireConnection } from '../services/dm/call-eligibility';
import { presenceState } from '../services/presence/presence.service';

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

// GET /calls/user/:userId/presence → where a connection is now, for the call button on their profile (11 Nov 2026,
// RSN 07): { state } as online, away, offline, or null when the read could not tell. Only for someone the member may
// call (a connection, no block, both members: the refusal is the call's own sentence), so it probes nobody else.
router.get(
  '/user/:userId/presence',
  authenticate,
  memberIdInPath,
  presenceReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requireConnection(req.user!.userId, req.params.userId);
      const state = await presenceState(req.params.userId);
      res.json({ success: true, data: { state } } as ApiResponse);
    } catch (err) { next(err); }
  },
);

export default router;
