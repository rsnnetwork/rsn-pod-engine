// ─── Host Control Routes ─────────────────────────────────────────────────────
// REST endpoints for host actions. These complement the Socket-based controls
// for clients that prefer HTTP or for administrative tooling.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { auditMiddleware } from '../middleware/audit';
import * as orchestrationService from '../services/orchestration/orchestration.service';

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────

const broadcastSchema = z.object({
  message: z.string().min(1).max(2000),
});

// ─── POST /sessions/:id/host/start ──────────────────────────────────────────

router.post(
  '/:id/host/start',
  authenticate,
  auditMiddleware('session:start', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrationService.startSession(req.params.id, req.user!.userId);
      res.json({ success: true, data: { message: 'Session started' } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/host/pause ──────────────────────────────────────────

router.post(
  '/:id/host/pause',
  authenticate,
  auditMiddleware('session:pause', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrationService.pauseSession(req.params.id, req.user!.userId);
      res.json({ success: true, data: { message: 'Session paused' } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/host/resume ─────────────────────────────────────────

router.post(
  '/:id/host/resume',
  authenticate,
  auditMiddleware('session:resume', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrationService.resumeSession(req.params.id, req.user!.userId);
      res.json({ success: true, data: { message: 'Session resumed' } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/host/end ────────────────────────────────────────────

router.post(
  '/:id/host/end',
  authenticate,
  auditMiddleware('session:end', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrationService.endSession(req.params.id, req.user!.userId);
      res.json({ success: true, data: { message: 'Session ended' } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/host/broadcast ──────────────────────────────────────

router.post(
  '/:id/host/broadcast',
  authenticate,
  validate(broadcastSchema, 'body'),
  auditMiddleware('session:broadcast', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrationService.broadcastMessage(
        req.params.id, req.user!.userId, req.body.message
      );
      res.json({ success: true, data: { message: 'Broadcast sent' } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/host/state — Get live session state ──────────────────

router.get(
  '/:id/host/state',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const state = orchestrationService.getActiveSessionState(req.params.id);
      if (!state) {
        res.json({ success: true, data: { active: false } });
        return;
      }
      res.json({ success: true, data: { active: true, ...state } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
