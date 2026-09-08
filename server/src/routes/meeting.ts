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
import * as callService from '../services/dm/meeting-call.service';
import { areActive } from '../services/presence/presence.service';
import { query } from '../db';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// GET /dm/presence — online status of all my conversation partners, for the
// green dot in the messages list (8 Sep 2026, Ali). Scoped to my own
// conversations so it can't probe arbitrary users.
router.get(
  '/presence',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const rows = await query<{ partner_id: string }>(
        `SELECT CASE WHEN user_a_id = $1 THEN user_b_id ELSE user_a_id END AS partner_id
           FROM dm_conversations
          WHERE user_a_id = $1 OR user_b_id = $1`,
        [me],
      );
      const online = await areActive(rows.rows.map((r) => r.partner_id));
      res.json({ success: true, data: { online } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

const callBodySchema = z.object({
  kind: z.enum(['audio', 'video']).optional(),
});

const availabilityBodySchema = z.object({
  windows: z.array(z.string().max(30)).max(21),
});

const confirmBodySchema = z.object({
  window: z.string().max(30),
  // W6: optional exact instant (ISO) + duration; absent = legacy daypart-only.
  startAt: z.string().datetime().optional(),
  durationMin: z.number().int().min(15).max(240).optional(),
  // W-meet: audio or video call.
  type: z.enum(['audio', 'video']).optional(),
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
        { startAt: req.body.startAt, durationMin: req.body.durationMin, type: req.body.type },
      );
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /dm/conversations/:id/scheduling/seen — I've looked at the scheduler;
// clear my calendar-icon "they updated availability" dot.
router.post(
  '/conversations/:id/scheduling/seen',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await meetingService.markSchedulerSeen(req.params.id, req.user!.userId);
      res.json({ success: true, data: { ok: true } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /dm/conversations/:id/call-token — mint a LiveKit token to join the call.
router.post(
  '/conversations/:id/call-token',
  authenticate,
  validate(callBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.getCallToken(req.params.id, req.user!.userId, req.body.kind || 'video');
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// POST /dm/conversations/:id/call/start — "Meet now": ring the partner (must be
// online) and return the caller's join token.
router.post(
  '/conversations/:id/call/start',
  authenticate,
  validate(callBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.startCall(req.params.id, req.user!.userId, req.body.kind || 'video');
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// GET /dm/conversations/:id/partner-presence — is the other person online now?
router.get(
  '/conversations/:id/partner-presence',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const online = await callService.isPartnerOnline(req.params.id, req.user!.userId);
      res.json({ success: true, data: { online } } as ApiResponse);
    } catch (err) { next(err); }
  },
);

export default router;
