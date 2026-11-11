// ─── Confirm it's you before a sensitive change (10 Nov 2026 spec, Part 3 Task 2) ─────────────────────────────────
//
// A signed-in member asks for a 6-digit code at their CURRENT address, types it, and gets a reauth token good for one
// change of one kind (a scope: shared/src/identity/reauth.ts) for REAUTH_GRANT_MINUTES.
//
// The code is a magic_links row, kept apart from every other row by its purpose ('reauth') and bound to the member
// (target_user_id) and the scope (action). It is spent through spendSignInCode, so it has the sign-in code's 15 minutes,
// five tries and keyed hash. It is never a sign-in code, nor an entry code, nor the reverse: each purpose reads only its
// own rows. Spending it turns the same row into the grant: its expiry becomes now + REAUTH_GRANT_MINUTES.
//
// The token is a JWT { sub, purpose: 'reauth', act: scope, jti: <row id> }. Its `purpose` claim means `authenticate`
// never takes it as an access token (isAccessToken). It proves nothing alone: consumeReauthGrant spends the row it
// names in one guarded UPDATE, so a token works once, for its own member and scope, before its expiry, and only while
// the account's email is still the address the code went to (a changed email kills every grant made before it).

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { ErrorCodes, REAUTH_GRANT_MINUTES, REAUTH_REQUIRED_MESSAGE, type ReauthScope } from '@rsn/shared';
import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { guestMembershipRequired } from '../../middleware/guest-scope';
import { sendReauthCodeEmail } from '../email/email.service';
import { SIGN_IN_CODE_TTL_MINUTES, hashSignInCode, newSignInCode } from './sign-in-code';
import { SIGN_IN_CODE_COLUMNS, codeWrong, spendSignInCode, type SignInCodeRow } from './identity.service';

export const REAUTH_PURPOSE = 'reauth';

/** What each code email says it confirms, finishing "before you ...". */
const PURPOSE_TEXT: Record<ReauthScope, string> = {
  change_email: 'change your sign-in email',
  close_account: 'close your account',
  admin_role: 'change an admin role',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReauthClaims { sub: string; purpose: 'reauth'; act: ReauthScope; jti: string }

/**
 * Email a confirmation code to the member's current address for `scope`. Their earlier codes for the same scope that
 * were never typed die first (only the newest works); a grant already made is left alone. Code only, no button: a
 * button would sign in whichever browser opens it, not the tab that asked. Event guests have nothing to confirm.
 */
export async function issueReauthCode(userId: string, scope: ReauthScope): Promise<{ sent: true; devCode?: string }> {
  const found = await query<{ email: string; account_kind: string }>(
    `SELECT email, account_kind FROM users WHERE id = $1`,
    [userId],
  );
  const user = found.rows[0];
  if (!user) throw new NotFoundError('User', userId);
  if (user.account_kind !== 'member') throw guestMembershipRequired();

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const code = newSignInCode();
  const codeHash = hashSignInCode(tokenHash, code);
  await query(
    `UPDATE magic_links SET used_at = NOW(), expires_at = LEAST(expires_at, NOW())
      WHERE target_user_id = $1 AND purpose = '${REAUTH_PURPOSE}' AND action = $2 AND used_at IS NULL`,
    [userId, scope],
  );
  await query(
    `INSERT INTO magic_links (email, token_hash, expires_at, code_hash, purpose, target_user_id, action)
     VALUES ($1, $2, NOW() + make_interval(mins => $3::int), $4, '${REAUTH_PURPOSE}', $5, $6)`,
    [user.email, tokenHash, SIGN_IN_CODE_TTL_MINUTES, codeHash, userId, scope],
  );
  await sendReauthCodeEmail(user.email, { code, purposeText: PURPOSE_TEXT[scope] });
  logger.info({ userId, scope }, 'Reauth code sent');
  return config.isDev ? { sent: true, devCode: code } : { sent: true };
}

/**
 * Type the confirmation code for `scope`: only the member's newest code for that scope is tried, and only while it went
 * to the account's current email, under spendSignInCode's rules. The spent row becomes a grant for REAUTH_GRANT_MINUTES,
 * and the answer is the token that names it.
 */
export async function verifyReauthCode(
  userId: string,
  scope: ReauthScope,
  code: string,
): Promise<{ reauthToken: string; expiresAt: string }> {
  const found = await query<SignInCodeRow>(
    `SELECT ${SIGN_IN_CODE_COLUMNS}
       FROM magic_links
      WHERE target_user_id = $1 AND purpose = '${REAUTH_PURPOSE}' AND action = $3 AND code_hash IS NOT NULL
        AND email = (SELECT email FROM users WHERE id = $1)
      ORDER BY created_at DESC LIMIT 1`,
    [userId, SIGN_IN_CODE_TTL_MINUTES, scope],
  );
  const link = found.rows[0];
  if (!link) throw codeWrong();
  await spendSignInCode(link, code);

  const granted = await query<{ expires_at: Date }>(
    `UPDATE magic_links SET expires_at = NOW() + make_interval(mins => $2::int)
      WHERE id = $1 AND purpose = '${REAUTH_PURPOSE}' RETURNING expires_at`,
    [link.id, REAUTH_GRANT_MINUTES],
  );
  const expiresAt = granted.rows[0]?.expires_at;
  if (!expiresAt) throw codeWrong();
  const claims: ReauthClaims = { sub: userId, purpose: 'reauth', act: scope, jti: link.id };
  const reauthToken = jwt.sign(claims, config.jwtSecret, { expiresIn: REAUTH_GRANT_MINUTES * 60 });
  return { reauthToken, expiresAt: new Date(expiresAt).toISOString() };
}

/** The claims of a reauth token for this member and scope, or null for anything else (an access token included). */
function readReauthToken(userId: string, scope: ReauthScope, token: string): ReauthClaims | null {
  let payload: unknown;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const claims = payload as Record<string, unknown>;
  if (claims.purpose !== 'reauth' || claims.sub !== userId || claims.act !== scope) return null;
  if (typeof claims.jti !== 'string' || !UUID.test(claims.jti)) return null;
  return claims as unknown as ReauthClaims;
}

/**
 * Spend the grant `token` names, for `userId` and `scope`. True once, for a live grant made from a code that went to the
 * account's current email; false for anything else (a spent grant, another member's or scope's, an expired one, an
 * access token, a forged one). One guarded UPDATE, so two requests racing with one token cannot both get true.
 */
export async function consumeReauthGrant(userId: string, scope: ReauthScope, token: string): Promise<boolean> {
  const claims = readReauthToken(userId, scope, token);
  if (!claims) return false;
  const spent = await query<{ id: string }>(
    `UPDATE magic_links SET expires_at = NOW()
      WHERE id = $1 AND purpose = '${REAUTH_PURPOSE}' AND target_user_id = $2 AND action = $3
        AND used_at IS NOT NULL AND expires_at > NOW()
        AND email = (SELECT email FROM users WHERE id = $2)
      RETURNING id`,
    [claims.jti, userId, scope],
  );
  return spent.rows.length > 0;
}

/** The refusal of a change asked without a fresh proof: 403 REAUTH_REQUIRED, naming the scope it needs. */
export function reauthRequired(scope: ReauthScope): AppError {
  return new AppError(403, ErrorCodes.REAUTH_REQUIRED, REAUTH_REQUIRED_MESSAGE, { scope });
}
