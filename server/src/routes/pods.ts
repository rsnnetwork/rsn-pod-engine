// ─── Pod Routes ──────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as podService from '../services/pod/pod.service';
import { fanoutPodEntities, fanoutPodMembershipForUser } from '../realtime/fanout';
import { emitEntities, getRealtimeIo } from '../realtime/emit';
import { E } from '../realtime/entities';
import { canViewPod } from '../services/pods/pod-access';
import { ApiResponse, UserRole, PodType, PodVisibility, PodMemberRole, OrchestrationMode, CommunicationMode, hasRoleAtLeast } from '@rsn/shared';
import { ForbiddenError, NotFoundError } from '../middleware/errors';
import { query } from '../db';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createPodSchema = z.object({
  name:              z.string().min(1).max(200),
  description:       z.string().max(2000).optional(),
  podType:           z.nativeEnum(PodType).optional(),
  orchestrationMode: z.nativeEnum(OrchestrationMode).optional(),
  communicationMode: z.nativeEnum(CommunicationMode).optional(),
  visibility:        z.nativeEnum(PodVisibility).optional(),
  maxMembers:        z.number().int().positive().max(10000).optional(),
  rules:             z.string().max(5000).optional(),
  allowMemberInvites: z.boolean().optional(),
});

const updatePodSchema = z.object({
  name:              z.string().min(1).max(200).optional(),
  description:       z.string().max(2000).optional(),
  podType:           z.nativeEnum(PodType).optional(),
  orchestrationMode: z.nativeEnum(OrchestrationMode).optional(),
  communicationMode: z.nativeEnum(CommunicationMode).optional(),
  visibility:        z.nativeEnum(PodVisibility).optional(),
  maxMembers:        z.number().int().positive().max(10000).nullable().optional(),
  rules:             z.string().max(5000).optional(),
  status:            z.enum(['draft', 'active', 'archived', 'suspended']).optional(),
  joinConfig:        z.object({
    rulesText:     z.string().max(5000).optional(),
    agreementText: z.string().max(1000).optional(),
  }).nullable().optional(),
  allowMemberInvites: z.boolean().optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role:   z.enum(['director', 'host', 'member']).optional(),
});

const joinConfigSchema = z.object({
  rulesText:     z.string().max(5000).optional(),
  agreementText: z.string().max(1000).optional(),
}).nullable();

// ─── POST /pods ─────────────────────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  validate(createPodSchema),
  auditMiddleware('create_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pod = await podService.createPod(req.user!.userId, req.body);
      const response: ApiResponse = { success: true, data: pod };
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

router.get(
  '/:id/members/for-invite',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) {
        res.status(400).json({ error: { message: 'sessionId required' } });
        return;
      }
      const members = await podService.getPodMembersForInvite(req.params.id, sessionId);
      res.json({ data: members });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /pods/:id ──────────────────────────────────────────────────────────

router.get(
  '/:id',
  authenticate,
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
  validate(updatePodSchema),
  auditMiddleware('update_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pod = await podService.updatePod(req.params.id, req.user!.userId, req.body, req.user!.role);
      // Bug 30 (19 May Ali) — every other pod mutation fans out; the
      // update route was missed. Renames, archive toggles, visibility
      // changes etc. now propagate to every active member instantly.
      fanoutPodEntities(req.params.id).catch(() => {});
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
  auditMiddleware('delete_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Bug 30 (19 May Ali) — fan out BEFORE the delete so fanoutPodEntities
      // can still resolve the active member list. After deletion the
      // pod_members rows are gone (cascade) and the lookup would find no
      // one to notify. fanoutPodEntities is fire-and-forget, so this is
      // safe to run before awaiting the deletePod call. includeUserPods
      // tags so every member's My Pods list invalidates too.
      fanoutPodEntities(req.params.id, [], { includeUserPodsPerMember: true }).catch(() => {});
      await podService.deletePod(req.params.id, req.user!.userId, req.user!.role);
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const requesterRole = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!requesterRole) {
          throw new ForbiddenError('You must be a pod member to view the member list');
        }
      }
      const members = await podService.getPodMembers(req.params.id);
      const response: ApiResponse = { success: true, data: members };
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
      const liveResult = await query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM sessions
         WHERE pod_id = $1 AND status IN ${liveStatuses}
         ORDER BY started_at DESC NULLS LAST
         LIMIT 1`,
        [req.params.id],
      );

      let session = liveResult.rows[0] || null;
      if (!session) {
        const upcoming = await query<{ id: string; title: string; status: string; scheduled_at: string }>(
          `SELECT id, title, status, scheduled_at FROM sessions
           WHERE pod_id = $1 AND status = 'scheduled'
             AND scheduled_at IS NOT NULL
             AND scheduled_at <= NOW() + INTERVAL '60 minutes'
             AND scheduled_at > NOW() - INTERVAL '5 minutes'
           ORDER BY scheduled_at ASC
           LIMIT 1`,
          [req.params.id],
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
  validate(addMemberSchema),
  auditMiddleware('add_pod_member', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const requesterRole = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!requesterRole || ![PodMemberRole.DIRECTOR, PodMemberRole.HOST].includes(requesterRole)) {
          throw new ForbiddenError('Only pod directors and hosts can add members');
        }
      }
      const member = await podService.addMember(req.params.id, req.body.userId, req.body.role || PodMemberRole.MEMBER);
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await podService.joinPod(req.params.id, req.user!.userId);
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await podService.requestToJoin(req.params.id, req.user!.userId);
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
  auditMiddleware('reactivate_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pod = await podService.reactivatePod(req.params.id, req.user!.userId);
      // Phase May-19 realtime — fan out so every member's UI flips
      // back from "archived" to "active" instantly.
      fanoutPodEntities(req.params.id, [], { includeUserPodsPerMember: true }).catch(() => {});
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
  requireRole(UserRole.SUPER_ADMIN),
  auditMiddleware('hard_delete_pod', 'pod'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Phase May-19 realtime — fan out BEFORE the hard delete so
      // fanoutPodEntities' active-member lookup still finds rows. Mirrors
      // the soft DELETE /pods/:id pattern above; includeUserPodsPerMember
      // so every member's My Pods list flips.
      fanoutPodEntities(req.params.id, [], { includeUserPodsPerMember: true }).catch(() => {});
      await podService.hardDeletePod(req.params.id);
      const response: ApiResponse = { success: true, data: { message: 'Pod permanently deleted' } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
