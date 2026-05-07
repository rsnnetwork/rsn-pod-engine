// ─── Admin email-action tokens for join requests ──────────────────────────
//
// Each admin who can review a join request gets two single-use tokens
// (approve / reject) sent to their inbox by email. Tokens are bound to
// (admin_user_id, join_request_id, action), hashed at rest, 24h expiry.
//
// Lifecycle:
//   1. createJoinRequest fans out the email to every admin → calls
//      issueReviewTokens(requestId, adminUserIds) here. Two rows per
//      admin in the magic_links table (purpose='join_request_review').
//   2. Admin clicks Approve or Reject → client calls peekActionToken()
//      via GET /admin/join-request-action/:token. Read-only; safe for
//      Outlook Safe Links / Gmail crawlers to prefetch.
//   3. Admin clicks the Confirm button → client POSTs /:token/confirm →
//      confirmActionToken() runs an atomic UPDATE on join_requests with
//      WHERE status='pending'. Race-safe: only the first concurrent
//      confirm wins; the loser sees 'already_reviewed'.
//   4. Welcome / decline email + in-app notification fire via the
//      existing email service exports.
//
// Login magic-links are unaffected — they keep purpose='login' (default).

import crypto from 'crypto';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { config } from '../../config';
import {
  sendJoinRequestWelcomeEmail,
  sendJoinRequestDeclineEmail,
} from '../email/email.service';

const TOKEN_PURPOSE = 'join_request_review';
const TOKEN_BYTES = 32;
const TOKEN_TTL_HOURS = 24;
const APPROVAL_LOGIN_LINK_DAYS = 7;

export type ActionKind = 'approve' | 'reject';

interface IssuedTokenPair {
  approveToken: string;
  rejectToken: string;
  approveUrl: string;
  rejectUrl: string;
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function actionUrl(rawToken: string): string {
  return `${config.clientUrl}/admin/jr/${rawToken}`;
}

// ─── Issue ─────────────────────────────────────────────────────────────────

/**
 * Issue an approve + reject token pair for each admin.
 * One transaction; 2N inserts. Returns a Map keyed by admin user id.
 */
export async function issueReviewTokens(
  requestId: string,
  admins: Array<{ id: string; email: string }>,
): Promise<Map<string, IssuedTokenPair>> {
  if (admins.length === 0) return new Map();

  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);
  const result = new Map<string, IssuedTokenPair>();

  await transaction(async (client) => {
    for (const admin of admins) {
      const approveToken = generateRawToken();
      const rejectToken = generateRawToken();
      const adminEmail = admin.email.toLowerCase().trim();

      await client.query(
        `INSERT INTO magic_links (email, token_hash, expires_at, purpose, target_user_id, target_id, action)
         VALUES ($1, $2, $3, $4, $5, $6, 'approve')`,
        [adminEmail, hashToken(approveToken), expiresAt, TOKEN_PURPOSE, admin.id, requestId],
      );
      await client.query(
        `INSERT INTO magic_links (email, token_hash, expires_at, purpose, target_user_id, target_id, action)
         VALUES ($1, $2, $3, $4, $5, $6, 'reject')`,
        [adminEmail, hashToken(rejectToken), expiresAt, TOKEN_PURPOSE, admin.id, requestId],
      );

      result.set(admin.id, {
        approveToken,
        rejectToken,
        approveUrl: actionUrl(approveToken),
        rejectUrl: actionUrl(rejectToken),
      });
    }
  });

  logger.info({ requestId, admins: admins.length }, 'Issued admin review tokens for join request');
  return result;
}

// ─── Peek ──────────────────────────────────────────────────────────────────

export type PeekResult =
  | {
      kind: 'ready';
      action: ActionKind;
      adminUserId: string;
      request: {
        id: string;
        fullName: string;
        email: string;
        linkedinUrl: string | null;
        reason: string | null;
        status: string;
        createdAt: string;
      };
    }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | {
      kind: 'already_processed';
      action: ActionKind;
      requestStatus: string;
      reviewedByName: string | null;
      reviewedAt: string | null;
    };

interface TokenRow {
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  target_user_id: string | null;
  target_id: string | null;
  action: string | null;
}

async function lookupToken(rawToken: string): Promise<TokenRow | null> {
  const r = await query<TokenRow>(
    `SELECT token_hash, expires_at, used_at, target_user_id, target_id, action
       FROM magic_links
      WHERE token_hash = $1 AND purpose = $2`,
    [hashToken(rawToken), TOKEN_PURPOSE],
  );
  return r.rows[0] || null;
}

/**
 * Peek the token: read-only, safe for email-crawler prefetch. Resolves
 * to one of four shapes the client can render directly.
 */
export async function peekActionToken(rawToken: string): Promise<PeekResult> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) {
    return { kind: 'invalid' };
  }
  const row = await lookupToken(rawToken);
  if (!row || !row.target_id || !row.action || (row.action !== 'approve' && row.action !== 'reject')) {
    return { kind: 'invalid' };
  }
  if (row.expires_at.getTime() < Date.now()) {
    return { kind: 'expired' };
  }

  const reqResult = await query<{
    id: string;
    full_name: string;
    email: string;
    linkedin_url: string | null;
    reason: string | null;
    status: string;
    created_at: Date;
    reviewed_at: Date | null;
    reviewer_name: string | null;
  }>(
    `SELECT jr.id, jr.full_name, jr.email, jr.linkedin_url, jr.reason, jr.status,
            jr.created_at, jr.reviewed_at, u.display_name AS reviewer_name
       FROM join_requests jr
       LEFT JOIN users u ON u.id = jr.reviewed_by
      WHERE jr.id = $1`,
    [row.target_id],
  );
  const req = reqResult.rows[0];
  if (!req) return { kind: 'invalid' };

  // Single-use semantics: if THIS token is already used, OR the request
  // has already been reviewed, the page becomes informational.
  if (row.used_at || req.status !== 'pending') {
    return {
      kind: 'already_processed',
      action: row.action as ActionKind,
      requestStatus: req.status,
      reviewedByName: req.reviewer_name,
      reviewedAt: req.reviewed_at ? req.reviewed_at.toISOString() : null,
    };
  }

  return {
    kind: 'ready',
    action: row.action as ActionKind,
    adminUserId: row.target_user_id || '',
    request: {
      id: req.id,
      fullName: req.full_name,
      email: req.email,
      linkedinUrl: req.linkedin_url,
      reason: req.reason,
      status: req.status,
      createdAt: req.created_at.toISOString(),
    },
  };
}

// ─── Confirm ───────────────────────────────────────────────────────────────

export type ConfirmResult =
  | {
      kind: 'success';
      action: ActionKind;
      request: { id: string; fullName: string; email: string };
    }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | {
      kind: 'already_processed';
      requestStatus: string;
      reviewedByName: string | null;
    };

/**
 * Finalise the review. Atomic check-and-set on join_requests.status. The
 * race-safety guarantee comes from `WHERE status = 'pending'` — only one
 * confirm call wins; the loser is reported as already_processed.
 */
export async function confirmActionToken(rawToken: string): Promise<ConfirmResult> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) {
    return { kind: 'invalid' };
  }
  const row = await lookupToken(rawToken);
  if (!row || !row.target_id || !row.target_user_id || (row.action !== 'approve' && row.action !== 'reject')) {
    return { kind: 'invalid' };
  }
  if (row.expires_at.getTime() < Date.now()) {
    return { kind: 'expired' };
  }
  if (row.used_at) {
    return reportAlreadyProcessed(row.target_id);
  }

  const decision = row.action === 'approve' ? 'approved' : 'declined';

  // Atomic check-and-set: only flips status if it's still 'pending'.
  const updated = await query<{
    id: string;
    full_name: string;
    email: string;
  }>(
    `UPDATE join_requests
        SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW(),
            reminder_count = CASE WHEN $1 = 'approved' THEN 0 ELSE reminder_count END,
            last_reminded_at = CASE WHEN $1 = 'approved' THEN NULL ELSE last_reminded_at END
      WHERE id = $3 AND status = 'pending'
    RETURNING id, full_name, email`,
    [decision, row.target_user_id, row.target_id],
  );

  // Mark token used regardless — prevents replay even if the request was
  // already reviewed by someone else simultaneously.
  await query(
    `UPDATE magic_links SET used_at = NOW() WHERE token_hash = $1`,
    [hashToken(rawToken)],
  );

  if (updated.rows.length === 0) {
    return reportAlreadyProcessed(row.target_id);
  }

  const reviewed = updated.rows[0];

  // Side effects (fire-and-forget) — match the existing dashboard path.
  if (decision === 'approved') {
    generateApprovalLoginUrl(reviewed.email)
      .then((url) => sendJoinRequestWelcomeEmail(reviewed.email, reviewed.full_name, url))
      .catch((err) => logger.error({ err, email: reviewed.email }, 'Welcome email failed (email-action path)'));

    query(
      `INSERT INTO notifications (user_id, type, title, body, link, created_at)
         SELECT id, 'approval', 'Welcome to RSN!',
                'Your request to join has been approved. Start exploring!', '/pods', NOW()
           FROM users WHERE LOWER(email) = LOWER($1)
          LIMIT 1`,
      [reviewed.email],
    ).catch((err) => logger.warn({ err }, 'Approval notification insert failed (best-effort)'));
  } else {
    sendJoinRequestDeclineEmail(reviewed.email, reviewed.full_name).catch((err) =>
      logger.error({ err, email: reviewed.email }, 'Decline email failed (email-action path)'),
    );
  }

  logger.info(
    { requestId: reviewed.id, decision, reviewedBy: row.target_user_id, via: 'email_action' },
    'Join request reviewed via admin email action',
  );

  return {
    kind: 'success',
    action: row.action as ActionKind,
    request: { id: reviewed.id, fullName: reviewed.full_name, email: reviewed.email },
  };
}

async function reportAlreadyProcessed(requestId: string): Promise<ConfirmResult> {
  const r = await query<{ status: string; reviewer_name: string | null }>(
    `SELECT jr.status, u.display_name AS reviewer_name
       FROM join_requests jr
       LEFT JOIN users u ON u.id = jr.reviewed_by
      WHERE jr.id = $1`,
    [requestId],
  );
  const row = r.rows[0];
  return {
    kind: 'already_processed',
    requestStatus: row?.status || 'unknown',
    reviewedByName: row?.reviewer_name || null,
  };
}

async function generateApprovalLoginUrl(email: string): Promise<string> {
  const normalizedEmail = email.toLowerCase().trim();
  const token = generateRawToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + APPROVAL_LOGIN_LINK_DAYS * 24 * 60 * 60 * 1000);
  // Invalidate prior login tokens for this email (matches identity service).
  await query(
    `UPDATE magic_links SET used_at = NOW()
      WHERE email = $1 AND purpose = 'login' AND used_at IS NULL AND expires_at > NOW()`,
    [normalizedEmail],
  );
  await query(
    `INSERT INTO magic_links (email, token_hash, expires_at, purpose) VALUES ($1, $2, $3, 'login')`,
    [normalizedEmail, tokenHash, expiresAt],
  );
  return `${config.clientUrl}/auth/verify?token=${token}`;
}
