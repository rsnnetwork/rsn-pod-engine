// ─── Your connections (REASON, 21 Oct 2026) ──────────────────────────────────
// Everyone the member is connected to or has met, one row per person, newest first, a page at a time. The
// People screen lists them before anything else (client feedback, 19 Oct: "On the People page, show the
// user's own connections first").
//
// Connected: a meeting request accepted in either direction, or a conversation between the two.
// Met: a meeting at an event, or a 1:1 meeting both of them joined. That is the Human Profile's own reading
// (person-brief.service.ts): accepting a request seeds an encounter row with times_met 0 and no event, and
// that row alone is not a meeting.
// Left out: the member themself, anyone blocked in either direction, and every account that is not active.

import { query } from '../../db';
import type { ConnectionList, PersonConnection } from '@rsn/shared';

// How many people one moment can hold when more than a page share it (see pageBySince). Only a bulk
// write could put that many on one millisecond; the number keeps the question bounded even then.
const ONE_MOMENT_MAX = 500;

interface Row {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  job_title: string | null;
  company: string | null;
  met: boolean;
  since: Date;
}

// The one definition of "a connection" (26 Oct 2026): a meeting request accepted either way, a conversation, a 1:1
// meeting both joined, an event meeting. Written once, as two CTEs that ask about the member in $1 and give one row
// per person (`person_id`, `met`, `since`). The People page reads it here and the invite picker
// (invite-candidates.service.ts) builds on the same text, so the two can never list different people.
// `since` is cut to the millisecond, so the cursor a page hands out (an ISO time) names it exactly.
export const CONNECTION_SIGNALS_SQL = `signals AS (
    SELECT CASE WHEN p.sender_id = $1 THEN p.recipient_id ELSE p.sender_id END AS person_id,
           false AS met, COALESCE(p.responded_at, p.created_at) AS at
      FROM user_pokes p
     WHERE (p.sender_id = $1 OR p.recipient_id = $1) AND p.status = 'accepted'
    UNION ALL
    SELECT CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END, false, c.created_at
      FROM dm_conversations c
     WHERE c.user_a_id = $1 OR c.user_b_id = $1
    UNION ALL
    SELECT CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END, true,
           GREATEST(c.meeting_joined_a_at, c.meeting_joined_b_at)
      FROM dm_conversations c
     WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
       AND c.meeting_joined_a_at IS NOT NULL AND c.meeting_joined_b_at IS NOT NULL
    UNION ALL
    SELECT CASE WHEN e.user_a_id = $1 THEN e.user_b_id ELSE e.user_a_id END, true, e.last_met_at
      FROM encounter_history e
     WHERE (e.user_a_id = $1 OR e.user_b_id = $1) AND (e.times_met > 0 OR e.last_session_id IS NOT NULL)
  ),
  people AS (
    SELECT person_id, bool_or(met) AS met, date_trunc('milliseconds', MAX(at)) AS since
      FROM signals
     GROUP BY person_id
  )`;

// $1 the member, $2 the cursor (people strictly before it) or null, $3 how many, $4 one moment only, or null.
const CONNECTIONS_SQL = `
  WITH ${CONNECTION_SIGNALS_SQL}
  SELECT u.id AS user_id, u.display_name, u.avatar_url, u.job_title, u.company, pe.met, pe.since
    FROM people pe
    JOIN users u ON u.id = pe.person_id
   WHERE u.id <> $1
     AND u.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM user_blocks b
                      WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                         OR (b.blocker_id = u.id AND b.blocked_id = $1))
     AND ($2::timestamptz IS NULL OR pe.since < $2::timestamptz)
     AND ($4::timestamptz IS NULL OR pe.since = $4::timestamptz)
   ORDER BY pe.since DESC, u.id
   LIMIT $3`;

const toItem = (r: Row): PersonConnection => ({
  userId: r.user_id,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  jobTitle: r.job_title,
  company: r.company,
  how: r.met ? 'met' : 'connected',
  since: r.since.toISOString(),
});

const read = async (viewerId: string, before: string | null, count: number, moment: string | null): Promise<Row[]> =>
  (await query<Row>(CONNECTIONS_SQL, [viewerId, before, count, moment])).rows;

/**
 * One page of people listed newest first by `since`, from a reader that answers "this many people, optionally only
 * those at this one moment". The next page is asked for with `before` set to `nextBefore`, and holds the people
 * strictly before it. A page therefore never ends between two people with the same time, or the next one would
 * skip the second: the people who share the time of the first person past the page wait for the next page
 * together. Only when more people than a page share one moment is the page all of them, and longer. The People
 * page and the invite picker (a member's connections, or an event's pod) page the same way, through this.
 */
export async function pageBySince<T extends { since: Date }>(
  limit: number,
  readPeople: (count: number, moment: string | null) => Promise<T[]>,
): Promise<{ rows: T[]; nextBefore: string | null }> {
  const rows = await readPeople(limit + 1, null);
  if (rows.length <= limit) return { rows, nextBefore: null };

  const waiting = rows[limit].since.getTime();
  const page = rows.slice(0, limit).filter((r) => r.since.getTime() !== waiting);
  if (page.length > 0) return { rows: page, nextBefore: page[page.length - 1].since.toISOString() };

  const moment = rows[limit].since.toISOString();
  return { rows: await readPeople(ONE_MOMENT_MAX, moment), nextBefore: moment };
}

/** One page of the member's connections, newest first (see pageBySince for how pages are cut). */
export async function listConnections(
  viewerId: string,
  { limit, before }: { limit: number; before: string | null },
): Promise<ConnectionList> {
  const { rows, nextBefore } = await pageBySince(limit, (count, moment) => read(viewerId, before, count, moment));
  return { items: rows.map(toItem), nextBefore };
}
