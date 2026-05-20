// ─── Session Routes ──────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as sessionService from '../services/session/session.service';
import * as podService from '../services/pod/pod.service';
import { fanoutSessionEntities, fanoutUserEntity } from '../realtime/fanout';
import { E } from '../realtime/entities';
import { canViewSession } from '../services/session/session-access';
import { buildSessionStateSnapshot } from '../services/session/session-state-snapshot.service';
import { ApiResponse, SessionStatus, UserRole, hasRoleAtLeast } from '@rsn/shared';
import { ForbiddenError, NotFoundError } from '../middleware/errors';
import { query } from '../db';
import type { Server as SocketServer } from 'socket.io';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createSessionSchema = z.object({
  podId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().nullable(),
  config: z.object({
    eventType: z.string().optional(),
    numberOfRounds: z.number().int().min(1).max(20).optional(),
    roundDurationSeconds: z.number().int().min(60).max(3600).optional(),
    lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    transitionDurationSeconds: z.number().int().min(10).max(120).optional(),
    ratingWindowSeconds: z.number().int().min(10).max(120).optional(),
    closingLobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    noShowTimeoutSeconds: z.number().int().min(15).max(300).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
    timerVisibility: z.string().optional(),
    matchingTemplateId: z.string().optional(),
  }).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
  config: z.object({
    eventType: z.string().optional(),
    numberOfRounds: z.number().int().min(1).max(20).optional(),
    roundDurationSeconds: z.number().int().min(60).max(3600).optional(),
    lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    transitionDurationSeconds: z.number().int().min(10).max(120).optional(),
    ratingWindowSeconds: z.number().int().min(10).max(120).optional(),
    closingLobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    noShowTimeoutSeconds: z.number().int().min(15).max(300).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
    timerVisibility: z.string().optional(),
    matchingTemplateId: z.string().optional(),
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

      // Bug 20 (18 May Stefan) — broadcast so every pod member's events
      // list refetches and sees the new session immediately (no refresh
      // needed). Phase 5 — entity tags carry it via fanoutSessionEntities.
      fanoutSessionEntities(session.podId ?? null, session.id).catch(() => {});

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
      const canView = await canViewSession(req.user!.userId, req.params.id, req.user!.role);
      if (!canView) {
        throw new ForbiddenError('You must be registered or a pod member to view this event.');
      }

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

// ─── GET /sessions/:id/state ───────────────────────────────────────────────
//
// T0-3 — Authoritative session-state snapshot. Clients call this on mount,
// on socket reconnect, and as a 30-s drift-detection fallback. Replaces the
// "broadcast-only" model where late joiners or reconnecters silently miss
// state transitions and need to refresh the page.
//
// Response shape lives in `session-state-snapshot.service.ts` and is shared
// with the existing `socket.emit('session:state', ...)` path so the two
// can never drift apart.
//
// Access is gated by canViewSession (admin/host/participant/pod-member).

router.get(
  '/:id/state',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const canView = await canViewSession(req.user!.userId, req.params.id, req.user!.role);
      if (!canView) {
        throw new ForbiddenError('You must be registered or a pod member to view this event.');
      }

      const io = req.app.get('io') as SocketServer | null;
      const snapshot = await buildSessionStateSnapshot(req.params.id, io);
      if (!snapshot) {
        throw new NotFoundError('Session not found');
      }

      const response: ApiResponse = { success: true, data: snapshot };
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
      // Bug 30 (19 May Ali) — fan out so every member's session list
      // shows the updated title/time/status instantly.
      fanoutSessionEntities(session.podId ?? null, session.id).catch(() => {});
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
      // Bug 30 (19 May Ali) — fetch pod_id BEFORE deletion so we can fan
      // out the right pod scope after. deleteSession itself is allowed to
      // proceed even if this lookup fails (best-effort).
      let podIdForNotify: string | null = null;
      try {
        const sessRow = await query<{ pod_id: string | null }>(
          `SELECT pod_id FROM sessions WHERE id = $1`,
          [req.params.id],
        );
        podIdForNotify = sessRow.rows[0]?.pod_id ?? null;
      } catch { /* non-fatal */ }

      await sessionService.deleteSession(req.params.id, req.user!.userId, req.user!.role);

      fanoutSessionEntities(podIdForNotify, req.params.id).catch(() => {});

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
      // Phase May-19 realtime — broadcast so every pod member +
      // registered participant sees the new self-registration without
      // a refresh (badge counts, "Registered" pill on the event card).
      //
      // Phase R2 (20 May 2026) — also fanout E.sessionParticipants so
      // every other client viewing this session's participants list
      // invalidates and refetches. Pre-fix, a tester who registered
      // while another user already had the event open saw stale-3
      // counts until F5; canonical entity-tag emit-miss.
      try {
        const sessRow = await query<{ pod_id: string | null }>(
          `SELECT pod_id FROM sessions WHERE id = $1`,
          [req.params.id],
        );
        const podId = sessRow.rows[0]?.pod_id ?? null;
        fanoutSessionEntities(podId, req.params.id, [
          E.userSessions(req.user!.userId),
          E.sessionParticipants(req.params.id),
        ]).catch(() => {});
      } catch { /* non-fatal */ }
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
      // Phase May-19 realtime — look up podId BEFORE unregister so
      // the fanout still resolves the right pod scope (unregister
      // itself updates session_participants.status='left' which the
      // notifier query excludes, so this is just to capture pod_id).
      let podIdForNotify: string | null = null;
      try {
        const sessRow = await query<{ pod_id: string | null }>(
          `SELECT pod_id FROM sessions WHERE id = $1`,
          [req.params.id],
        );
        podIdForNotify = sessRow.rows[0]?.pod_id ?? null;
      } catch { /* non-fatal */ }

      await sessionService.unregisterParticipant(req.params.id, req.user!.userId);
      // Phase R2 (20 May 2026) — also fanout E.sessionParticipants so
      // other clients viewing this session's participants list see the
      // user disappear without F5.
      fanoutSessionEntities(podIdForNotify, req.params.id, [
        E.userSessions(req.user!.userId),
        E.sessionParticipants(req.params.id),
      ]).catch(() => {});
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
      // Phase May-19 realtime — fan out BEFORE the hard delete so the
      // fanout's pod/participant lookup still finds rows. Mirrors
      // the soft DELETE /sessions/:id pattern above.
      let podIdForNotify: string | null = null;
      try {
        const sessRow = await query<{ pod_id: string | null }>(
          `SELECT pod_id FROM sessions WHERE id = $1`,
          [req.params.id],
        );
        podIdForNotify = sessRow.rows[0]?.pod_id ?? null;
      } catch { /* non-fatal */ }
      fanoutSessionEntities(podIdForNotify, req.params.id).catch(() => {});

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
      // Phase May-19 realtime — ping the current user's own room so
      // any other tabs they have open see the updated selections.
      fanoutUserEntity(req.user!.userId).catch(() => {});
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

      // Phase May-19 realtime — fan out so host's "Feedback received"
      // count + recap view updates instantly. Look up pod_id once so
      // fanoutSessionEntities can address the right scope.
      try {
        const sessRow = await query<{ pod_id: string | null }>(
          `SELECT pod_id FROM sessions WHERE id = $1`,
          [req.params.id],
        );
        fanoutSessionEntities(
          sessRow.rows[0]?.pod_id ?? null,
          req.params.id,
        ).catch(() => {});
      } catch { /* non-fatal */ }

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

// ─── GET /sessions/:id/cohosts/check (am I a co-host?) ──────────────────────

router.get(
  '/:id/cohosts/check',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query<any>('SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2', [req.params.id, req.user!.userId]);
      res.json({ success: true, data: { isCohost: result.rows.length > 0 } });
    } catch (err) { next(err); }
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
      // Also allow co-hosts
      let isCohost = false;
      if (!isHostOrAdmin) {
        const cohostCheck = await query<any>('SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2', [req.params.id, req.user!.userId]);
        isCohost = cohostCheck.rows.length > 0;
      }
      if (!isHostOrAdmin && !isCohost) {
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

// ─── GET /sessions/:id/plan — pre-event plan visibility (Phase 3 / 5 May spec) ─
//
// Returns aggregate per-round status for the host UI's plan-visibility strip.
// Host-or-cohost auth (admins / super-admins also allowed). Non-host
// participants get 403 — they don't need to see the future-round arrangement.
//
// Response shape:
//   { rounds: [{ roundNumber, status, pairCount, byeCount, hasFallback }] }
//
// status maps from match.status:
//   'completed' → all matches in this round are status='completed'
//   'active'    → at least one match is status='active'
//   'planned'   → all matches are status='scheduled' (pre-planned, not yet started)
//   'cancelled' → all matches are status='cancelled'
//   'mixed'     → otherwise

router.get(
  '/:id/plan',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params.id;
      const userId = req.user!.userId;
      const userRole = req.user!.role as UserRole;

      const sessionResult = await query<{ host_user_id: string; pod_id: string; config: any }>(
        `SELECT host_user_id, pod_id, config FROM sessions WHERE id = $1`,
        [sessionId],
      );
      if (sessionResult.rows.length === 0) {
        throw new NotFoundError('Session', sessionId);
      }
      const session = sessionResult.rows[0];

      // Host-or-cohost-or-admin only.
      const isAdmin = hasRoleAtLeast(userRole, UserRole.ADMIN);
      const isHost = session.host_user_id === userId;
      let isCohost = false;
      if (!isHost && !isAdmin) {
        // Phase R6 (20 May 2026) — session_cohosts is the canonical cohost
        // source. Pre-fix queried session_participants.role which doesn't
        // exist; the silent catch returned [] so cohosts could never view
        // the event plan they'd been added to.
        const cohostRes = await query<{ user_id: string }>(
          `SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
          [sessionId, userId],
        ).catch(() => ({ rows: [] as { user_id: string }[] }));
        isCohost = cohostRes.rows.length > 0;
      }
      if (!isHost && !isCohost && !isAdmin) {
        throw new ForbiddenError('Only the host or a co-host can view the event plan');
      }

      const config = typeof session.config === 'string' ? JSON.parse(session.config as unknown as string) : session.config;
      const totalRounds: number = config?.numberOfRounds || 5;

      const matchesResult = await query<{
        round_number: number;
        status: string;
        cnt: string;
        fallback_count: string;
      }>(
        `SELECT round_number, status, COUNT(*)::text AS cnt,
                SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END)::text AS fallback_count
         FROM matches
         WHERE session_id = $1
         GROUP BY round_number, status
         ORDER BY round_number`,
        [sessionId],
      );

      // Aggregate per round.
      const byRound = new Map<number, { statuses: Map<string, number>; fallbackCount: number }>();
      for (const row of matchesResult.rows) {
        const r = row.round_number;
        if (!byRound.has(r)) byRound.set(r, { statuses: new Map(), fallbackCount: 0 });
        const entry = byRound.get(r)!;
        entry.statuses.set(row.status, parseInt(row.cnt, 10));
        entry.fallbackCount += parseInt(row.fallback_count || '0', 10);
      }

      // Get bye participants per round (those NOT in any match for that round).
      // A participant is "byed" in round R if they have status NOT IN ('removed','left','no_show')
      // AND no match in round R contains them.
      const byeResult = await query<{ round_number: number; bye_count: string }>(
        `WITH active_participants AS (
           SELECT user_id FROM session_participants
           WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
             AND user_id != $2
         ),
         round_participants AS (
           SELECT m.round_number,
                  unnest(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS user_id
           FROM matches m
           WHERE m.session_id = $1 AND m.status NOT IN ('cancelled')
         )
         SELECT r.round_number,
                (SELECT COUNT(*)::text FROM active_participants ap
                 WHERE NOT EXISTS (
                   SELECT 1 FROM round_participants rp
                   WHERE rp.round_number = r.round_number AND rp.user_id = ap.user_id
                 )) AS bye_count
         FROM (SELECT DISTINCT round_number FROM matches WHERE session_id = $1) r`,
        [sessionId, session.host_user_id],
      );
      const byeByRound = new Map<number, number>();
      for (const row of byeResult.rows) {
        byeByRound.set(row.round_number, parseInt(row.bye_count || '0', 10));
      }

      // Build the response: include every round 1..totalRounds, even if not yet planned.
      const rounds: { roundNumber: number; status: string; pairCount: number; byeCount: number; hasFallback: boolean }[] = [];
      for (let r = 1; r <= totalRounds; r++) {
        const entry = byRound.get(r);
        if (!entry || entry.statuses.size === 0) {
          rounds.push({ roundNumber: r, status: 'unplanned', pairCount: 0, byeCount: 0, hasFallback: false });
          continue;
        }
        // Determine aggregate status. Priority: active > completed > planned > cancelled > mixed.
        let aggregateStatus = 'mixed';
        if (entry.statuses.has('active')) aggregateStatus = 'active';
        else if (entry.statuses.has('completed') && entry.statuses.size === 1) aggregateStatus = 'completed';
        else if (entry.statuses.has('completed')) aggregateStatus = 'completed';
        else if (entry.statuses.has('scheduled') && entry.statuses.size === 1) aggregateStatus = 'planned';
        else if (entry.statuses.has('cancelled') && entry.statuses.size === 1) aggregateStatus = 'cancelled';
        const pairCount = Array.from(entry.statuses.entries())
          .filter(([s]) => s !== 'cancelled')
          .reduce((sum, [, c]) => sum + c, 0);
        rounds.push({
          roundNumber: r,
          status: aggregateStatus,
          pairCount,
          byeCount: byeByRound.get(r) || 0,
          hasFallback: entry.fallbackCount > 0,
        });
      }

      const response: ApiResponse = {
        success: true,
        data: { rounds, totalRounds },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
