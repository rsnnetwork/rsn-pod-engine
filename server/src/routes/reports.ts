// ─── Report Routes ─────────────────────────────────────────────────────────
//
// Phase H of chat-fix-and-dm-system plan (1 May 2026). User → admin
// reporting flow.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { reportLimiter } from '../middleware/rateLimit';
import * as reportService from '../services/report/report.service';
import { fanoutAdminEntities } from '../realtime/fanout';
import { ApiResponse, REPORT_REASONS, REPORT_SUBJECT_KINDS, UserRole } from '@rsn/shared';

const router = Router();

// Postgres reads an upper-case uuid as the same row, but the service compares ids as plain strings.
const lowerUuid = z.string().uuid().transform((s) => s.toLowerCase());

const submitBodySchema = z.object({
  // The member reported. A report of a message or a post names its author itself, so it may leave this out.
  reportedId: lowerUuid.optional(),
  reason: z.enum(REPORT_REASONS),
  description: z.string().max(2000).optional(),
  // 8 Sep 2026: when reported from a chat, carry the conversation so admins can
  // review the messages behind the report.
  conversationId: lowerUuid.optional(),
  // 11 Nov 2026 (Shirley Palmer's item 16): one message or wall post, reported as such.
  subject: z.object({ kind: z.enum(REPORT_SUBJECT_KINDS), id: lowerUuid }).optional(),
}).refine((b) => !!b.reportedId || !!b.subject, { message: 'Say who or what you are reporting.', path: ['reportedId'] });

const resolveBodySchema = z.object({
  notes: z.string().max(2000).optional(),
});

// POST /reports — any authenticated user can submit, at most 10 an hour (reportLimiter); the same report again within a
// day is a 409 "You already reported this." (REPORT_ALREADY_SENT).
router.post(
  '/',
  authenticate,
  reportLimiter,
  validate(submitBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportService.submitReport(
        { userId: req.user!.userId, role: req.user!.role },
        {
          reportedId: req.body.reportedId,
          reason: req.body.reason,
          description: req.body.description,
          conversationId: req.body.conversationId,
          subject: req.body.subject,
        },
      );
      // Phase May-19 realtime — fanout so every admin moderation
      // queue shows the new report without a refresh.
      fanoutAdminEntities('violations').catch(() => {});
      const response: ApiResponse = { success: true, data: result };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /reports/open — admin only — moderation queue
router.get(
  '/open',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportService.listOpenReports();
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /reports/:id/resolve — admin only
router.post(
  '/:id/resolve',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(resolveBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportService.resolveReport(req.params.id, req.user!.userId, req.body.notes);
      // Phase May-19 realtime — admin moderation queue refresh.
      fanoutAdminEntities('violations').catch(() => {});
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /reports/:id/dismiss — admin only
router.post(
  '/:id/dismiss',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(resolveBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportService.dismissReport(req.params.id, req.user!.userId, req.body.notes);
      // Phase May-19 realtime — admin moderation queue refresh.
      fanoutAdminEntities('violations').catch(() => {});
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
