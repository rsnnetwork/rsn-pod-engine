// ─── A member's public profile link (Shirley pilot S6, 11 Nov 2026; plan decision D5) ───────────────────────────────
//
// Opt-in and revocable. A member makes a link, /p/<token>, to show their profile to people who are not on REASON yet.
// The token is 16 random bytes (base64url, 22 characters), never derived from the member's id, so a revoked or replaced
// link is dead for good: its screenshots and its shares stop with it.
//
// What the link shows is the public card and nothing more (PublicProfileCard: toPublicMember without the id, and what
// they can bring). It opens nothing, with the same 404 as a token that never existed, when:
//   - the token is malformed, unknown, revoked or replaced;
//   - the account is not active (closed, suspended, banned) or is an event guest's (guests have no public profile);
//   - the member chose not to be shown in search (profile_visible false): a hidden profile is never opened by a link
//     a stranger holds, and the owner is told their link is paused;
//   - the reader is signed in and a block stands between them and the member, in either direction.
//
// The token leaves the server only to its owner (getMyPublicLink and the three writes). getUserById does not read it,
// so no profile read, the owner's, an admin's or another member's, ever carries it.

import crypto from 'crypto';
import {
  ErrorCodes, canBring, type PublicProfileCard, type PublicProfileLink, type PublicProfileLinkState,
} from '@rsn/shared';
import { query } from '../../db';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import * as blockService from '../block/block.service';
import { getUserById } from '../identity/identity.service';
import { toPublicMember } from './public-card';

/** A token as the server makes it: 22 base64url characters. Anything else is looked up nowhere. */
export const PUBLIC_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** The one answer for every link that opens nothing, whatever the reason, so no answer tells one reason from another. */
export const LINK_NOT_AVAILABLE = 'This profile link is not available.';
const notAvailable = () => new NotFoundError('Profile', undefined, LINK_NOT_AVAILABLE);

export const ONLY_MEMBERS_SHARE = 'Only members can share a public profile link.';
export const NO_LINK_TO_REPLACE = 'You have no public link to replace. Make one first.';

/** A fresh token: 128 random bits. */
export const newPublicToken = (): string => crypto.randomBytes(16).toString('base64url');

/** The app's page for a token. */
export const publicProfilePath = (token: string): string => `/p/${token}`;

interface LinkRow { token: string | null; created_at: Date | null; profile_visible: boolean }

function stateOf(row: LinkRow | undefined): PublicProfileLinkState {
  const link: PublicProfileLink | null = row?.token && row.created_at
    ? { token: row.token, path: publicProfilePath(row.token), createdAt: row.created_at.toISOString() }
    : null;
  return { link, paused: link && row && !row.profile_visible ? 'hidden' : null };
}

const LINK_COLUMNS = `public_profile_token AS token, public_profile_token_created_at AS created_at, profile_visible`;

/** Who may hold a link: an active member, never an event guest. */
const MAY_SHARE = `status = 'active' AND account_kind = 'member'`;

/** The owner's own link, or none. */
export async function getMyPublicLink(userId: string): Promise<PublicProfileLinkState> {
  const r = await query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM users WHERE id = $1`, [userId]);
  if (r.rows.length === 0) throw new NotFoundError('User', userId);
  return stateOf(r.rows[0]);
}

/** Postgres' unique_violation: a new token that some member already holds (128 bits: in practice, never). */
const isTokenClash = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

/** Writes a fresh token with `sql` ($1 the member, $2 the token), trying again on the impossible clash. */
async function writeToken(userId: string, sql: string): Promise<LinkRow | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await query<LinkRow>(sql, [userId, newPublicToken()]);
      return r.rows[0];
    } catch (err) {
      if (!isTokenClash(err) || attempt >= 2) throw err;
    }
  }
}

/**
 * Make the member's link, or keep the one they have: a second press (a double click, a second tab) answers the same
 * link, never a new one. Only an active member may make one.
 */
export async function createPublicLink(userId: string): Promise<PublicProfileLinkState> {
  const row = await writeToken(userId,
    `UPDATE users
        SET public_profile_token = COALESCE(public_profile_token, $2),
            public_profile_token_created_at = CASE WHEN public_profile_token IS NULL THEN NOW()
                                                   ELSE public_profile_token_created_at END
      WHERE id = $1 AND ${MAY_SHARE}
      RETURNING ${LINK_COLUMNS}`);
  if (!row) throw new ForbiddenError(ONLY_MEMBERS_SHARE);
  return stateOf(row);
}

/** A new link in place of the member's link: the old one stops at once. Refused when there is no link to replace. */
export async function regeneratePublicLink(userId: string): Promise<PublicProfileLinkState> {
  const row = await writeToken(userId,
    `UPDATE users
        SET public_profile_token = $2, public_profile_token_created_at = NOW()
      WHERE id = $1 AND ${MAY_SHARE} AND public_profile_token IS NOT NULL
      RETURNING ${LINK_COLUMNS}`);
  if (!row) throw new AppError(409, ErrorCodes.PUBLIC_LINK_NONE, NO_LINK_TO_REPLACE);
  return stateOf(row);
}

/** Turn the link off. Turning off a link that is already off changes nothing and says the same. */
export async function revokePublicLink(userId: string): Promise<PublicProfileLinkState> {
  const r = await query<LinkRow>(
    `UPDATE users SET public_profile_token = NULL, public_profile_token_created_at = NULL
      WHERE id = $1
      RETURNING ${LINK_COLUMNS}`,
    [userId],
  );
  if (r.rows.length === 0) throw new NotFoundError('User', userId);
  return stateOf(r.rows[0]);
}

/**
 * The page a link opens: the member's public card, through the one projection every other member is shown
 * (toPublicMember), without their id. `viewerId` is the reader when they are signed in, so a block stands.
 */
export async function getPublicProfile(token: string, viewerId: string | null): Promise<PublicProfileCard> {
  if (!PUBLIC_TOKEN_SHAPE.test(token)) throw notAvailable();
  const r = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE public_profile_token = $1 AND ${MAY_SHARE} AND profile_visible = TRUE
      LIMIT 1`,
    [token],
  );
  const memberId = r.rows[0]?.id;
  if (!memberId) throw notAvailable();
  if (viewerId && await blockService.areBlocked(viewerId, memberId)) throw notAvailable();
  const { id: _id, ...card } = toPublicMember(await getUserById(memberId));
  return { ...card, canBring: canBring(card) };
}
