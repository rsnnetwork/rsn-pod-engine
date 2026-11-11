// ─── Identity Service ────────────────────────────────────────────────────────
// Handles user CRUD, magic link authentication, and token management.

import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import {
  User, UserRole, CreateUserInput, UpdateUserInput, AccountKind,
  AuthTokenPair, JwtPayload, ErrorCodes, UserStatusCounts,
} from '@rsn/shared';
import { NotFoundError, ConflictError, UnauthorizedError, AppError } from '../../middleware/errors';
import { invalidateUserStatusCache } from '../../middleware/auth';
import { sendMagicLinkEmail } from '../email/email.service';
import { saveEnrichedCandidate, setEnrichmentState } from '../onboarding/enrichment.repo';
import type { EnrichResult } from '../onboarding/enrichment.service';
import { statusFromResult } from '../onboarding/providers/registry';
import { hasAvatar, tryGravatar } from '../onboarding/avatar.service';
import { bannerUrlFor } from '../user/banner.service';
import { savePicture } from '../user/picture.service';
import { fanoutProfileChange } from '../../realtime/fanout';
import { captureGooglePhoto } from './google-photo-link';
import { assertCanSignIn, signInRefusal } from './account-access';
import { clientOriginConfig, resolveClientBaseUrl } from './client-origin';
import { safeReturnPath } from './return-path';
import {
  SIGN_IN_CODE_MAX_ATTEMPTS, SIGN_IN_CODE_TTL_MINUTES, hashSignInCode, newSignInCode, signInCodeMatches,
} from './sign-in-code';

/**
 * A photo for a member signing in for the first time — but never their
 * LinkedIn one on their behalf.
 *
 * 14 Sep 2026 this captured the approval-time LinkedIn photo straight onto
 * the account. 23 Sep 2026 it stopped: Shradha's deck says nothing reaches a
 * profile unless the member confirms it, and a LinkedIn match can be the
 * wrong person (it was, in Stefan's test). When a LinkedIn photo exists it is
 * OFFERED on the confirm step instead (services/onboarding/linkedin-photo.ts),
 * and nothing here takes that choice away — not even Gravatar, which would
 * fill the slot and hide the offer. With no LinkedIn photo at all, a public
 * Gravatar for their own email is still tried: that is a photo they chose.
 */
function seedPhotoFallback(userId: string, enriched: EnrichResult): void {
  if (enriched.profile?.photoUrl) return;
  hasAvatar(userId)
    .then(async (has) => { if (!has) await tryGravatar(userId); })
    .catch((e) => logger.warn({ err: e, userId }, 'gravatar fallback at first sign-in failed (non-fatal)'));
}

/**
 * The photo a Google sign-in brings, kept as our own copy at 1024 pixels (30 Oct review, T3a, "pictures look
 * pixelated": Google's link is a 96-pixel photo that can change or expire). The link is already on the account, so a
 * photo shows at once; the copy replaces it when the download lands, and the member's screens and pods are told.
 * In the background: a slow download never holds up the sign-in. Never throws.
 */
function keepGooglePhoto(userId: string, picture: string): void {
  captureGooglePhoto(userId, picture)
    .then((kept) => (kept ? fanoutProfileChange(userId) : undefined))
    .catch((e) => logger.warn({ err: e, userId }, 'google photo: could not keep a copy (non-fatal)'));
}

// ─── Registration Gate ──────────────────────────────────────────────────────
// New users can only sign up if they have an approved join request OR a valid invite code.
// Super admin emails are always whitelisted.

const WHITELISTED_EMAILS = [
  'im@mister-raw.com',
  'sa@mister-raw.com',
  'alihamza891840@gmail.com',
];

async function isEmailApproved(email: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM join_requests WHERE email = $1 AND status = 'approved' LIMIT 1`,
    [email.toLowerCase().trim()]
  );
  return result.rows.length > 0;
}

async function hasPendingInviteForEmail(email: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM invites
     WHERE invitee_email = $1
       AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > NOW())
       AND use_count < max_uses
     LIMIT 1`,
    [email.toLowerCase().trim()]
  );
  return result.rows.length > 0;
}

async function assertRegistrationAllowed(email: string, hasValidInvite: boolean): Promise<void> {
  if (WHITELISTED_EMAILS.includes(email.toLowerCase().trim())) return;
  if (hasValidInvite) return; // invite code already validated upstream
  const approved = await isEmailApproved(email);
  if (approved) return;
  // Auto-detect: if someone sent this email ANY invite (pod, event, platform), let them in
  const hasInvite = await hasPendingInviteForEmail(email);
  if (hasInvite) return;
  throw new AppError(
    403,
    ErrorCodes.REGISTRATION_BLOCKED,
    'Registration requires an approved join request or a valid invite code. Please request to join first.'
  );
}

// ─── User Operations ────────────────────────────────────────────────────────

/** A users row as getUserById reads it: the member, plus when their banner last changed while they have one. */
type UserRow = Omit<User, 'bannerUrl'> & { bannerUpdatedAt?: Date | null };

export async function getUserById(id: string): Promise<User> {
  // The banner's time is read only while a picture is kept (21 Oct 2026), and turned into its address
  // below. The picture itself is never read here: it is served on its own by GET /users/:id/banner.
  const result = await query<UserRow>(
    `SELECT id, email, display_name AS "displayName", first_name AS "firstName", last_name AS "lastName",
            avatar_url AS "avatarUrl",
            CASE WHEN banner_blob IS NOT NULL THEN banner_updated_at END AS "bannerUpdatedAt",
            bio, company, job_title AS "jobTitle", industry, location,
            linkedin_url AS "linkedinUrl", website_url AS "websiteUrl", instagram_url AS "instagramUrl",
            x_url AS "xUrl", facebook_url AS "facebookUrl", interests, reasons_to_connect AS "reasonsToConnect",
            languages, timezone, phone,
            expertise_text AS "expertiseText", what_i_care_about AS "whatICareAbout",
            what_i_can_help_with AS "whatICanHelpWith", who_i_want_to_meet AS "whoIWantToMeet",
            why_i_want_to_meet AS "whyIWantToMeet", my_intent AS "myIntent",
            professional_role AS "professionalRole", current_state AS "currentState",
            career_stage AS "careerStage", goals, meeting_preferences AS "meetingPreferences",
            matching_notes AS "matchingNotes",
            invited_by_user_id AS "invitedByUserId",
            role, status, profile_complete AS "profileComplete",
            email_verified AS "emailVerified",
            notify_email AS "notifyEmail", notify_event_reminders AS "notifyEventReminders",
            notify_matches AS "notifyMatches", profile_visible AS "profileVisible",
            invite_opt_out_public_events AS "inviteOptOutPublicEvents",
            onboarding_completed AS "onboardingCompleted",
            onboarding_status AS "onboardingStatus",
            onboarding_version AS "onboardingVersion",
            last_onboarded_at AS "lastOnboardedAt",
            account_kind AS "accountKind",
            last_active_at AS "lastActiveAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM users WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('User', id);
  }
  const { bannerUpdatedAt, ...user } = result.rows[0];
  return { ...user, bannerUrl: bannerUrlFor(user.id, bannerUpdatedAt ?? null) };
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, display_name AS "displayName", first_name AS "firstName", last_name AS "lastName",
            avatar_url AS "avatarUrl", bio, company, job_title AS "jobTitle", industry, location,
            linkedin_url AS "linkedinUrl", interests, reasons_to_connect AS "reasonsToConnect",
            languages, timezone, phone,
            expertise_text AS "expertiseText", what_i_care_about AS "whatICareAbout",
            what_i_can_help_with AS "whatICanHelpWith", who_i_want_to_meet AS "whoIWantToMeet",
            why_i_want_to_meet AS "whyIWantToMeet", my_intent AS "myIntent",
            professional_role AS "professionalRole", current_state AS "currentState",
            career_stage AS "careerStage", goals, meeting_preferences AS "meetingPreferences",
            matching_notes AS "matchingNotes",
            invited_by_user_id AS "invitedByUserId",
            role, status, profile_complete AS "profileComplete",
            email_verified AS "emailVerified",
            notify_email AS "notifyEmail", notify_event_reminders AS "notifyEventReminders",
            notify_matches AS "notifyMatches", profile_visible AS "profileVisible",
            invite_opt_out_public_events AS "inviteOptOutPublicEvents",
            last_active_at AS "lastActiveAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

/** The name a guest goes by before they give one: users.display_name is NOT NULL, and an email is never shown. */
const GUEST_FALLBACK_NAME = 'Guest';

export async function createUser(
  input: CreateUserInput & { accountKind?: AccountKind; guestFirstSessionId?: string },
): Promise<User> {
  const existing = await getUserByEmail(input.email);
  if (existing) {
    throw new ConflictError('USER_ALREADY_EXISTS', 'A user with this email already exists');
  }

  const id = uuid();

  if (input.accountKind === 'event_guest') {
    // An event guest (Part 2, Task 3): someone who joined an event from its link. Their address was proved by the
    // link's code, so it is verified. They are kept out of every discovery list twice over: not onboarded and not
    // visible, besides account_kind itself. Becoming a member (an approved join request, promoteEventGuest) makes
    // them visible and takes them through onboarding.
    const guestName = input.displayName?.trim()
      || `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim()
      || GUEST_FALLBACK_NAME;
    await query(
      `INSERT INTO users (id, email, display_name, first_name, last_name, linkedin_url, role, status, email_verified,
                          account_kind, guest_first_session_id, onboarding_completed, profile_visible)
       VALUES ($1, $2, $3, $4, $5, $6, 'member', 'active', TRUE, 'event_guest', $7, FALSE, FALSE)`,
      [id, input.email.toLowerCase(), guestName, input.firstName ?? '', input.lastName ?? '', input.linkedinUrl || null,
        input.guestFirstSessionId ?? null]
    );
  } else {
    const displayName = input.displayName || `${input.firstName} ${input.lastName}`;
    await query(
      `INSERT INTO users (id, email, display_name, first_name, last_name, linkedin_url, role, status, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, 'member', 'active', FALSE)`,
      [id, input.email.toLowerCase(), displayName, input.firstName, input.lastName, input.linkedinUrl || null]
    );
  }

  // Create default subscription
  await query(
    `INSERT INTO user_subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
    [id]
  );

  // Create default entitlements
  await query(
    `INSERT INTO user_entitlements (user_id) VALUES ($1)`,
    [id]
  );

  return getUserById(id);
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<User> {
  // Verify user exists
  await getUserById(id);

  // Production's own form (origin/main ProfilePage.tsx) still sends a new photo as a data URL in avatarUrl. Since the
  // 30 Oct review (T3a) it is kept the way the pencil keeps one: as a picture behind its own address, cut to the
  // 1024 square, placed in the middle. A picture that is not one is refused before anything is saved. Any other
  // value (a web address, or null) is written as it always was.
  if (typeof input.avatarUrl === 'string' && input.avatarUrl.startsWith('data:')) {
    await savePicture('avatar', id, { image: input.avatarUrl });
    const { avatarUrl: _kept, ...rest } = input;
    input = rest;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const fieldMap: Record<string, string> = {
    displayName: 'display_name',
    firstName: 'first_name',
    lastName: 'last_name',
    avatarUrl: 'avatar_url',
    bio: 'bio',
    company: 'company',
    jobTitle: 'job_title',
    industry: 'industry',
    location: 'location',
    linkedinUrl: 'linkedin_url',
    websiteUrl: 'website_url',
    instagramUrl: 'instagram_url',
    xUrl: 'x_url',
    facebookUrl: 'facebook_url',
    interests: 'interests',
    reasonsToConnect: 'reasons_to_connect',
    languages: 'languages',
    timezone: 'timezone',
    phone: 'phone',
    expertiseText: 'expertise_text',
    whatICareAbout: 'what_i_care_about',
    whatICanHelpWith: 'what_i_can_help_with',
    whoIWantToMeet: 'who_i_want_to_meet',
    whyIWantToMeet: 'why_i_want_to_meet',
    myIntent: 'my_intent',
    notifyEmail: 'notify_email',
    notifyEventReminders: 'notify_event_reminders',
    notifyMatches: 'notify_matches',
    profileVisible: 'profile_visible',
    inviteOptOutPublicEvents: 'invite_opt_out_public_events',
    professionalRole: 'professional_role',
    currentState: 'current_state',
    careerStage: 'career_stage',
    goals: 'goals',
    meetingPreferences: 'meeting_preferences',
    matchingNotes: 'matching_notes',
  };

  for (const [key, dbCol] of Object.entries(fieldMap)) {
    if (key in input) {
      setClauses.push(`${dbCol} = $${paramIndex}`);
      values.push((input as Record<string, unknown>)[key]);
      paramIndex++;
    }
  }

  // 13 Aug 2026 (B1): a title the member types on their own profile is
  // stated, whatever enrichment once proposed.
  if ('jobTitle' in input && String((input as Record<string, unknown>).jobTitle ?? '').trim()) {
    setClauses.push(`job_title_source = 'stated'`);
  }

  if (setClauses.length === 0) {
    return getUserById(id);
  }

  values.push(id);
  await query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
    values
  );

  // Check if profile is now complete. A complete profile has non-empty values for:
  // firstName, lastName, displayName, company, jobTitle, industry, and at least one
  // reasonsToConnect entry. ProtectedRoute gates access on this flag AND
  // onboardingCompleted, so a stale profile_complete=TRUE user won't leak through.
  const user = await getUserById(id);
  const nonEmpty = (s: string | null | undefined) => !!(s && s.trim().length > 0);
  const isComplete = !!(
    nonEmpty(user.firstName) && nonEmpty(user.lastName) && nonEmpty(user.displayName) &&
    nonEmpty(user.company) && nonEmpty(user.jobTitle) && nonEmpty(user.industry) &&
    Array.isArray(user.reasonsToConnect) &&
    user.reasonsToConnect.filter(r => typeof r === 'string' && r.trim().length > 0).length > 0
  );

  if (isComplete !== user.profileComplete) {
    await query(
      'UPDATE users SET profile_complete = $1 WHERE id = $2',
      [isComplete, id]
    );
  }

  return getUserById(id);
}

export async function updateLastActive(userId: string): Promise<void> {
  await query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [userId]);
}

// ─── Magic Link Authentication ──────────────────────────────────────────────

export async function sendMagicLink(
  email: string,
  requestedClientUrl?: string,
  inviteCode?: string,
  returnPath?: string,
): Promise<{ sent: boolean; devLink?: string; devCode?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Allow existing users to log in without gate check — unless the account is
  // closed or suspended, which is said plainly here rather than after a click.
  const existingUser = await getUserByEmail(normalizedEmail);
  assertCanSignIn(existingUser);
  let hasValidInvite = false;

  // Invite codes are optional, and only gate NEW users. An existing user who
  // signs in again through their (now-used, single-use) invite link must not be
  // re-blocked by the "invite already used" check — that locks returning users
  // out of login entirely. Existing accounts skip invite validation here; the
  // !existingUser gate below is the only registration check that applies to them.
  if (inviteCode && !existingUser) {
    const invResult = await query<{ id: string; status: string; use_count: number; max_uses: number; expires_at: Date | null }>(
      `SELECT id, status, use_count, max_uses, expires_at FROM invites WHERE code = $1`,
      [inviteCode]
    );
    if (invResult.rows.length === 0) {
      throw new AppError(400, ErrorCodes.INVALID_INVITE, 'Invalid invite code');
    }
    const inv = invResult.rows[0];
    if (inv.status === 'revoked') {
      throw new AppError(400, ErrorCodes.INVALID_INVITE, 'This invite code has been revoked');
    }
    if (inv.status === 'expired' || (inv.expires_at && new Date(inv.expires_at) < new Date())) {
      throw new AppError(400, ErrorCodes.INVALID_INVITE, 'This invite code has expired');
    }
    if (inv.use_count >= inv.max_uses) {
      throw new AppError(400, ErrorCodes.INVALID_INVITE, 'This invite code has already been used');
    }
    hasValidInvite = true;
  }

  // Gate: new users need approved join request or valid invite
  if (!existingUser) {
    await assertRegistrationAllowed(normalizedEmail, hasValidInvite);
  }

  // Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + config.magicLinkExpiryMinutes * 60 * 1000);
  // The 6-digit code the same email carries (sign-in-code.ts): stored only as a keyed hash bound to this link.
  const code = newSignInCode();
  const codeHash = hashSignInCode(tokenHash, code);

  // Invalidate existing SHORT-LIVED login links for this email, but never the
  // long-lived (7-day) approval "one-click" link. 7 Sep 2026 (Stefan): a member
  // who had an approval link, then tapped "send me a login link", had the
  // approval link silently killed here — clicking it read "invalid or expired".
  // Bounding by expiry keeps this a same-class cleanup (login vs login) and
  // leaves the approval link alone. Phase-7 scoping to purpose='login' kept.
  await query(
    `UPDATE magic_links SET used_at = NOW()
      WHERE email = $1 AND purpose = 'login' AND used_at IS NULL
        AND expires_at > NOW()
        AND expires_at <= NOW() + INTERVAL '2 hours'`,
    [normalizedEmail]
  );

  // Store the hashed token and the hashed code (purpose defaults to 'login').
  await query(
    `INSERT INTO magic_links (email, token_hash, expires_at, code_hash) VALUES ($1, $2, $3, $4)`,
    [normalizedEmail, tokenHash, expiresAt, codeHash]
  );

  // Build the magic link URL. It opens the asking page's origin only when that
  // is one of our own sites (client-origin.ts); anything else gets the main app.
  const clientBaseUrl = resolveClientBaseUrl(requestedClientUrl, clientOriginConfig());
  // Carry the invite code IN THE LINK (Stefan, 9 Jun): a new user invited to an
  // event clicks the magic link from their email — usually a different tab /
  // browser / phone where the login tab's sessionStorage `rsn_redirect` does NOT
  // exist. Without the code in the URL, VerifyPage falls back to '/' (dashboard)
  // and the invitee never reaches the invite-accept step, so they're never
  // registered for the event. The Google-OAuth path already embeds inviteCode in
  // the verify URL; magic link must too so VerifyPage routes them to /invite/:code.
  // 1 Nov 2026: the page the member was going to (a meeting link they followed signed out) rides in the link too,
  // so the verify page lands there even in another tab or on another device. Same-site paths only (return-path.ts).
  const params = new URLSearchParams({ token });
  if (inviteCode) params.set('inviteCode', inviteCode);
  const back = safeReturnPath(returnPath);
  if (back) params.set('redirect', back);
  const magicLinkUrl = `${clientBaseUrl}/auth/verify?${params.toString()}`;

  // In development, return the link and the code directly (also send email if configured). Never in production:
  // config.isDev is true only when NODE_ENV is development.
  if (config.isDev) {
    logger.info({ email: normalizedEmail, magicLinkUrl }, 'Magic link generated (dev mode)');
    // Still try to send email in dev if Resend is configured
    if (config.resendApiKey) {
      try {
        await sendMagicLinkEmail(normalizedEmail, magicLinkUrl, code);
      } catch (error) {
        logger.warn({ error, email: normalizedEmail }, 'Email send failed in dev mode; returning devLink');
      }
    }
    return { sent: true, devLink: magicLinkUrl, devCode: code };
  }

  // Production: send email via Resend
  await sendMagicLinkEmail(normalizedEmail, magicLinkUrl, code);
  logger.info({ email: normalizedEmail }, 'Magic link email sent');
  return { sent: true };
}

// Short window during which an ALREADY-USED magic link may still be re-verified.
// Corporate email security scanners (Microsoft Defender/SafeLinks, Mimecast,
// Proofpoint, etc.) PRE-FETCH every link in an email to scan it — that fetch runs
// the verify and burns the one-time token seconds before the human clicks, so the
// real click would otherwise fail with "already used" on a brand-new link (exactly
// what blocked corporate attendees). Within this window we re-verify idempotently
// (same email → same login). The 60-min expiry is still the real lifetime; this
// only tolerates a near-simultaneous second hit (scanner pre-fetch / double-click).
const MAGIC_LINK_REUSE_GRACE_MS = 2 * 60 * 1000;

/**
 * Seed values for a new account created via an approved join request: the real
 * name + LinkedIn the applicant submitted. Falls back to the email prefix when
 * there's no approved request (invite / other paths). This is what lets onboarding
 * take the fast high-confidence LinkedIn path instead of a slow name search.
 */
async function getApprovedJoinRequestSeed(email: string): Promise<{
  firstName: string;
  lastName: string;
  displayName: string;
  linkedinUrl: string | null;
  enriched: (EnrichResult & { provider?: string | null }) | null;
  reason: string | null;
}> {
  const fallback = {
    firstName: '',
    lastName: '',
    displayName: email.split('@')[0],
    linkedinUrl: null as string | null,
    enriched: null as (EnrichResult & { provider?: string | null }) | null,
    reason: null as string | null,
  };
  try {
    const r = await query<{ full_name: string | null; linkedin_url: string | null; enriched: (EnrichResult & { provider?: string | null }) | null; reason: string | null }>(
      `SELECT full_name, linkedin_url, enriched, reason FROM join_requests
        WHERE lower(email) = lower($1) AND status = 'approved'
        ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    const jr = r.rows[0];
    if (!jr) return fallback;
    const linkedinUrl = jr.linkedin_url?.trim() || null;
    const enriched = jr.enriched && typeof jr.enriched === 'object' ? jr.enriched : null;
    const reason = jr.reason?.trim() || null;
    const name = (jr.full_name || '').trim();
    if (!name) return { ...fallback, linkedinUrl, enriched, reason };
    const parts = name.split(/\s+/);
    return {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      displayName: name,
      linkedinUrl,
      enriched,
      reason,
    };
  } catch {
    return fallback;
  }
}

export async function verifyMagicLink(token: string): Promise<AuthTokenPair> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Find the magic link. Only a LOGIN link can sign anyone in. The Approve and Reject buttons in an
  // admin's email are rows in this table too (purpose 'join_request_review', bound to that admin by
  // admin-action-tokens.service.ts), and they must never be a way in: before 21 Oct 2026 posting one
  // here signed in the admin it was made for, and spent the link. A link of any other purpose is simply
  // not found, so it is refused exactly like a token nobody issued: not marked used, no account made,
  // nothing said about what it is. (The column is NOT NULL DEFAULT 'login' since migration 058, so
  // every link made before purposes existed is a login link.)
  const result = await query<{ id: string; email: string; expires_at: Date; used_at: Date | null }>(
    `SELECT id, email, expires_at, used_at FROM magic_links WHERE token_hash = $1 AND purpose = 'login'`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid magic link');
  }

  const magicLink = result.rows[0];

  // Time expiry is always enforced.
  if (new Date(magicLink.expires_at) < new Date()) {
    throw new AppError(400, 'AUTH_MAGIC_LINK_EXPIRED', 'This magic link has expired');
  }

  // Single-use, but tolerant of a near-simultaneous second hit (scanner pre-fetch
  // / double-click) within the reuse grace — see MAGIC_LINK_REUSE_GRACE_MS.
  if (magicLink.used_at) {
    const usedAgoMs = Date.now() - new Date(magicLink.used_at).getTime();
    if (usedAgoMs > MAGIC_LINK_REUSE_GRACE_MS) {
      throw new AppError(400, 'AUTH_MAGIC_LINK_USED', 'This magic link has already been used');
    }
    // within grace → idempotent re-verify; don't re-stamp used_at, fall through
  } else {
    await query('UPDATE magic_links SET used_at = NOW() WHERE id = $1', [magicLink.id]);
  }

  return signInByEmail(magicLink.email);
}

/**
 * The session a spent sign-in link or sign-in code gives (1 Nov 2026: the code reuses it, so the two can never
 * sign anyone in differently). The caller has already proved the link or the code and spent it.
 */
async function signInByEmail(email: string): Promise<AuthTokenPair> {
  // Find or create the user (handle concurrent verify race condition).
  //
  // NO registration gate here. sendMagicLink already enforces assertRegistration
  // Allowed at SEND time WITH the invite context — a magic link is only ever
  // issued to a NEW email when registration was permitted (a valid invite,
  // including an open/shared event link, or an approved join request). Re-running
  // the gate here with hasValidInvite=false cannot see the invite the user arrived
  // through, so it wrongly rejected legitimate signups via the shared link — the
  // account was never created and the user saw a fresh link as "expired". The
  // send-time gate is the single source of truth; the link's existence is proof
  // registration was allowed.
  let user = await getUserByEmail(email);
  // No session for a closed or suspended account: the next request would
  // refuse it anyway, and the member would be bounced with no reason.
  assertCanSignIn(user);
  if (!user) {
    // Seed name + LinkedIn from the applicant's approved join request so onboarding
    // can use the fast high-confidence LinkedIn path (falls back to email prefix).
    const seed = await getApprovedJoinRequestSeed(email);
    try {
      user = await createUser({
        email,
        firstName: seed.firstName,
        lastName: seed.lastName,
        displayName: seed.displayName,
        linkedinUrl: seed.linkedinUrl,
      });
    } catch (err: any) {
      // Race condition: another request created the user between our check and insert
      if (err?.code === '23505' || err?.message?.includes('already exists')) {
        user = await getUserByEmail(email);
        if (!user) throw err; // Should never happen, but rethrow if it does
      } else {
        throw err;
      }
    }
    // Copy the preloaded enrichment from the approved join request onto the new
    // user's profile, so onboarding shows a fully-populated card with zero wait
    // (the ~50s lookup already ran at approval time).
    if (user && seed.enriched && seed.enriched.confidence > 0) {
      await saveEnrichedCandidate(user.id, seed.enriched).catch((e) =>
        logger.warn({ err: e, userId: user!.id }, 'failed to copy preloaded enrichment')
      );
      // Also seed the enrichment STATE machine (user_intent_profiles.enrichment_*)
      // from the same blob, using the SAME confidence→status mapping the
      // orchestrator's 90-day cache-hit path uses (statusFromResult,
      // providers/registry.ts) — so GET /onboarding/status already returns
      // found/partial on this member's very first call instead of 'none' (the
      // ~3-5s "searching" flash the client used to show while its own trigger
      // caught up to the already-cached candidate). Best-effort, same
      // discipline as saveEnrichedCandidate above: a write failure must never
      // break login.
      await setEnrichmentState(user.id, {
        status: statusFromResult(seed.enriched),
        // The preload blob carries the RESOLVED provider that produced it
        // (join-request.service.ts stashes it at preload time). Blobs written
        // before that field existed — including ones from the legacy
        // claude_web rollback path, which stays live for up to 30 days on an
        // approved-but-unactivated join request — carry no provider, and null
        // is the honest value there: the same discipline the orchestrator's
        // own `source: null` writes already use, not a guess at which
        // provider actually ran.
        source: seed.enriched.provider ?? null,
        startedAt: seed.enriched.enrichedAt,
        completedAt: seed.enriched.enrichedAt,
      }).catch((e) =>
        logger.warn({ err: e, userId: user!.id }, 'failed to copy preloaded enrichment state')
      );
      seedPhotoFallback(user.id, seed.enriched);
    }
    // Seed their stated reason for joining as an initial "why I want to meet" — the
    // onboarding chat refines/overrides it (kept if the chat doesn't restate one).
    if (user && seed.reason) {
      await query('UPDATE users SET why_i_want_to_meet = $1 WHERE id = $2', [seed.reason, user.id]).catch(() => {});
    }
  }

  // Mark email as verified
  if (!user.emailVerified) {
    await query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
  }

  // Update last active
  await updateLastActive(user.id);

  // Generate auth tokens
  return generateTokenPair(user);
}

// ─── The 6-digit sign-in code (1 Nov 2026, sign-in-code.ts) ─────────────────

/** A link that carries a 6-digit code, as spendSignInCode reads it (SIGN_IN_CODE_COLUMNS). */
export interface SignInCodeRow {
  id: string;
  email: string;
  token_hash: string;
  code_hash: string;
  used_at: Date | null;
  code_attempts: number;
  code_live: boolean;
  link_live: boolean;
}

/** The columns spendSignInCode reads (SignInCodeRow); $2 is the code's life in minutes. */
export const SIGN_IN_CODE_COLUMNS = `id, email, token_hash, code_hash, used_at, code_attempts,
       created_at > NOW() - make_interval(mins => $2::int) AS code_live, expires_at > NOW() AS link_live`;

/** A wrong code, or no code to try: one refusal for every purpose, so the answer never tells which it was. */
export const codeWrong = (attemptsLeft?: number) => new AppError(
  400, ErrorCodes.AUTH_SIGN_IN_CODE_WRONG, 'That code is not right.', attemptsLeft === undefined ? undefined : { attemptsLeft },
);

/** Why this link's code can no longer be used, or null while it can. Locked first: it explains the rest. */
function signInCodeRefusal(row: SignInCodeRow): AppError | null {
  if (row.code_attempts >= SIGN_IN_CODE_MAX_ATTEMPTS) {
    return new AppError(400, ErrorCodes.AUTH_SIGN_IN_LOCKED, 'This code was entered wrongly too many times.');
  }
  if (row.used_at) return new AppError(400, ErrorCodes.AUTH_MAGIC_LINK_USED, 'This code has already been used');
  if (!row.code_live || !row.link_live) return new AppError(400, ErrorCodes.AUTH_SIGN_IN_CODE_EXPIRED, 'This code has expired');
  return null;
}

/**
 * Sign in with the 6-digit code from the sign-in email: the same session the link gives.
 *
 * Only the newest login link of that email that carries a code is tried (asking again kills the older ones, in
 * sendMagicLink). A try is reserved before the code is compared, in one statement that refuses once five have been
 * made, so even tries sent all at once compare at most five codes. A wrong fifth try kills the link and the code
 * together: the link's expiry is pulled to now, so it is refused at once rather than after the scanner grace.
 * The right code spends the link (and gives back the try it reserved, so only wrong tries count).
 */
export async function verifySignInCode(email: string, code: string): Promise<AuthTokenPair> {
  const normalizedEmail = email.toLowerCase().trim();
  const found = await query<SignInCodeRow>(
    `SELECT ${SIGN_IN_CODE_COLUMNS}
       FROM magic_links WHERE email = $1 AND purpose = 'login' AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [normalizedEmail, SIGN_IN_CODE_TTL_MINUTES]
  );
  const link = found.rows[0];
  if (!link) throw codeWrong();
  await spendSignInCode(link, code);
  return signInByEmail(link.email);
}

/**
 * Try `code` against one link's code, and spend the link when it is right (1 Nov 2026; extracted 11 Nov 2026 so the
 * RSN Call link's entry code is held to exactly the same rules). A link that can no longer take a code is refused
 * first. A try is reserved before the code is compared, in one statement that refuses once five have been made; a wrong
 * fifth try kills the link and the code together (its expiry is pulled to now); the right code spends the link and
 * gives back the try it reserved, so only wrong tries count. Throws on every refusal; returns once the link is spent.
 */
export async function spendSignInCode(
  link: SignInCodeRow,
  code: string,
  beforeClaim?: () => Promise<void>,
): Promise<void> {
  const refusal = signInCodeRefusal(link);
  if (refusal) throw refusal;

  const reserved = await query<{ code_attempts: number }>(
    `UPDATE magic_links SET code_attempts = code_attempts + 1
      WHERE id = $1 AND used_at IS NULL AND code_attempts < $2 RETURNING code_attempts`,
    [link.id, SIGN_IN_CODE_MAX_ATTEMPTS]
  );
  if (!reserved.rows[0]) {
    // Another try spent the last attempt, or the link, between the read and now.
    const now = await query<SignInCodeRow>(
      `SELECT ${SIGN_IN_CODE_COLUMNS} FROM magic_links WHERE id = $1`,
      [link.id, SIGN_IN_CODE_TTL_MINUTES]
    );
    throw (now.rows[0] && signInCodeRefusal(now.rows[0])) || codeWrong();
  }
  const attempts = reserved.rows[0].code_attempts;

  if (!signInCodeMatches(link.token_hash, code, link.code_hash)) {
    if (attempts < SIGN_IN_CODE_MAX_ATTEMPTS) throw codeWrong(SIGN_IN_CODE_MAX_ATTEMPTS - attempts);
    await query(
      `UPDATE magic_links SET used_at = COALESCE(used_at, NOW()), expires_at = LEAST(expires_at, NOW()) WHERE id = $1`,
      [link.id]
    );
    // Logged by the member's id (and the link's), never their email address: no PII in the logs.
    const member = await getUserByEmail(link.email);
    logger.warn({ userId: member?.id ?? null, magicLinkId: link.id }, 'Sign-in code locked after too many wrong tries');
    throw new AppError(400, ErrorCodes.AUTH_SIGN_IN_LOCKED, 'This code was entered wrongly too many times.');
  }

  // The code is right. A caller that still has to decide something about the proved address (the RSN Call link's
  // admission rule, 11 Nov 2026 fix round) does it now: a refusal gives back the try and leaves the link unspent, so the
  // same code can be sent again with what was missing (an admission code). Sign-in passes nothing: unchanged.
  if (beforeClaim) {
    try {
      await beforeClaim();
    } catch (err) {
      await query(`UPDATE magic_links SET code_attempts = code_attempts - 1 WHERE id = $1 AND used_at IS NULL`, [link.id]);
      throw err;
    }
  }

  const claimed = await query<{ id: string }>(
    `UPDATE magic_links SET used_at = NOW(), code_attempts = code_attempts - 1
      WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [link.id]
  );
  if (!claimed.rows[0]) throw new AppError(400, ErrorCodes.AUTH_MAGIC_LINK_USED, 'This code has already been used');
}

// ─── The RSN Call link's entry code (Part 2 foundation, Task 6, 11 Nov 2026) ─

// An event's link (services/session/call-entry.service.ts) proves an email the same way sign-in does: a magic_links
// row with a 6-digit code, spent through spendSignInCode, with the sign-in code's 15-minute life and five tries. The
// row is kept apart from sign-in by its purpose and bound to one event by target_id, so a sign-in code is never an
// entry code (and the reverse), and an entry code for one event is wrong for every other.

const EVENT_ENTRY_PURPOSE = 'event_entry';

/**
 * Issue an entry link and code for `email` on `sessionId`: the address's earlier unused entry links for that event are
 * spent and expired first (only the newest code works, and an older email's button keeps no scanner grace), then a new one is stored, its token and code as hashes only. The link
 * lives as long as a sign-in link (60 minutes); its code 15.
 */
export async function issueEventEntryLink(email: string, sessionId: string): Promise<{ token: string; code: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + config.magicLinkExpiryMinutes * 60 * 1000);
  const code = newSignInCode();
  const codeHash = hashSignInCode(tokenHash, code);
  await query(
    `UPDATE magic_links SET used_at = NOW(), expires_at = LEAST(expires_at, NOW())
      WHERE email = $1 AND purpose = '${EVENT_ENTRY_PURPOSE}' AND target_id = $2 AND used_at IS NULL`,
    [normalizedEmail, sessionId],
  );
  await query(
    `INSERT INTO magic_links (email, token_hash, expires_at, code_hash, purpose, target_id)
     VALUES ($1, $2, $3, $4, '${EVENT_ENTRY_PURPOSE}', $5)`,
    [normalizedEmail, tokenHash, expiresAt, codeHash, sessionId],
  );
  return { token, code };
}

/**
 * Prove `email` for `sessionId` with the 6-digit entry code: only the newest entry link of that address for that event
 * is tried, under spendSignInCode's rules. `admit` runs once the code is proved right and before the link is spent: a
 * refusal there leaves the link unspent and its try given back. Answers the proved address.
 */
export async function verifyEventEntryCode(
  email: string,
  sessionId: string,
  code: string,
  admit?: (provedEmail: string) => Promise<void>,
): Promise<string> {
  const normalizedEmail = email.toLowerCase().trim();
  const found = await query<SignInCodeRow>(
    `SELECT ${SIGN_IN_CODE_COLUMNS}
       FROM magic_links
      WHERE email = $1 AND purpose = '${EVENT_ENTRY_PURPOSE}' AND target_id = $3 AND code_hash IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [normalizedEmail, SIGN_IN_CODE_TTL_MINUTES, sessionId],
  );
  const link = found.rows[0];
  if (!link) throw codeWrong();
  await spendSignInCode(link, code, admit ? () => admit(link.email) : undefined);
  // The email's button dies with its code (fix round 1): a link spent by the code keeps no scanner grace.
  await query(`UPDATE magic_links SET expires_at = LEAST(expires_at, NOW()) WHERE id = $1`, [link.id]);
  return link.email;
}

/**
 * Prove an address for `sessionId` with the button in the entry email: the token of an entry link for that event, single
 * use with the same 2-minute scanner grace as a sign-in link (verifyMagicLink) when the button itself spent it, refused
 * once expired (a code locked after five wrong tries, or a right code, has pulled its expiry to now). `admit` runs before
 * the link is spent. Answers the proved address.
 */
export async function verifyEventEntryToken(
  token: string,
  sessionId: string,
  admit?: (provedEmail: string) => Promise<void>,
): Promise<string> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await query<{ id: string; email: string; expires_at: Date; used_at: Date | null }>(
    `SELECT id, email, expires_at, used_at FROM magic_links
      WHERE token_hash = $1 AND purpose = '${EVENT_ENTRY_PURPOSE}' AND target_id = $2`,
    [tokenHash, sessionId],
  );
  const link = result.rows[0];
  if (!link) throw new UnauthorizedError('This link is not valid. Ask for a new code.');
  if (new Date(link.expires_at).getTime() <= Date.now()) {
    throw new AppError(400, ErrorCodes.AUTH_MAGIC_LINK_EXPIRED, 'This link has expired. Ask for a new code.');
  }
  // A refusal (the event does not take this address) leaves the link as it was.
  if (admit) await admit(link.email);
  if (link.used_at) {
    if (Date.now() - new Date(link.used_at).getTime() > MAGIC_LINK_REUSE_GRACE_MS) {
      throw new AppError(400, ErrorCodes.AUTH_MAGIC_LINK_USED, 'This link has already been used. Ask for a new code.');
    }
  } else {
    await query('UPDATE magic_links SET used_at = NOW() WHERE id = $1 AND used_at IS NULL', [link.id]);
  }
  return link.email;
}

/**
 * The session an entry code (or entry link) gives, for an address it has just proved. An existing account signs in as
 * it is (its kind unchanged; a closed or suspended one is refused). An address with no account becomes an event guest
 * of this event (createUser: verified, not onboarded, not visible, named 'Guest' until the details step), race-safe as
 * signInByEmail: a second verify that lost the insert reads the row the first one made.
 */
export async function signInForEventEntry(
  email: string,
  sessionId: string,
): Promise<AuthTokenPair & { accountKind: AccountKind; created: boolean }> {
  const normalizedEmail = email.toLowerCase().trim();
  let user = await getUserByEmail(normalizedEmail);
  assertCanSignIn(user);
  let created = false;
  if (!user) {
    try {
      user = await createUser({
        email: normalizedEmail, firstName: '', lastName: '', accountKind: 'event_guest', guestFirstSessionId: sessionId,
      });
      created = true;
    } catch (err: unknown) {
      const raced = (err as { code?: string })?.code === '23505'
        || (err instanceof ConflictError && err.code === 'USER_ALREADY_EXISTS');
      if (!raced) throw err;
      user = await getUserByEmail(normalizedEmail);
      if (!user) throw err;
      assertCanSignIn(user);
    }
  }
  if (!user.emailVerified) await query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
  await updateLastActive(user.id);
  const kind = await query<{ account_kind: AccountKind }>(`SELECT account_kind FROM users WHERE id = $1`, [user.id]);
  const tokens = await generateTokenPair(user);
  return { ...tokens, accountKind: kind.rows[0]?.account_kind ?? 'member', created };
}

// ─── Token Management ───────────────────────────────────────────────────────

/** A fresh access and refresh token pair for `user`, the refresh token's hash stored before it is handed out. */
export async function generateTokenPair(user: User): Promise<AuthTokenPair> {
  const sessionId = uuid();

  const accessPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName || user.email,
    sessionId,
  };

  const accessToken = jwt.sign(accessPayload, config.jwtSecret, {
    expiresIn: config.jwtAccessExpiry as unknown as number,
  });

  const refreshToken = jwt.sign(
    { sub: user.id, sessionId, type: 'refresh' },
    config.jwtSecret,
    { expiresIn: config.jwtRefreshExpiry as unknown as number }
  );

  // Store refresh token hash. AWAITED — 7 Sep 2026 (Stefan's test): this used to
  // be fire-and-forget, so a client could be handed a refresh token whose row
  // was not committed yet (or failed to write silently). The very next refresh
  // then hit "revoked or not found" → 401 → the client logged the user out
  // mid-session. Await the store so login/refresh fails cleanly instead of
  // issuing a pair the server can never honour.
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, refreshHash, refreshExpiry]
  );

  const decoded = jwt.decode(accessToken) as JwtPayload;

  return {
    accessToken,
    refreshToken,
    expiresAt: decoded.exp * 1000,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<AuthTokenPair> {
  try {
    const payload = jwt.verify(refreshToken, config.jwtSecret) as { sub: string; sessionId: string; type: string };

    if (payload.type !== 'refresh') {
      throw new UnauthorizedError('Invalid token type');
    }

    // Verify the refresh token hash exists and is not revoked
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const result = await query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2`,
      [hash, payload.sub]
    );

    if (result.rows.length === 0 || result.rows[0].revoked_at) {
      // Deleting an account revokes its tokens, so a member whose account was
      // closed mid-session lands here. Tell them that, not "token revoked".
      const owner = await getUserById(payload.sub).catch(() => null);
      const refusal = signInRefusal(owner?.status);
      if (refusal) throw new AppError(401, refusal.code, refusal.message);
      throw new UnauthorizedError('Refresh token revoked or not found');
    }

    // Revoke the old refresh token (rotation)
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [result.rows[0].id]);

    // Get user, verify active, and generate new pair
    const user = await getUserById(payload.sub);
    const refusal = signInRefusal(user.status);
    if (refusal) {
      // Still a 401, so the client ends the session; the code tells it why.
      throw new AppError(401, refusal.code, refusal.message);
    }
    return generateTokenPair(user);
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new UnauthorizedError('Invalid refresh token');
  }
}

// ─── Google OAuth ───────────────────────────────────────────────────────────

export async function findOrCreateGoogleUser(
  profile: { email: string; name?: string; givenName?: string; familyName?: string; picture?: string },
  inviteCode?: string,
): Promise<AuthTokenPair> {
  const normalizedEmail = profile.email.toLowerCase().trim();
  let user = await getUserByEmail(normalizedEmail);

  if (!user) {
    // New user — require approved join request or valid invite code
    let inviteId: string | null = null;
    let inviterId: string | null = null;
    let hasValidInvite = false;

    if (inviteCode) {
      const invResult = await query<{ id: string; status: string; use_count: number; max_uses: number; expires_at: Date | null; inviter_id: string }>(
        `SELECT id, status, use_count, max_uses, expires_at, inviter_id FROM invites WHERE code = $1`,
        [inviteCode]
      );
      if (invResult.rows.length === 0) {
        throw new AppError(400, ErrorCodes.INVALID_INVITE, 'Invalid invite code');
      }
      const inv = invResult.rows[0];
      if (inv.status === 'revoked' || inv.status === 'expired' ||
          (inv.expires_at && new Date(inv.expires_at) < new Date()) ||
          inv.use_count >= inv.max_uses) {
        throw new AppError(400, ErrorCodes.INVALID_INVITE, 'This invite code is no longer valid');
      }
      inviteId = inv.id;
      inviterId = inv.inviter_id;
      hasValidInvite = true;
    }

    // Gate: require approved join request or valid invite
    await assertRegistrationAllowed(normalizedEmail, hasValidInvite);

    // Seed from the applicant's approved join request — SAME behavior as the
    // magic-link path (verifyMagicLink). Google sign-in used to skip this, so a
    // member who gave their LinkedIn + reason at request time was asked for the
    // LinkedIn again and lost the reason + preloaded enrichment (Stefan, 2 Jul).
    const seed = await getApprovedJoinRequestSeed(normalizedEmail);

    // Create the user.
    //
    // T1-2 (Issue 1) — invited users get onboarding_completed=TRUE so they
    // can join their event/pod immediately without being intercepted by
    // the onboarding gate. They can complete profile fields later via the
    // non-blocking banner in AppLayout. Direct sign-ups (no invite) still
    // default to onboarding_completed=FALSE so they're prompted to fill
    // out the profile on first visit.
    const id = uuid();
    // Google's verified name wins; the join-request name is the fallback.
    const displayName = profile.name || seed.displayName || normalizedEmail.split('@')[0];
    const firstName = profile.givenName || (profile.name ? profile.name.split(' ')[0] : '') || seed.firstName;
    const lastName = profile.familyName || (profile.name && profile.name.includes(' ') ? profile.name.split(' ').slice(1).join(' ') : '') || seed.lastName;
    const onboardingCompletedDefault = inviteId !== null;
    await query(
      `INSERT INTO users (id, email, display_name, first_name, last_name, avatar_url, invited_by_user_id, role, status, email_verified, onboarding_completed, linkedin_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'member', 'active', TRUE, $8, $9)`,
      [id, normalizedEmail, displayName, firstName, lastName, profile.picture || null, inviterId, onboardingCompletedDefault, seed.linkedinUrl]
    );
    // Copy the preloaded enrichment (ran at approval) + seed the stated reason,
    // exactly as verifyMagicLink does — instant card, no re-asking.
    if (seed.enriched && seed.enriched.confidence > 0) {
      await saveEnrichedCandidate(id, seed.enriched).catch((e) =>
        logger.warn({ err: e, userId: id }, 'failed to copy preloaded enrichment (google path)')
      );
      // Same enrichment-state seeding as verifyMagicLink — see its comment
      // for the confidence→status mapping + source-value rationale.
      await setEnrichmentState(id, {
        status: statusFromResult(seed.enriched),
        source: seed.enriched.provider ?? null,
        startedAt: seed.enriched.enrichedAt,
        completedAt: seed.enriched.enrichedAt,
      }).catch((e) =>
        logger.warn({ err: e, userId: id }, 'failed to copy preloaded enrichment state (google path)')
      );
      seedPhotoFallback(id, seed.enriched);
    }
    if (seed.reason) {
      await query('UPDATE users SET why_i_want_to_meet = $1 WHERE id = $2', [seed.reason, id]).catch(() => {});
    }
    await query(`INSERT INTO user_subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`, [id]);
    await query(`INSERT INTO user_entitlements (user_id) VALUES ($1)`, [id]);

    // Accept the invite exactly as the invite page does (acceptInvite): bound to this Google address when the invite
    // names one (IDENTITY_MISMATCH otherwise), its pod or event through the same gates as every other way in
    // (pod.service addMember, registerParticipant with viaInvite: an invitation-only event admits only a personal
    // invite), and the accepter recorded only if nobody accepted first. Part 2 Task 4 fix round 1: this path used to
    // write the accepter over any earlier one and insert the event place directly, past every rule. A refusal never
    // stops the sign-in: the account exists, and the invite page the verify link leads to says what happened.
    if (inviteId && inviteCode) {
      try {
        const { acceptInvite } = await import('../invite/invite.service');
        const accepted = await acceptInvite(inviteCode, id, normalizedEmail);
        logger.info({ userId: id, registeredFor: accepted.registeredFor }, 'Google OAuth: invite accepted');
      } catch (err) {
        logger.warn({ err, userId: id }, 'Google OAuth: the invite was not applied at sign-up');
      }
    }

    user = await getUserById(id);
    logger.info({ userId: id, email: normalizedEmail }, 'Google OAuth: new user created');
    if (profile.picture) keepGooglePhoto(id, profile.picture);
  } else {
    assertCanSignIn(user);
    // Update avatar if provided and user doesn't have one
    if (profile.picture && !user.avatarUrl) {
      await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [profile.picture, user.id]);
      keepGooglePhoto(user.id, profile.picture);
    }
    if (!user.emailVerified) {
      await query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
    }
  }

  await updateLastActive(user.id);
  return generateTokenPair(user);
}

export async function logout(userId: string, sessionId: string, refreshToken?: string): Promise<void> {
  if (refreshToken) {
    // Revoke only the specific refresh token — other devices/tabs keep their sessions
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
      [userId, tokenHash]
    );
  } else {
    // Fallback: revoke all tokens (backward compatibility if client doesn't send token)
    await query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  }
  logger.info({ userId, sessionId, specific: !!refreshToken }, 'User logged out');
}

export async function getUsers(params: {
  page?: number;
  pageSize?: number;
  role?: UserRole;
  status?: 'active' | 'suspended' | 'banned' | 'deactivated';
  search?: string;
  industry?: string;
  /** Leave out anyone blocked in either direction with this member (26 Oct 2026: the admin's invite search). */
  notBlockedWith?: string;
  /** Also count each status for the same filters (the admin Users page's tabs, T2). */
  withStatusCounts?: boolean;
}): Promise<{ users: User[]; total: number; statusCounts?: UserStatusCounts }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE 1=1';
  const values: unknown[] = [];
  let paramIdx = 1;

  if (params.role) {
    whereClause += ` AND role = $${paramIdx}`;
    values.push(params.role);
    paramIdx++;
  }

  // T2 (1 Nov 2026): the status is added last of the filters, after the counts per status below have been read with
  // every other filter (so each tab of the admin Users page says how many it holds for the same search).
  let statusFilter: { clause: string; value: string } | null = null;
  if (params.status) {
    statusFilter = { clause: ` AND status = $`, value: params.status };
  }

  if (params.search) {
    const prefixParam = paramIdx;
    values.push(`${params.search}%`);
    paramIdx++;
    // Short queries (1-2 chars): prefix-only on names — "c" finds "Chief" and "Claus", not "Mac"
    // Longer queries (3+): also search contains on names + emails for broader matching
    if (params.search.length <= 2) {
      whereClause += ` AND (
        display_name ILIKE $${prefixParam} OR first_name ILIKE $${prefixParam} OR last_name ILIKE $${prefixParam}
      )`;
    } else {
      const containsParam = paramIdx;
      values.push(`%${params.search}%`);
      paramIdx++;
      whereClause += ` AND (
        display_name ILIKE $${prefixParam} OR first_name ILIKE $${prefixParam} OR last_name ILIKE $${prefixParam}
        OR display_name ILIKE $${containsParam} OR email ILIKE $${containsParam}
      )`;
    }
  }

  if (params.industry) {
    whereClause += ` AND industry ILIKE $${paramIdx}`;
    values.push(`%${params.industry}%`);
    paramIdx++;
  }

  if (params.notBlockedWith) {
    whereClause += ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $${paramIdx} AND b.blocked_id = users.id) OR (b.blocker_id = users.id AND b.blocked_id = $${paramIdx}))`;
    values.push(params.notBlockedWith);
    paramIdx++;
  }

  let statusCounts: UserStatusCounts | undefined;
  if (params.withStatusCounts) {
    const byStatus = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM users ${whereClause} GROUP BY status`,
      values
    );
    statusCounts = { active: 0, suspended: 0, deactivated: 0, banned: 0 };
    for (const row of byStatus.rows) {
      if (row.status in statusCounts) statusCounts[row.status as keyof UserStatusCounts] = parseInt(row.count, 10);
    }
  }

  if (statusFilter) {
    whereClause += `${statusFilter.clause}${paramIdx}`;
    values.push(statusFilter.value);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM users ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Relevance scoring: name-starts-with first, name-contains second, email-only last
  let relevanceOrder = '';
  if (params.search) {
    const relPrefix = paramIdx;
    values.push(`${params.search.toLowerCase()}%`);
    paramIdx++;
    if (params.search.length <= 2) {
      // Short query: only prefix relevance (no contains params needed)
      relevanceOrder = `CASE
        WHEN LOWER(display_name) LIKE $${relPrefix} OR LOWER(first_name) LIKE $${relPrefix} THEN 0
        WHEN LOWER(last_name) LIKE $${relPrefix} THEN 1
        ELSE 2 END ASC,`;
    } else {
      const relContains = paramIdx;
      values.push(`%${params.search.toLowerCase()}%`);
      paramIdx++;
      relevanceOrder = `CASE
        WHEN LOWER(display_name) LIKE $${relPrefix} OR LOWER(first_name) LIKE $${relPrefix} THEN 0
        WHEN LOWER(last_name) LIKE $${relPrefix} THEN 1
        WHEN LOWER(display_name) LIKE $${relContains} THEN 2
        WHEN LOWER(email) LIKE $${relContains} THEN 3
        ELSE 4 END ASC,`;
    }
  }

  values.push(pageSize, offset);
  const result = await query<User>(
    `SELECT id, email, display_name AS "displayName", first_name AS "firstName", last_name AS "lastName",
            avatar_url AS "avatarUrl", bio, company, job_title AS "jobTitle", industry, location,
            linkedin_url AS "linkedinUrl", interests, reasons_to_connect AS "reasonsToConnect",
            languages, timezone, phone,
            expertise_text AS "expertiseText", what_i_care_about AS "whatICareAbout",
            what_i_can_help_with AS "whatICanHelpWith", who_i_want_to_meet AS "whoIWantToMeet",
            why_i_want_to_meet AS "whyIWantToMeet", my_intent AS "myIntent",
            invited_by_user_id AS "invitedByUserId",
            role, status, profile_complete AS "profileComplete",
            email_verified AS "emailVerified",
            notify_email AS "notifyEmail", notify_event_reminders AS "notifyEventReminders",
            notify_matches AS "notifyMatches", profile_visible AS "profileVisible",
            invite_opt_out_public_events AS "inviteOptOutPublicEvents",
            last_active_at AS "lastActiveAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM users ${whereClause}
     ORDER BY ${relevanceOrder} LOWER(COALESCE(display_name, email)) ASC, created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { users: result.rows, total, statusCounts };
}

// ─── Admin User Management ──────────────────────────────────────────────────

export async function updateUserRole(userId: string, role: UserRole): Promise<User> {
  const user = await getUserById(userId);
  await query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', [role, userId]);
  logger.info({ userId, oldRole: user.role, newRole: role }, 'User role updated');
  return getUserById(userId);
}

export async function updateUserStatus(userId: string, status: 'active' | 'suspended' | 'banned' | 'deactivated'): Promise<User> {
  const user = await getUserById(userId);
  await query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, userId]);
  invalidateUserStatusCache(userId);
  logger.info({ userId, oldStatus: user.status, newStatus: status }, 'User status updated');
  return getUserById(userId);
}

export async function deleteUser(userId: string): Promise<void> {
  await getUserById(userId); // Verify exists

  // Remove from all pods
  await query(`UPDATE pod_members SET status = 'removed', left_at = NOW() WHERE user_id = $1 AND status = 'active'`, [userId]);

  // Phase 2A (5 May spec) — capture the user's live-session footprint BEFORE
  // the bulk update so we can sync each affected in-memory state machine.
  // The bulk UPDATE below covers all session_participants rows (live + ended)
  // efficiently in one round-trip; for live ones we additionally call the
  // chokepoint with persistToDb:false to keep the in-memory state aligned.
  const liveSessionsBefore = await query<{ session_id: string }>(
    `SELECT session_id FROM session_participants WHERE user_id = $1 AND status NOT IN ('removed', 'left')`,
    [userId],
  );

  // Remove from all sessions (DB-side bulk; covers everything including ended sessions)
  await query(`UPDATE session_participants SET status = 'removed', left_at = NOW() WHERE user_id = $1 AND status NOT IN ('removed', 'left')`, [userId]);

  // Sync in-memory state machines for any sessions currently active in this
  // process. Skipped for sessions not in activeSessions (already-ended events
  // have no orchestrator to update). Best-effort: any failure is logged and
  // the reconciler will catch it on the next tick.
  if (liveSessionsBefore.rows.length > 0) {
    try {
      const { activeSessions } = await import('../orchestration/state/session-state');
      const { transitionParticipant, ParticipantState } = await import('../orchestration/state/participant-state-machine');
      for (const row of liveSessionsBefore.rows) {
        if (activeSessions.has(row.session_id)) {
          await transitionParticipant(row.session_id, userId, ParticipantState.REMOVED, { persistToDb: false });
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, 'deleteUser: in-memory state-machine sync failed (DB write committed; reconciler will fix on next tick)');
    }
  }

  // Revoke all tokens
  await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);

  // Deactivate the account (soft delete)
  await query(`UPDATE users SET status = 'deactivated', updated_at = NOW() WHERE id = $1`, [userId]);
  invalidateUserStatusCache(userId);
  logger.info({ userId }, 'User deleted (deactivated)');
}
