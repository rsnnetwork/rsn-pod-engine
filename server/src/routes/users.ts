// ─── User Routes ─────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import * as identityService from '../services/identity/identity.service';
import { ApiResponse, UserRole, hasRoleAtLeast } from '@rsn/shared';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  avatarUrl: z.string().max(2_000_000).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  industry: z.string().max(100).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  linkedinUrl: z.string().max(500).nullable().optional(),
  interests: z.array(z.string().max(50)).max(20).optional(),
  reasonsToConnect: z.array(z.string().max(100)).max(10).optional(),
  languages: z.array(z.string().max(30)).max(10).optional(),
  timezone: z.string().max(50).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  expertiseText: z.string().max(5000).nullable().optional(),
  whatICareAbout: z.string().max(2000).nullable().optional(),
  whatICanHelpWith: z.string().max(2000).nullable().optional(),
  whoIWantToMeet: z.string().max(2000).nullable().optional(),
  whyIWantToMeet: z.string().max(2000).nullable().optional(),
  myIntent: z.string().max(2000).nullable().optional(),
  notifyEmail: z.boolean().optional(),
  notifyEventReminders: z.boolean().optional(),
  notifyMatches: z.boolean().optional(),
  profileVisible: z.boolean().optional(),
  inviteOptOutPublicEvents: z.boolean().optional(),
});

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  role: z.enum(['member', 'host', 'admin', 'super_admin', 'free', 'pro', 'founding_member']).optional(),
  status: z.enum(['active', 'suspended', 'banned', 'deactivated']).optional(),
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

// ─── GET /users/search (authenticated, public fields only) ──────────────────

router.get(
  '/search',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = (req.query.q as string || '').trim();
      const industry = (req.query.industry as string || '').trim();
      if (q.length < 1 && !industry) {
        res.json({ success: true, data: [] });
        return;
      }
      const result = await identityService.getUsers({
        search: q || undefined,
        industry: industry || undefined,
        pageSize: 20,
        status: 'active',
      });
      // Return only public profile fields
      const data = result.users.map(u => ({
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        company: u.company,
        jobTitle: u.jobTitle,
        industry: u.industry,
        avatarUrl: u.avatarUrl,
      }));
      res.json({ success: true, data } as ApiResponse);
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
      const isOwnerOrAdmin = req.user!.userId === user.id || hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
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
            location: user.location,
            linkedinUrl: user.linkedinUrl,
            interests: user.interests,
            reasonsToConnect: user.reasonsToConnect,
            languages: user.languages,
            expertiseText: user.expertiseText,
            whatICareAbout: user.whatICareAbout,
            whatICanHelpWith: user.whatICanHelpWith,
            whoIWantToMeet: user.whoIWantToMeet,
            whyIWantToMeet: user.whyIWantToMeet,
            myIntent: user.myIntent,
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
      const { page, pageSize, role, status, search } = req.query as Record<string, string>;
      const result = await identityService.getUsers({
        page: page ? parseInt(page) : undefined,
        pageSize: pageSize ? parseInt(pageSize) : undefined,
        role: role as UserRole | undefined,
        status: status as 'active' | 'suspended' | 'banned' | 'deactivated' | undefined,
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

// ─── PUT /users/:id/role (admin only) ───────────────────────────────────────

router.put(
  '/:id/role',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { role } = req.body;
      if (!role || !Object.values(UserRole).includes(role)) {
        return res.status(400).json({ success: false, error: { message: 'Invalid role' } });
      }

      // Only super_admin can assign admin or super_admin roles
      if ((role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) && req.user!.role !== UserRole.SUPER_ADMIN) {
        return res.status(403).json({ success: false, error: { message: 'Only super admins can assign admin roles' } });
      }

      const user = await identityService.updateUserRole(req.params.id, role);
      const response: ApiResponse = { success: true, data: user };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── PUT /users/:id/status (admin only) ─────────────────────────────────────

router.put(
  '/:id/status',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body;
      if (!status || !['active', 'suspended', 'banned', 'deactivated'].includes(status)) {
        return res.status(400).json({ success: false, error: { message: 'Invalid status' } });
      }

      const user = await identityService.updateUserStatus(req.params.id, status);
      const response: ApiResponse = { success: true, data: user };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── DELETE /users/:id (super_admin only) ───────────────────────────────────

router.delete(
  '/:id',
  authenticate,
  requireRole(UserRole.SUPER_ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await identityService.deleteUser(req.params.id);
      const response: ApiResponse = { success: true, data: { message: 'User deleted' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
