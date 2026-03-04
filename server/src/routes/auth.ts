// ─── Auth Routes ─────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import * as identityService from '../services/identity/identity.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const magicLinkSchema = z.object({
  email: z.string().email('Valid email is required').max(255),
});

const verifySchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ─── POST /auth/magic-link ──────────────────────────────────────────────────

router.post(
  '/magic-link',
  authLimiter,
  validate(magicLinkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      const result = await identityService.sendMagicLink(email);

      const response: ApiResponse = {
        success: true,
        data: { message: 'If an account exists, a magic link has been sent.', ...result },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /auth/verify ──────────────────────────────────────────────────────

router.post(
  '/verify',
  authLimiter,
  validate(verifySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;
      const tokens = await identityService.verifyMagicLink(token);

      const response: ApiResponse = {
        success: true,
        data: tokens,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /auth/refresh ─────────────────────────────────────────────────────

router.post(
  '/refresh',
  validate(refreshSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      const tokens = await identityService.refreshAccessToken(refreshToken);

      const response: ApiResponse = {
        success: true,
        data: tokens,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /auth/logout ──────────────────────────────────────────────────────

router.post(
  '/logout',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await identityService.logout(req.user!.userId, req.user!.sessionId);

      const response: ApiResponse = {
        success: true,
        data: { message: 'Logged out successfully' },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /auth/session ──────────────────────────────────────────────────────

router.get(
  '/session',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await identityService.getUserById(req.user!.userId);

      const response: ApiResponse = {
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            profileComplete: user.profileComplete,
          },
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
