// ─── Identity Service ────────────────────────────────────────────────────────
// Handles user CRUD, magic link authentication, and token management.

import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import {
  User, UserRole, CreateUserInput, UpdateUserInput,
  AuthTokenPair, JwtPayload, ErrorCodes,
} from '@rsn/shared';
import { NotFoundError, ConflictError, UnauthorizedError, AppError } from '../../middleware/errors';
import { sendMagicLinkEmail } from '../email/email.service';

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

export async function getUserById(id: string): Promise<User> {
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
     FROM users WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('User', id);
  }
  return result.rows[0];
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

export async function createUser(input: CreateUserInput): Promise<User> {
  const existing = await getUserByEmail(input.email);
  if (existing) {
    throw new ConflictError('USER_ALREADY_EXISTS', 'A user with this email already exists');
  }

  const id = uuid();
  const displayName = input.displayName || `${input.firstName} ${input.lastName}`;

  await query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, role, status, email_verified)
     VALUES ($1, $2, $3, $4, $5, 'member', 'active', FALSE)`,
    [id, input.email.toLowerCase(), displayName, input.firstName, input.lastName]
  );

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

  if (setClauses.length === 0) {
    return getUserById(id);
  }

  values.push(id);
  await query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
    values
  );

  // Check if profile is now complete
  const user = await getUserById(id);
  const isComplete = !!(
    user.firstName && user.lastName && user.displayName &&
    user.company && user.jobTitle && user.industry &&
    user.reasonsToConnect && user.reasonsToConnect.length > 0
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

function resolveClientBaseUrl(requestedClientUrl?: string): string {
  if (!requestedClientUrl) return config.clientUrl.replace(/\/$/, '');

  try {
    const parsed = new URL(requestedClientUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return config.clientUrl.replace(/\/$/, '');
    }

    const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '') : '';
    return `${parsed.origin}${basePath}`;
  } catch {
    return config.clientUrl.replace(/\/$/, '');
  }
}

export async function sendMagicLink(email: string, requestedClientUrl?: string, inviteCode?: string): Promise<{ sent: boolean; devLink?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Allow existing users to log in without gate check
  const existingUser = await getUserByEmail(normalizedEmail);
  let hasValidInvite = false;

  // Invite codes are optional - validate only if provided
  if (inviteCode) {
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

  // Invalidate any existing magic links for this email
  await query(
    `UPDATE magic_links SET used_at = NOW() WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [normalizedEmail]
  );

  // Store the hashed token
  await query(
    `INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [normalizedEmail, tokenHash, expiresAt]
  );

  // Build the magic link URL using request origin when available.
  const clientBaseUrl = resolveClientBaseUrl(requestedClientUrl);
  const magicLinkUrl = `${clientBaseUrl}/auth/verify?token=${token}`;

  // In development, return the link directly (also send email if configured)
  if (config.isDev) {
    logger.info({ email: normalizedEmail, magicLinkUrl }, 'Magic link generated (dev mode)');
    // Still try to send email in dev if Resend is configured
    if (config.resendApiKey) {
      try {
        await sendMagicLinkEmail(normalizedEmail, magicLinkUrl);
      } catch (error) {
        logger.warn({ error, email: normalizedEmail }, 'Email send failed in dev mode; returning devLink');
      }
    }
    return { sent: true, devLink: magicLinkUrl };
  }

  // Production: send email via Resend
  await sendMagicLinkEmail(normalizedEmail, magicLinkUrl);
  logger.info({ email: normalizedEmail }, 'Magic link email sent');
  return { sent: true };
}

export async function verifyMagicLink(token: string): Promise<AuthTokenPair> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Find the magic link
  const result = await query<{ id: string; email: string; expires_at: Date; used_at: Date | null }>(
    `SELECT id, email, expires_at, used_at FROM magic_links WHERE token_hash = $1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid magic link');
  }

  const magicLink = result.rows[0];

  if (magicLink.used_at) {
    throw new AppError(400, 'AUTH_MAGIC_LINK_USED', 'This magic link has already been used');
  }

  if (new Date(magicLink.expires_at) < new Date()) {
    throw new AppError(400, 'AUTH_MAGIC_LINK_EXPIRED', 'This magic link has expired');
  }

  // Mark the magic link as used
  await query('UPDATE magic_links SET used_at = NOW() WHERE id = $1', [magicLink.id]);

  // Find or create the user (handle concurrent verify race condition)
  let user = await getUserByEmail(magicLink.email);
  if (!user) {
    // Safety net: block new user creation if not approved and no invite
    await assertRegistrationAllowed(magicLink.email, false);
    try {
      user = await createUser({
        email: magicLink.email,
        firstName: '',
        lastName: '',
        displayName: magicLink.email.split('@')[0],
      });
    } catch (err: any) {
      // Race condition: another request created the user between our check and insert
      if (err?.code === '23505' || err?.message?.includes('already exists')) {
        user = await getUserByEmail(magicLink.email);
        if (!user) throw err; // Should never happen, but rethrow if it does
      } else {
        throw err;
      }
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

// ─── Token Management ───────────────────────────────────────────────────────

function generateTokenPair(user: User): AuthTokenPair {
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

  // Store refresh token hash
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, refreshHash, refreshExpiry]
  ).catch((err) => logger.error({ err }, 'Failed to store refresh token'));

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
      throw new UnauthorizedError('Refresh token revoked or not found');
    }

    // Revoke the old refresh token (rotation)
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [result.rows[0].id]);

    // Get user, verify active, and generate new pair
    const user = await getUserById(payload.sub);
    if (user.status !== 'active') {
      throw new UnauthorizedError('Account is deactivated');
    }
    return generateTokenPair(user);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof NotFoundError) {
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
    let invUseCount = 0;
    let invMaxUses = 0;
    let invStatus = '';
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
      invUseCount = inv.use_count;
      invMaxUses = inv.max_uses;
      invStatus = inv.status;
      inviterId = inv.inviter_id;
      hasValidInvite = true;
    }

    // Gate: require approved join request or valid invite
    await assertRegistrationAllowed(normalizedEmail, hasValidInvite);

    // Create the user
    const id = uuid();
    const displayName = profile.name || normalizedEmail.split('@')[0];
    const firstName = profile.givenName || (profile.name ? profile.name.split(' ')[0] : '');
    const lastName = profile.familyName || (profile.name && profile.name.includes(' ') ? profile.name.split(' ').slice(1).join(' ') : '');
    await query(
      `INSERT INTO users (id, email, display_name, first_name, last_name, avatar_url, invited_by_user_id, role, status, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'member', 'active', TRUE)`,
      [id, normalizedEmail, displayName, firstName, lastName, profile.picture || null, inviterId]
    );
    await query(`INSERT INTO user_subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`, [id]);
    await query(`INSERT INTO user_entitlements (user_id) VALUES ($1)`, [id]);

    // Mark invite as used (only if one was provided)
    if (inviteId) {
      const newCount = invUseCount + 1;
      const newStatus = newCount >= invMaxUses ? 'accepted' : invStatus;
      await query(
        `UPDATE invites SET use_count = $1, status = $2, accepted_by_user_id = $3, accepted_at = NOW() WHERE id = $4`,
        [newCount, newStatus, id, inviteId]
      );

      // Apply invite membership effects — same logic as invite.service.ts acceptInvite()
      // Without this, Google OAuth users are created but NOT added to the pod/session.
      const inviteDetail = await query<{ type: string; pod_id: string | null; session_id: string | null }>(
        `SELECT type, pod_id, session_id FROM invites WHERE id = $1`,
        [inviteId]
      );
      const inv = inviteDetail.rows[0];
      if (inv) {
        if (inv.type === 'pod' && inv.pod_id) {
          await query(
            `INSERT INTO pod_members (pod_id, user_id, role) VALUES ($1, $2, 'member')
             ON CONFLICT (pod_id, user_id) DO NOTHING`,
            [inv.pod_id, id]
          );
        }
        if (inv.type === 'session' && inv.session_id) {
          // Add to pod first (required for private pod sessions)
          const sessionPod = await query<{ pod_id: string }>(
            `SELECT pod_id FROM sessions WHERE id = $1`, [inv.session_id]
          );
          if (sessionPod.rows[0]?.pod_id) {
            await query(
              `INSERT INTO pod_members (pod_id, user_id, role) VALUES ($1, $2, 'member')
               ON CONFLICT (pod_id, user_id) DO NOTHING`,
              [sessionPod.rows[0].pod_id, id]
            );
          }
          // Register as session participant
          await query(
            `INSERT INTO session_participants (session_id, user_id, status)
             VALUES ($1, $2, 'registered')
             ON CONFLICT (session_id, user_id) DO NOTHING`,
            [inv.session_id, id]
          );
        }
        logger.info({ userId: id, inviteType: inv.type, podId: inv.pod_id, sessionId: inv.session_id },
          'Google OAuth: invite membership effects applied');
      }
    }

    user = await getUserById(id);
    logger.info({ userId: id, email: normalizedEmail }, 'Google OAuth: new user created');
  } else {
    // Update avatar if provided and user doesn't have one
    if (profile.picture && !user.avatarUrl) {
      await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [profile.picture, user.id]);
    }
    if (!user.emailVerified) {
      await query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
    }
  }

  await updateLastActive(user.id);
  return generateTokenPair(user);
}

export async function logout(userId: string, sessionId: string): Promise<void> {
  // Revoke all refresh tokens for this session
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  logger.info({ userId, sessionId }, 'User logged out');
}

export async function getUsers(params: {
  page?: number;
  pageSize?: number;
  role?: UserRole;
  status?: 'active' | 'suspended' | 'banned' | 'deactivated';
  search?: string;
  industry?: string;
}): Promise<{ users: User[]; total: number }> {
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

  if (params.status) {
    whereClause += ` AND status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  if (params.search) {
    whereClause += ` AND (display_name ILIKE $${paramIdx} OR email ILIKE $${paramIdx} OR first_name ILIKE $${paramIdx} OR last_name ILIKE $${paramIdx})`;
    values.push(`%${params.search}%`);
    paramIdx++;
  }

  if (params.industry) {
    whereClause += ` AND industry ILIKE $${paramIdx}`;
    values.push(`%${params.industry}%`);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM users ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

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
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { users: result.rows, total };
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
  logger.info({ userId, oldStatus: user.status, newStatus: status }, 'User status updated');
  return getUserById(userId);
}

export async function deleteUser(userId: string): Promise<void> {
  await getUserById(userId); // Verify exists

  // Remove from all pods
  await query(`UPDATE pod_members SET status = 'removed', left_at = NOW() WHERE user_id = $1 AND status = 'active'`, [userId]);

  // Remove from all sessions
  await query(`UPDATE session_participants SET status = 'removed', left_at = NOW() WHERE user_id = $1 AND status NOT IN ('removed', 'left')`, [userId]);

  // Revoke all tokens
  await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);

  // Deactivate the account (soft delete)
  await query(`UPDATE users SET status = 'deactivated', updated_at = NOW() WHERE id = $1`, [userId]);
  logger.info({ userId }, 'User deleted (deactivated)');
}
