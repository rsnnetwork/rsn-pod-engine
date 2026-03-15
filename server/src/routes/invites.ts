// ─── Invite Routes ───────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, optionalAuth } from '../middleware/auth';
import { inviteLimiter } from '../middleware/rateLimit';
import { auditMiddleware } from '../middleware/audit';
import * as inviteService from '../services/invite/invite.service';
import { query } from '../db';
import { ApiResponse, InviteType, InviteStatus } from '@rsn/shared';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createInviteSchema = z.object({
  type: z.nativeEnum(InviteType),
  inviteeEmail: z.string().email().optional(),
  podId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  maxUses: z.number().int().positive().max(1000).optional(),
  expiresInHours: z.number().positive().max(720).optional(), // max 30 days
});

// ─── POST /invites ──────────────────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  inviteLimiter,
  validate(createInviteSchema),
  auditMiddleware('create_invite', 'invite'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await inviteService.createInvite(req.user!.userId, req.body, req.user!.role);
      const response: ApiResponse = { success: true, data: invite };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /invites ───────────────────────────────────────────────────────────

router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, status, page, pageSize } = req.query as Record<string, string>;

      const result = await inviteService.listInvitesByUser(req.user!.userId, {
        type: type as InviteType | undefined,
        status: status as InviteStatus | undefined,
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
      });

      const pg = parseInt(page || '1');
      const ps = Math.min(parseInt(pageSize || '20'), 100);
      const totalPages = Math.ceil(result.total / ps);

      const response: ApiResponse = {
        success: true,
        data: result.invites,
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

// ─── GET /invites/received ──────────────────────────────────────────────────

router.get(
  '/received',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Look up the user's email, then find invites addressed to them
      const userResult = await query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`,
        [req.user!.userId]
      );
      const email = userResult.rows[0]?.email;
      if (!email) {
        const response: ApiResponse = { success: true, data: [] };
        return res.json(response);
      }

      const invites = await inviteService.listReceivedInvites(email);
      const response: ApiResponse = { success: true, data: invites };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── GET /invites/:code ─────────────────────────────────────────────────────

router.get(
  '/:code',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await inviteService.getInviteByCode(req.params.code);

      // Enrich with context: inviter name, pod/session details
      let inviterName: string | undefined;
      let podName: string | undefined;
      let podDescription: string | undefined;
      let sessionTitle: string | undefined;
      let sessionScheduledAt: string | undefined;
      let sessionDescription: string | undefined;

      // Fetch inviter display name
      const inviterResult = await query<{ displayName: string }>(
        `SELECT display_name AS "displayName" FROM users WHERE id = $1`,
        [invite.inviterId]
      );
      inviterName = inviterResult.rows[0]?.displayName || undefined;

      // Fetch pod details
      if (invite.podId) {
        const podResult = await query<{ name: string; description: string }>(
          `SELECT name, description FROM pods WHERE id = $1`,
          [invite.podId]
        );
        podName = podResult.rows[0]?.name;
        podDescription = podResult.rows[0]?.description;
      }

      // Fetch session details
      if (invite.sessionId) {
        const sessionResult = await query<{ title: string; scheduledAt: string; description: string }>(
          `SELECT title, scheduled_at AS "scheduledAt", description FROM sessions WHERE id = $1`,
          [invite.sessionId]
        );
        sessionTitle = sessionResult.rows[0]?.title;
        sessionScheduledAt = sessionResult.rows[0]?.scheduledAt;
        sessionDescription = sessionResult.rows[0]?.description;
      }

      const context = { inviterName, podName, podDescription, sessionTitle, sessionScheduledAt, sessionDescription };

      // Non-authenticated users see limited invite fields but full context
      const data = req.user
        ? { ...invite, ...context }
        : {
            code: invite.code,
            type: invite.type,
            status: invite.status,
            podId: invite.podId,
            sessionId: invite.sessionId,
            expiresAt: invite.expiresAt,
            ...context,
          };

      const response: ApiResponse = { success: true, data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /invites/:code/accept ─────────────────────────────────────────────

router.post(
  '/:code/accept',
  authenticate,
  auditMiddleware('accept_invite', 'invite'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await inviteService.acceptInvite(req.params.code, req.user!.userId);
      const response: ApiResponse = { success: true, data: invite };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /invites/:code/decline ────────────────────────────────────────────

router.post(
  '/:code/decline',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userResult = await query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`,
        [req.user!.userId]
      );
      const email = userResult.rows[0]?.email;
      if (!email) {
        const response: ApiResponse = { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
        return res.status(404).json(response);
      }

      await inviteService.declineInvite(req.params.code, email);
      const response: ApiResponse = { success: true, data: { message: 'Invite declined' } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── DELETE /invites/:id ────────────────────────────────────────────────────

router.delete(
  '/:id',
  authenticate,
  auditMiddleware('revoke_invite', 'invite'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await inviteService.revokeInvite(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: { message: 'Invite revoked' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
