// ─── Pod Routes ──────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { auditMiddleware } from '../middleware/audit';
import * as podService from '../services/pod/pod.service';
import { ApiResponse, UserRole, PodType, PodVisibility, PodMemberRole } from '@rsn/shared';

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
      const { podType, status, page, pageSize } = req.query as Record<string, string>;

      // Regular users only see their own pods; admins see all
      const userId = req.user!.role === UserRole.ADMIN ? undefined : req.user!.userId;

      const result = await podService.listPods({
        userId,
        podType: podType as PodType | undefined,
        status: status as any,
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
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
      const response: ApiResponse = { success: true, data: pod };
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
      const pod = await podService.updatePod(req.params.id, req.user!.userId, req.body);
      const response: ApiResponse = { success: true, data: pod };
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
      await podService.removeMember(req.params.id, req.params.userId, req.user!.userId);
      const response: ApiResponse = { success: true, data: { message: 'Member removed' } };
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

export default router;
