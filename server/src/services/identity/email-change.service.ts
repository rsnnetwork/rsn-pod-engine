// ─── Change one's sign-in email (10 Nov 2026 spec, Part 3 Task 2) ─────────────────────────────────────────────────
//
// The email is REASON's only sign-in credential (no passwords; Google signs in by matching it), so whoever holds the
// address holds the account. A change takes two proofs: a fresh change_email reauth grant (the current address, spent
// by the route before requestEmailChange runs) and a code sent to the NEW address (a magic_links row, purpose
// 'email_change', email = the new address, target_user_id = the member, spent through spendSignInCode).
//
// Once the second code is right, one transaction moves the address, expires every live link of the old address (a
// sign-in link already in a mailbox, an entry code, a reauth grant: none of them may still work), revokes every
// refresh token (every other device signs in again), and puts the change on record by member id only. The caller gets a
// fresh token pair for this device (the access token carries the email), and the old address is told, with the new one
// masked. No address is ever logged or written to the audit row.

import crypto from 'crypto';
import { ErrorCodes, type AuthTokenPair } from '@rsn/shared';
import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, ConflictError, NotFoundError } from '../../middleware/errors';
import { forgetAccountGate } from '../../middleware/auth';
import { sendEmailChangeCodeEmail, sendEmailChangedNoticeEmail } from '../email/email.service';
import { isReservedTestAddress, maskAddress } from './reserved-address';
import { SIGN_IN_CODE_TTL_MINUTES, hashSignInCode, newSignInCode } from './sign-in-code';
import {
  SIGN_IN_CODE_COLUMNS, codeWrong, generateTokenPair, getUserById, spendSignInCode, type SignInCodeRow,
} from './identity.service';

export const EMAIL_CHANGE_PURPOSE = 'email_change';

const emailInUse = () => new ConflictError(ErrorCodes.EMAIL_IN_USE, 'That email is already used by another account.');

async function currentEmail(userId: string): Promise<string> {
  const found = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError('User', userId);
  return row.email;
}

/**
 * Refuse when another account already signs in with `email`, in any case: an address stored before every write path
 * lower-cased it must still count as taken.
 */
async function assertAddressFree(userId: string, email: string): Promise<void> {
  const taken = await query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2 LIMIT 1`,
    [email, userId],
  );
  if (taken.rows[0]) throw emailInUse();
}

/**
 * The checks that tell an unproven caller nothing about anyone else, run BEFORE the change_email proof is spent so a
 * typo never costs the member their code: the address they already have, and an address no person can receive mail at
 * (reserved-address.ts; allowed only to an account that is itself on one, the platform's own test members). Whether
 * another account has the address is asked only after the proof (requestEmailChange).
 */
export async function assertNewAddressAcceptable(userId: string, newEmail: string): Promise<void> {
  const email = newEmail.trim().toLowerCase();
  const current = await currentEmail(userId);
  if (email === current.toLowerCase()) throw new AppError(400, ErrorCodes.INVALID_INPUT, "That's already your email.");
  if (isReservedTestAddress(email) && !isReservedTestAddress(current)) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, "That address can't receive email. Please use another one.");
  }
}

/**
 * Email a code to `newEmail` that makes it the member's sign-in email once typed. The route has already spent the
 * member's change_email proof; the cheap checks run again here (nothing may reach the write without them), then the
 * address must be free. The member's earlier unused change codes die.
 */
export async function requestEmailChange(userId: string, newEmail: string): Promise<{ sent: true; devCode?: string }> {
  const email = newEmail.trim().toLowerCase();
  await assertNewAddressAcceptable(userId, email);
  await assertAddressFree(userId, email);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const code = newSignInCode();
  const codeHash = hashSignInCode(tokenHash, code);
  await query(
    `UPDATE magic_links SET used_at = NOW(), expires_at = LEAST(expires_at, NOW())
      WHERE target_user_id = $1 AND purpose = '${EMAIL_CHANGE_PURPOSE}' AND used_at IS NULL`,
    [userId],
  );
  await query(
    `INSERT INTO magic_links (email, token_hash, expires_at, code_hash, purpose, target_user_id)
     VALUES ($1, $2, NOW() + make_interval(mins => $3::int), $4, '${EMAIL_CHANGE_PURPOSE}', $5)`,
    [email, tokenHash, SIGN_IN_CODE_TTL_MINUTES, codeHash, userId],
  );
  await sendEmailChangeCodeEmail(email, { code });
  logger.info({ userId }, 'Email change code sent');
  return config.isDev ? { sent: true, devCode: code } : { sent: true };
}

/** A unique violation on users.email: another account took the address between the check and the write. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/**
 * Type the code from the new address: the member's newest change code is tried under spendSignInCode's rules (the
 * address re-checked as free before it is spent), then the change is made in one transaction. Answers a fresh token
 * pair for this device; every other session has to sign in again.
 */
export async function confirmEmailChange(userId: string, code: string, ipAddress?: string): Promise<AuthTokenPair> {
  const found = await query<SignInCodeRow>(
    `SELECT ${SIGN_IN_CODE_COLUMNS}
       FROM magic_links
      WHERE target_user_id = $1 AND purpose = '${EMAIL_CHANGE_PURPOSE}' AND code_hash IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId, SIGN_IN_CODE_TTL_MINUTES],
  );
  const link = found.rows[0];
  if (!link) throw codeWrong();
  const newEmail = link.email;
  await spendSignInCode(link, code, () => assertAddressFree(userId, newEmail));

  let oldEmail: string;
  try {
    oldEmail = await transaction(async (client) => {
      const locked = await client.query<{ email: string }>(`SELECT email FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const old = locked.rows[0]?.email;
      if (!old) throw new NotFoundError('User', userId);
      await client.query(
        `UPDATE users SET email = $2, email_verified = TRUE, updated_at = NOW() WHERE id = $1`,
        [userId, newEmail],
      );
      await client.query(
        `UPDATE magic_links SET expires_at = LEAST(expires_at, NOW()) WHERE email = $1 AND expires_at > NOW()`,
        [old],
      );
      await client.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip_address)
         VALUES ($1, 'user.email_changed', 'user', $1, '{}', $2)`,
        [userId, ipAddress ?? null],
      );
      return old;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailInUse();
    throw err;
  }
  logger.info({ userId }, 'Sign-in email changed');

  const tokens = await generateTokenPair(await getUserById(userId));
  forgetAccountGate(userId);
  sendEmailChangedNoticeEmail(oldEmail, { maskedNew: maskAddress(newEmail) })
    .then((sent) => { if (!sent.sent) logger.warn({ userId }, 'Email change notice to the old address was not sent'); })
    .catch((err) => logger.warn({ err, userId }, 'Email change notice to the old address failed (non-fatal)'));
  return tokens;
}
