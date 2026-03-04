// ─── User Routes ─────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import * as identityService from '../services/identity/identity.service';
import { ApiResponse, UserRole } from '@rsn/shared';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  industry: z.string().max(100).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  linkedinUrl: z.string().url().nullable().optional(),
  interests: z.array(z.string().max(50)).max(20).optional(),
  reasonsToConnect: z.array(z.string().max(100)).max(10).optional(),
  languages: z.array(z.string().max(30)).max(10).optional(),
  timezone: z.string().max(50).nullable().optional(),
});

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  role: z.enum(['member', 'host', 'admin']).optional(),
  search: z.string().max(100).optional(),
});

// ─── GET /users/me ──────────────────────────────────────────────────────────

router.get(
  '/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await identityService.getUserById(req.user!.userId);

      const response: ApiResponse = { success: true, data: user };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /users/me ──────────────────────────────────────────────────────────

router.put(
  '/me',
  authenticate,
  validate(updateUserSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await identityService.updateUser(req.user!.userId, req.body);

      const response: ApiResponse = { success: true, data: user };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /users/:id ─────────────────────────────────────────────────────────

router.get(
  '/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await identityService.getUserById(req.params.id);

      // Non-admin users only see public profile
      const isOwnerOrAdmin = req.user!.userId === user.id || req.user!.role === UserRole.ADMIN;
      const data = isOwnerOrAdmin
        ? user
        : {
            id: user.id,
            displayName: user.displayName,
            firstName: user.firstName,
            lastName: user.lastName,
            avatarUrl: user.avatarUrl,
            bio: user.bio,
            company: user.company,
            jobTitle: user.jobTitle,
            industry: user.industry,
            interests: user.interests,
            reasonsToConnect: user.reasonsToConnect,
          };

      const response: ApiResponse = { success: true, data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /users (admin only) ────────────────────────────────────────────────

router.get(
  '/',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(listUsersQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, pageSize, role, search } = req.query as Record<string, string>;
      const result = await identityService.getUsers({
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
        role: role as UserRole | undefined,
        search,
      });

      const pg = parseInt(page || '1');
      const ps = parseInt(pageSize || '20');
      const totalPages = Math.ceil(result.total / ps);

      const response: ApiResponse = {
        success: true,
        data: result.users,
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

export default router;
