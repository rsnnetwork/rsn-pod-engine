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
import { callRequestIdInPath, conversationIdInPath } from '../middleware/dm-path-ids';
import * as meetingService from '../services/dm/meeting-windows.service';
import * as callService from '../services/dm/meeting-call.service';
import { presenceOf } from '../services/presence/presence.service';
import { callLeaveLimiter, callReadLimiter, callRequestLimiter, presenceReadLimiter } from '../middleware/rateLimit';
import { buildMeetingFile, MEETING_FILE_HEADERS } from '../services/meetings/meeting-calendar';
import { NotFoundError } from '../middleware/errors';
import { query } from '../db';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// 26 Oct 2026: every id in a path is checked before it reaches the database (middleware/dm-path-ids.ts):
// "undefined" sent as a conversation id came back a 500, and is now a 400 in a member's words.

// GET /dm/conversations/:id/meeting.ics — the confirmed meeting as a universal
// calendar file (Google, Outlook, Apple…) for the in-app "Add to calendar"
// (Stefan, 9 Sep 2026: "it says Google Calendar — calendar could be anything").
// Participant-only (getScheduling enforces it).
router.get(
  '/conversations/:id/meeting.ics',
  authenticate,
  conversationIdInPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const s = await meetingService.getScheduling(req.params.id, me);
      if (!s.confirmed?.startAt) throw new NotFoundError('Meeting time', req.params.id);
      // 26 Oct 2026: the same calendar identity, SEQUENCE and organizer as the emailed invite, so
      // adding this file updates the entry the email made instead of adding a second one.
      const ics = await buildMeetingFile({
        conversationId: req.params.id,
        viewerId: me,
        partnerId: s.partnerId,
        kind: s.confirmed.type ?? 'video',
        startAt: new Date(s.confirmed.startAt),
        durationMin: s.confirmed.durationMin ?? 30,
        meetingId: s.confirmed.meetingId ?? null,
      });
      res.set(MEETING_FILE_HEADERS);
      res.send(ics);
    } catch (err) {
      next(err);
    }
  },
);

// GET /dm/presence — where each of my conversation partners is now, for the dot in the messages list (8 Sep 2026,
// Ali; three states 11 Nov 2026). Scoped to my own conversations so it can't probe arbitrary users, and a pair where
// either has blocked the other is left out (a block hides presence both ways). `states` has online / away / offline,
// a partner the read could not place left out (unknown); `online` is kept for screens that read only it.
router.get(
  '/presence',
  authenticate,
  presenceReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const rows = await query<{ partner_id: string }>(
        `SELECT CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS partner_id
           FROM dm_conversations c
          WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = c.user_a_id AND b.blocked_id = c.user_b_id)
                  OR (b.blocker_id = c.user_b_id AND b.blocked_id = c.user_a_id))
          LIMIT 500`,
        [me],
      );
      const states = await presenceOf(rows.rows.map((r) => r.partner_id));
      const online = Object.fromEntries(Object.entries(states).map(([id, state]) => [id, state === 'online']));
      res.json({ success: true, data: { online, states } } as ApiResponse);
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
  // 25 Oct 2026: a save that leaves exactly one shared time books it, with this
  // length and kind. Both optional: production's scheduler sends only `windows`,
  // and then the meeting is 30 minutes of video. Same bounds as confirm.
  durationMin: z.number().int().min(5).max(240).optional(),
  type: z.enum(['audio', 'video']).optional(),
});

const confirmBodySchema = z.object({
  window: z.string().max(30),
  // W6: optional exact instant (ISO) + duration; a concrete slot key already IS
  // the instant. Duration is a custom number of minutes (Ali, 9 Sep): 5–240.
  startAt: z.string().datetime().optional(),
  durationMin: z.number().int().min(5).max(240).optional(),
  // W-meet: audio or video call.
  type: z.enum(['audio', 'video']).optional(),
  // H2b item 9 (26 Oct 2026): the meeting the client saw (its window key, or null for none). When the standing
  // meeting no longer matches, the answer is 409 MEETING_CHANGED_SINCE_SEEN with details.scheduling.
  expectedWindow: z.string().max(30).nullable().optional(),
});

router.get(
  '/conversations/:id/scheduling',
  authenticate,
  conversationIdInPath,
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
  conversationIdInPath,
  validate(availabilityBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await meetingService.setAvailability(
        req.params.id, req.user!.userId, req.body.windows,
        { durationMin: req.body.durationMin, type: req.body.type },
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
  conversationIdInPath,
  validate(confirmBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await meetingService.confirmWindow(
        req.params.id, req.user!.userId, req.body.window,
        { startAt: req.body.startAt, durationMin: req.body.durationMin, type: req.body.type, expectedWindow: req.body.expectedWindow },
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
  conversationIdInPath,
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
  conversationIdInPath,
  validate(callBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.getCallToken(req.params.id, req.user!.userId, req.body.kind || 'video');
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// POST /dm/conversations/:id/call/leave { sid } — I have left this conversation's call on purpose: take that
// connection of mine (its LiveKit participant sid) out of the room, so the other person is told at once even when the
// leave my browser sent never reached LiveKit (leave fix, 2 Nov 2026). It changes no data any screen reads: the room's
// membership reaches both people through LiveKit itself, so there is no entity to emit.
const callLeaveBodySchema = z.object({
  sid: z.string().regex(/^PA_[A-Za-z0-9]+$/).max(64),
});
router.post(
  '/conversations/:id/call/leave',
  authenticate,
  conversationIdInPath,
  callLeaveLimiter,
  validate(callLeaveBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.leaveCallRoom(req.params.id, req.user!.userId, req.body.sid);
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// POST /dm/conversations/:id/call/request — ask the partner for a call of a
// chosen length (9 Sep 2026). The partner must be online; the caller then waits
// for accept/decline. 1 Nov 2026: a video call needs a connection, not a held
// meeting; audio still needs calls unlocked. 10 rings per 10 minutes per member,
// one bucket with POST /calls/user/:userId.
router.post(
  '/conversations/:id/call/request',
  authenticate,
  conversationIdInPath,
  callRequestLimiter,
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
  conversationIdInPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.getPendingCallRequest(req.params.id, req.user!.userId);
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// GET /dm/call/requests/incoming — the call ringing me now, if any; /outgoing — the one I rang that is still
// waiting (1 Nov 2026). Any screen opened or refreshed while a call rings shows it again from these.
router.get(
  '/call/requests/incoming',
  authenticate,
  callReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.getIncomingCallRequest(req.user!.userId);
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);
router.get(
  '/call/requests/outgoing',
  authenticate,
  callReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await callService.getOutgoingCallRequest(req.user!.userId);
      res.json({ success: true, data: result } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// POST /dm/call/requests/:id/accept|decline|cancel
router.post(
  '/call/requests/:id/accept',
  authenticate,
  callRequestIdInPath,
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
  callRequestIdInPath,
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
  callRequestIdInPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ok as before (production's client reads only that), and what the withdraw ended as: "accepted" when the
      // answer came first, so the caller's screen goes into the room instead (fix round 1).
      const outcome = await callService.cancelCallRequest(req.params.id, req.user!.userId);
      res.json({ success: true, data: { ok: true, ...outcome } } as ApiResponse);
    } catch (err) { next(err); }
  },
);

// GET /dm/conversations/:id/partner-presence — where the other person is now: `state` is online, away, offline, or
// null when the read could not tell (11 Nov 2026, RSN 07); `online` is kept for screens that read only it.
router.get(
  '/conversations/:id/partner-presence',
  authenticate,
  conversationIdInPath,
  presenceReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await callService.partnerPresence(req.params.id, req.user!.userId);
      res.json({ success: true, data: { online: state === 'online', state } } as ApiResponse);
    } catch (err) { next(err); }
  },
);

export default router;
