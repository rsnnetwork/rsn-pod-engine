// ─── Admin: feedback after meetings (30 Oct 2026, item 5c) ──────────────────
// "Save the answers in the admin panel." Every answer, newest first, a page at a time, and the same rows as a CSV.
//
// GET /admin/feedback?problems=only&limit=1..100&cursor=<nextCursor>   AdminFeedbackPage
// GET /admin/feedback.csv?problems=only                                text/csv; each download is written to audit_log
//
// Admins only (a member is a 403). Each row: when it was answered, where (after a meeting, or "Profile" for the
// profile's outcome sheet), the meeting's time and kind, both people (a closed account reads "Former member"), the
// answer, and the other person's answer about the same meeting.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, UserRole } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { recordAudit } from '../middleware/audit';
import { clientIp, adminFeedbackExportLimiter, adminFeedbackReadLimiter } from '../middleware/rateLimit';
import * as feedback from '../services/meetings/meeting-feedback.service';

const router = Router();

const problemsFilter = z.enum(['all', 'only']).default('all');

const listQuery = z.object({
  problems: problemsFilter,
  limit: z.coerce.number().int().min(1).max(feedback.ADMIN_FEEDBACK_PAGE_MAX).default(30),
  cursor: z.string().refine(feedback.isAdminFeedbackCursor, 'Not a page of this list').optional(),
});
type ListQuery = z.infer<typeof listQuery>;

const csvQuery = z.object({ problems: problemsFilter });
type CsvQuery = z.infer<typeof csvQuery>;

router.get('/feedback', authenticate, requireRole(UserRole.ADMIN), adminFeedbackReadLimiter, validate(listQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // validate() has already replaced req.query with the parsed value, but Express types it loosely.
      const { problems, limit, cursor } = req.query as unknown as ListQuery;
      const data = await feedback.listAdminFeedback({ problemsOnly: problems === 'only', limit, cursor });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.get('/feedback.csv', authenticate, requireRole(UserRole.ADMIN), adminFeedbackExportLimiter, validate(csvQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { problems } = req.query as unknown as CsvQuery;
      const rows = await feedback.allAdminFeedback(problems === 'only');
      // Members' own words leave REASON in this file, so who took it, when and how much is kept.
      await recordAudit({
        actorId: req.user!.userId,
        action: 'admin.feedback_csv_download',
        entityType: 'meeting_feedback',
        entityId: null,
        details: { problems, rows: rows.length },
        ipAddress: clientIp(req),
      });
      const day = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="reason-meeting-feedback-${day}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(feedback.adminFeedbackCsv(rows));
    } catch (err) {
      next(err);
    }
  });

export default router;
