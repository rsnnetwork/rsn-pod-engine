// ─── Platform Match Routes ───────────────────────────────────────────────────
//
// REASON platform v1 Phase 1 (17 Jul 2026). The standing match check Stefan
// described: after onboarding the system looks for people who fit you.
// GET  /matches/platform            → suggestions (or the no-match payload)
// GET  /matches/platform?browse=1   → relaxed threshold ("find other people")
// POST /matches/platform/:userId/interest → "I want to meet" (rides poke rails)

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
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

// POST /matches/platform/:userId/interest — "I want to meet"
router.post(
  '/platform/:userId/interest',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const poke = await platformMatchService.expressInterest(req.user!.userId, req.params.userId);
      const response: ApiResponse = { success: true, data: poke };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
