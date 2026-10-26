// ─── Invite Routes ───────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, optionalAuth } from '../middleware/auth';
import { inviteLimiter, inviteBatchLimiter, inviteReminderLimiter, peopleReadLimiter } from '../middleware/rateLimit';
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
      // The emails go out after this answer, two a second at most (see createInvitesBatch). Nothing here waits for them;
      // the promise never rejects, and says so by logging each failure itself.
      batch.delivery.catch(() => {});
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

      // Only the host, a co-host or an admin can view an event's invites (26 Oct 2026: co-hosts send them now, so
      // they see who has answered).
      const sessionResult = await query<{ host_user_id: string }>(
        `SELECT host_user_id FROM sessions WHERE id = $1`, [sessionId]
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Event not found' } });
      }
      const role = await inviteService.eventInviteRole(sessionId, req.user!.userId, inviteService.isAdminRole(req.user!.role));
      if (!role) {
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host or a co-host can view this event\'s invites' } });
      }

      const invites = await inviteService.listSessionInvites(sessionId, status);
      // The host and admins see every address, as they always did. A co-host sees one only on the invites they sent
      // themselves: the platform's member lists carry no emails, so on the rest a label stands in its place.
      const data = role === 'cohost' ? inviteService.hideOthersAddresses(invites, req.user!.userId) : invites;
      const response: ApiResponse = { success: true, data };
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
// 26 Oct 2026 (fix round 2): limited to 60 reminders an hour per member (this route and Remind All share it), and the
// email says what the invite was for.

router.post(
  '/:id/remind',
  authenticate,
  inviteReminderLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await query<{ id: string; invitee_email: string; type: InviteType; session_id: string | null; pod_id: string | null; circle_id: string | null; status: string; code: string; expires_at: string | null; inviter_id: string }>(
        `SELECT id, invitee_email, type, session_id, pod_id, circle_id, status, code, expires_at, inviter_id FROM invites WHERE id = $1`, [req.params.id]
      );
      if (invite.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'INVITE_NOT_FOUND', message: 'Invite not found' } });
      }
      const inv = invite.rows[0];

      // Whoever runs the invite's event (its host, a co-host, an admin) or pod (its director, host, an admin) can
      // remind, whoever sent the invite (fix round 1: a co-host sends event invites, and the host reminds them too).
      // Asked before anything is said about the invite, so someone who may not learns nothing of it.
      const isAdmin = inviteService.isAdminRole(req.user!.role);
      if (inv.session_id) {
        if (!(await inviteService.eventInviteRole(inv.session_id, req.user!.userId, isAdmin))) {
          return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host or a co-host can send reminders' } });
        }
      } else if (inv.pod_id) {
        if (!(await inviteService.mayRunPodInvites(inv.pod_id, req.user!.userId, isAdmin))) {
          return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only pod directors can send reminders' } });
        }
      } else if (inv.inviter_id !== req.user!.userId && !isAdmin) {
        // A platform or circle invite belongs to the person who sent it. (This route used to check nothing for them:
        // anyone signed in who knew the invite's id could have it re-sent.)
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the person who sent an invite can send reminders for it' } });
      }

      if (inv.status !== 'pending') {
        return res.status(400).json({ success: false, error: { code: 'INVITE_NOT_PENDING', message: 'Invite is no longer pending' } });
      }
      // An invite whose expiry has passed keeps the status 'pending', but its link is dead: no reminder for it.
      if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) {
        return res.status(400).json({ success: false, error: { code: 'INVITE_EXPIRED', message: 'This invite has expired' } });
      }
      // A closed account, or anyone blocked either way with the sender, is never emailed: one neutral sentence.
      if (inv.invitee_email && (await inviteService.unreachableAddresses(req.user!.userId, [inv.invitee_email])).size > 0) {
        return res.status(409).json({ success: false, error: { code: 'INVITE_NOT_PERMITTED', message: inviteService.CANNOT_BE_INVITED } });
      }

      // Re-send the invite email, worded like the first one (fix round 2): the very functions that build and send it
      // do it again, so a pod invite is a pod invite with the pod's name, a circle's names the circle, and an event's
      // carries its title and its calendar entry, the length of which is the shared eventDurationMinutes. This used to
      // be written out here, as an event invite whatever the invite was for.
      if (inv.invitee_email) {
        const context = await inviteService.buildInviteContext(req.user!.userId, inv.type, {
          podId: inv.pod_id, sessionId: inv.session_id, circleId: inv.circle_id,
        });
        await inviteService.emailInvite(context, { code: inv.code, inviteeEmail: inv.invitee_email });
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
  inviteReminderLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Only the host, a co-host or an admin can bulk remind (26 Oct 2026: co-hosts send event invites, so they remind them)
      const sessionResult = await query<{ host_user_id: string; title: string; scheduled_at: string | null; config: any; event_format?: string | null }>(
        `SELECT host_user_id, title, scheduled_at, config, event_format FROM sessions WHERE id = $1`, [sessionId]
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Event not found' } });
      }
      const session = sessionResult.rows[0];
      if (!(await inviteService.eventInviteRole(sessionId, req.user!.userId, inviteService.isAdminRole(req.user!.role)))) {
        return res.status(403).json({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Only the host or a co-host can send reminders' } });
      }

      // Get all pending invites for this session (only those with an email to send to). An invite whose expiry has
      // passed keeps the status 'pending' but its link is dead, so nobody is reminded with it.
      const allPending = await query<{ id: string; invitee_email: string; code: string }>(
        `SELECT id, invitee_email, code FROM invites
         WHERE session_id = $1 AND status = 'pending' AND invitee_email IS NOT NULL AND invitee_email != ''
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [sessionId]
      );
      // A closed account, or anyone blocked either way with the sender, is never emailed. They are left out without
      // a word (and not counted), so a block is never revealed.
      const unreachable = await inviteService.unreachableAddresses(req.user!.userId, allPending.rows.map((inv) => inv.invitee_email));
      const pendingInvites = { rows: allPending.rows.filter((inv) => !unreachable.has(inv.invitee_email.toLowerCase())) };

      // Both numbers, always: production's event page toasts "Reminders sent to ${reminded}/${total} pending invites",
      // and without a total it read "0/undefined" (fix round 2).
      if (pendingInvites.rows.length === 0) {
        return res.json({ success: true, data: { reminded: 0, total: 0 } });
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

      // Non-authenticated users see limited invite fields but full context. A signed-in caller sees the whole invite,
      // but its address only if they have a right to it (fix round 2): the invitee, the sender, the event's host or the
      // pod's director or host, and admins read it whole; anyone else reads it masked. The code is all it takes to ask
      // here, so the address was otherwise open to every signed-in member who had one. Production's accept page never
      // shows it, so no one loses anything on screen.
      const data = req.user
        ? {
            ...invite,
            inviteeEmail: await inviteService.inviteeAddressFor(invite, { userId: req.user.userId, email: req.user.email, role: req.user.role }),
            ...context,
          }
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
// Mark an invite as accepted for the current user.
// Was used when the normal accept flow failed (already used/expired) but the user
// had been registered via a different path; the client dropped that recovery in T0-4
// and nothing calls it now. 26 Oct 2026 (fix round 2): it applies the rules accept
// applies (the invite must still be usable, and a personal invite is marked only for
// the person it was sent to) instead of trusting any signed-in caller with any code.

router.post(
  '/:code/mark-accepted',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await inviteService.markInviteAccepted(req.params.code, req.user!.userId, req.user!.email);
      // Bug 30 (19 May Ali) — same fanout as /accept so the affected
      // pod / session lists repaint everywhere instantly.
      if (row.podId) {
        fanoutPodEntities(row.podId, [E.userPods(req.user!.userId)]).catch(() => {});
      }
      if (row.sessionId) {
        fanoutSessionEntities(row.podId, row.sessionId, [E.userSessions(req.user!.userId)]).catch(() => {});
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
      const revoked = await inviteService.revokeInvite(req.params.id, req.user!.userId, req.user!.role);
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
// A person who cannot be invited at all (a closed account, or a block either way) is skipped the same way, with no
// word about why: INVITE_NOT_PERMITTED is the one code createInvite gives for every such case.
const BULK_SKIP_CODES: ReadonlySet<string> = new Set([
  'DUPLICATE_INVITE', 'SESSION_ALREADY_REGISTERED', 'POD_MEMBER_EXISTS', 'INVITE_NOT_PERMITTED',
]);

router.post(
  '/bulk',
  authenticate,
  validate(bulkInviteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId, emails } = req.body;
      const userId = req.user!.userId;
      const results = { sent: 0, skipped: 0, errors: 0 };

      // Someone who declined an invite to this event, and has not accepted one since, is not asked again by "Invite All"
      // (fix round 2, a ruling): they are counted as skipped, which production's page reads as "already invited". One
      // question for the whole list. It is asked only for a caller who may invite here: for anyone else every address is
      // refused by the invite itself, as it always was, so the answer cannot tell who declined. The single Invite for one
      // member (POST /invites) does not ask: the organiser may still ask them again by hand.
      let mayInvite = true;
      try {
        await inviteService.assertMayInviteToSession(sessionId, userId, false);
      } catch {
        mayInvite = false;
      }
      const declined = mayInvite ? await inviteCandidates.declinedAddresses('session', sessionId, emails) : new Set<string>();

      for (const email of emails) {
        if (declined.has(email.toLowerCase())) {
          results.skipped++;
          continue;
        }
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
