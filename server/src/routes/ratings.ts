// ─── Rating & Encounter Routes ───────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/rbac';
import { UserRole } from '@rsn/shared';
import * as ratingService from '../services/rating/rating.service';

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────

const submitRatingSchema = z.object({
  matchId: z.string().uuid(),
  qualityScore: z.number().int().min(1).max(5),
  meetAgain: z.boolean(),
  feedback: z.string().max(1000).optional(),
});

// ─── POST /ratings — Submit a rating for a match ────────────────────────────

router.post(
  '/',
  authenticate,
  validate(submitRatingSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rating = await ratingService.submitRating(req.user!.userId, req.body);
      res.status(201).json({ success: true, data: rating });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /ratings/match/:matchId — Get ratings for a specific match ─────────

router.get(
  '/match/:matchId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ratings = await ratingService.getRatingsByMatch(req.params.matchId);
      res.json({ success: true, data: ratings });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /ratings/my — Get ratings I've given ───────────────────────────────

router.get(
  '/my',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.query.sessionId as string | undefined;
      const ratings = await ratingService.getRatingsByUser(req.user!.userId, sessionId);
      res.json({ success: true, data: ratings });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /ratings/received — Get ratings I've received ──────────────────────

router.get(
  '/received',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.query.sessionId as string | undefined;
      const ratings = await ratingService.getRatingsReceived(req.user!.userId, sessionId);
      res.json({ success: true, data: ratings });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/people-met — Get people-met summary ─────────────────

router.get(
  '/sessions/:id/people-met',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const peopleMet = await ratingService.getPeopleMet(req.user!.userId, req.params.id);
      res.json({ success: true, data: peopleMet });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/export — Export session data (admin/host) ────────────

router.get(
  '/sessions/:id/export',
  authenticate,
  requireRole(UserRole.ADMIN, UserRole.HOST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exportData = await ratingService.exportSessionData(req.params.id);
      res.json({ success: true, data: exportData });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/stats — Get session rating stats ────────────────────

router.get(
  '/sessions/:id/stats',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await ratingService.getSessionRatingStats(req.params.id);
      res.json({ success: true, data: stats });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /encounters — Get my encounter history ─────────────────────────────

router.get(
  '/encounters',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mutualOnly = req.query.mutualOnly === 'true';
      const encounters = await ratingService.getUserEncounters(req.user!.userId, mutualOnly);
      res.json({ success: true, data: encounters });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
