// ─── Join Request Routes ─────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { authLimiter } from '../middleware/rateLimit';
import * as joinRequestService from '../services/join-request/join-request.service';
import { ApiResponse, UserRole } from '@rsn/shared';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createRequestSchema = z.object({
  fullName: z.string().min(1).max(100),
  email: z.string().email().max(255),
  linkedinUrl: z.string().url().max(500),
  reason: z.string().min(1).max(1000),
});

const reviewRequestSchema = z.object({
  decision: z.enum(['approved', 'declined']),
  reviewNotes: z.string().max(500).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'declined']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

// ─── POST /join-requests (public - rate limited) ────────────────────────────

router.post(
  '/',
  authLimiter,
  validate(createRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await joinRequestService.createJoinRequest(req.body);

      const response: ApiResponse = {
        success: true,
        data: request,
      };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /join-requests (admin only) ────────────────────────────────────────

router.get(
  '/',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(listQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, page, pageSize } = req.query as Record<string, string>;
      const result = await joinRequestService.listJoinRequests({
        status,
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
      });

      const pg = parseInt(page || '1');
      const ps = parseInt(pageSize || '20');
      const totalPages = Math.ceil(result.total / ps);

      const response: ApiResponse = {
        success: true,
        data: result.requests,
        meta: {
          page: pg,
          pageSize: ps,
          totalCount: result.total,
          totalPages,
          hasNext: pg < totalPages,
          hasPrev: pg > 1,
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /join-requests/:id (admin only) ────────────────────────────────────

router.get(
  '/:id',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await joinRequestService.getJoinRequestById(req.params.id);

      const response: ApiResponse = { success: true, data: request };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /join-requests/:id/review (admin only) ───────────────────────────

router.patch(
  '/:id/review',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(reviewRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { decision, reviewNotes } = req.body;
      const request = await joinRequestService.reviewJoinRequest(
        req.params.id,
        decision,
        req.user!.userId,
        reviewNotes
      );

      const response: ApiResponse = { success: true, data: request };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /join-requests/:id/note (admin only) ──────────────────────────────

router.post(
  '/:id/note',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(z.object({ note: z.string().max(2000) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await joinRequestService.updateAdminNotes(req.params.id, req.body.note);
      const response: ApiResponse = { success: true, data: updated };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /join-requests/:id/message (admin only) ───────────────────────────

router.post(
  '/:id/message',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(z.object({ message: z.string().min(1).max(2000) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const joinRequest = await joinRequestService.getJoinRequestById(req.params.id);

      // Send email to the applicant
      const { sendGenericEmail } = await import('../services/email/email.service');
      await sendGenericEmail(joinRequest.email, joinRequest.fullName, {
        subject: 'Message from RSN',
        body: req.body.message,
      });

      res.json({ success: true, data: { sent: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
