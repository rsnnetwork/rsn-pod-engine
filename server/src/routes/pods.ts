// ─── Pod Routes ──────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { auditMiddleware } from '../middleware/audit';
import * as podService from '../services/pod/pod.service';
import { ApiResponse, UserRole, PodType, PodVisibility, PodMemberRole, hasRoleAtLeast } from '@rsn/shared';
import { ForbiddenError } from '../middleware/errors';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createPodSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  podType: z.nativeEnum(PodType).optional(),
  orchestrationMode: z.enum(['timed_rounds', 'free_form', 'moderated']).optional(),
  communicationMode: z.enum(['video', 'audio', 'text', 'hybrid']).optional(),
  visibility: z.nativeEnum(PodVisibility).optional(),
  maxMembers: z.number().int().positive().max(10000).optional(),
  rules: z.string().max(5000).optional(),
});

const updatePodSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  visibility: z.nativeEnum(PodVisibility).optional(),
  maxMembers: z.number().int().positive().max(10000).optional(),
  rules: z.string().max(5000).optional(),
  status: z.enum(['draft', 'active', 'archived', 'suspended']).optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['director', 'host', 'member']).optional(),
});

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

      // browse=true shows all active non-private pods; otherwise scope to user's own pods (admins always see all)
      const isBrowse = browse === 'true';
      const userId = isBrowse || hasRoleAtLeast(req.user!.role, UserRole.ADMIN) ? undefined : req.user!.userId;
      const effectiveStatus = isBrowse ? 'active' : status;

      const result = await podService.listPods({
        userId,
        podType: podType as PodType | undefined,
        status: effectiveStatus as any,
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
        browse: isBrowse,
      });

      const pg = parseInt(page || '1');
      const ps = Math.min(parseInt(pageSize || '20'), 100);
      const totalPages = Math.ceil(result.total / ps);

      const response: ApiResponse = {
        success: true,
        data: result.pods,
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

// ─── GET /pods/:id ──────────────────────────────────────────────────────────

router.get(
  '/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pod = await podService.getPodById(req.params.id);

      // Include user's membership role (null if not a member)
      let memberRole = null;
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        memberRole = await podService.getMemberRole(req.params.id, req.user!.userId);
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
      const members = await podService.getPodMembers(req.params.id);
      const response: ApiResponse = { success: true, data: members };
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
      // Only directors and hosts can add members
      if (!hasRoleAtLeast(req.user!.role, UserRole.ADMIN)) {
        const requesterRole = await podService.getMemberRole(req.params.id, req.user!.userId);
        if (!requesterRole || ![PodMemberRole.DIRECTOR, PodMemberRole.HOST].includes(requesterRole)) {
          throw new ForbiddenError('Only pod directors and hosts can add members');
        }
      }

      const member = await podService.addMember(
        req.params.id,
        req.body.userId,
        req.body.role || PodMemberRole.MEMBER
      );
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

// ─── POST /pods/:id/join ────────────────────────────────────────────────────

router.post(
  '/:id/join',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await podService.joinPod(
        req.params.id,
        req.user!.userId
      );
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
      const member = await podService.requestToJoin(
        req.params.id,
        req.user!.userId
      );
      const response: ApiResponse = { success: true, data: member };
      res.status(201).json(response);
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
      const member = await podService.approveMember(
        req.params.id,
        req.params.userId,
        req.user!.userId,
        req.user!.role
      );
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
      await podService.rejectMember(
        req.params.id,
        req.params.userId,
        req.user!.userId,
        req.user!.role
      );
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
