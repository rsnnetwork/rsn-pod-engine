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

      const invites = await inviteService.listReceivedInvites(email, req.user!.userId);
      const response: ApiResponse = { success: true, data: invites };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── GET /invites/session/:sessionId ─────────────────────────────────────────

router.get(
  '/session/:sessionId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const status = req.query.status as string | undefined;

      // Only host or admin can view session invites
      const sessionResult = await query<{ host_user_id: string }>(
        `SELECT host_user_id FROM sessions WHERE id = $1`, [sessionId]
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
      }
      const isHost = sessionResult.rows[0].host_user_id === req.user!.userId;
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';
      if (!isHost && !isAdmin) {
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host can view session invites' } });
      }

      const invites = await inviteService.listSessionInvites(sessionId, status);
      const response: ApiResponse = { success: true, data: invites };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── POST /invites/:id/remind ────────────────────────────────────────────────

router.post(
  '/:id/remind',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await query<{ id: string; invitee_email: string; session_id: string; status: string; code: string }>(
        `SELECT id, invitee_email, session_id, status, code FROM invites WHERE id = $1`, [req.params.id]
      );
      if (invite.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'INVITE_NOT_FOUND', message: 'Invite not found' } });
      }
      const inv = invite.rows[0];
      if (inv.status !== 'pending') {
        return res.status(400).json({ success: false, error: { code: 'INVITE_NOT_PENDING', message: 'Invite is no longer pending' } });
      }

      // Only host/admin of the session can remind
      if (inv.session_id) {
        const sessionResult = await query<{ host_user_id: string }>(
          `SELECT host_user_id FROM sessions WHERE id = $1`, [inv.session_id]
        );
        const isHost = sessionResult.rows[0]?.host_user_id === req.user!.userId;
        const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';
        if (!isHost && !isAdmin) {
          return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host can send reminders' } });
        }
      }

      // Re-send invite email
      if (inv.invitee_email) {
        const { default: config } = await import('../config');
        const emailService = await import('../services/email/email.service');
        const inviterResult = await query<{ displayName: string }>(
          `SELECT display_name AS "displayName" FROM users WHERE id = $1`, [req.user!.userId]
        );
        const inviterName = inviterResult.rows[0]?.displayName || 'Someone';

        let targetName: string | undefined;
        let calendarEvent: any = undefined;
        if (inv.session_id) {
          const sr = await query<{ title: string; scheduled_at: string | null; host_user_id: string; config: any }>(
            `SELECT title, scheduled_at, host_user_id, config FROM sessions WHERE id = $1`, [inv.session_id]
          );
          const session = sr.rows[0];
          targetName = session?.title;

          if (session?.scheduled_at) {
            const cfg = session.config || {};
            const rounds = cfg.numberOfRounds || 5;
            const roundDuration = cfg.roundDurationSeconds || 480;
            const breakDuration = cfg.transitionDurationSeconds || 30;
            const totalMinutes = Math.ceil((rounds * roundDuration + (rounds - 1) * breakDuration) / 60);
            const hostResult = await query<{ display_name: string; email: string }>(
              'SELECT display_name, email FROM users WHERE id = $1', [session.host_user_id]
            );
            const host = hostResult.rows[0];
            calendarEvent = {
              title: session.title,
              description: `RSN Event — ${session.title}`,
              startTime: new Date(session.scheduled_at),
              durationMinutes: totalMinutes,
              organizerName: host?.display_name || 'RSN Host',
              organizerEmail: host?.email,
              sessionId: inv.session_id,
            };
          }
        }

        await emailService.sendInviteEmail(inv.invitee_email, {
          inviterName,
          type: 'session',
          targetName,
          inviteUrl: `${config.clientUrl}/invite/${inv.code}`,
          calendarEvent,
        });
      }

      return res.json({ success: true, data: { reminded: true } });
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
      let sessionStatus: string | undefined;

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
        const sessionResult = await query<{ title: string; scheduledAt: string; description: string; status: string }>(
          `SELECT title, scheduled_at AS "scheduledAt", description, status FROM sessions WHERE id = $1`,
          [invite.sessionId]
        );
        sessionTitle = sessionResult.rows[0]?.title;
        sessionScheduledAt = sessionResult.rows[0]?.scheduledAt;
        sessionDescription = sessionResult.rows[0]?.description;
        sessionStatus = sessionResult.rows[0]?.status;
      }

      const context = { inviterName, podName, podDescription, sessionTitle, sessionScheduledAt, sessionDescription, sessionStatus };

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
