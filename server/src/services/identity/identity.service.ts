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
  AuthTokenPair, JwtPayload,
} from '@rsn/shared';
import { NotFoundError, ConflictError, UnauthorizedError, AppError } from '../../middleware/errors';
import { sendMagicLinkEmail } from '../email/email.service';

// ─── User Operations ────────────────────────────────────────────────────────

export async function getUserById(id: string): Promise<User> {
  const result = await query<User>(
    `SELECT id, email, display_name AS "displayName", first_name AS "firstName", last_name AS "lastName",
            avatar_url AS "avatarUrl", bio, company, job_title AS "jobTitle", industry, location,
            linkedin_url AS "linkedinUrl", interests, reasons_to_connect AS "reasonsToConnect",
            languages, timezone, role, status, profile_complete AS "profileComplete",
            email_verified AS "emailVerified", last_active_at AS "lastActiveAt",
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
            languages, timezone, role, status, profile_complete AS "profileComplete",
            email_verified AS "emailVerified", last_active_at AS "lastActiveAt",
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

export async function sendMagicLink(email: string): Promise<{ sent: boolean; devLink?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

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

  // Build the magic link URL
  const magicLinkUrl = `${config.clientUrl}/auth/verify?token=${token}`;

  // In development, return the link directly (also send email if configured)
  if (config.isDev) {
    logger.info({ email: normalizedEmail, magicLinkUrl }, 'Magic link generated (dev mode)');
    // Still try to send email in dev if Resend is configured
    if (config.resendApiKey) {
      await sendMagicLinkEmail(normalizedEmail, magicLinkUrl);
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

    // Get user and generate new pair
    const user = await getUserById(payload.sub);
    return generateTokenPair(user);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof NotFoundError) {
      throw err;
    }
    throw new UnauthorizedError('Invalid refresh token');
  }
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
  search?: string;
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

  if (params.search) {
    whereClause += ` AND (display_name ILIKE $${paramIdx} OR email ILIKE $${paramIdx} OR first_name ILIKE $${paramIdx} OR last_name ILIKE $${paramIdx})`;
    values.push(`%${params.search}%`);
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
            languages, timezone, role, status, profile_complete AS "profileComplete",
            email_verified AS "emailVerified", last_active_at AS "lastActiveAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM users ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { users: result.rows, total };
}
