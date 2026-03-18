// ─── Session Routes ──────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as sessionService from '../services/session/session.service';
import * as podService from '../services/pod/pod.service';
import { ApiResponse, SessionStatus, UserRole, hasRoleAtLeast } from '@rsn/shared';
import { ForbiddenError } from '../middleware/errors';
import { query } from '../db';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createSessionSchema = z.object({
  podId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().nullable(),
  config: z.object({
    numberOfRounds: z.number().int().min(1).max(20).optional(),
    roundDurationSeconds: z.number().int().min(60).max(3600).optional(),
    lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    transitionDurationSeconds: z.number().int().min(10).max(120).optional(),
    ratingWindowSeconds: z.number().int().min(10).max(120).optional(),
    closingLobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    noShowTimeoutSeconds: z.number().int().min(15).max(300).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
  }).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
  config: z.object({
    numberOfRounds: z.number().int().min(1).max(20).optional(),
    roundDurationSeconds: z.number().int().min(60).max(3600).optional(),
    lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    transitionDurationSeconds: z.number().int().min(10).max(120).optional(),
    ratingWindowSeconds: z.number().int().min(10).max(120).optional(),
    closingLobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    noShowTimeoutSeconds: z.number().int().min(15).max(300).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
  }).optional(),
});

// ─── POST /pods/:podId/sessions ─────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  validate(createSessionSchema),
  auditMiddleware('create_session', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await sessionService.createSession(req.user!.userId, req.body, req.user!.role);

      // Auto-register the host as a participant
      try {
        await sessionService.registerParticipant(session.id, req.user!.userId);
      } catch { /* ignore if already registered */ }

      const response: ApiResponse = { success: true, data: session };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id ──────────────────────────────────────────────────────

router.get(
  '/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await sessionService.getSessionById(req.params.id);
      const participantCount = await sessionService.getParticipantCount(req.params.id);

      const response: ApiResponse = {
        success: true,
        data: { ...session, participantCount },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /sessions/:id ─────────────────────────────────────────────────────

router.put(
  '/:id',
  authenticate,
  validate(updateSessionSchema),
  auditMiddleware('update_session', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await sessionService.updateSession(req.params.id, req.user!.userId, req.body, req.user!.role);
      const response: ApiResponse = { success: true, data: session };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /sessions/:id ───────────────────────────────────────────────────

router.delete(
  '/:id',
  authenticate,
  auditMiddleware('delete_session', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await sessionService.deleteSession(req.params.id, req.user!.userId, req.user!.role);
      const response: ApiResponse = { success: true, data: { message: 'Event deleted' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions (by pod) ─────────────────────────────────────────────────

router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { podId, status, page, pageSize } = req.query as Record<string, string>;

      // Non-admin users: if podId specified, verify membership; otherwise show all sessions
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN) && podId) {
        const memberRole = await podService.getMemberRole(podId, req.user!.userId);
        if (!memberRole) {
          throw new ForbiddenError('You do not have access to this pod');
        }
      }

      const isAdmin = hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      const result = await sessionService.listSessions({
        podId,
        userId: podId ? undefined : req.user!.userId,
        isAdmin: isAdmin && !podId,
        status: status as SessionStatus | undefined,
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
      });

      const pg = parseInt(page || '1');
      const ps = Math.min(parseInt(pageSize || '20'), 100);
      const totalPages = Math.ceil(result.total / ps);

      const response: ApiResponse = {
        success: true,
        data: result.sessions,
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

// ─── POST /sessions/:id/register ────────────────────────────────────────────

router.post(
  '/:id/register',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const participant = await sessionService.registerParticipant(req.params.id, req.user!.userId, req.user!.role);
      const response: ApiResponse = { success: true, data: participant };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /sessions/:id/register ──────────────────────────────────────────

router.delete(
  '/:id/register',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await sessionService.unregisterParticipant(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: { message: 'Unregistered successfully' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/participants ─────────────────────────────────────────

router.get(
  '/:id/participants',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Access control: only participants, the host, pod members, or admins can view the list
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const session = await sessionService.getSessionById(req.params.id);
        const isHost = session.hostUserId === req.user!.userId;
        const isParticipant = await sessionService.isSessionParticipant(req.params.id, req.user!.userId);
        const isPodMember = session.podId
          ? !!(await podService.getMemberRole(session.podId, req.user!.userId))
          : false;
        if (!isHost && !isParticipant && !isPodMember) {
          throw new ForbiddenError('You must be a participant or pod member to view this list');
        }
      }
      const participants = await sessionService.getSessionParticipants(req.params.id);
      const response: ApiResponse = { success: true, data: participants };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);
// ─── GET /sessions/:id/participant-counts ─────────────────────────────────────

router.get(
  '/:id/participant-counts',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Only host, pod members, or admins
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const session = await sessionService.getSessionById(req.params.id);
        const isHost = session.hostUserId === req.user!.userId;
        const isPodMember = session.podId
          ? !!(await podService.getMemberRole(session.podId, req.user!.userId))
          : false;
        if (!isHost && !isPodMember) {
          throw new ForbiddenError('You must be the host or a pod member to view participant counts');
        }
      }
      const counts = await sessionService.getParticipantStatusCounts(req.params.id);
      const response: ApiResponse = { success: true, data: counts };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/token (LiveKit access token) ─────────────────────────

router.post(
  '/:id/token',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const roomId = req.body?.roomId;
      const result = await sessionService.generateLiveKitToken(req.params.id, req.user!.userId, roomId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /sessions/:id/permanent (super_admin only) ────────────────────

router.delete(
  '/:id/permanent',
  authenticate,
  requireRole(UserRole.SUPER_ADMIN),
  auditMiddleware('hard_delete_session', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await sessionService.hardDeleteSession(req.params.id);
      const response: ApiResponse = { success: true, data: { message: 'Event permanently deleted' } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);
// ─── Premium Selections ───────────────────────────────────────────────────────

const MAX_PREMIUM_SELECTIONS = 12;

// GET /sessions/:id/preferred-people
router.get(
  '/:id/preferred-people',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await sessionService.getPremiumSelections(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /sessions/:id/preferred-people
router.post(
  '/:id/preferred-people',
  authenticate,
  validate(z.object({
    selectedUserIds: z.array(z.string().uuid()).min(1).max(MAX_PREMIUM_SELECTIONS),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await sessionService.setPremiumSelections(req.params.id, req.user!.userId, req.body.selectedUserIds);
      const response: ApiResponse = { success: true, data: { message: 'Preferred people saved' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/feedback ──────────────────────────────────────────────

router.post(
  '/:id/feedback',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== 'string' || feedback.trim().length === 0) {
        res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Feedback text is required' } });
        return;
      }

      await query(
        `INSERT INTO event_feedback (session_id, user_id, feedback)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET feedback = $3, created_at = NOW()`,
        [req.params.id, req.user!.userId, feedback.trim().slice(0, 2000)]
      );

      const response: ApiResponse = { success: true, data: { submitted: true } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/feedback (host only) ──────────────────────────────────

router.get(
  '/:id/feedback',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await sessionService.getSessionById(req.params.id);
      const isHostOrAdmin = session.hostUserId === req.user!.userId || hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      if (!isHostOrAdmin) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the host can view feedback' } });
        return;
      }

      const result = await query<{ userId: string; displayName: string; feedback: string; createdAt: string }>(
        `SELECT ef.user_id AS "userId", u.display_name AS "displayName", ef.feedback, ef.created_at AS "createdAt"
         FROM event_feedback ef
         JOIN users u ON u.id = ef.user_id
         WHERE ef.session_id = $1
         ORDER BY ef.created_at ASC`,
        [req.params.id]
      );

      const response: ApiResponse = { success: true, data: result.rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id/host-recap (full round breakdown for host) ────────────

router.get(
  '/:id/host-recap',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await sessionService.getSessionById(req.params.id);
      const isHostOrAdmin = session.hostUserId === req.user!.userId || hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      if (!isHostOrAdmin) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the host can view the full recap' } });
        return;
      }

      // Get all matches grouped by round
      const matchesResult = await query<any>(
        `SELECT m.id, m.round_number AS "roundNumber", m.room_id AS "roomId", m.status,
                m.participant_a_id AS "participantAId", m.participant_b_id AS "participantBId",
                m.participant_c_id AS "participantCId",
                ua.display_name AS "nameA", ub.display_name AS "nameB", uc.display_name AS "nameC"
         FROM matches m
         JOIN users ua ON ua.id = m.participant_a_id
         JOIN users ub ON ub.id = m.participant_b_id
         LEFT JOIN users uc ON uc.id = m.participant_c_id
         WHERE m.session_id = $1
         ORDER BY m.round_number ASC, m.created_at ASC`,
        [req.params.id]
      );

      // Get all participants with stats
      const participantsResult = await query<any>(
        `SELECT sp.user_id AS "userId", u.display_name AS "displayName", u.email,
                sp.rounds_completed AS "roundsCompleted", sp.status,
                sp.is_no_show AS "isNoShow"
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1
         ORDER BY u.display_name ASC`,
        [req.params.id]
      );

      // Get feedback
      const feedbackResult = await query<any>(
        `SELECT ef.user_id AS "userId", u.display_name AS "displayName", ef.feedback, ef.created_at AS "createdAt"
         FROM event_feedback ef JOIN users u ON u.id = ef.user_id
         WHERE ef.session_id = $1 ORDER BY ef.created_at ASC`,
        [req.params.id]
      );

      // Get rating stats
      const statsResult = await query<any>(
        `SELECT COUNT(*)::int AS "totalRatings",
                COALESCE(AVG(quality_score), 0) AS "avgQuality",
                COUNT(*) FILTER (WHERE meet_again = true)::int AS "meetAgainCount"
         FROM ratings r JOIN matches m ON r.match_id = m.id
         WHERE m.session_id = $1`,
        [req.params.id]
      );

      const response: ApiResponse = {
        success: true,
        data: {
          session: { id: session.id, title: session.title, scheduledAt: session.scheduledAt, status: session.status },
          matches: matchesResult.rows,
          participants: participantsResult.rows,
          feedback: feedbackResult.rows,
          stats: statsResult.rows[0] || { totalRatings: 0, avgQuality: 0, meetAgainCount: 0 },
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
