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
const OAUTH_STATE_TTL = '30m';
const OAUTH_STATE_PURPOSE = 'google-oauth-state';

export interface GoogleOauthState {
  inviteCode?: string;
  /** Set when the flow only attaches a photo to an already signed-in member. */
  photoLinkUserId?: string;
  /** Client path to return to after a photo link (validated: same-site path only). */
  redirect?: string;
  /**
   * The site the member started on (7 Oct 2026), so Google brings them back there and not always to the
   * main app. The start resolves it against the exact allow-list in client-origin.ts; the callback resolves
   * it AGAIN before using it, because the redirect it feeds carries live tokens.
   */
  origin?: string;
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

/**
 * The OAuth state, signed (7 Oct 2026). It used to be plain base64 JSON, and the callback trusted the
 * member id in it, so anyone could write a state naming ANOTHER member's photo link, finish Google with
 * their own account, and replace that member's photo. It is now a token signed with the server's secret
 * (the same pattern as the photo-link token), so only the start can write one, and it expires.
 *
 * The `purpose` claim keeps it apart from the other tokens that secret signs. GET /auth/google hands a
 * state to anyone who asks, so no reader of an access or refresh token may take one for the other
 * (middleware/auth.ts and the refresh both require what a state lacks).
 */
export function buildOauthState(state: GoogleOauthState): string {
  return jwt.sign({ ...state, purpose: OAUTH_STATE_PURPOSE }, config.jwtSecret, { expiresIn: OAUTH_STATE_TTL });
}

/** Why a state was refused: one of four classes of reason, never anything the state held. */
type StateRefusal = 'expired' | 'bad signature' | 'wrong purpose' | 'malformed';

function refusalOf(err: unknown): StateRefusal {
  if (err instanceof jwt.TokenExpiredError) return 'expired';
  if (err instanceof jwt.JsonWebTokenError && /signature|algorithm/.test(err.message)) return 'bad signature';
  return 'malformed';
}

/**
 * What a state we signed carries. Anything else (unsigned, edited, signed by another secret or algorithm,
 * expired, of another purpose, not a token at all) reads as no state: the member still signs in with their
 * own Google account, on the main app, with no invite code and no photo link.
 *
 * A refusal is logged, as a warning naming the class of reason (expired, bad signature, wrong purpose,
 * malformed) and nothing else: never the token, which a forger writes and a member's own carries their id.
 * So a probe, or a change that made every real state fail, shows in the logs. A missing state is not a
 * refusal and logs nothing.
 */
export function parseOauthState(raw: string | undefined): GoogleOauthState {
  if (!raw) return {};
  const refuse = (reason: StateRefusal): GoogleOauthState => {
    logger.warn({ reason }, 'Google sign-in state refused');
    return {};
  };
  try {
    const decoded = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') return refuse('malformed');
    if (decoded.purpose !== OAUTH_STATE_PURPOSE) return refuse('wrong purpose');
    return {
      inviteCode: typeof decoded.inviteCode === 'string' ? decoded.inviteCode : undefined,
      photoLinkUserId: typeof decoded.photoLinkUserId === 'string' ? decoded.photoLinkUserId : undefined,
      redirect: typeof decoded.redirect === 'string' ? decoded.redirect : undefined,
      origin: typeof decoded.origin === 'string' ? decoded.origin : undefined,
    };
  } catch (err) {
    return refuse(refusalOf(err));
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
