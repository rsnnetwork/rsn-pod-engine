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
import {
  mintPhotoLinkToken, readPhotoLinkToken, safeRedirectPath, buildOauthState, parseOauthState, applyGooglePhoto,
} from '../services/identity/google-photo-link';

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
            onboardingCompleted: (user as any).onboardingCompleted,
            onboardingStatus: user.onboardingStatus,
            // pg returns Date; the shared contract is ISO string or null
            lastOnboardedAt: (user.lastOnboardedAt as any) instanceof Date ? ((user.lastOnboardedAt as any) as Date).toISOString() : (user.lastOnboardedAt ?? null),
            // Matching-profile free-text fields the profile page reads. getUserById
            // selects these; they must be surfaced here or the profile shows blank
            // even when onboarding (or the form) saved them.
            expertiseText: (user as any).expertiseText,
            whatICareAbout: (user as any).whatICareAbout,
            whatICanHelpWith: (user as any).whatICanHelpWith,
            whoIWantToMeet: (user as any).whoIWantToMeet,
            whyIWantToMeet: (user as any).whyIWantToMeet,
            myIntent: (user as any).myIntent,
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
    // 7 Sep 2026: "Use my Google photo" from the onboarding card. The signed
    // token names the member; the callback attaches the picture to them.
    const photoLinkUserId = readPhotoLinkToken(req.query.photo as string | undefined) ?? undefined;
    const state = buildOauthState({
      inviteCode,
      ...(photoLinkUserId ? { photoLinkUserId, redirect: safeRedirectPath(req.query.redirect as string | undefined) } : {}),
    });

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

// 7 Sep 2026: the onboarding card's "Use my Google photo". Returns the URL
// that walks the signed-in member through Google's consent and straight back.
router.post('/google/photo-state', authenticate, (req: Request, res: Response) => {
  if (!config.googleClientId) {
    res.status(501).json({ success: false, error: { message: 'Google login is not configured' } });
    return;
  }
  const redirect = safeRedirectPath(typeof req.body?.redirect === 'string' ? req.body.redirect : undefined);
  const token = mintPhotoLinkToken(req.user!.userId);
  const url = `${config.apiBaseUrl}/api/auth/google?photo=${encodeURIComponent(token)}&redirect=${encodeURIComponent(redirect)}`;
  res.json({ success: true, data: { url } } satisfies ApiResponse);
});

router.get(
  '/google/callback',
  async (req: Request, res: Response) => {
    const { code, state } = req.query as Record<string, string>;
    const oauthState = parseOauthState(state);
    const inviteCode = oauthState.inviteCode || '';
    // Photo link: the member is already signed in; every exit goes back to
    // where they were, with the outcome in the query string.
    const photoReturn = oauthState.photoLinkUserId ? `${config.clientUrl}${safeRedirectPath(oauthState.redirect)}` : null;
    const fail = (errorCode: string) =>
      res.redirect(photoReturn ? `${photoReturn}?photo=failed` : `${config.clientUrl}/login?error=${errorCode}`);

    if (!code) {
      if (photoReturn) { res.redirect(`${photoReturn}?photo=cancelled`); return; }
      fail('google_auth_failed');
      return;
    }

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
        fail('google_auth_failed');
        return;
      }

      // Get user profile from Google
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = await userInfoRes.json() as { email: string; name?: string; given_name?: string; family_name?: string; picture?: string };

      if (!profile.email) {
        fail('google_auth_failed');
        return;
      }

      // Photo link: attach the picture to the signed-in member and go back.
      // No account lookup by email, no new session.
      if (oauthState.photoLinkUserId && photoReturn) {
        const outcome = await applyGooglePhoto(oauthState.photoLinkUserId, profile.picture);
        res.redirect(`${photoReturn}?photo=${outcome}`);
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
      fail(errorCode);
    }
  }
);

// The old chat onboarding had a second way to finish: POST /auth/onboarding/complete,
// a plain form that set onboarding_completed and onboarding_status itself.
// It was removed on 22 Sep 2026. It seeded no searches, ran no newcomer
// fan-out and emitted nothing, so anyone who finished through it landed on a
// permanently empty Suggestions page — and by then its only caller was a
// screen nothing imported, leaving it reachable by direct request alone.
// POST /onboarding/answers/confirm is the one way to finish now.
export default router;
