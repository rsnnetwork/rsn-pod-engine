// ─── Invite Routes ───────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, optionalAuth } from '../middleware/auth';
import { inviteLimiter, inviteBatchLimiter, peopleReadLimiter } from '../middleware/rateLimit';
import { auditMiddleware } from '../middleware/audit';
import * as inviteService from '../services/invite/invite.service';
import * as inviteCandidates from '../services/invite/invite-candidates.service';
import { fanoutPodEntities, fanoutSessionEntities } from '../realtime/fanout';
import { emitEntities, getRealtimeIo } from '../realtime/emit';
import { E } from '../realtime/entities';
import { query } from '../db';
import { ApiResponse, InviteType, InviteStatus, InviteBatchResponse, eventDurationMinutes, resolveEventFormat } from '@rsn/shared';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createInviteSchema = z.object({
  type: z.nativeEnum(InviteType),
  inviteeEmail: z.string().email().optional(),
  inviteeUserId: z.string().uuid().optional(),
  podId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  circleId: z.string().uuid().optional(),
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
  expiresInHours: z.number().positive().max(720).optional(), // max 30 days
});

// Postgres reads an upper-case uuid as the same id, but the services compare ids as plain strings, so ids are
// lower-cased here (as in routes/people.ts).
const lowerUuid = z.string().uuid().transform((s) => s.toLowerCase());

// The connections picker's list, a page at a time: 30 people unless fewer are asked for, never more than 50.
// `before` is the nextBefore of the page already shown, an ISO time.
const CANDIDATES_PAGE = 30;
const CANDIDATES_PAGE_MAX = 50;
const candidatesQuery = z.object({
  podId: lowerUuid.optional(),
  sessionId: lowerUuid.optional(),
  source: z.enum(['connections', 'pod']).default('connections'),
  q: z.string().trim().max(100).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).optional()
    .transform((n) => Math.min(n ?? CANDIDATES_PAGE, CANDIDATES_PAGE_MAX)),
}).superRefine((value, ctx) => {
  if (Boolean(value.podId) === Boolean(value.sessionId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['podId'], message: 'Name either podId or sessionId' });
  }
  if (value.source === 'pod' && !value.sessionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'The pod list is for inviting to an event' });
  }
});
type CandidatesQuery = z.infer<typeof candidatesQuery>;

// Up to 50 people in one call. "Everyone in the pod" (events only) may stand in for naming them.
const batchInviteSchema = z.object({
  type: z.enum(['pod', 'session']),
  podId: lowerUuid.optional(),
  sessionId: lowerUuid.optional(),
  inviteeUserIds: z.array(lowerUuid).max(inviteCandidates.BATCH_MAX).default([]),
  allPodMembers: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.type === 'pod' && !value.podId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['podId'], message: 'Choose the pod to invite to' });
  }
  if (value.type === 'session' && !value.sessionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessionId'], message: 'Choose the event to invite to' });
  }
  if (value.allPodMembers && value.type !== 'session') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allPodMembers'], message: 'Everyone in the pod is for inviting to an event' });
  }
  if (value.inviteeUserIds.length === 0 && !value.allPodMembers) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeUserIds'], message: 'Choose at least one person to invite' });
  }
});
type BatchInviteBody = z.infer<typeof batchInviteSchema>;

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
      // Bug 30 (19 May Ali) — every invite mutation fans out so each
      // surface that reads pod or session lists ("Pending Invites" count,
      // pod page, sessions list) repaints without a refresh. Pre-fix the
      // sender's own dashboard didn't update after they hit "Send".
      if (invite.podId) {
        fanoutPodEntities(invite.podId).catch(() => {});
      }
      if (invite.sessionId) {
        fanoutSessionEntities(invite.podId ?? null, invite.sessionId, [E.sessionInvites(invite.sessionId)]).catch(() => {});
      }
      const response: ApiResponse = { success: true, data: invite };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /invites/batch ────────────────────────────────────────────────────
// 26 Oct 2026: up to 50 people in one call, one outcome each, the same person never invited twice (the service
// takes the lock). Registered with the fixed paths, ahead of every /:code route. The pod's or the event's screens
// are told once for the whole batch, not once per invitee; each invitee's own bell is pushed by the service.

router.post(
  '/batch',
  authenticate,
  inviteBatchLimiter,
  validate(batchInviteSchema),
  auditMiddleware('create_invite_batch', 'invite'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: BatchInviteBody = req.body;
      const batch = await inviteCandidates.createInvitesBatch({ userId: req.user!.userId, role: req.user!.role }, body);
      if (batch.counts.invited > 0) {
        const { podId, sessionId } = batch.target;
        if (sessionId) {
          fanoutSessionEntities(podId, sessionId, [E.sessionInvites(sessionId)]).catch(() => {});
        } else {
          fanoutPodEntities(podId).catch(() => {});
        }
      }
      const data: InviteBatchResponse = { results: batch.results, counts: batch.counts };
      if (batch.remaining !== undefined) data.remaining = batch.remaining;
      res.json({ success: true, data } as ApiResponse);
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

// ─── GET /invites/candidates ────────────────────────────────────────────────
// 26 Oct 2026: the people an organiser can invite to a pod or an event, with where each stands against it (member,
// going, invited, declined, or available). `source=connections` is the asker's own connections, `source=pod` the
// people in the event's pod. 403 unless the asker may send an invite there. Registered ahead of GET /:code, or
// "candidates" would be read as an invite code. A read: it emits nothing.

router.get(
  '/candidates',
  authenticate,
  peopleReadLimiter,
  validate(candidatesQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // validate() has replaced req.query with the parsed value; Express still types it as raw strings.
      const asked: CandidatesQuery = req.query as unknown as CandidatesQuery;
      const data = await inviteCandidates.listInviteCandidates(
        { userId: req.user!.userId, role: req.user!.role },
        {
          podId: asked.podId,
          sessionId: asked.sessionId,
          source: asked.source,
          q: asked.q,
          before: asked.before ?? null,
          limit: asked.limit,
        },
      );
      res.json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
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

      // Only the host, a co-host or an admin can view session invites (26 Oct 2026: co-hosts send them now, so
      // they see who has answered)
      const sessionResult = await query<{ host_user_id: string }>(
        `SELECT host_user_id FROM sessions WHERE id = $1`, [sessionId]
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
      }
      const isHost = sessionResult.rows[0].host_user_id === req.user!.userId;
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';
      let isCohost = false;
      if (!isHost && !isAdmin) {
        const cohost = await query(
          `SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
          [sessionId, req.user!.userId]
        );
        isCohost = cohost.rows.length > 0;
      }
      if (!isHost && !isAdmin && !isCohost) {
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host or a co-host can view session invites' } });
      }

      const invites = await inviteService.listSessionInvites(sessionId, status);
      const response: ApiResponse = { success: true, data: invites };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── GET /invites/pod/:podId ──────────────────────────────────────────────────

router.get(
  '/pod/:podId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { podId } = req.params;
      const status = req.query.status as string | undefined;

      // Only pod director/host or admin can view pod invites
      const memberResult = await query<{ role: string }>(
        `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
        [podId, req.user!.userId]
      );
      const memberRole = memberResult.rows[0]?.role;
      const isDirectorOrHost = memberRole === 'director' || memberRole === 'host';
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';
      if (!isDirectorOrHost && !isAdmin) {
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only pod directors can view pod invites' } });
      }

      const invites = await inviteService.listPodInvites(podId, status);
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
      const invite = await query<{ id: string; invitee_email: string; session_id: string; pod_id: string; status: string; code: string }>(
        `SELECT id, invitee_email, session_id, pod_id, status, code FROM invites WHERE id = $1`, [req.params.id]
      );
      if (invite.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'INVITE_NOT_FOUND', message: 'Invite not found' } });
      }
      const inv = invite.rows[0];
      if (inv.status !== 'pending') {
        return res.status(400).json({ success: false, error: { code: 'INVITE_NOT_PENDING', message: 'Invite is no longer pending' } });
      }

      // Only host/director/admin can remind
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';
      if (inv.session_id) {
        const sessionResult = await query<{ host_user_id: string }>(
          `SELECT host_user_id FROM sessions WHERE id = $1`, [inv.session_id]
        );
        const isHost = sessionResult.rows[0]?.host_user_id === req.user!.userId;
        if (!isHost && !isAdmin) {
          return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host can send reminders' } });
        }
      } else if (inv.pod_id) {
        const podMemberResult = await query<{ role: string }>(
          `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`, [inv.pod_id, req.user!.userId]
        );
        const isDirector = podMemberResult.rows[0]?.role === 'director' || podMemberResult.rows[0]?.role === 'host';
        if (!isDirector && !isAdmin) {
          return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only pod directors can send reminders' } });
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
          const sr = await query<{ title: string; scheduled_at: string | null; host_user_id: string; config: any; event_format?: string | null }>(
            `SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions WHERE id = $1`, [inv.session_id]
          );
          const session = sr.rows[0];
          targetName = session?.title;

          if (session?.scheduled_at) {
            // 26 Oct 2026 — the same length as the first invite: the shared eventDurationMinutes.
            const totalMinutes = eventDurationMinutes(resolveEventFormat({ format: session.event_format, config: session.config }), session.config);
            const hostResult = await query<{ display_name: string; email: string }>(
              'SELECT display_name, email FROM users WHERE id = $1', [session.host_user_id]
            );
            const host = hostResult.rows[0];
            calendarEvent = {
              title: session.title,
              description: `REASON event — ${session.title}`,
              startTime: new Date(session.scheduled_at),
              durationMinutes: totalMinutes,
              organizerName: host?.display_name || 'REASON',
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

// ─── POST /invites/remind-all/:sessionId ─────────────────────────────────────
// Bulk remind: resend invite emails to ALL pending invites for a session

router.post(
  '/remind-all/:sessionId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Only host/admin can bulk remind
      const sessionResult = await query<{ host_user_id: string; title: string; scheduled_at: string | null; config: any; event_format?: string | null }>(
        `SELECT host_user_id, title, scheduled_at, config, event_format FROM sessions WHERE id = $1`, [sessionId]
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
      }
      const session = sessionResult.rows[0];
      const isHost = session.host_user_id === req.user!.userId;
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';
      if (!isHost && !isAdmin) {
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host can send reminders' } });
      }

      // Get all pending invites for this session (only those with an email to send to)
      const pendingInvites = await query<{ id: string; invitee_email: string; code: string }>(
        `SELECT id, invitee_email, code FROM invites
         WHERE session_id = $1 AND status = 'pending' AND invitee_email IS NOT NULL AND invitee_email != ''`,
        [sessionId]
      );

      if (pendingInvites.rows.length === 0) {
        return res.json({ success: true, data: { reminded: 0 } });
      }

      // Build calendar event context
      const inviterResult = await query<{ displayName: string }>(
        `SELECT display_name AS "displayName" FROM users WHERE id = $1`, [req.user!.userId]
      );
      const inviterName = inviterResult.rows[0]?.displayName || 'Someone';

      let calendarEvent: any = undefined;
      if (session.scheduled_at) {
        // 26 Oct 2026 — the same length as the first invite: the shared eventDurationMinutes.
        const totalMinutes = eventDurationMinutes(resolveEventFormat({ format: session.event_format, config: session.config }), session.config);
        const hostResult = await query<{ display_name: string; email: string }>(
          'SELECT display_name, email FROM users WHERE id = $1', [session.host_user_id]
        );
        const host = hostResult.rows[0];
        calendarEvent = {
          title: session.title,
          description: `REASON event — ${session.title}`,
          startTime: new Date(session.scheduled_at),
          durationMinutes: totalMinutes,
          organizerName: host?.display_name || 'REASON',
          organizerEmail: host?.email,
          sessionId,
        };
      }

      // Send reminders in parallel (batched)
      const { default: appConfig } = await import('../config');
      const emailService = await import('../services/email/email.service');
      let sentCount = 0;
      const BATCH = 10;
      for (let i = 0; i < pendingInvites.rows.length; i += BATCH) {
        const batch = pendingInvites.rows.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(inv =>
            emailService.sendInviteEmail(inv.invitee_email, {
              inviterName,
              type: 'session',
              targetName: session.title,
              inviteUrl: `${appConfig.clientUrl}/invite/${inv.code}`,
              calendarEvent,
            })
          )
        );
        sentCount += results.filter(r => r.status === 'fulfilled').length;
      }

      return res.json({ success: true, data: { reminded: sentCount, total: pendingInvites.rows.length } });
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

      // 13 Aug 2026 (C3): a circle invite names the circle to a stranger.
      //
      // 22 Sep 2026: and went on naming it after it was archived. This route is
      // optionalAuth, so anyone holding an old invite code could read the name
      // and description of a circle that had been taken down — every other read
      // of circles filters archived_at, this one did not.
      let circleName: string | undefined;
      let circleDescription: string | undefined;
      if (invite.circleId) {
        const circleResult = await query<{ name: string; description: string | null }>(
          `SELECT name, description FROM circles WHERE id = $1 AND archived_at IS NULL`,
          [invite.circleId]
        );
        circleName = circleResult.rows[0]?.name;
        circleDescription = circleResult.rows[0]?.description ?? undefined;
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

      const context = { inviterName, podName, podDescription, sessionTitle, sessionScheduledAt, sessionDescription, sessionStatus, circleName, circleDescription };

      // Non-authenticated users see limited invite fields but full context
      const data = req.user
        ? { ...invite, ...context }
        : {
            code: invite.code,
            type: invite.type,
            status: invite.status,
            podId: invite.podId,
            sessionId: invite.sessionId,
            circleId: invite.circleId,
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
      // T0-4 — acceptInvite now returns { invite, redirectTo, registeredFor }
      // so the client can navigate definitively without guessing.
      // T1-1 — pass req.user.email so the service can enforce the
      // identity-match guard (rejects if invite.invitee_email is set and
      // doesn't match this user's authenticated email).
      const result = await inviteService.acceptInvite(
        req.params.code,
        req.user!.userId,
        req.user!.email,
      );
      // Bug 29 (19 May Ali) — pod/session-list realtime fanout was missing
      // on the invite-accept path. Sister mutations in routes/pods.ts
      // (add/remove/role-change/approve/reject) already fan out, but
      // invites had no wiring of its own — Waseem's pod page kept showing
      // "Pending Invite" for Raja even after Raja accepted. Fan out the
      // entity tags here so accepting feels live for every member, not
      // just the accepter. The accepter's userPods / userSessions entities
      // ensure their own "My Pods" / "My Events" list flips too.
      if (result.registeredFor?.podId) {
        fanoutPodEntities(result.registeredFor.podId, [E.userPods(req.user!.userId)]).catch(() => {});
      }
      if (result.registeredFor?.sessionId) {
        // R2-audit (20 May 2026 — live-test post-mortem). Also fanout
        // E.sessionParticipants so every other client viewing the session's
        // participants list invalidates and refetches. Pre-fix only
        // E.userSessions fired, which updated the accepter's own session
        // list but left other viewers stuck on a stale 3-person list until
        // F5 — same root pattern as the POST /register fix in commit
        // f3e59a8.
        fanoutSessionEntities(
          result.registeredFor.podId ?? null,
          result.registeredFor.sessionId,
          [
            E.userSessions(req.user!.userId),
            E.sessionParticipants(result.registeredFor.sessionId),
          ],
        ).catch(() => {});
      }
      // Cover the accepter even if they're not yet in the active-member
      // SELECT on a slow replica — invite list shrinks and they pick up
      // the pod/session entity.
      emitEntities(
        getRealtimeIo(),
        [req.user!.userId],
        [
          E.userInvites(req.user!.userId),
          ...(result.registeredFor?.podId ? [E.pod(result.registeredFor.podId), E.userPods(req.user!.userId)] : []),
          ...(result.registeredFor?.sessionId ? [
            E.session(result.registeredFor.sessionId),
            E.userSessions(req.user!.userId),
            E.sessionParticipants(result.registeredFor.sessionId),
          ] : []),
        ],
      ).catch(() => {});
      const response: ApiResponse = {
        success: true,
        data: {
          ...result.invite,
          redirectTo: result.redirectTo,
          registeredFor: result.registeredFor,
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /invites/:code/mark-accepted ───────────────────────────────────────
// Force-mark an invite as accepted for the current user.
// Used when the normal accept flow fails (already used/expired) but the user
// has been registered via a different path. Ensures notifications & dashboard
// reflect the real state.

router.post(
  '/:code/mark-accepted',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inviteResult = await query<{ id: string; status: string; pod_id: string | null; session_id: string | null }>(
        `SELECT id, status, pod_id, session_id FROM invites WHERE code = $1`,
        [req.params.code]
      );
      if (inviteResult.rows.length === 0) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invite not found' } });
        return;
      }
      const row = inviteResult.rows[0];
      // Update invite status to accepted and record accepting user
      await query(
        `UPDATE invites SET status = 'accepted', accepted_by_user_id = $1, accepted_at = COALESCE(accepted_at, NOW()) WHERE id = $2`,
        [req.user!.userId, row.id]
      );
      // Bug 30 (19 May Ali) — same fanout as /accept so the affected
      // pod / session lists repaint everywhere instantly.
      if (row.pod_id) {
        fanoutPodEntities(row.pod_id, [E.userPods(req.user!.userId)]).catch(() => {});
      }
      if (row.session_id) {
        fanoutSessionEntities(row.pod_id, row.session_id, [E.userSessions(req.user!.userId)]).catch(() => {});
      }
      emitEntities(
        getRealtimeIo(),
        [req.user!.userId],
        [E.userInvites(req.user!.userId)],
      ).catch(() => {});
      res.json({ success: true, data: { marked: true } });
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

      const declined = await inviteService.declineInvite(req.params.code, email);
      // Bug 30 (19 May Ali) — fan out so the inviter's "Pending Invites"
      // count drops to zero without a refresh, and any other pod member
      // viewing the pod sees the badge update. The decliner's own
      // userInvites tag flips their notification bell.
      if (declined.podId) {
        fanoutPodEntities(declined.podId).catch(() => {});
      }
      if (declined.sessionId) {
        // 26 Oct 2026: the event's invites tag too, so an organiser's list flips to "declined" without a refresh.
        fanoutSessionEntities(declined.podId, declined.sessionId, [E.sessionInvites(declined.sessionId)]).catch(() => {});
      }
      emitEntities(
        getRealtimeIo(),
        [req.user!.userId],
        [E.userInvites(req.user!.userId)],
      ).catch(() => {});
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
      const revoked = await inviteService.revokeInvite(req.params.id, req.user!.userId);
      // Bug 30 (19 May Ali) — same fanout so the pending-invites surface
      // repaints everywhere on revoke.
      if (revoked.podId) {
        fanoutPodEntities(revoked.podId).catch(() => {});
      }
      if (revoked.sessionId) {
        fanoutSessionEntities(revoked.podId, revoked.sessionId, [E.sessionInvites(revoked.sessionId)]).catch(() => {});
      }
      const response: ApiResponse = { success: true, data: { message: 'Invite revoked' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /invites/bulk — Bulk invite pod members to a session ─────────────

const bulkInviteSchema = z.object({
  sessionId: z.string().uuid(),
  emails: z.array(z.string().email()).min(1).max(500),
});

// Someone who already has a pending invite, is already going, or is already in the pod is skipped, not an error.
// (The route used to look for 'INVITE_EXISTS' and 'CONFLICT', which nothing throws, so every duplicate was
// counted as an error: audit 03, defect 7.)
const BULK_SKIP_CODES: ReadonlySet<string> = new Set(['DUPLICATE_INVITE', 'SESSION_ALREADY_REGISTERED', 'POD_MEMBER_EXISTS']);

router.post(
  '/bulk',
  authenticate,
  validate(bulkInviteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId, emails } = req.body;
      const userId = req.user!.userId;
      const results = { sent: 0, skipped: 0, errors: 0 };

      for (const email of emails) {
        try {
          await inviteService.createInvite(userId, {
            type: InviteType.SESSION,
            sessionId,
            inviteeEmail: email,
            maxUses: 1,
          });
          results.sent++;
        } catch (err) {
          // Skip already-invited, already-registered, etc
          if (BULK_SKIP_CODES.has((err as { code?: string }).code ?? '')) {
            results.skipped++;
          } else {
            results.errors++;
          }
        }
      }

      // Bug 30 (19 May Ali) — single fanout per session after the bulk
      // completes. One broadcast covers every pod member's pending-invites
      // list and the session's invite list. Looking up podId once instead
      // of per-row keeps it cheap. Best-effort: silent on failure.
      if (results.sent > 0) {
        try {
          const sess = await query<{ pod_id: string | null }>(
            `SELECT pod_id FROM sessions WHERE id = $1`,
            [sessionId],
          );
          const podId = sess.rows[0]?.pod_id ?? null;
          fanoutSessionEntities(podId, sessionId, [E.sessionInvites(sessionId)]).catch(() => {});
          if (podId) {
            fanoutPodEntities(podId).catch(() => {});
          }
        } catch { /* non-fatal */ }
      }

      const response: ApiResponse = { success: true, data: results };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
