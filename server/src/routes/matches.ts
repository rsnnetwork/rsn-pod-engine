// ─── Platform Match Routes ───────────────────────────────────────────────────
//
// REASON platform v1 Phase 1 (17 Jul 2026). The standing match check Stefan
// described: after onboarding the system looks for people who fit you.
// GET  /matches/platform            → suggestions (or the no-match payload)
// GET  /matches/platform?browse=1   → relaxed threshold ("find other people")
// POST /matches/platform/:userId/interest → "I want to meet" (rides poke rails)

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as platformMatchService from '../services/matching/platform-match.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// GET /matches/platform — the standing match check
router.get(
  '/platform',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const browse = req.query.browse === '1' || req.query.browse === 'true';
      const result = await platformMatchService.getPlatformMatches(req.user!.userId, { browse });
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// Milestone 1 (29 Sep 2026): the Meet sheet adds a personal "why now" note and
// a preferred format. Both optional: today's callers POST with no body at all.
// 300 leaves room for REASON's reason inside the request's 500 characters.
const interestBody = z.object({
  note: z.string().trim().max(300).optional(),
  format: z.enum(['video_20', 'coffee', 'message_first']).optional(),
});
// A target that is not a UUID used to reach SQL and come back as a Postgres 500.
// Lower-cased because Postgres reads an upper-case uuid as the same member while
// the service compares ids as plain strings (yourself, blocked, already asked).
const userParams = z.object({ userId: z.string().uuid('Not a member id').transform((s) => s.toLowerCase()) });

// POST /matches/platform/:userId/interest — "I want to meet"
router.post(
  '/platform/:userId/interest',
  authenticate,
  validate(userParams, 'params'),
  validate(interestBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const poke = await platformMatchService.expressInterest(req.user!.userId, req.params.userId, undefined, {
        note: req.body.note,
        format: req.body.format,
      });
      const response: ApiResponse = { success: true, data: poke };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
