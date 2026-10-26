// ─── Meetings (26 Oct 2026, CON-04/05) ───────────────────────────────────────
// A member's confirmed 1:1 meetings: what Events lists and counts, and the meeting's own page.
//
// GET  /meetings?scope=upcoming|past|cancelled&limit=1..50&before=<ISO>  { items, nextBefore }
// GET  /meetings/summary                                                  { upcomingCount, liveNow, next }
// GET  /meetings/:id                                                      Meeting, 404 for anyone but its two people
// POST /meetings/:id/cancel                                               Meeting; already cancelled → 200, started or ended → 409
//
// `before` is a page's `nextBefore`. Booking and moving stay in the scheduler (routes/meeting.ts).
// The reads are held by the API limiter in front of every /api route; cancel has an allowance of its
// own. The service decides who sees what and tells the screens once a cancel is done.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { meetingCancelLimiter } from '../middleware/rateLimit';
import * as meetings from '../services/meetings/meeting.service';

const router = Router();

// Postgres reads an upper-case uuid as the same row, but the service compares ids as plain strings.
const meetingParams = z.object({ id: z.string().uuid('Not a meeting id').transform((s) => s.toLowerCase()) });

const listQuery = z.object({
  scope: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime({ offset: true }).optional(),
});

// validate() has already replaced req.query with the parsed value, but Express types it loosely.
type ListQuery = z.infer<typeof listQuery>;

router.get('/', authenticate, validate(listQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scope, limit, before } = req.query as unknown as ListQuery;
      const data = await meetings.listMeetings(req.user!.userId, { scope, limit, before });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// Before /:id, so "summary" is never read as a meeting id.
router.get('/summary', authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await meetings.getMeetingSummary(req.user!.userId);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id', authenticate, validate(meetingParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await meetings.getMeeting(req.user!.userId, req.params.id);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/cancel', authenticate, meetingCancelLimiter, validate(meetingParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await meetings.cancelMeeting(req.user!.userId, req.params.id);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
