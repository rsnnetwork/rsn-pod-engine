// ─── Pod Routes ──────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as podService from '../services/pod/pod.service';
import { ApiResponse, UserRole, PodType, PodVisibility, PodMemberRole, OrchestrationMode, CommunicationMode, hasRoleAtLeast } from '@rsn/shared';
import { ForbiddenError } from '../middleware/errors';

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
      const pod = await podService.getPodById(req.params.id);
      const memberRole = await podService.getMemberRole(req.params.id, req.user!.userId);

      if (pod.visibility === 'private' && !memberRole && !hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        throw new ForbiddenError('This pod is private. You must be a member to view it.');
      }

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
      await podService.hardDeletePod(req.params.id);
      const response: ApiResponse = { success: true, data: { message: 'Pod permanently deleted' } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
