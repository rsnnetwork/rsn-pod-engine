// ─── Platform-wide people search (13 Aug 2026, Task C1) ──────────────────────
//
// The only member-facing search on the platform was /users/connected, over
// people you had already met, so a member could not find someone they had
// come here to find. (/users/search is admin-only moderation and returns
// emails; it is untouched.)
//
// This is deliberately a THIN result: name, title, company, location, photo.
// Everything else stays behind the gates it already sits behind; being
// findable is not the same as being open.

import { query } from '../../db';

export interface SearchResult {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
// One character matches most of the network — that is a scrape, not a search.
const MIN_QUERY = 2;

/** `%` and `_` are wildcards inside ILIKE; a member typing them must not widen the search. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function searchMembers(
  viewerId: string,
  q: string,
  limit: number,
): Promise<SearchResult[]> {
  const term = (q || '').trim();
  if (term.length < MIN_QUERY) return [];
  const capped = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  const r = await query<SearchResult>(
    `SELECT u.id AS "userId", u.display_name AS "displayName",
            u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle",
            u.company, u.location
       FROM users u
      WHERE u.id <> $1
        AND u.status = 'active'
        AND u.onboarding_completed = true
        AND (u.display_name ILIKE $2 OR u.job_title ILIKE $2 OR u.company ILIKE $2)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY
        -- A name match is what someone searching for "Claus" means; title and
        -- company matches come after it.
        (u.display_name ILIKE $2) DESC,
        u.display_name ASC
      LIMIT $3`,
    [viewerId, `%${escapeLike(term)}%`, capped],
  );
  return r.rows;
}
