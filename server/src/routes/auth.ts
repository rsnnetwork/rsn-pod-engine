// ─── Auth Routes ─────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import * as identityService from '../services/identity/identity.service';
import { ApiResponse } from '@rsn/shared';
import config from '../config';
import logger from '../config/logger';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────────────────────────

const magicLinkSchema = z.object({
  email: z.string().email('Valid email is required').max(255),
  clientUrl: z.string().url('Valid client URL is required').max(2048).optional(),
  inviteCode: z.string().max(20).optional(),
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
      const { email, clientUrl, inviteCode } = req.body;
      const result = await identityService.sendMagicLink(email, clientUrl, inviteCode);

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
      await identityService.logout(req.user!.userId, req.user!.sessionId, req.body?.refreshToken);

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
            timezone: user.timezone,
            phone: user.phone,
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

// ─── Google OAuth ───────────────────────────────────────────────────────────

router.get(
  '/google',
  (req: Request, res: Response) => {
    if (!config.googleClientId) {
      res.status(501).json({ success: false, error: { message: 'Google login is not configured' } });
      return;
    }

    const inviteCode = (req.query.inviteCode as string) || '';
    const state = Buffer.from(JSON.stringify({ inviteCode })).toString('base64url');

    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: `${config.apiBaseUrl}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
      state,
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }
);

router.get(
  '/google/callback',
  async (req: Request, res: Response) => {
    const { code, state } = req.query as Record<string, string>;

    if (!code) {
      res.redirect(`${config.clientUrl}/login?error=google_auth_failed`);
      return;
    }

    let inviteCode = '';
    try {
      const decoded = JSON.parse(Buffer.from(state || '', 'base64url').toString());
      inviteCode = decoded.inviteCode || '';
    } catch { /* ignore bad state */ }

    try {
      // Exchange authorization code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: `${config.apiBaseUrl}/api/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json() as { access_token?: string };

      if (!tokenData.access_token) {
        logger.warn({ tokenData }, 'Google OAuth: failed to get access token');
        res.redirect(`${config.clientUrl}/login?error=google_auth_failed`);
        return;
      }

      // Get user profile from Google
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = await userInfoRes.json() as { email: string; name?: string; given_name?: string; family_name?: string; picture?: string };

      if (!profile.email) {
        res.redirect(`${config.clientUrl}/login?error=google_auth_failed`);
        return;
      }

      // Find or create user and generate JWT pair
      const tokens = await identityService.findOrCreateGoogleUser(
        { email: profile.email, name: profile.name, givenName: profile.given_name, familyName: profile.family_name, picture: profile.picture },
        inviteCode || undefined,
      );

      // Redirect to client with tokens + invite context (if any)
      const params = new URLSearchParams({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      // Preserve invite context so VerifyPage can redirect to /invite/{code}
      if (inviteCode) {
        params.set('inviteCode', inviteCode);
      }
      res.redirect(`${config.clientUrl}/auth/verify?${params}`);
    } catch (err: any) {
      logger.error({ err }, 'Google OAuth callback error');
      const errorCode = err?.code === 'REGISTRATION_BLOCKED' ? 'REGISTRATION_BLOCKED' : 'google_auth_failed';
      res.redirect(`${config.clientUrl}/login?error=${errorCode}`);
    }
  }
);

// ─── Onboarding Complete ───────────────────────────────────────────────────
import { query } from '../db';

router.post('/onboarding/complete', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    await query('UPDATE users SET onboarding_completed = true WHERE id = $1', [userId]);
    res.json({ data: { onboardingCompleted: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
