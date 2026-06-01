// ─── Report Routes ─────────────────────────────────────────────────────────
//
// Phase H of chat-fix-and-dm-system plan (1 May 2026). User → admin
// reporting flow.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import * as reportService from '../services/report/report.service';
import { ApiResponse, UserRole } from '@rsn/shared';

const router = Router();

const submitBodySchema = z.object({
  reportedId: z.string().uuid(),
  reason: z.enum(['spam', 'harassment', 'inappropriate_content', 'fake_profile', 'safety', 'other']),
  description: z.string().max(2000).optional(),
});

const resolveBodySchema = z.object({
  notes: z.string().max(2000).optional(),
});

// POST /reports — any authenticated user can submit
router.post(
  '/',
  authenticate,
  validate(submitBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportService.submitReport(
        req.user!.userId, req.body.reportedId,
        req.body.reason, req.body.description,
      );
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
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
