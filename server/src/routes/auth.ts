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
            onboardingCompleted: (user as any).onboardingCompleted,
            onboardingStatus: user.onboardingStatus,
            lastOnboardedAt: user.lastOnboardedAt,
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
// Enforces mandatory profile capture as part of onboarding. The client posts the
// same required fields it just saved via PUT /users/me — we validate them here
// server-side so a direct API caller can't bypass the onboarding gate by skipping
// the PUT. Required: display_name, company, job_title, industry, reasons_to_connect.
import { query } from '../db';

const onboardingCompleteSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  company: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().min(1).max(200),
  industry: z.string().trim().min(1).max(100),
  reasonsToConnect: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
});

router.post('/onboarding/complete', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req as any).user?.userId || (req as any).user?.id;

    // Validate the submitted required fields. We return field-level errors so the
    // client can surface inline messages on whichever step the user is missing.
    const parsed = onboardingCompleteSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || 'body';
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Profile is incomplete. Please fill all required fields.',
          fields: fieldErrors,
        },
      });
      return;
    }

    const { displayName, company, jobTitle, industry, reasonsToConnect } = parsed.data;

    // Backfill first_name / last_name from displayName when missing. Magic-link
    // signups create users with empty first/last names; profile_complete requires
    // them, so without a backfill those users would be stuck in an onboarding
    // redirect loop forever.
    const currentRow = await query<{ first_name: string | null; last_name: string | null }>(
      `SELECT first_name, last_name FROM users WHERE id = $1`,
      [userId]
    );
    const cur = currentRow.rows[0] || { first_name: null, last_name: null };
    let firstName = (cur.first_name || '').trim();
    let lastName = (cur.last_name || '').trim();
    if (!firstName || !lastName) {
      const parts = displayName.split(/\s+/).filter(Boolean);
      if (!firstName) firstName = parts[0] || displayName;
      if (!lastName) lastName = parts.length > 1 ? parts.slice(1).join(' ') : firstName;
    }

    // Persist the fields on the user record. We don't trust that PUT /users/me was
    // already called — saving them here guarantees the server is the source of truth.
    // Also sets onboarding_status='completed' + last_onboarded_at: D2's route
    // guard redirects on onboarding_status, not onboarding_completed — without
    // this, a user completing via this fallback form would stay
    // 'not_started'/'update_required' and get redirected back into onboarding
    // forever (the loop trap).
    await query(
      `UPDATE users
         SET display_name = $2,
             first_name = $3,
             last_name = $4,
             company = $5,
             job_title = $6,
             industry = $7,
             reasons_to_connect = $8,
             onboarding_completed = true,
             onboarding_status = 'completed',
             last_onboarded_at = NOW()
       WHERE id = $1`,
      [userId, displayName, firstName, lastName, company, jobTitle, industry, reasonsToConnect]
    );

    // Re-compute profile_complete using the same logic as updateUser() so the flag
    // reflects the new values. If any of the other required fields (first/last name)
    // are still missing, profile_complete stays false and the client will send the
    // user back through onboarding — but at minimum the onboarding step inputs
    // persist so the user isn't asked to re-type them on next load.
    const check = await query<{
      first_name: string | null; last_name: string | null; display_name: string | null;
      company: string | null; job_title: string | null; industry: string | null;
      reasons_to_connect: string[] | null;
    }>(
      `SELECT first_name, last_name, display_name, company, job_title, industry, reasons_to_connect
       FROM users WHERE id = $1`,
      [userId]
    );
    const row = check.rows[0];
    const isComplete = !!(
      row &&
      row.first_name && row.last_name && row.display_name &&
      row.company && row.job_title && row.industry &&
      Array.isArray(row.reasons_to_connect) && row.reasons_to_connect.length > 0
    );
    await query('UPDATE users SET profile_complete = $1 WHERE id = $2', [isComplete, userId]);

    res.json({
      success: true,
      data: { onboardingCompleted: true, profileComplete: isComplete },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
