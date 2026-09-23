// ─── Who may sign in, and what an approval gives back ───────────────────────
//
// 23 Sep 2026 (Shradha): an admin deleted her test accounts, she asked to join
// again and was approved, and still could not get in. Deleting only closes an
// account (users.status = 'deactivated'), approval never looked at users at
// all, and sign-in handed a closed account a full session that the very next
// request refused. She saw a spinner, then the sign-in page, and no reason.
//
// Two rules close it:
//   1. Approving a join request reopens a CLOSED account with that email.
//      Suspended and banned are moderation decisions and approval never lifts
//      them.
//   2. Sign-in refuses an account that is not active, before any session is
//      issued, with words the member understands.

import type { PoolClient } from 'pg';
import { ErrorCode, ErrorCodes } from '@rsn/shared';
import logger from '../../config/logger';
import { AppError } from '../../middleware/errors';
import { invalidateUserStatusCache } from '../../middleware/auth';
import { recordAudit } from '../../middleware/audit';
import { fanoutAdminEntities, fanoutUserEntity } from '../../realtime/fanout';

const CLOSED_MESSAGE =
  'This account was closed. Ask to join again, and you can sign in as soon as you are approved.';
const SUSPENDED_MESSAGE =
  'This account is suspended. Please contact the RSN team if you think this is a mistake.';

/** The member-facing refusal for an account that cannot sign in, or null when it can. */
export function signInRefusal(status: string | null | undefined): { code: ErrorCode; message: string } | null {
  if (!status || status === 'active') return null;
  if (status === 'deactivated') return { code: ErrorCodes.ACCOUNT_CLOSED, message: CLOSED_MESSAGE };
  return { code: ErrorCodes.USER_SUSPENDED, message: SUSPENDED_MESSAGE };
}

/**
 * Refuse to start a session for an account that is not active. 403, not 401:
 * the client answers a 401 by trying to refresh, which would bury the reason.
 */
export function assertCanSignIn(user: { status: string } | null): void {
  const refusal = signInRefusal(user?.status);
  if (refusal) throw new AppError(403, refusal.code, refusal.message);
}

export interface ApprovedAccount {
  /** The account this approval reopened, if it had been closed. */
  reopenedUserId: string | null;
  /** Set when the email belongs to a suspended or banned account. Approval leaves it as it is. */
  blockedStatus: 'suspended' | 'banned' | null;
}

/**
 * Run inside the approval's transaction, so the account is open before the
 * welcome email and its one-click link go out. Old sessions are revoked: the
 * member comes back through the approval link, never through a device that
 * was signed in before the account was closed.
 */
export async function reopenClosedAccount(client: PoolClient, email: string): Promise<ApprovedAccount> {
  const reopened = await client.query<{ id: string }>(
    `UPDATE users SET status = 'active', updated_at = NOW()
      WHERE LOWER(email) = LOWER($1) AND status = 'deactivated'
      RETURNING id`,
    [email],
  );
  const reopenedUserId = reopened.rows[0]?.id ?? null;
  if (reopenedUserId) {
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [reopenedUserId],
    );
    return { reopenedUserId, blockedStatus: null };
  }

  const blocked = await client.query<{ status: 'suspended' | 'banned' }>(
    `SELECT status FROM users WHERE LOWER(email) = LOWER($1) AND status IN ('suspended', 'banned') LIMIT 1`,
    [email],
  );
  return { reopenedUserId: null, blockedStatus: blocked.rows[0]?.status ?? null };
}

/** After the approval commits: drop the cached 'closed', tell every screen, and leave a record. */
export function announceReopened(
  userId: string,
  context: { actorId: string | null; joinRequestId: string; email: string; via: 'dashboard' | 'email_action' },
): void {
  invalidateUserStatusCache(userId);
  fanoutAdminEntities('users').catch(() => {});
  fanoutUserEntity(userId).catch(() => {});
  recordAudit({
    actorId: context.actorId,
    action: 'user.reopened_by_approval',
    entityType: 'user',
    entityId: userId,
    details: { joinRequestId: context.joinRequestId, email: context.email, via: context.via },
  }).catch(() => {});
  logger.info({ userId, ...context }, 'Closed account reopened by join-request approval');
}
