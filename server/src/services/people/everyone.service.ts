// ─── Everyone (REASON, Stefan 10 Nov 2026) ───────────────────────────────────
// "HOW can I connect with ANYONE, you know, just browse through." A list of every member the viewer may meet,
// A to Z, a page at a time, with a search box. Nothing here needs a typed word to show people.
//
// Listed: active, finished onboarding (spec 12/13: an incomplete account never appears) and kept "Show me in search
// and suggestions" on, which is the directory consent. Never listed: the viewer, and anyone blocked either way.
// Fields: the public card only (toPublicMember); what a member wants stays private.
//
// Order is lower(display_name) then id, and the cursor is that pair, so a page never skips or repeats anyone even
// when two members share a name. Each row says where a meeting request between the two stands (live requests only:
// pending or accepted, so a declined or cancelled one reads as no request) and how the two are related, derived
// from the same signals as Your connections (CONNECTION_SIGNALS_SQL).

import { z } from 'zod';
import { query } from '../../db';
import { ValidationError } from '../../middleware/errors';
import type { EveryoneMember, EveryonePage, RelationshipState } from '@rsn/shared';
import { toPublicMember } from '../user/public-card';
import { bannerUrlFor } from '../user/banner.service';
import { CONNECTION_SIGNALS_SQL } from './connections.service';

export const EVERYONE_PAGE = 30;
export const EVERYONE_PAGE_MAX = 50;
export const EVERYONE_SEARCH_MAX = 100;

export type EveryoneRow = EveryoneMember;

export interface EveryoneOptions { q?: string; cursor?: string | null; limit?: number }

interface Row {
  id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  banner_updated_at: Date | null;
  bio: string | null;
  company: string | null;
  job_title: string | null;
  industry: string | null;
  location: string | null;
  linkedin_url: string | null;
  languages: string[] | null;
  professional_role: string[] | null;
  expertise_text: string | null;
  what_i_can_help_with: string | null;
  sort_name: string;
  poke_status: 'pending' | 'accepted' | null;
  poke_sent_by_owner: boolean | null;
  connected: boolean | null;
  met: boolean | null;
  declined_by_them: boolean | null;
}

// An opaque cursor: base64url of {n, id}. Whatever else arrives is refused, not trusted into SQL.
// A NUL character is not valid text in Postgres: it would come back as a 500, so it is refused here as a 400.
const noNul = (s: string) => !s.includes('\u0000');
const cursorShape = z.object({ n: z.string().max(400).refine(noNul), id: z.string().uuid() }).strict();
export const searchWord = z.string().trim().max(EVERYONE_SEARCH_MAX).refine(noNul, 'Search words cannot hold that character.');

export function encodeCursor(sortName: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: sortName, id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { n: string; id: string } {
  try {
    const parsed = cursorShape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { n: parsed.n, id: parsed.id.toLowerCase() };
  } catch {
    throw new ValidationError('That page of people is no longer available. Start again from the top.');
  }
}

/** A search word as an ILIKE pattern: the characters LIKE treats as wildcards are matched literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// $1 viewer, $2 pattern or null, $3 cursor name or null, $4 cursor id or null, $5 how many.
const EVERYONE_SQL = `
  WITH ${CONNECTION_SIGNALS_SQL}
  SELECT u.id, u.display_name, u.first_name, u.last_name, u.avatar_url,
         CASE WHEN u.banner_blob IS NOT NULL THEN u.banner_updated_at END AS banner_updated_at,
         u.bio, u.company, u.job_title, u.industry, u.location, u.linkedin_url, u.languages,
         u.professional_role, u.expertise_text, u.what_i_can_help_with,
         lower(COALESCE(u.display_name, '')) AS sort_name,
         pk.status AS poke_status, (pk.sender_id = $1) AS poke_sent_by_owner,
         (pe.person_id IS NOT NULL) AS connected, COALESCE(pe.met, false) AS met,
         EXISTS (SELECT 1 FROM user_pokes d
                  WHERE d.sender_id = $1 AND d.recipient_id = u.id AND d.status = 'declined') AS declined_by_them
    FROM users u
    LEFT JOIN people pe ON pe.person_id = u.id
    LEFT JOIN LATERAL (
      SELECT p2.status, p2.sender_id
        FROM user_pokes p2
       WHERE p2.status IN ('pending', 'accepted')
         AND ((p2.sender_id = $1 AND p2.recipient_id = u.id)
           OR (p2.sender_id = u.id AND p2.recipient_id = $1))
       ORDER BY p2.created_at DESC
       LIMIT 1
    ) pk ON TRUE
   WHERE u.id <> $1
     AND u.status = 'active'
     AND u.onboarding_completed = true
     AND u.profile_visible = true
     AND NOT EXISTS (SELECT 1 FROM user_blocks b
                      WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                         OR (b.blocker_id = u.id AND b.blocked_id = $1))
     AND ($2::text IS NULL
          OR u.display_name ILIKE $2::text
          OR u.company ILIKE $2::text
          OR u.job_title ILIKE $2::text
          OR array_to_string(u.professional_role, ' ') ILIKE $2::text)
     AND ($3::text IS NULL
          OR (lower(COALESCE(u.display_name, '')), u.id) > ($3::text, $4::uuid))
   ORDER BY lower(COALESCE(u.display_name, '')), u.id
   LIMIT $5`;

function relationshipOf(r: Row): RelationshipState {
  if (r.met) return 'met';
  if (r.connected || r.poke_status === 'accepted') return 'connected';
  if (r.poke_status === 'pending') return r.poke_sent_by_owner ? 'requested' : 'incoming';
  // sendPoke refuses a second request to someone who declined the first, so the sender reads it as declined (the
  // Human Profile's rule). The one who declined can still ask later, and reads none.
  return r.declined_by_them ? 'declined' : 'none';
}

const toRow = (r: Row): EveryoneRow => ({
  ...toPublicMember({
    id: r.id,
    displayName: r.display_name ?? '',
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    avatarUrl: r.avatar_url,
    bannerUrl: bannerUrlFor(r.id, r.banner_updated_at),
    bio: r.bio,
    company: r.company,
    jobTitle: r.job_title,
    industry: r.industry,
    location: r.location,
    linkedinUrl: r.linkedin_url,
    languages: r.languages ?? [],
    professionalRole: r.professional_role ?? [],
    expertiseText: r.expertise_text,
    whatICanHelpWith: r.what_i_can_help_with,
  }),
  pokeStatus: r.poke_status,
  pokeSentByOwner: r.poke_status ? !!r.poke_sent_by_owner : null,
  relationship: relationshipOf(r),
});

export async function listEveryone(viewerId: string, opts: EveryoneOptions = {}): Promise<EveryonePage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? EVERYONE_PAGE), 1), EVERYONE_PAGE_MAX);
  const word = opts.q?.trim().slice(0, EVERYONE_SEARCH_MAX);
  if (word && !noNul(word)) throw new ValidationError('Search words cannot hold that character.');
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const r = await query<Row>(EVERYONE_SQL, [
    viewerId, word ? likePattern(word) : null, cursor?.n ?? null, cursor?.id ?? null, limit + 1,
  ]);
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    people: page.map(toRow),
    nextCursor: r.rows.length > limit && last ? encodeCursor(last.sort_name, last.id) : null,
  };
}
