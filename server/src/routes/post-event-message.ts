// ─── Post-Event Broadcast Message Routes ─────────────────────────────────────
//
// Task 9 of the post-event-broadcast-messaging plan (May 2026).
// Exposes four endpoints for the broadcast-message feature:
//   GET  /sessions/:sessionId/post-event-message/eligibility
//   GET  /sessions/:sessionId/post-event-message/preview
//   POST /sessions/:sessionId/post-event-message
//   GET  /sessions/:sessionId/post-event-message/status
//
// Mounted at /api/sessions (alongside sessionRoutes) in index.ts.
// Uses mergeParams: true so :sessionId is visible on this router.

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { AppError, NotFoundError } from '../middleware/errors';
import { ErrorCodes, ApiResponse, UserRole } from '@rsn/shared';
import { getEligibilityForEvent } from '../services/post-event-message/broadcast-eligibility';
import {
  previewJob,
  createJob,
  getLatestJob,
} from '../services/post-event-message/post-event-message.service';
import { query } from '../db';

const router = Router({ mergeParams: true });

// ─── Enabled guard ────────────────────────────────────────────────────────────
//
// v1: only admins are enabled; hosts/directors see coming-soon state via
// the eligibility endpoint but cannot call preview/create.

async function requireBroadcastEnabled(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const elig = await getEligibilityForEvent(
      req.user!.userId,
      req.user!.role as UserRole,
      req.params.sessionId,
    );
    if (!elig.enabled) {
      return next(
        new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'This feature is coming soon'),
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ─── Completed-event guard (inline helper) ────────────────────────────────────
//
// Returns the session row if status='completed', otherwise throws.
// Used inside preview and create handlers.

async function assertSessionCompleted(sessionId: string): Promise<void> {
  const result = await query<{ status: string }>(
    `SELECT status FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Session', sessionId);
  }
  if (result.rows[0].status !== 'completed') {
    throw new AppError(
      409,
      ErrorCodes.VALIDATION_ERROR,
      'Post-event messages can only be sent for completed events',
    );
  }
}

// ─── GET /:sessionId/post-event-message/eligibility ──────────────────────────
//
// No enabled-guard — callers need to query this to decide whether to show
// the button at all (visible vs enabled). Still requires auth.

router.get(
  '/:sessionId/post-event-message/eligibility',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Ensure the session exists (NotFound beats eligibility noise).
      const sessResult = await query<{ id: string }>(
        `SELECT id FROM sessions WHERE id = $1`,
        [req.params.sessionId],
      );
      if (sessResult.rows.length === 0) {
        throw new NotFoundError('Session', req.params.sessionId);
      }

      const elig = await getEligibilityForEvent(
        req.user!.userId,
        req.user!.role as UserRole,
        req.params.sessionId,
      );
      const response: ApiResponse = { success: true, data: elig };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:sessionId/post-event-message/preview ──────────────────────────────
//
// Dry-run: classify recipients and return grouped counts. Sends nothing.

router.get(
  '/:sessionId/post-event-message/preview',
  authenticate,
  requireBroadcastEnabled,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertSessionCompleted(req.params.sessionId);
      const preview = await previewJob(req.params.sessionId);
      const response: ApiResponse = { success: true, data: preview };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:sessionId/post-event-message ─────────────────────────────────────
//
// Create a pending broadcast job. The background worker picks it up within ~10 s.

router.post(
  '/:sessionId/post-event-message',
  authenticate,
  requireBroadcastEnabled,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertSessionCompleted(req.params.sessionId);
      const job = await createJob(req.params.sessionId, req.user!.userId);
      const response: ApiResponse = { success: true, data: job };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:sessionId/post-event-message/status ───────────────────────────────
//
// Returns the most-recent job for this event, or null if none exists yet.

router.get(
  '/:sessionId/post-event-message/status',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await getLatestJob(req.params.sessionId);
      const response: ApiResponse = { success: true, data: job };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
