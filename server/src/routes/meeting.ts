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
import { generateIcsContent } from '../services/calendar/calendar.service';
import { NotFoundError } from '../middleware/errors';
import { query } from '../db';
import config from '../config';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// GET /dm/conversations/:id/meeting.ics — the confirmed meeting as a universal
// calendar file (Google, Outlook, Apple…) for the in-app "Add to calendar"
// (Stefan, 9 Sep 2026: "it says Google Calendar — calendar could be anything").
// Participant-only (getScheduling enforces it).
router.get(
  '/conversations/:id/meeting.ics',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const s = await meetingService.getScheduling(req.params.id, me);
      if (!s.confirmed?.startAt) throw new NotFoundError('Meeting time', req.params.id);
      const people = await query<{ id: string; display_name: string | null; email: string | null }>(
        `SELECT id, display_name, email FROM users WHERE id = ANY($1)`,
        [[me, s.partnerId]],
      );
      const other = people.rows.find((p) => p.id === s.partnerId);
      const kind = s.confirmed.type ?? 'video';
      const ics = generateIcsContent({
        title: 'RSN meeting',
        description: `A 1:1 ${kind} call on RSN with ${other?.display_name || 'your match'}. Join: ${config.clientUrl}/meet/${req.params.id}?scheduled=1&kind=${kind}`,
        startTime: new Date(s.confirmed.startAt),
        durationMinutes: s.confirmed.durationMin ?? 30,
        attendees: people.rows.filter((p) => p.email).map((p) => ({ name: p.display_name || undefined, email: p.email! })),
      });
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8; method=REQUEST');
      res.setHeader('Content-Disposition', 'attachment; filename="rsn-meeting.ics"');
      res.send(ics);
    } catch (err) {
      next(err);
    }
  },
);

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

// 9 Sep 2026: a call is REQUESTED with a duration the caller types (any number
// of minutes, clamped 5–240 server-side), then accepted by the other person.
const callRequestBodySchema = z.object({
  kind: z.enum(['audio', 'video']).optional(),
  durationMin: z.number().int().min(1).max(1000),
});

const availabilityBodySchema = z.object({
  // 30-min slots over a week are far more than the old 7×3 day-parts.
  windows: z.array(z.string().max(30)).max(200),
});

const confirmBodySchema = z.object({
  window: z.string().max(30),
  // W6: optional exact instant (ISO) + duration; a concrete slot key already IS
  // the instant. Duration is a custom number of minutes (Ali, 9 Sep): 5–240.
  startAt: z.string().datetime().optional(),
  durationMin: z.number().int().min(5).max(240).optional(),
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

// POST /dm/conversations/:id/call/request — ask the partner for a call of a
// chosen length (9 Sep 2026). Requires calls to be unlocked (first meeting
// happened) and the partner online. The caller then waits for accept/decline.
router.post(
  '/conversations/:id/call/request',
  authenticate,
  validate(callRequestBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.requestCall(
        req.params.id, req.user!.userId, req.body.kind || 'video', req.body.durationMin,
      );
      res.status(201).json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// GET /dm/conversations/:id/call/pending — the live request on this thread, if
// any, so a refreshed client can restore "waiting…" / "X wants a call".
router.get(
  '/conversations/:id/call/pending',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.getPendingCallRequest(req.params.id, req.user!.userId);
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// POST /dm/call/requests/:id/accept|decline|cancel
router.post(
  '/call/requests/:id/accept',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.acceptCallRequest(req.params.id, req.user!.userId);
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);
router.post(
  '/call/requests/:id/decline',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await callService.declineCallRequest(req.params.id, req.user!.userId);
      res.json({ success: true, data: { ok: true } } as ApiResponse);
    } catch (err) { next(err); }
  },
);
router.post(
  '/call/requests/:id/cancel',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await callService.cancelCallRequest(req.params.id, req.user!.userId);
      res.json({ success: true, data: { ok: true } } as ApiResponse);
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
