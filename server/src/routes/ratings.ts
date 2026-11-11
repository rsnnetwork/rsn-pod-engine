// ─── Rating & Encounter Routes ───────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { UserRole, hasRoleAtLeast } from '@rsn/shared';
import * as ratingService from '../services/rating/rating.service';
import * as sessionService from '../services/session/session.service';
import { notifyRatingSubmitted } from '../services/orchestration/orchestration.service';
import { ForbiddenError } from '../middleware/errors';
import { fanoutLateRating } from '../services/session/event-report.service';

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────

const submitRatingSchema = z.object({
  matchId: z.string().uuid(),
  qualityScore: z.number().int().min(1).max(5),
  meetAgain: z.boolean(),
  feedback: z.string().max(1000).optional(),
  toUserId: z.string().uuid().optional(),
  // WS3/H5 — "this conversation didn't work": rating recorded (dedup/replay
  // see the match as handled) but excluded from every quality average.
  didntWork: z.boolean().optional(),
});

// ─── POST /ratings — Submit a rating for a match ────────────────────────────

router.post(
  '/',
  authenticate,
  validate(submitRatingSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rating = await ratingService.submitRating(req.user!.userId, req.body);
      // Trigger early-exit check: if all participants have rated, end rating window immediately
      notifyRatingSubmitted(req.user!.userId).catch(() => {});
      res.status(201).json({ success: true, data: rating });
      // A rating sent once the event is closing or over (the recap) changes its organisers' report; a live round's
      // ratings are announced once, when the round's rating window closes. Never throws.
      void fanoutLateRating(req.body.matchId);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /ratings/unrated — Get partners user hasn't rated ─────────────────

router.get(
  '/unrated',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) {
        res.status(400).json({ error: { message: 'sessionId required' } });
        return;
      }
      const userId = req.user!.userId;
      const unrated = await ratingService.getUnratedPartners(sessionId, userId);
      res.json({ data: unrated });
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
      // Verify user is a participant in this match or admin
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const isParticipant = await ratingService.isMatchParticipant(req.params.matchId, req.user!.userId);
        if (!isParticipant) {
          throw new ForbiddenError('You are not a participant in this match');
        }
      }

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
// The production recap's Export button reads this, so its shape stays. Since 11 Nov 2026 (Part 3 Task 4) what a
// member wrote privately about a partner (a rating's `feedback`) and the individual scores (a rating's quality_score
// and meet_again, a pair's last_quality_score) only reach an admin; the event's host reads them as null.

router.get(
  '/sessions/:id/export',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Only the session's own host or a system admin can export
      const isAdmin = hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      if (!isAdmin) {
        const session = await sessionService.getSessionById(req.params.id);
        if (session.hostUserId !== req.user!.userId) {
          throw new ForbiddenError('Only the session host or an admin can export session data');
        }
      }
      const exportData = await ratingService.exportSessionData(req.params.id, { individualScores: isAdmin });
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
      // Only participants, the session host, or admins can view stats
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const session = await sessionService.getSessionById(req.params.id);
        if (session.hostUserId !== req.user!.userId) {
          const isParticipant = await sessionService.isSessionParticipant(req.params.id, req.user!.userId);
          if (!isParticipant) {
            throw new ForbiddenError('You do not have access to this session');
          }
        }
      }
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
