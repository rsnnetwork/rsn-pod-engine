// ─── "Use my Google photo" (7 Sep 2026, Ali) ─────────────────────────────────
//
// Google only hands a photo to a site when the person signs in with Google
// and consents; there is no lookup by email address (that endpoint closed in
// 2019). A member who came in through the email link therefore has no photo
// unless LinkedIn or Gravatar had one. This lets them fetch it in one tap
// from the onboarding card: the client asks for a short-lived signed token,
// sends the browser through the normal Google consent screen with that token
// in the OAuth state, and the callback attaches the picture to THAT member
// (never to whichever account the Google email happens to match) and sends
// them back where they were. No new session is issued; they were logged in.

import jwt from 'jsonwebtoken';
import config from '../../config';
import logger from '../../config/logger';
import { query } from '../../db';
import { captureAvatar } from '../onboarding/avatar.service';
import { record as recordStageEvent } from '../onboarding/stage-events.repo';

const PHOTO_LINK_TTL = '15m';
const PHOTO_LINK_PURPOSE = 'google-photo';

export interface GoogleOauthState {
  inviteCode?: string;
  /** Set when the flow only attaches a photo to an already signed-in member. */
  photoLinkUserId?: string;
  /** Client path to return to after a photo link (validated: same-site path only). */
  redirect?: string;
}

/** A token the client carries into GET /auth/google?photo=..., minted for the signed-in member. */
export function mintPhotoLinkToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: PHOTO_LINK_PURPOSE }, config.jwtSecret, { expiresIn: PHOTO_LINK_TTL });
}

/** The member id inside a photo-link token, or null for anything else. */
export function readPhotoLinkToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string; purpose?: string };
    return payload.purpose === PHOTO_LINK_PURPOSE && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Only a same-site path may be a return target; anything else goes to the onboarding page. */
export function safeRedirectPath(redirect: string | undefined): string {
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//')) return '/onboarding';
  return redirect.slice(0, 200);
}

export function buildOauthState(state: GoogleOauthState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

export function parseOauthState(raw: string | undefined): GoogleOauthState {
  try {
    const decoded = JSON.parse(Buffer.from(raw || '', 'base64url').toString()) as GoogleOauthState;
    return {
      inviteCode: typeof decoded.inviteCode === 'string' ? decoded.inviteCode : undefined,
      photoLinkUserId: typeof decoded.photoLinkUserId === 'string' ? decoded.photoLinkUserId : undefined,
      redirect: typeof decoded.redirect === 'string' ? decoded.redirect : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Attach the Google picture to the member. A durable copy is preferred
 * (captureAvatar stores the bytes and serves them from our own endpoint);
 * if that download fails, the Google URL itself is stored so the photo
 * still shows. Returns 'done' when a photo is on the account, 'none' when
 * Google had no picture for that account.
 */
export async function applyGooglePhoto(userId: string, picture: string | undefined): Promise<'done' | 'none'> {
  if (!picture) return 'none';
  const startedAt = Date.now();
  const captured = await captureAvatar(userId, picture);
  if (!captured) {
    await query(`UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2`, [picture, userId]).catch((err) =>
      logger.warn({ err, userId }, 'google photo: could not store the picture url'));
  }
  recordStageEvent(userId, 'photo_captured', { source: 'google' }, Date.now() - startedAt).catch(() => {});
  logger.info({ userId, captured }, 'google photo attached to the member');
  return 'done';
}
