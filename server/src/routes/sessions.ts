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
export default router;
