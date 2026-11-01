// ─── Which links to an entity count (30 Oct review, 7.2; L23) ─────────────────────────────────────────────────────
//
// A link is 'pending' until an admin approves it, then 'active'; an admin can decline a claim or remove a member.
// Only an active link is listed on the entity's page or a person's profile, counted, or carries admin rights. Every
// query that reads entity_members says which links it means with one of these fragments, or says in a comment
// /* every status: <why> */ that it reads them all on purpose; entity-links.test.ts fails on a query that does neither
// (audit 05 §7.2 risk 1: one missed filter shows an unapproved claim on a profile, or makes a pending person an admin).

import { ErrorCodes } from '@rsn/shared';
import { AppError } from '../../middleware/errors';

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

function checked(alias: string): string {
  if (!SQL_ALIAS.test(alias)) throw new AppError(500, ErrorCodes.INTERNAL_ERROR, `Not a table alias: ${JSON.stringify(alias)}`);
  return alias;
}

/** The entity_members row aliased `alias` is an approved, listed link. */
export const activeLinkSql = (alias: string) => `${checked(alias)}.status = 'active'`;

/** The row is the person's own live link: listed, or a claim still waiting (their own list, Leave, the fan-out). */
export const openLinkSql = (alias: string) => `${checked(alias)}.status IN ('active', 'pending')`;
