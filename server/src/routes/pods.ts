// ─── Pod Routes ──────────────────────────────────────────────────────────────
// Shirley pilot S2 (11 Nov 2026): every route is rate limited (podReadLimiter, podWriteLimiter); a private pod's events
// count, rules and circles are read only by someone who may see the pod (canViewPod: an ACTIVE member, or anyone for a
// discoverable pod; 404 otherwise, as the pod itself); a pod's settings are Private, Public with approval or Public
// open ("invite only" is refused); nobody adds a second director, and only the director adds a host; a change to the
// pod also tells the circles it is in.
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as podService from '../services/pod/pod.service';
import { withoutEmail } from '../services/user/public-card';
import { podReadLimiter, podWriteLimiter } from '../middleware/rateLimit';
import {
  fanoutAdminEntities, fanoutCircleChange, fanoutCirclesOfPod, fanoutPodEntities, fanoutPodMembershipForUser, podAudience, tellPodAudience,
} from '../realtime/fanout';
import { assertCircleManager } from '../services/circle/circle-managers';
import { emitEntities, getRealtimeIo } from '../realtime/emit';
import { E } from '../realtime/entities';
import { canViewPod } from '../services/pods/pod-access';
import { eventListedForSql } from '../services/session/event-access';
import {
  ApiResponse, UserRole, PodType, PodVisibility, PodMemberRole, OrchestrationMode, CommunicationMode, hasRoleAtLeast,
  POD_VISIBILITY_SETTINGS,
} from '@rsn/shared';
import { ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors';
import { query } from '../db';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

// Shirley pilot S2 (11 Nov 2026, D2): a pod is Private, Public with approval or Public open. "Invite only" is retired:
// one that still arrives (an old client, or a request during a deploy) is stored as Private, the more private setting
// (fix round 1: migration 148 adds no CHECK, so nothing old breaks mid-deploy). Any other value is a 400 in words.
const podVisibility = z.preprocess(
  (v) => (v === PodVisibility.INVITE_ONLY ? PodVisibility.PRIVATE : v),
  z.nativeEnum(PodVisibility).refine(
    (v) => (POD_VISIBILITY_SETTINGS as readonly string[]).includes(v),
    { message: 'Choose Private, Public with approval or Public open.' },
  ),
);

const createPodSchema = z.object({
  name:              z.string().min(1).max(200),
  description:       z.string().max(2000).optional(),
  podType:           z.nativeEnum(PodType).optional(),
  orchestrationMode: z.nativeEnum(OrchestrationMode).optional(),
  communicationMode: z.nativeEnum(CommunicationMode).optional(),
  visibility:        podVisibility.optional(),
  maxMembers:        z.number().int().positive().max(10000).optional(),
  rules:             z.string().max(5000).optional(),
  allowMemberInvites: z.boolean().optional(),
  // T14 (1 Nov 2026): made from a circle's page and attached to it in the same transaction. Production's form never sends it.
  circleId:          z.string().uuid().transform((id) => id.toLowerCase()).optional(),
});

const updatePodSchema = z.object({
  name:              z.string().min(1).max(200).optional(),
  description:       z.string().max(2000).optional(),
  podType:           z.nativeEnum(PodType).optional(),
  orchestrationMode: z.nativeEnum(OrchestrationMode).optional(),
  communicationMode: z.nativeEnum(CommunicationMode).optional(),
  visibility:        podVisibility.optional(),
  maxMembers:        z.number().int().positive().max(10000).nullable().optional(),
  rules:             z.string().max(5000).optional(),
  status:            z.enum(['draft', 'active', 'archived', 'suspended']).optional(),
  joinConfig:        z.object({
    rulesText:     z.string().max(5000).optional(),
    agreementText: z.string().max(1000).optional(),
  }).nullable().optional(),
  allowMemberInvites: z.boolean().optional(),
});

// S2: adding someone makes them a member or (by the director) a host. A director is added only by a platform admin
// (fix round 1: super admin powers unchanged), so a host can no longer make a second director, nor make themselves one
// through a second account.
const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role:   z.enum(['director', 'host', 'member'], { errorMap: () => ({ message: 'Add them as a member or a host.' }) }).optional(),
});
export const ONLY_DIRECTOR_ADDS_HOSTS = "Only the pod's director can add a host.";
export const ONLY_ADMIN_ADDS_DIRECTOR = 'Only a platform admin can add a director.';
const ASKED_ROLE: Record<string, PodMemberRole> = {
  director: PodMemberRole.DIRECTOR, host: PodMemberRole.HOST, member: PodMemberRole.MEMBER,
};

const joinConfigSchema = z.object({
  rulesText:     z.string().max(5000).optional(),
  agreementText: z.string().max(1000).optional(),
}).nullable();

// ─── POST /pods ─────────────────────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  podWriteLimiter,
  validate(createPodSchema),
  auditMiddleware('create_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const circleId: string | undefined = req.body.circleId;
      // T14: a pod is added to a circle only by the people who run it, checked before anything is made (404 for an
      // archived circle, 403 for anyone else), so a refusal never leaves a pod behind.
      if (circleId) {
        await assertCircleManager(circleId, req.user!.userId, req.user!.role, 'Only the people who run this circle can add a pod to it.');
      }
      const pod = await podService.createPod(req.user!.userId, req.body);
      // 26 Oct 2026 — a new pod used to tell nobody (the client refetched its own list by hand). Its only
      // member, the creator, gets the pod and their pods list; every admin's pod list refreshes.
      fanoutPodEntities(pod.id, [E.userPods(req.user!.userId)]).catch(() => {});
      fanoutAdminEntities('pods').catch(() => {});
      if (circleId) fanoutCircleChange(circleId, req.user!.userId).catch(() => {});
      const response: ApiResponse = { success: true, data: circleId ? { ...pod, circleId } : pod };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods ──────────────────────────────────────────────────────────────

router.get(
  '/',
  authenticate,
  podReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { podType, status, page, pageSize, browse } = req.query as Record<string, string>;

      const isBrowse    = browse === 'true';
      const isAdminView = req.query.admin === 'true' && hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      const scopeUserId = isBrowse || isAdminView ? undefined : req.user!.userId;
      const effectiveStatus = isBrowse ? 'active' : status;

      const result = await podService.listPods({
        userId:           scopeUserId,
        requestingUserId: req.user!.userId,
        podType:          podType as PodType | undefined,
        status:           effectiveStatus as any,
        page:             page ? parseInt(page) : undefined,
        pageSize:         pageSize ? parseInt(pageSize) : undefined,
        browse:           isBrowse,
      });

      const pg = parseInt(page || '1');
      const ps = Math.min(parseInt(pageSize || '20'), 100);
      const totalPages = Math.ceil(result.total / ps);

      const response: ApiResponse = {
        success: true,
        data: result.pods,
        meta: {
          page: pg, pageSize: ps,
          totalCount: result.total, totalPages,
          hasNext: pg < totalPages, hasPrev: pg > 1,
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id/members/for-invite ───────────────────────────────────────
// MUST be before /:id to avoid Express matching /:id first

// 26 Oct 2026 (fix round 3): the pod in the path has to be the event's own pod. The route used to check only that the
// caller hosts or co-hosts the event, so any pod director or host who ran an event of their own could list ANY pod's
// active members, with their addresses. Production's event page always asks for its own event's pod (session.podId), so
// nothing it does changes. The address goes to the event's host and to admins (the event page shows this list to the
// host); a co-host who asks is given names and ids only, as in the event's invite list.
router.get(
  '/:id/members/for-invite',
  authenticate,
  podReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asked = z.string().uuid().safeParse(req.query.sessionId);
      if (!asked.success) throw new ValidationError('Choose the event to invite to');
      const sessionId = asked.data;
      const isAdmin = hasRoleAtLeast(req.user!.role, UserRole.ADMIN);

      const event = await query<{ host_user_id: string; pod_id: string | null }>(
        `SELECT host_user_id, pod_id FROM sessions WHERE id = $1`, [sessionId],
      );
      const found = event.rows[0];
      const isHost = found?.host_user_id === req.user!.userId;
      // Who runs no such event is refused first (403, as before), so a stranger learns nothing about the event.
      if (!isAdmin && !isHost) {
        const cohost = await query(
          `SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
          [sessionId, req.user!.userId],
        );
        if (cohost.rows.length === 0) {
          throw new ForbiddenError('Only the event host can see who to invite');
        }
      }
      if (!found || found.pod_id !== req.params.id.toLowerCase()) throw new NotFoundError('Session', undefined, "We couldn't find that event.");

      // Made for the person asking: their blocks (and the ones against them) and accounts that are not active are left out.
      const members = await podService.getPodMembersForInvite(req.params.id, sessionId, req.user!.userId);
      res.json({ data: isAdmin || isHost ? members : withoutEmail(members) });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id ──────────────────────────────────────────────────────────

router.get(
  '/:id',
  authenticate,
  podReadLimiter,
  uuidInPath('id', PATH_REFUSALS.pod), // a malformed id: a 400 in a member's words, not a Postgres 500 (26 Oct 2026)
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const canView = await canViewPod(req.user!.userId, req.params.id, req.user!.role);
      if (!canView) {
        // Private pods → 404 (don't leak existence, mirrors GitHub private-repo UX)
        throw new NotFoundError('Pod', req.params.id);
      }

      const pod = await podService.getPodById(req.params.id);
      const memberRole = await podService.getMemberRole(req.params.id, req.user!.userId);

      const response: ApiResponse = { success: true, data: { ...pod, memberRole } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /pods/:id ──────────────────────────────────────────────────────────

router.put(
  '/:id',
  authenticate,
  podWriteLimiter,
  validate(updatePodSchema),
  auditMiddleware('update_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pod = await podService.updatePod(req.params.id, req.user!.userId, req.body, req.user!.role);
      // Bug 30 (19 May Ali) — every other pod mutation fans out; the
      // update route was missed. Renames, archive toggles, visibility
      // changes etc. now propagate to every active member instantly.
      fanoutPodEntities(req.params.id).catch(() => {});
      // S2: a pod made private (or renamed, archived) changes the page of every circle it is in.
      void fanoutCirclesOfPod(req.params.id, req.user!.userId); // never throws
      const response: ApiResponse = { success: true, data: pod };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /pods/:id ───────────────────────────────────────────────────────

router.delete(
  '/:id',
  authenticate,
  podWriteLimiter,
  auditMiddleware('delete_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // The pod is archived, not deleted (its members stay), so its screens are told AFTER the archive is saved, as
      // every mutation does (H2b item 20, 26 Oct 2026). The fan-out used to go first, from the days the pod and its
      // member rows were really deleted (Bug 30, 19 May): a page that refetched at once could still read the pod as
      // open. includeUserPods tags so every member's My Pods list invalidates too.
      await podService.deletePod(req.params.id, req.user!.userId, req.user!.role);
      fanoutPodEntities(req.params.id, [], { includeUserPodsPerMember: true }).catch(() => {});
      void fanoutCirclesOfPod(req.params.id, req.user!.userId); // never throws
      const response: ApiResponse = { success: true, data: { message: 'Pod deleted' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id/members ──────────────────────────────────────────────────

router.get(
  '/:id/members',
  authenticate,
  podReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
      if (!isAdmin) {
        const requesterRole = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!requesterRole) {
          throw new ForbiddenError('You must be a pod member to view the member list');
        }
      }
      const members = await podService.getPodMembers(req.params.id);
      // Members see each other's public card, never emails or interests
      // (Stefan, 9 Sep 2026). Admins keep the full row.
      const response: ApiResponse = { success: true, data: isAdmin ? members : withoutEmail(members) };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id/active-session (T1-3 / Issue 3) ──────────────────────────
//
// Returns the current/next live or imminent session in this pod, so the
// client can auto-redirect a freshly-joined user into the lobby instead of
// stranding them on the pod page. "Live" = status in (lobby_open,
// round_active, round_rating, round_transition, closing_lobby).
// "Imminent" = scheduled to start within the next hour AND status='scheduled'.
//
// Returns 200 with `{ session: null }` when no live/imminent session exists
// — the client treats that as "stay on the pod page".

router.get(
  '/:id/active-session',
  authenticate,
  podReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Same access gate as other pod-scoped reads (member or admin).
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const role = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!role) {
          throw new ForbiddenError('You must be a pod member to view sessions');
        }
      }

      const liveStatuses = `('lobby_open','round_active','round_rating','round_transition','closing_lobby')`;
      // Live first; if none, look for imminent scheduled within next 60 min.
      // Part 2 Task 2 (D1): never someone else's draft, never an archived event (eventListedForSql).
      const liveResult = await query<{ id: string; title: string; status: string }>(
        `SELECT s.id, s.title, s.status FROM sessions s
         WHERE s.pod_id = $1 AND s.status IN ${liveStatuses}
           AND ${eventListedForSql('s', '$2')}
         ORDER BY s.started_at DESC NULLS LAST
         LIMIT 1`,
        [req.params.id, req.user!.userId],
      );

      let session = liveResult.rows[0] || null;
      if (!session) {
        const upcoming = await query<{ id: string; title: string; status: string; scheduled_at: string }>(
          `SELECT s.id, s.title, s.status, s.scheduled_at FROM sessions s
           WHERE s.pod_id = $1 AND s.status = 'scheduled'
             AND s.scheduled_at IS NOT NULL
             AND s.scheduled_at <= NOW() + INTERVAL '60 minutes'
             AND s.scheduled_at > NOW() - INTERVAL '5 minutes'
             AND ${eventListedForSql('s', '$2')}
           ORDER BY s.scheduled_at ASC
           LIMIT 1`,
          [req.params.id, req.user!.userId],
        );
        if (upcoming.rows.length > 0) session = upcoming.rows[0];
      }

      const response: ApiResponse = { success: true, data: { session } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id/member-counts ────────────────────────────────────────────

router.get(
  '/:id/member-counts',
  authenticate,
  podReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const role = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!role || (role !== 'director' && role !== 'host')) {
          throw new ForbiddenError('Only pod directors can view member counts');
        }
      }
      const counts = await podService.getMemberStatusCounts(req.params.id);
      const response: ApiResponse = { success: true, data: counts };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/members ─────────────────────────────────────────────────

router.post(
  '/:id/members',
  authenticate,
  podWriteLimiter,
  validate(addMemberSchema),
  auditMiddleware('add_pod_member', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asked = ASKED_ROLE[(req.body.role as string | undefined) ?? 'member'];
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        if (asked === PodMemberRole.DIRECTOR) throw new ForbiddenError(ONLY_ADMIN_ADDS_DIRECTOR);
        const requesterRole = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!requesterRole || ![PodMemberRole.DIRECTOR, PodMemberRole.HOST].includes(requesterRole)) {
          throw new ForbiddenError('Only pod directors and hosts can add members');
        }
        // S2: a host adds members; only the director makes a host.
        if (asked === PodMemberRole.HOST && requesterRole !== PodMemberRole.DIRECTOR) {
          throw new ForbiddenError(ONLY_DIRECTOR_ADDS_HOSTS);
        }
      }
      const member = await podService.addMember(req.params.id, req.body.userId, asked);
      // Bug 19 (18 May Stefan) — broadcast so every current member's UI
      // refetches the pod queries and sees the new row immediately. The
      // added user's own My Pods list also needs the user-scoped invalidator.
      fanoutPodEntities(req.params.id, [E.userPods(req.body.userId)]).catch(() => {});
      // Cover the added user too (in case they're not in the active
      // members SELECT yet on a slow replica) — direct user-room emit.
      emitEntities(getRealtimeIo(), [req.body.userId], [E.pod(req.params.id), E.podMembers(req.params.id), E.userPods(req.body.userId)]).catch(() => {});
      const response: ApiResponse = { success: true, data: member };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /pods/:id/members/:userId ───────────────────────────────────────

router.delete(
  '/:id/members/:userId',
  authenticate,
  podWriteLimiter,
  auditMiddleware('remove_pod_member', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await podService.removeMember(req.params.id, req.params.userId, req.user!.userId, req.user!.role);
      // Bug 19 — fan out before AND notify the removed user too so their
      // own UI flips. fanoutPodEntities only emits to current members
      // (`status NOT IN ('removed', 'declined')`), so call the per-user
      // notifier first while the row is still present in the result set.
      fanoutPodMembershipForUser(req.params.id, req.params.userId).catch(() => {});
      fanoutPodEntities(req.params.id, [E.userPods(req.params.userId)]).catch(() => {});
      const response: ApiResponse = { success: true, data: { message: 'Member removed' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /pods/:id/members/:userId/role ────────────────────────────────────

router.patch(
  '/:id/members/:userId/role',
  authenticate,
  podWriteLimiter,
  auditMiddleware('update_pod_member_role', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { role } = req.body;
      if (!role || !['host', 'member'].includes(role)) {
        throw new ForbiddenError('Role must be "host" or "member"');
      }
      const member = await podService.updateMemberRole(req.params.id, req.params.userId, role, req.user!.userId, req.user!.role);
      // Bug 19 — broadcast role change to every pod member.
      fanoutPodEntities(req.params.id).catch(() => {});
      const response: ApiResponse = { success: true, data: member };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/join ────────────────────────────────────────────────────

router.post(
  '/:id/join',
  authenticate,
  podWriteLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await podService.joinPod(req.params.id, req.user!.userId, req.user!.role);
      // Bug 19 — broadcast: someone joined (could be direct join for
      // public pods, or pending for invite-only). Every member's UI
      // sees the count update, and the joiner's My Pods list flips.
      fanoutPodEntities(req.params.id, [E.userPods(req.user!.userId)]).catch(() => {});
      // The joiner might not be in the active-member SELECT yet if status
      // is 'pending_approval' — emit direct to their user room too.
      emitEntities(getRealtimeIo(), [req.user!.userId], [E.pod(req.params.id), E.podMembers(req.params.id), E.userPods(req.user!.userId)]).catch(() => {});
      const response: ApiResponse = { success: true, data: member };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/request-join ────────────────────────────────────────────

router.post(
  '/:id/request-join',
  authenticate,
  podWriteLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await podService.requestToJoin(req.params.id, req.user!.userId);
      // Stefan (2 Jul) — same live fanout as /join: directors viewing the
      // pod page gain the pending request + count without a refresh, and
      // the requester's own tabs flip to "pending". The requester may not
      // be in the active-member fanout audience yet, so emit direct to
      // their user room too.
      fanoutPodEntities(req.params.id, [E.userPods(req.user!.userId)]).catch(() => {});
      emitEntities(getRealtimeIo(), [req.user!.userId], [E.pod(req.params.id), E.podMembers(req.params.id), E.userPods(req.user!.userId)]).catch(() => {});
      const response: ApiResponse = { success: true, data: member };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/decline ──────────────────────────────────────────────────

router.post(
  '/:id/decline',
  authenticate,
  podWriteLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await podService.declineMember(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: { message: 'Invitation declined' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/members/:userId/approve ─────────────────────────────────

router.post(
  '/:id/members/:userId/approve',
  authenticate,
  podWriteLimiter,
  auditMiddleware('approve_pod_member', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await podService.approveMember(req.params.id, req.params.userId, req.user!.userId, req.user!.role);
      // Bug 3 (18 May Stefan) — Stefan approved a pending request but the
      // requester didn't see "Approved" until they refreshed, and the host's
      // pending count stayed stale too. Live broadcast on both directions:
      //   - target user's user room gets the pod + members + userPods
      //     entity tags so their UI flips from "Pending approval" to
      //     "Active member" via the global entity:changed handler;
      //   - the all-members fanout decrements the host's pending count.
      fanoutPodMembershipForUser(req.params.id, req.params.userId)
        .catch(() => { /* best-effort */ });
      // Bug 19 (18 May Stefan) — fan out to all pod members too so the
      // member list everyone sees updates immediately (new approved
      // member appears, pending count decrements).
      fanoutPodEntities(req.params.id).catch(() => {});
      const response: ApiResponse = { success: true, data: member };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/members/:userId/reject ──────────────────────────────────

router.post(
  '/:id/members/:userId/reject',
  authenticate,
  podWriteLimiter,
  auditMiddleware('reject_pod_member', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await podService.rejectMember(req.params.id, req.params.userId, req.user!.userId, req.user!.role);
      // Bug 3 (18 May Stefan) — same live broadcast on reject so the
      // requester learns the verdict without a refresh.
      fanoutPodMembershipForUser(req.params.id, req.params.userId)
        .catch(() => { /* best-effort */ });
      // Bug 19 — fan out: pending count decrements for every admin viewing.
      fanoutPodEntities(req.params.id).catch(() => {});
      const response: ApiResponse = { success: true, data: { message: 'Request rejected' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/leave ───────────────────────────────────────────────────

router.post(
  '/:id/leave',
  authenticate,
  podWriteLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await podService.leavePod(req.params.id, req.user!.userId);
      // Phase May-19 realtime — fan out so every remaining member's
      // pod page count + roster updates immediately. Also notify the
      // leaver's own room so their "My Pods" list flips. leavePod
      // already updates pod_members.status='left', so the leaver is
      // excluded from fanoutPodEntities' active-member fanout — the
      // fanoutPodMembershipForUser call covers them directly.
      fanoutPodMembershipForUser(req.params.id, req.user!.userId).catch(() => {});
      fanoutPodEntities(req.params.id).catch(() => {});
      const response: ApiResponse = { success: true, data: { message: 'Left pod successfully' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /pods/:id/reactivate ──────────────────────────────────────────────

router.post(
  '/:id/reactivate',
  authenticate,
  podWriteLimiter,
  auditMiddleware('reactivate_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pod = await podService.reactivatePod(req.params.id, req.user!.userId);
      // Phase May-19 realtime — fan out so every member's UI flips
      // back from "archived" to "active" instantly.
      fanoutPodEntities(req.params.id, [], { includeUserPodsPerMember: true }).catch(() => {});
      void fanoutCirclesOfPod(req.params.id, req.user!.userId); // never throws
      const response: ApiResponse = { success: true, data: pod };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id/session-count ────────────────────────────────────────────

router.get(
  '/:id/session-count',
  authenticate,
  podReadLimiter,
  uuidInPath('id', PATH_REFUSALS.pod),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // S2: read only by someone who may see the pod (a private pod's count by id was open to anyone; 404 as the pod).
      if (!(await canViewPod(req.user!.userId, req.params.id, req.user!.role))) throw new NotFoundError('Pod', req.params.id);
      const count = await podService.getSessionCountForPod(req.params.id);
      const response: ApiResponse = { success: true, data: { count } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id/join-config ───────────────────────────────────────────────

router.get(
  '/:id/join-config',
  authenticate,
  podReadLimiter,
  uuidInPath('id', PATH_REFUSALS.pod),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // S2: a private pod's rules are its members' (they were readable by id); 404 as the pod for anyone else.
      if (!(await canViewPod(req.user!.userId, req.params.id, req.user!.role))) throw new NotFoundError('Pod', req.params.id);
      const config = await podService.getJoinConfig(req.params.id);
      const response: ApiResponse = { success: true, data: config };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /pods/:id/join-config ───────────────────────────────────────────────

router.put(
  '/:id/join-config',
  authenticate,
  podWriteLimiter,
  validate(z.object({ joinConfig: joinConfigSchema })),
  auditMiddleware('update_pod_join_config', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await podService.setJoinConfig(req.params.id, req.user!.userId, req.body.joinConfig, req.user!.role);
      // Phase May-19 realtime — fan out so the join-page rules text
      // updates for every member viewing the pod.
      fanoutPodEntities(req.params.id).catch(() => {});
      const response: ApiResponse = { success: true, data: { message: 'Join config updated' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /pods/:id/permanent (super_admin only) ─────────────────────────

router.delete(
  '/:id/permanent',
  authenticate,
  podWriteLimiter,
  requireRole(UserRole.SUPER_ADMIN),
  auditMiddleware('hard_delete_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // The member list is read BEFORE the hard delete (the rows go with the pod), and the members are told AFTER the
      // delete is saved, as every mutation does (12 Nov 2026: it used to tell them first, so a page that read the pod
      // again at once could still find it). includeUserPodsPerMember so every member's My Pods list flips.
      const audience = await podAudience(req.params.id);
      await podService.hardDeletePod(req.params.id);
      tellPodAudience(audience, req.params.id, [], { includeUserPodsPerMember: true }).catch(() => {});
      const response: ApiResponse = { success: true, data: { message: 'Pod permanently deleted' } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
