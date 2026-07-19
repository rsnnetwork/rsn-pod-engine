// ─── Meeting Windows Routes ──────────────────────────────────────────────────
//
// REASON v1 Phase 2 (19 Jul 2026). Mounted on /api/dm alongside dm routes —
// path shapes are disjoint (dm uses /conversations/:id/messages etc.).
// GET  /dm/conversations/:id/scheduling               → both sides + overlap + confirmed
// PUT  /dm/conversations/:id/scheduling/availability  → replace MY windows
// POST /dm/conversations/:id/scheduling/confirm       → confirm an overlap window

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as meetingService from '../services/dm/meeting-windows.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

const availabilityBodySchema = z.object({
  windows: z.array(z.string().max(30)).max(21),
});

const confirmBodySchema = z.object({
  window: z.string().max(30),
});

router.get(
  '/conversations/:id/scheduling',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await meetingService.getScheduling(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/conversations/:id/scheduling/availability',
  authenticate,
  validate(availabilityBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await meetingService.setAvailability(
        req.params.id, req.user!.userId, req.body.windows,
      );
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/conversations/:id/scheduling/confirm',
  authenticate,
  validate(confirmBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await meetingService.confirmWindow(
        req.params.id, req.user!.userId, req.body.window,
      );
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
