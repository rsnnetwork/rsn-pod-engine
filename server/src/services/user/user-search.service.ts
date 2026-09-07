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

  // 7 Sep 2026 (W4 recall): match EVERY word of the query, each against a wider
  // set of columns (industry + expertise as well as name/title/company), so
  // "software engineer" finds "Engineer, Software" and "manufacturing" finds
  // someone whose industry is Manufacturing. A single literal %substring% over
  // three columns missed all of these.
  const tokens = term.split(/\s+/).map(t => t.trim()).filter(Boolean).slice(0, 6);
  const params: unknown[] = [viewerId];
  const tokenClauses = tokens.map((tok) => {
    params.push(`%${escapeLike(tok)}%`);
    const p = `$${params.length}`;
    return `(u.display_name ILIKE ${p} OR u.job_title ILIKE ${p} OR u.company ILIKE ${p} OR u.industry ILIKE ${p} OR u.expertise_text ILIKE ${p})`;
  }).join(' AND ');
  params.push(`%${escapeLike(term)}%`);
  const wholeTermP = `$${params.length}`;
  params.push(capped);
  const limitP = `$${params.length}`;

  const r = await query<SearchResult>(
    `SELECT u.id AS "userId", u.display_name AS "displayName",
            u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle",
            u.company, u.location
       FROM users u
      WHERE u.id <> $1
        AND u.status = 'active'
        AND u.onboarding_completed = true
        AND (${tokenClauses})
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY
        -- A whole-term name match is what someone searching for "Claus" means;
        -- token / title / company / industry matches come after it.
        (u.display_name ILIKE ${wholeTermP}) DESC,
        u.display_name ASC
      LIMIT ${limitP}`,
    params,
  );
  return r.rows;
}
