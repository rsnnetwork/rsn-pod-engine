// ─── Who other members may see (T2, 1 Nov 2026) ─────────────────────────────────────────────────────────────
//
// An account an admin removed (deactivated), suspended or banned vanishes from every list, every count and every
// send path a member reaches: pod members, circle members, event participants, the old profile page, messaging.
// Its old words stay where they were written (chats, walls), as "Former member". Every such query says "a member
// others may see" with this one fragment, so no surface can drift to its own reading of it (30 Oct review: Stefan
// removed two accounts twice each because they never left any list).
//
// Admin screens keep every status, each in its own tab; they do not use this.

import { ErrorCodes } from '@rsn/shared';
import { AppError } from '../../middleware/errors';

/** A plain lower-case SQL name: the alias is written into the SQL, so nothing else may reach it. */
const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * The SQL condition "the users row aliased `alias` is an active member": `<alias>.status = 'active'`.
 * `alias` is the name the query gave the users table (`u`, `users`, …); anything else is refused.
 */
export function activeMemberSql(alias: string): string {
  if (!SQL_ALIAS.test(alias)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, `Not a table alias: ${JSON.stringify(alias)}`);
  }
  return `${alias}.status = 'active'`;
}

/** The name a removed, suspended or banned person goes by where their old words stay. */
export const FORMER_MEMBER_NAME = 'Former member';
