// ─── Session Routes ──────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as sessionService from '../services/session/session.service';
import * as podService from '../services/pod/pod.service';
import { withoutEmail } from '../services/user/public-card';
import {
  fanoutSessionEntities, fanoutSessionListEntities, fanoutUserEntity, resolveSessionListAudience,
} from '../realtime/fanout';
import { E } from '../realtime/entities';
import { canViewSession } from '../services/session/session-access';
import {
  canSeeEvent, lineLooksStalled, managesRequests, readEventAccessFacts, summariseEventAccess,
} from '../services/session/event-access';
import { readEventCircle } from '../services/circle/circle-events.service';
import { summariseEventLifecycle } from '../services/session/event-lifecycle.service';
import * as eventRequests from '../services/session/event-requests.service';
import { fanoutEventGroups } from '../services/session/event-groups.service';
import { fanoutMyAnswers } from '../services/session/event-questions.service';
import { eventAnswersSchema } from './event-questions';
import { eventChatReadLimiter, eventRequestLimiter } from '../middleware/rateLimit';
import { buildSessionStateSnapshot } from '../services/session/session-state-snapshot.service';
import { afterPlaceFreed, registerOrWaitlist } from '../services/session/event-waitlist.service';
// 27 May — live main-room presence (heartbeat) to gate the event-plan "not matched" counts.
import { activeSessions } from '../services/orchestration/state/session-state';
import { getCanonicalConnectedSet } from '../services/orchestration/state/canonical-state';
import {
  ApiResponse, SessionStatus, UserRole, hasRoleAtLeast, EventFormat, EVENT_FORMAT_KEYS, resolveEventFormat, liveKindOf,
  EventVisibility, EVENT_VISIBILITY_KEYS, ErrorCodes, GROUP_LIMITS, isGroupKey, canonicalTimeZone,
  type WaitlistedRegistration, type EventAnswers,
} from '@rsn/shared';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors';
import { query } from '../db';
import logger from '../config/logger';
import { sendRegistrationEmail } from '../services/session/registration-email';
import type { Server as SocketServer } from 'socket.io';
import { matchingPresetsLimiter } from '../middleware/rateLimit';
import { listMatchingPresets } from '../services/matching/matching-template-choice';

const router = Router();

const VIEW_REFUSAL = 'You must be registered or a pod member to view this event.';

/**
 * The refusal for someone who may not see an event: 403 with today's words, as production's client reads them.
 * T11 fix round 1: a private event (its own visibility) says so in its code, EVENT_PRIVATE, so the preview can show
 * "This event is private"; the status and the message stay exactly what production's client already shows.
 * Part 2 Task 2 (D1): an id that names no event, and a draft the person does not run, answer the same 404, so nobody
 * can tell a draft from a wrong id.
 */
async function refuseView(sessionId: string): Promise<never> {
  const row = await query<{ visibility: string | null; is_draft: boolean | null }>(
    `SELECT visibility, (publication = 'draft') AS is_draft FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const event = row?.rows?.[0];
  if (!event || event.is_draft === true) throw new NotFoundError('Session', sessionId, "We couldn't find that event.");
  if (event.visibility === 'private') throw new AppError(403, ErrorCodes.EVENT_PRIVATE, VIEW_REFUSAL);
  throw new ForbiddenError(VIEW_REFUSAL);
}

/**
 * Part 2 Task 2, fix round 1: a route that answers about an event (its participants, their counts) answers a draft the
 * person does not run with the 404 an unknown id gets, before its own checks. A published event goes on to the route's
 * own checks exactly as before (one primary-key read more); an id that names nothing goes on to their own 404.
 */
async function refuseHiddenDraft(sessionId: string, userId: string, role: string): Promise<void> {
  if (hasRoleAtLeast(role as UserRole, UserRole.ADMIN)) return;
  const row = await query<{ is_draft: boolean | null }>(
    `SELECT (publication = 'draft') AS is_draft FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (row?.rows?.[0]?.is_draft !== true) return;
  if (await canViewSession(userId, sessionId, role)) return;
  throw new NotFoundError('Session', sessionId, "We couldn't find that event.");
}

/** Whether the event page registers this person on opening it: its audience or an invitee, who may see the event. */
async function registersOnOpening(sessionId: string, userId: string, role: string | undefined): Promise<boolean> {
  const f = await readEventAccessFacts(sessionId, userId);
  // Fix round 2: a kick is terminal. Someone the host removed from the event is never let back to its list through an
  // invite or the event's circle, as nothing else about the event lets them back.
  if (!f || f.participantStatus === 'removed') return false;
  return canSeeEvent(f, role) && (f.inAudience || f.isInvited);
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

// 26 Oct 2026 — the event's format, from the shared definition. Optional: production's old form sends
// config.eventType instead, which the service reads (option O1).
const eventFormatSchema = z.enum(EVENT_FORMAT_KEYS as [EventFormat, ...EventFormat[]]);
// T11 (1 Nov 2026) — who can join. Optional: production's form sends none, and the event follows its pod (NULL).
const eventVisibilitySchema = z.enum(EVENT_VISIBILITY_KEYS as [EventVisibility, ...EventVisibility[]]);

// Part 3 Task 1 (K1): the event's IANA zone, spelled as the runtime spells it. Optional: production's forms send none,
// and the service then takes the host's own zone when it is real, else UTC.
const eventZoneSchema = z.string().transform((zone, ctx) => {
  const canonical = canonicalTimeZone(zone);
  if (!canonical) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: sessionService.EVENT_ZONE_REFUSAL });
    return z.NEVER;
  }
  return canonical;
});

/**
 * A zone that is not a real one is refused before the body's other checks, in the forms' own words: the 400's message
 * is the sentence (the forms show a refusal's message as it is), and the field carries it too.
 */
function refuseUnknownEventZone(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  const zone = body && typeof body === 'object' ? body.timezone : undefined;
  if (zone === undefined || (typeof zone === 'string' && canonicalTimeZone(zone))) {
    next();
    return;
  }
  next(new ValidationError(sessionService.EVENT_ZONE_REFUSAL, { timezone: [sessionService.EVENT_ZONE_REFUSAL] }));
}

export const createSessionSchema = z.object({
  podId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().nullable(),
  format: eventFormatSchema.optional(),
  visibility: eventVisibilitySchema.optional(),
  // T13 (1 Nov 2026) — an event for a whole circle. Optional: production's form sends none, and nothing changes.
  circleId: z.string().uuid().optional(),
  // Part 2 Task 2 — a draft, seen only by the people who run it until it is published, and when registration opens.
  // Optional: production's form sends neither, and the event is published at once, as today.
  publication: z.enum(['draft', 'published']).optional(),
  registrationOpensAt: z.string().datetime().nullable().optional(),
  timezone: eventZoneSchema.optional(),
  config: z.object({
    eventType: z.string().optional(),
    numberOfRounds: z.number().int().min(1).max(20).optional(),
    roundDurationSeconds: z.number().int().min(60).max(3600).optional(),
    lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    transitionDurationSeconds: z.number().int().min(10).max(120).optional(),
    // F5 (21 May Ali) — min raised 10 → 20. 10 s left no headroom for
    // users to read the rating form and submit; live test (21 May)
    // showed users repeatedly missing the form. Ceiling unchanged.
    ratingWindowSeconds: z.number().int().min(20).max(120).optional(),
    closingLobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    noShowTimeoutSeconds: z.number().int().min(15).max(300).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
    timerVisibility: z.string().optional(),
    matchingTemplateId: z.string().optional(),
    // 26 May — without this, zod stripped the host's "Platform-wide no
    // rematch" selection, so sessions silently persisted matchingPolicy=
    // within_event and prior-event pairs were re-matched. Must be listed to
    // survive validation.
    matchingPolicy: z.enum(['platform_wide', 'within_event', 'none', 'cooldown']).optional(),
    // Phase 2 (matching) — months a pair stays un-rematchable under 'cooldown'.
    cooldownMonths: z.coerce.number().int().min(1).max(60).optional(),
    // 26 Oct 2026 — the event forms' own fields: a meeting's length, and the round length in minutes (stored
    // as roundDurationSeconds). Only their shape is checked here: their limits are the shared definition's,
    // checked by the service on every path (old body included), so a refusal reads in the definition's words.
    // Fix round 1: bounded here too (1 to 10,000), so no stored length can overflow a Postgres integer later.
    durationMinutes: z.number().int().min(1).max(10_000).optional(),
    roundMinutes: z.number().finite().optional(),
    // 30 Oct 2026 — where an in-person event happens. Its limit (300 once trimmed) and whether it is required are
    // the shared definition's, checked by the service; this only keeps a body from carrying a book.
    location: z.string().max(2000).optional(),
  }).optional(),
});

export const updateSessionSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
  format: eventFormatSchema.optional(),
  visibility: eventVisibilitySchema.optional(),
  // T13 (1 Nov 2026) — name a circle (one its managers run) or clear it with null. Production's edit form sends none.
  circleId: z.string().uuid().nullable().optional(),
  // Part 3 Task 1 — a new zone; the instant in scheduledAt is kept as sent.
  timezone: eventZoneSchema.optional(),
  config: z.object({
    eventType: z.string().optional(),
    numberOfRounds: z.number().int().min(1).max(20).optional(),
    roundDurationSeconds: z.number().int().min(60).max(3600).optional(),
    lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    transitionDurationSeconds: z.number().int().min(10).max(120).optional(),
    // F5 (21 May Ali) — min raised 10 → 20. 10 s left no headroom for
    // users to read the rating form and submit; live test (21 May)
    // showed users repeatedly missing the form. Ceiling unchanged.
    ratingWindowSeconds: z.number().int().min(20).max(120).optional(),
    closingLobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
    noShowTimeoutSeconds: z.number().int().min(15).max(300).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
    timerVisibility: z.string().optional(),
    matchingTemplateId: z.string().optional(),
    // 26 May — without this, zod stripped the host's "Platform-wide no
    // rematch" selection, so sessions silently persisted matchingPolicy=
    // within_event and prior-event pairs were re-matched. Must be listed to
    // survive validation.
    matchingPolicy: z.enum(['platform_wide', 'within_event', 'none', 'cooldown']).optional(),
    // Phase 2 (matching) — months a pair stays un-rematchable under 'cooldown'.
    cooldownMonths: z.coerce.number().int().min(1).max(60).optional(),
    // 26 Oct 2026 — the event forms' own fields: a meeting's length, and the round length in minutes (stored
    // as roundDurationSeconds). Only their shape is checked here: their limits are the shared definition's,
    // checked by the service on every path (old body included), so a refusal reads in the definition's words.
    // Fix round 1: bounded here too (1 to 10,000), so no stored length can overflow a Postgres integer later.
    durationMinutes: z.number().int().min(1).max(10_000).optional(),
    roundMinutes: z.number().finite().optional(),
    // 30 Oct 2026 — where an in-person event happens. Its limit (300 once trimmed) and whether it is required are
    // the shared definition's, checked by the service; this only keeps a body from carrying a book.
    location: z.string().max(2000).optional(),
  }).optional(),
});

// ─── POST /pods/:podId/sessions ─────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  refuseUnknownEventZone,
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
      // 8 Oct 2026 — and the member's own lists (Home, Sessions, the For You
      // next-event panel), which listen on user tags this fanout does not carry.
      fanoutSessionListEntities(session.podId ?? null, session.id).catch(() => {});

      const response: ApiResponse = { success: true, data: session };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/matching-presets ─────────────────────────────────────────
// 30 Oct 2026 — who should meet whom: the presets any organiser may choose for a speed-networking event,
// { id, name, description }. Declared before /:id, which would read "matching-presets" as an event id.

router.get(
  '/matching-presets',
  authenticate,
  matchingPresetsLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const response: ApiResponse = { success: true, data: await listMatchingPresets() };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions/:id ──────────────────────────────────────────────────────
// A malformed id is a 400 in a member's words, not a Postgres 500 (26 Oct 2026).

router.get(
  '/:id',
  authenticate,
  uuidInPath('id', PATH_REFUSALS.event),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Part 3 Task 3 (controller ruling): the event page, which someone on its waiting list may open (to see their place
      // and leave the line); the live state and the attendee list stay closed to them.
      const canView = await canViewSession(req.user!.userId, req.params.id, req.user!.role, { eventPage: true });
      if (!canView) await refuseView(req.params.id);

      const session = await sessionService.getSessionById(req.params.id);
      const participantCount = await sessionService.getParticipantCount(req.params.id);
      // T11 (1 Nov 2026) — additive: what this viewer can do (Register, Request to join, or the private notice),
      // so the event page stops guessing from the pod.
      const facts = await readEventAccessFacts(req.params.id, req.user!.userId);
      const access = facts ? summariseEventAccess(facts, req.user!.role) : undefined;
      // Part 3 Task 3, fix round 1 (review I-1): people waiting while a place is free: the line is moved on (background).
      if (facts && lineLooksStalled(facts)) sessionService.lineStalled(req.params.id);
      // T13 (1 Nov 2026) — additive: the circle the event is for, so its page says "For <circle>" with a link.
      const circle = await readEventCircle(session?.circleId);
      // Part 2 Task 2 — additive: where the event stands (draft … cancelled) and the steps this viewer may take.
      const { lifecycle, allowedActions } = summariseEventLifecycle(session, facts, req.user!.role);

      const response: ApiResponse = {
        success: true,
        data: {
          ...session, participantCount, ...(access ? { access } : {}), ...(circle ? { circle } : {}),
          lifecycle, allowedActions,
        },
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
      if (!canView) await refuseView(req.params.id);

      const io = req.app.get('io') as SocketServer | null;
      const snapshot = await buildSessionStateSnapshot(req.params.id, io);
      if (!snapshot) {
        throw new NotFoundError('Session', req.params.id, "We couldn't find that event.");
      }

      // H1 fix round 1 — hccParticipants is the Host Control Center's list: every registered person's email,
      // platform role, state and join time. Production's client reads it only there (HostControlCenter.tsx, for
      // the host, a co-host or a super admin), so everyone else gets it empty; the rest of the state is theirs.
      // The same rule as the participants list's emails (admins and the event's host / co-hosts).
      const me = req.user!.userId;
      const runsTheEvent = hasRoleAtLeast(req.user!.role, UserRole.ADMIN)
        || snapshot.hostUserId === me || snapshot.cohosts.includes(me);
      const response: ApiResponse = { success: true, data: runsTheEvent ? snapshot : { ...snapshot, hccParticipants: [] } };
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
  refuseUnknownEventZone,
  validate(updateSessionSchema),
  auditMiddleware('update_session', 'session'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await sessionService.updateSession(req.params.id, req.user!.userId, req.body, req.user!.role);
      // Part 3 Task 3: a capacity raised (or a format switch, which sets the format's own) frees places for the waiting
      // list. Promotion reads the event's own count under its lock, so an edit that freed nothing promotes nobody.
      const body = req.body as { config?: { maxParticipants?: unknown }; format?: unknown };
      if (body.config?.maxParticipants !== undefined || body.format !== undefined) void afterPlaceFreed(session.id, 'capacity');
      // Bug 30 (19 May Ali) — fan out so every member's session list
      // shows the updated title/time/status instantly.
      fanoutSessionEntities(session.podId ?? null, session.id).catch(() => {});
      // 8 Oct 2026 — a rescheduled or renamed event reaches the member's own lists too.
      fanoutSessionListEntities(session.podId ?? null, session.id).catch(() => {});
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
      // 8 Oct 2026 — deleting only marks the event cancelled, so its participants
      // are still readable; the member's own lists drop it.
      fanoutSessionListEntities(podIdForNotify, req.params.id).catch(() => {});

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
      const { podId, status, page, pageSize, archived } = req.query as Record<string, string>;

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
        // Part 2 Task 2: who is asking, so a pod's list leaves out other people's drafts; `archived=1` lists the archived
        // events they ran or held a place in instead.
        viewerId: req.user!.userId,
        viewerIsAdmin: isAdmin,
        archived: archived === '1' || archived === 'true',
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

// ─── Requests to join (T11, 1 Nov 2026) ─────────────────────────────────────
// An event that asks the host to approve each place: the person asks, may withdraw, and the event's organisers
// approve or decline. Every write tells the organisers and the requester (session:<id>:join-requests).

const joinRequestSchema = z.object({ message: z.string().trim().max(500).optional() });
const joinRequestListSchema = z.object({ status: z.enum(['pending', 'approved', 'declined', 'withdrawn']).optional() });
const requesterPath = z.object({ userId: z.string().uuid() });

function requesterId(req: Request): string {
  const parsed = requesterPath.safeParse({ userId: req.params.userId });
  if (!parsed.success) throw new ValidationError('That is not a person on REASON.');
  return parsed.data.userId;
}

router.post(
  '/:id/requests',
  authenticate,
  uuidInPath('id', PATH_REFUSALS.event),
  eventRequestLimiter,
  validate(joinRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const message = (req.body.message as string | undefined)?.trim() || null;
      const request = await eventRequests.requestToJoin(req.params.id, req.user!.userId, req.user!.role, message);
      const response: ApiResponse = { success: true, data: request };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:id/requests/mine',
  authenticate,
  uuidInPath('id', PATH_REFUSALS.event),
  eventRequestLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await eventRequests.withdrawRequest(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// The Requests list: any event's can be asked for by id, so it is counted like the event's kept chat, in the same
// per-member allowance (final fix wave SM4, 2 Nov 2026).
router.get(
  '/:id/requests',
  authenticate,
  eventChatReadLimiter,
  uuidInPath('id', PATH_REFUSALS.event),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = joinRequestListSchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError('That is not a request status.');
      const requests = await eventRequests.listRequests(
        req.params.id, req.user!.userId, req.user!.role, parsed.data.status ?? 'pending',
      );
      const response: ApiResponse = { success: true, data: requests };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/requests/:userId/approve',
  authenticate,
  uuidInPath('id', PATH_REFUSALS.event),
  eventRequestLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requesterId(req);
      const outcome = await eventRequests.approveRequest(req.params.id, userId, req.user!.userId, req.user!.role);
      const sessRow = await query<{ pod_id: string | null }>(`SELECT pod_id FROM sessions WHERE id = $1`, [req.params.id]);
      const podId = sessRow.rows[0]?.pod_id ?? null;
      fanoutSessionEntities(podId, req.params.id, [E.userSessions(userId), E.sessionParticipants(req.params.id)]).catch(() => {});
      eventRequests.fanoutJoinRequests(req.params.id, userId, [E.sessionParticipants(req.params.id), E.userSessions(userId)]).catch(() => {});
      if (outcome.isNewRegistration) void sendRegistrationEmail(req.params.id, userId);
      // Part 3 Task 3 (additive): an approval on a full event approves the request and puts the person on the waiting
      // list; the organiser's toast says where ("number N on the waiting list"). null: they were given a place.
      const response: ApiResponse = { success: true, data: { ...outcome.request, waitlistPosition: outcome.waitlistPosition } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/requests/:userId/decline',
  authenticate,
  uuidInPath('id', PATH_REFUSALS.event),
  eventRequestLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requesterId(req);
      const request = await eventRequests.declineRequest(req.params.id, userId, req.user!.userId, req.user!.role);
      const response: ApiResponse = { success: true, data: request };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /sessions/:id/register ────────────────────────────────────────────

// 10 Nov 2026 spec, Part 2 Task 5: an event with matching groups asks which group the person is in; the answer
// may come with the registration as `groupKeys`. Every other field, and no body at all, reads as before.
const registerBodySchema = z.object({
  groupKeys: z.array(z.string().refine(isGroupKey, "That group isn't one of this event's groups.")).max(GROUP_LIMITS.maxGroups).optional(),
  // Part 3 Task 5: answers to the event's extra matching questions, written with the place (or the waiting-list row).
  answers: eventAnswersSchema.optional(),
}).passthrough();
// Part 3 Task 3: `waitlist: true` asks to join the waiting list when the event is full (202). Without it a full event
// answers 409 SESSION_FULL exactly as before (controller ruling: no environment switch; production's client sends no
// such field, so it behaves as today). Read from the same body, which registerBodySchema passes through.
const registerWaitlistSchema = z.object({ waitlist: z.boolean().optional() }).passthrough();

/**
 * The registration's options from its body: the group chosen (Part 2 Task 5) and (Part 3 Task 5) the answers to the
 * event's matching questions, or undefined when it carries neither (exactly as before either existed). Answers given are
 * kept with a place or a waiting-list row alike, and their change is told to the organisers and the person.
 */
function registerOptionsOf(body: z.infer<typeof registerBodySchema>): sessionService.RegisterOptions | undefined {
  const answers: EventAnswers | undefined = body.answers && Object.keys(body.answers).length > 0 ? body.answers : undefined;
  if (!body.groupKeys && !answers) return undefined;
  return { ...(body.groupKeys ? { groupKeys: body.groupKeys } : {}), ...(answers ? { answers } : {}) };
}

/** Part 3 Task 3: the event page's registration with `waitlist: true`: a full event answers the person's place in its line. */
async function registerOrQueueFromEventPage(
  req: Request, options: sessionService.RegisterOptions | undefined,
): Promise<sessionService.RegisterResult | WaitlistedRegistration> {
  const outcome = await registerOrWaitlist(req.params.id, req.user!.userId, req.user!.role, {
    ...(options ?? {}), joinedVia: 'register',
  });
  if (outcome.kind === 'waitlisted') return { waitlisted: true, position: outcome.position };
  return { ...outcome.participant, isNewRegistration: outcome.isNewRegistration };
}

router.post(
  '/:id/register',
  authenticate,
  validate(registerBodySchema.default({})),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = registerOptionsOf(req.body as z.infer<typeof registerBodySchema>);
      const asked = registerWaitlistSchema.safeParse(req.body);
      if (!asked.success) throw new ValidationError('Check what you entered and try again.');
      const participant = asked.data.waitlist === true
        ? await registerOrQueueFromEventPage(req, options)
        : await sessionService.registerParticipant(req.params.id, req.user!.userId, req.user!.role, options);
      if (options?.answers) void fanoutMyAnswers(req.params.id, req.user!.userId);
      if ('waitlisted' in participant) {
        res.status(202).json({ success: true, data: participant } satisfies ApiResponse);
        return;
      }
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
      // Part 2 Task 5: a group chosen with the registration changes the event's group counts.
      if (options?.groupKeys?.length) void fanoutEventGroups(req.params.id);

      // 26 May (Stefan) — self-registration now sends a "you're registered"
      // confirmation with a calendar invite (.ics) attached, mirroring what
      // emailed host-invites already do. Best-effort + fire-and-forget so email
      // latency never delays the 201. Invite-accepts register via a different
      // path (and already got the invite email + calendar), so no double-send.
      //
      // S15 (live-test 2026-06-06) — FRESH registrations only. The live page
      // auto-registers on every mount, so "Join Live Event" / rejoin-after-
      // leaving hit the re-register path and re-sent this email every time.
      if (participant.isNewRegistration) void sendRegistrationEmail(req.params.id, req.user!.userId);

      const response: ApiResponse = { success: true, data: participant };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /sessions/:id/intention ───────────────────────────────────────────
// Phase 2 (matching) — per-event intention captured at check-in. A skippable
// overlay on the permanent profile that feeds the engine's eventIntentionAlignment
// signal; openness tunes serendipity. Best-effort: no-op if not registered yet.
const eventIntentionSchema = z.object({
  intention: z.string().trim().max(60).nullish(),
  openness: z.enum(['very_open', 'somewhat', 'only_relevant']).nullish(),
});

router.post(
  '/:id/intention',
  authenticate,
  validate(eventIntentionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const intention = (req.body.intention ?? '').toString().trim() || null;
      const openness = req.body.openness ?? null;
      const r = await query(
        `UPDATE session_participants
            SET event_intention = $3, openness = $4
          WHERE session_id = $1 AND user_id = $2`,
        [req.params.id, req.user!.userId, intention, openness],
      );
      const response: ApiResponse = { success: true, data: { updated: r.rowCount ?? 0 } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
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
      // Part 3 Task 3: the place is free; the first person on the waiting list is given it (after this answer).
      void afterPlaceFreed(req.params.id, 'unregister');
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
      await refuseHiddenDraft(req.params.id, req.user!.userId, req.user!.role);
      // Access control: only participants, the host, pod members, or admins can view the list
      // Emails are for admins and the event's host / co-hosts only (9 Sep 2026);
      // fellow participants and pod members get the public card.
      let seesEmail = hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      if (!seesEmail) {
        const session = await sessionService.getSessionById(req.params.id);
        const isHost = session.hostUserId === req.user!.userId;
        const isParticipant = await sessionService.isSessionParticipant(req.params.id, req.user!.userId);
        const isPodMember = session.podId
          ? !!(await podService.getMemberRole(session.podId, req.user!.userId))
          : false;
        // T13 fix (1 Nov 2026): the people the event page registers on opening it read it as its pod's members do, because
        // that page registers them only once this list has loaded: the event's audience (for an event for a whole circle,
        // the circle's active members, who are not in the pod) and its invitees (fix round 1), each only while they may
        // see the event. For an event with no circle the audience is exactly the pod's active members. Read only when
        // nothing above allowed.
        const allowedBefore = isHost || isParticipant || isPodMember;
        if (!allowedBefore && !(await registersOnOpening(req.params.id, req.user!.userId, req.user!.role))) {
          throw new ForbiddenError('You must be a participant or pod member to view this list');
        }
        const cohost = isHost ? null : await query(
          `SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
          [req.params.id, req.user!.userId],
        );
        seesEmail = isHost || !!cohost?.rows.length;
      }
      const participants = await sessionService.getSessionParticipants(req.params.id);
      const response: ApiResponse = { success: true, data: seesEmail ? participants : withoutEmail(participants) };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);
// ─── GET /sessions/:id/participant-counts ─────────────────────────────────────

/** Part 3 Task 3: the people waiting on the event's line (active accounts), for its organisers' counts. */
async function countWaiting(sessionId: string): Promise<number> {
  const r = await query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM event_waitlist w JOIN users u ON u.id = w.user_id
      WHERE w.session_id = $1 AND w.status = 'waiting' AND u.status = 'active'`,
    [sessionId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

router.get(
  '/:id/participant-counts',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await refuseHiddenDraft(req.params.id, req.user!.userId, req.user!.role);
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
      // Part 3 Task 3 (additive): how many are waiting, for the people who manage the event's line only (attendees are
      // never told counts, only "full").
      const facts = await readEventAccessFacts(req.params.id, req.user!.userId);
      const data = facts && managesRequests(facts, req.user!.role)
        ? { ...counts, waitlisted: await countWaiting(req.params.id) }
        : counts;
      const response: ApiResponse = { success: true, data };
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

      // 8 Oct 2026 — the member's own lists: read who they are BEFORE the delete
      // (it takes the participants and the host with the event) and tell them
      // AFTER it, so the refetch they trigger cannot still find the event. A read
      // that fails is logged and read again afterwards, and then reaches the pod's
      // members only; it must not stop the delete.
      const listAudience = await resolveSessionListAudience(podIdForNotify, req.params.id).catch((err: unknown) => {
        logger.warn(
          { err, sessionId: req.params.id },
          'Permanent delete: could not read who to tell beforehand, so only the pod will be told (non-fatal)',
        );
        return undefined;
      });
      // Part 2 Task 2: the trail keeps what the event was (event.deleted), written with the deletes.
      await sessionService.hardDeleteSession(req.params.id, { actorId: req.user!.userId });
      fanoutSessionListEntities(podIdForNotify, req.params.id, listAudience).catch(() => {});
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

// ─── POST/DELETE /sessions/:id/cohosts/:userId (S16 — pre-event co-host) ────
//
// Ali (2026-06-06): co-host management must also live on the EVENT DETAIL
// page, not only inside the live page's participant drawer. The socket
// handlers (handleAssignCohost / handleRemoveCohost) stay the in-event path;
// these REST twins serve page surfaces with no session socket. Same rules:
//   - any acting host may manage co-hosts (canActAsHost: director, formal
//     co-host, pod admin / super_admin),
//   - only the DIRECTOR may change a platform admin's co-host status
//     (Bug J / Bug 2 supreme-host carve-out),
//   - assignment requires an actual (non-removed) participant row.
// Side effects mirror the socket path so a live page open pre-start updates
// instantly: cohost:assigned/removed + permissions:updated + roster:changed
// + entity fanout, and a future-rounds repair when the event is running.

async function mutateSessionCohost(
  req: Request,
  res: Response,
  next: NextFunction,
  action: 'assign' | 'remove',
): Promise<void> {
  try {
    const sessionId = req.params.id;
    const targetUserId = req.params.userId;
    const session = await sessionService.getSessionById(sessionId); // 404s

    // S16.1 (Ali) — no co-host changes on a finished event.
    if (session.status === SessionStatus.COMPLETED || session.status === SessionStatus.CANCELLED) {
      res.status(400).json({ success: false, error: { code: 'SESSION_OVER', message: 'This event has ended — co-hosts can no longer be changed' } });
      return;
    }

    const { canActAsHost } = await import('../services/roles/effective-role.service');
    const { allowed } = await canActAsHost(req.user!.userId, req.user!.role, sessionId);
    if (!allowed) {
      throw new ForbiddenError('Only the event host or a co-host can manage co-hosts');
    }

    if (targetUserId === session.hostUserId) {
      res.status(400).json({ success: false, error: { code: 'TARGET_IS_DIRECTOR', message: 'The event director is already the host' } });
      return;
    }

    const targetRes = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [targetUserId]);
    if (targetRes.rows.length === 0) throw new NotFoundError('User', targetUserId);
    const isDirectorCaller = req.user!.userId === session.hostUserId;
    if (hasRoleAtLeast(targetRes.rows[0].role as UserRole, UserRole.ADMIN) && !isDirectorCaller) {
      throw new ForbiddenError("Only the event director can change a platform admin's co-host status");
    }

    if (action === 'assign') {
      const partRes = await query(
        `SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2 AND status != 'removed'`,
        [sessionId, targetUserId],
      );
      if (partRes.rows.length === 0) {
        res.status(400).json({ success: false, error: { code: 'NOT_A_PARTICIPANT', message: 'Co-hosts must be registered participants of this event' } });
        return;
      }
      await query(
        `INSERT INTO session_cohosts (session_id, user_id, role, granted_by)
         VALUES ($1, $2, 'co_host', $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET role = 'co_host'`,
        [sessionId, targetUserId, req.user!.userId],
      );
    } else {
      await query(`DELETE FROM session_cohosts WHERE session_id = $1 AND user_id = $2`, [sessionId, targetUserId]);
    }

    // Socket side effects — same shape the socket handlers emit, so any
    // open live page (even pre-start) flips without a refresh.
    try {
      const { getRealtimeIo } = await import('../realtime/emit');
      const { sessionRoom, userRoom } = await import('../services/orchestration/state/session-state');
      const io = getRealtimeIo();
      if (io) {
        if (action === 'assign') {
          const displayName = (await query<{ display_name: string }>(
            `SELECT display_name FROM users WHERE id = $1`, [targetUserId],
          )).rows[0]?.display_name || 'User';
          io.to(sessionRoom(sessionId)).emit('cohost:assigned', { userId: targetUserId, displayName, role: 'co_host' });
          io.to(userRoom(targetUserId)).emit('permissions:updated', {
            sessionId,
            effectiveRole: 'cohost' as const,
            capabilities: [
              'mute_participants', 'remove_participants', 'reassign',
              'start_round', 'pause', 'resume', 'broadcast', 'create_breakout',
            ],
          });
        } else {
          io.to(sessionRoom(sessionId)).emit('cohost:removed', { userId: targetUserId });
          io.to(userRoom(targetUserId)).emit('permissions:updated', {
            sessionId, effectiveRole: 'participant' as const, capabilities: [],
          });
        }
        io.to(sessionRoom(sessionId)).emit('roster:changed', {
          sessionId, cause: action === 'assign' ? 'cohost_assigned' : 'cohost_removed',
        });
        // Running event: re-shape upcoming rounds (Phase 8A.5 parity) —
        // a promoted co-host must drop out of future matching, a demoted
        // one must re-enter it.
        if (activeSessions.has(sessionId)) {
          const { maybeRepairFutureRounds } = await import('../services/orchestration/handlers/host-actions');
          maybeRepairFutureRounds(io, sessionId).catch((err: unknown) =>
            logger.warn({ err, sessionId }, 'REST cohost change: plan repair failed (non-fatal)'));
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'REST cohost change: socket fanout failed (non-fatal)');
    }
    fanoutSessionEntities(session.podId ?? null, sessionId, [
      E.session(sessionId), E.sessionParticipants(sessionId), E.sessionPlan(sessionId),
    ]).catch(() => {});
    // Part 3 Task 3: a co-host holds no place, so making one frees theirs for the waiting list. Removing a co-host makes
    // them count again and bumps nobody.
    if (action === 'assign') void afterPlaceFreed(sessionId, 'cohost');

    logger.info({ sessionId, targetUserId, action, by: req.user!.userId }, 'Co-host change via REST');
    res.json({ success: true, data: { userId: targetUserId, isCohost: action === 'assign' } });
  } catch (err) {
    next(err);
  }
}

router.post(
  '/:id/cohosts/:userId',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => mutateSessionCohost(req, res, next, 'assign'),
);

router.delete(
  '/:id/cohosts/:userId',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => mutateSessionCohost(req, res, next, 'remove'),
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
                COALESCE(m.is_manual, FALSE) AS "isManual", COALESCE(m.is_override, FALSE) AS "isOverride",
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
                COALESCE(AVG(quality_score) FILTER (WHERE NOT excluded_from_quality_stats), 0) AS "avgQuality",
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

      const sessionResult = await query<{ host_user_id: string; pod_id: string; config: any; event_format: string | null }>(
        `SELECT host_user_id, pod_id, config, event_format FROM sessions WHERE id = $1`,
        [sessionId],
      );
      if (sessionResult.rows.length === 0) {
        throw new NotFoundError('Session', sessionId, "We couldn't find that event.");
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

      // 26 Oct 2026 — a video meeting has no rounds, so nothing is planned. Production's live page hides the
      // Event Plan strip when the plan is empty.
      if (liveKindOf(resolveEventFormat({ format: session.event_format, config })) !== 'rounds') {
        const empty: ApiResponse = { success: true, data: { rounds: [], totalRounds: 0 } };
        res.json(empty);
        return;
      }

      const totalRounds: number = config?.numberOfRounds || 5;

      const matchesResult = await query<{
        round_number: number;
        status: string;
        cnt: string;
        fallback_count: string;
        repeat_count: string;
      }>(
        // 25 May (Ali live test) — the EVENT PLAN strip reflects ALGORITHM
        // rounds only. Manual breakout rooms inherit the current round_number
        // (host-actions INSERTs use activeSession.currentRound) and are
        // status='active', so a manual room created AFTER a round ended was
        // flipping that round's chip back to amber "Active". Exclude manual.
        // 26 May — also sum repeat_in_event so the host tooltip can report
        // "N pairs reused a past partner" (Item A tooltip spec).
        `SELECT round_number, status, COUNT(*)::text AS cnt,
                SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END)::text AS fallback_count,
                SUM(CASE WHEN repeat_in_event AND COALESCE(is_manual, FALSE) = FALSE THEN 1 ELSE 0 END)::text AS repeat_count
         FROM matches
         WHERE session_id = $1
           AND COALESCE(is_manual, FALSE) = FALSE
         GROUP BY round_number, status
         ORDER BY round_number`,
        [sessionId],
      );

      // Aggregate per round.
      const byRound = new Map<number, { statuses: Map<string, number>; fallbackCount: number; repeatCount: number }>();
      for (const row of matchesResult.rows) {
        const r = row.round_number;
        if (!byRound.has(r)) byRound.set(r, { statuses: new Map(), fallbackCount: 0, repeatCount: 0 });
        const entry = byRound.get(r)!;
        entry.statuses.set(row.status, parseInt(row.cnt, 10));
        entry.fallbackCount += parseInt(row.fallback_count || '0', 10);
        entry.repeatCount += parseInt(row.repeat_count || '0', 10);
      }

      // Get bye participants per round (those NOT in any match for that round).
      // A participant is "byed" in round R if they have status NOT IN ('removed','left','no_show')
      // AND no match in round R contains them.
      // 27 May — gate "not matched" on LIVE main-room presence so a registered-
      // but-absent participant (accepted but never joined, or here-then-left) is
      // never counted as a bye/warning. Fail-open: no active session or empty
      // presence → keep the DB-status behaviour (never wrongly inflate or zero
      // the count). The same numbers are served to the host AND co-hosts.
      // Ship B — canonical-first presence, heartbeat map fallback.
      const presentIds = Array.from(
        (await getCanonicalConnectedSet(sessionId))
        ?? activeSessions.get(sessionId)?.presenceMap.keys()
        ?? []);
      const presenceFilter = presentIds.length > 0 ? 'AND user_id = ANY($3::uuid[])' : '';
      const byeParams: unknown[] = presentIds.length > 0
        ? [sessionId, session.host_user_id, presentIds]
        : [sessionId, session.host_user_id];
      const byeResult = await query<{ round_number: number; bye_count: string }>(
        `WITH active_participants AS (
           SELECT user_id FROM session_participants
           WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
             AND user_id != $2
             -- 23 May (Stefan live test): cohosts are hosts too (excluded from
             -- matching), so they must not be counted as "not matched" either.
             -- Pre-fix, promoting someone to co-host made them show up in the
             -- "N not matched" tally, confusing the host.
             AND user_id NOT IN (SELECT user_id FROM session_cohosts WHERE session_id = $1)
             ${presenceFilter}
         ),
         round_participants AS (
           SELECT m.round_number,
                  unnest(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS user_id
           FROM matches m
           WHERE m.session_id = $1 AND m.status NOT IN ('cancelled')
             AND COALESCE(m.is_manual, FALSE) = FALSE
           -- Bug② (2026-06-08): someone who left a room (Back to Main Room) is
           -- removed from the slots but kept in departed_user_ids — they WERE
           -- matched this round. Union them in so the Event Plan strip's
           -- "N not matched" only counts genuine byes, not voluntary leavers.
           UNION
           SELECT m.round_number, unnest(m.departed_user_ids) AS user_id
           FROM matches m
           WHERE m.session_id = $1 AND m.status NOT IN ('cancelled')
             AND COALESCE(m.is_manual, FALSE) = FALSE
         )
         SELECT r.round_number,
                (SELECT COUNT(*)::text FROM active_participants ap
                 WHERE NOT EXISTS (
                   SELECT 1 FROM round_participants rp
                   WHERE rp.round_number = r.round_number AND rp.user_id = ap.user_id
                 )) AS bye_count
         FROM (SELECT DISTINCT round_number FROM matches
               WHERE session_id = $1 AND COALESCE(is_manual, FALSE) = FALSE) r`,
        byeParams,
      );
      const byeByRound = new Map<number, number>();
      for (const row of byeResult.rows) {
        byeByRound.set(row.round_number, parseInt(row.bye_count || '0', 10));
      }

      // Build the response: include every round 1..totalRounds, even if not yet planned.
      const rounds: { roundNumber: number; status: string; pairCount: number; byeCount: number; hasFallback: boolean; repeatPairCount: number }[] = [];
      for (let r = 1; r <= totalRounds; r++) {
        const entry = byRound.get(r);
        if (!entry || entry.statuses.size === 0) {
          rounds.push({ roundNumber: r, status: 'unplanned', pairCount: 0, byeCount: 0, hasFallback: false, repeatPairCount: 0 });
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
          // 26 May — count of algorithm pairs where at least one person had
          // already met their partner in a prior round of this event. Drives
          // the host tooltip: "N pairs reused a past partner this round."
          repeatPairCount: entry.repeatCount,
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
