// ─── Meetings (26 Oct 2026, CON-04/05) ───────────────────────────────────────
// A member's confirmed 1:1 meetings: what Events lists and counts, and the meeting's own page.
//
// GET  /meetings?scope=upcoming|past|cancelled&limit=1..50&before=<ISO>  { items, nextBefore }
// GET  /meetings/summary                                                  { upcomingCount, liveNow, next }
// GET  /meetings/:id                                                      Meeting, 404 for anyone but its two people
// POST /meetings/:id/cancel                                               Meeting; already cancelled → 200, started or ended → 409
// POST /meetings/:id/feedback  { worthContinuing, problems?, problemText? } SavedMeetingFeedback (30 Oct 2026); a second
//                                                                         press edits the same answer
//
// `before` is a page's `nextBefore`. Booking and moving stay in the scheduler (routes/meeting.ts).
// The reads are held by the API limiter in front of every /api route; cancel has an allowance of its
// own, and so does feedback. The service decides who sees what and tells the screens once a cancel is done; the
// feedback service tells the author's screens and every admin's feedback list once an answer is saved.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, MEETING_PROBLEMS, MEETING_PROBLEM_TEXT_MAX, WORTH_CONTINUING } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { meetingCancelLimiter, meetingFeedbackLimiter } from '../middleware/rateLimit';
import * as meetings from '../services/meetings/meeting.service';
import * as feedback from '../services/meetings/meeting-feedback.service';

const router = Router();

// Postgres reads an upper-case uuid as the same row, but the service compares ids as plain strings.
const meetingParams = z.object({ id: z.string().uuid('Not a meeting id').transform((s) => s.toLowerCase()) });

const listQuery = z.object({
  scope: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime({ offset: true }).optional(),
});

// "How did it go?": the lists are the shared ones the database CHECKs hold. A problem picked twice counts once.
const feedbackBody = z.object({
  worthContinuing: z.enum(WORTH_CONTINUING, { errorMap: () => ({ message: 'Choose Yes, Maybe or No.' }) }),
  problems: z.array(z.enum(MEETING_PROBLEMS)).max(MEETING_PROBLEMS.length * 2).optional(),
  problemText: z.string().max(MEETING_PROBLEM_TEXT_MAX, `Keep it to ${MEETING_PROBLEM_TEXT_MAX} characters.`).optional(),
});
type FeedbackBody = z.infer<typeof feedbackBody>;

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

router.post('/:id/feedback', authenticate, meetingFeedbackLimiter, validate(meetingParams, 'params'), validate(feedbackBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as FeedbackBody;
      const data = await feedback.submitMeetingFeedback(req.user!.userId, req.params.id, body);
      void feedback.announceFeedback(req.user!.userId, data.meetingId);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
