// ─── The Human Profile brief (REASON milestone 1, 29 Sep 2026) ───────────────
// Everything the Human Profile shows about ONE person, from where the viewer
// stands: who they are (the public card only), why REASON thinks they matter,
// where the relationship is, what you share, and one path through someone you
// both really know. The other member's wants never leave the server (Stefan,
// 9 Sep): until the per-reason share switch exists, the brief carries only
// what they OFFER and what the VIEWER is looking for.

import { query } from '../../db';
import {
  ErrorCodes, type OutcomeKey, type PersonBrief, type RecentConnection,
  type RelationshipState, type WorthContinuing,
} from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';
import * as blockService from '../block/block.service';
import { getUserById } from '../identity/identity.service';
import { toPublicIntentProfile, toPublicMember } from '../user/public-card';
import { loadProfile, scoreFit, MATCH_THRESHOLD, BROWSE_THRESHOLD } from '../matching/platform-match.service';
import { getPokeWith } from '../poke/poke.service';
import { getResponse } from './person-response.service';
import { clip } from './text';

// An answer is worth showing when it has a letter or digit in it. A member who types ".", "…" or "!!!"
// to get past a box has given no answer, and after a colon it reads as a mistake. It is judged on the
// text the page would show (clip cuts a long answer short), and it counts as blank, so the reading goes
// on to the member's next field.
const usableAnswer = (text: string | null | undefined): string | null => {
  const shown = clip(text);
  return shown && /[\p{L}\p{N}]/u.test(shown) ? shown : null;
};

// A member's words are set after a colon exactly as they wrote them: their own first letter, capital or
// not, reads naturally there ("european market entry", "Mentorship for founders", "I can help with
// pricing"). Only the end changes: whatever sentence-ending marks and spaces it ends in, in any script
// ("!", " ?", ". . .", "。"), become one full stop. An answer clip had to cut already ends in "…", which is
// not a sentence-ending mark and ends the clause, and a full stop after it would make a cut word look finished.
function asClause(answer: string): string {
  const bare = answer.replace(/[\s\p{Sentence_Terminal}]+$/u, '');
  return bare.endsWith('…') ? bare : `${bare}.`;
}

// A host's event title is shown exactly as written, so unlike an answer it keeps its own "!" or "?". It
// gets a full stop only when it does not already end its sentence: "Founders Night!", "Coffee & Co." and
// "Back again…" stay as they are.
const endTitle = (title: string): string => (/[\p{Sentence_Terminal}…]$/u.test(title) ? title : `${title}.`);

/**
 * "The first 20 minutes": fixed words around the two members' own answers (approved point 3).
 * With no usable offer the line says why REASON put the two together when it has a reason, and
 * otherwise asks each of them what they are working on.
 */
function openerFor(o: {
  first: string; theyCanBring: string | null; youAreLookingFor: string | null; hasMatch: boolean; sharedEvent: string | null;
}): string {
  const parts: string[] = [];
  if (o.theyCanBring) parts.push(`Start with what ${o.first} can bring: ${asClause(o.theyCanBring)}`);
  else if (o.hasMatch) parts.push('Start with why REASON put you two together.');
  else parts.push('Start with what each of you is working on right now.');
  if (o.youAreLookingFor) parts.push(`Then say what you are looking for: ${asClause(o.youAreLookingFor)}`);
  // Titles are only checked for length, so one can end in spaces, or be nothing else.
  const event = o.sharedEvent?.trimEnd();
  if (event) parts.push(`You will both be at ${endTitle(event)}`);
  return parts.join(' ');
}

/**
 * "Your path": one person between you, never a mutual-connection count. Each
 * hop is a relationship both of its people chose: you genuinely met M, and M
 * and the person both said "meet again" or accepted a meeting request.
 * Driven from the viewer's own encounters, so it reads a handful of rows.
 */
async function findPath(viewerId: string, targetId: string): Promise<{ id: string; displayName: string } | null> {
  const r = await query<{ id: string; display_name: string }>(
    `SELECT m.id, m.display_name
       FROM encounter_history e1
       JOIN users m ON m.id = CASE WHEN e1.user_a_id = $1 THEN e1.user_b_id ELSE e1.user_a_id END
      WHERE (e1.user_a_id = $1 OR e1.user_b_id = $1)
        AND (e1.times_met > 0 OR e1.last_session_id IS NOT NULL)
        AND m.id <> $2 AND m.status = 'active'
        AND (
          EXISTS (SELECT 1 FROM encounter_history e2
                   WHERE e2.user_a_id = LEAST($2::uuid, m.id) AND e2.user_b_id = GREATEST($2::uuid, m.id)
                     AND e2.mutual_meet_again = true)
          OR EXISTS (SELECT 1 FROM user_pokes p
                      WHERE p.status = 'accepted'
                        AND ((p.sender_id = m.id AND p.recipient_id = $2)
                          OR (p.sender_id = $2 AND p.recipient_id = m.id))))
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id IN ($1, $2) AND b.blocked_id = m.id)
                            OR (b.blocker_id = m.id AND b.blocked_id IN ($1, $2)))
      ORDER BY e1.last_met_at DESC
      LIMIT 1`,
    [viewerId, targetId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, displayName: row.display_name } : null;
}

export async function getPersonBrief(viewerId: string, targetId: string): Promise<PersonBrief> {
  if (viewerId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'This is your own profile');
  }
  if (await blockService.areBlocked(viewerId, targetId)) throw new NotFoundError('User', targetId);
  const target = await getUserById(targetId);
  if (target.status !== 'active') throw new NotFoundError('User', targetId);

  const [a, b] = viewerId < targetId ? [viewerId, targetId] : [targetId, viewerId];

  // The eleven reads used to start together in one Promise.all, so a single profile open could hold eleven
  // of the pool's connections (25 by default) and crowd everyone else out. They run in three groups of at
  // most four: where the relationship stands, then the two profiles and what the viewer has recorded, then
  // what the two share. A failure in the first group ends the brief before the rest are asked.
  const [poke, response, enc, conv] = await Promise.all([
    getPokeWith(viewerId, targetId),
    getResponse(viewerId, targetId),
    query<{ times_met: number; last_met_at: Date; last_session_id: string | null }>(
      `SELECT times_met, last_met_at, last_session_id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2`,
      [a, b]),
    query<{ id: string; joined_a: Date | null; joined_b: Date | null }>(
      `SELECT id, meeting_joined_a_at AS joined_a, meeting_joined_b_at AS joined_b FROM dm_conversations WHERE user_a_id = $1 AND user_b_id = $2`,
      [a, b]),
  ]);
  const [me, them, outcomeRows] = await Promise.all([
    loadProfile(viewerId),
    loadProfile(targetId),
    query<{ worth_continuing: WorthContinuing; outcome_keys: OutcomeKey[]; created_at: Date }>(
      `SELECT worth_continuing, outcome_keys, created_at FROM meeting_outcomes
        WHERE user_id = $1 AND target_user_id = $2 ORDER BY created_at DESC LIMIT 5`,
      [viewerId, targetId]),
  ]);
  const [circles, pods, events, path] = await Promise.all([
    query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM circle_members x
         JOIN circle_members y ON y.circle_id = x.circle_id
         JOIN circles c ON c.id = x.circle_id
        WHERE x.user_id = $1 AND y.user_id = $2 AND c.archived_at IS NULL
        ORDER BY c.name LIMIT 5`,
      [viewerId, targetId]),
    query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM pod_members x
         JOIN pod_members y ON y.pod_id = x.pod_id
         JOIN pods p ON p.id = x.pod_id
        WHERE x.user_id = $1 AND y.user_id = $2 AND x.status = 'active' AND y.status = 'active' AND p.status = 'active'
        ORDER BY p.name LIMIT 5`,
      [viewerId, targetId]),
    query<{ id: string; title: string; scheduled_at: Date }>(
      `SELECT s.id, s.title, s.scheduled_at FROM session_participants x
         JOIN session_participants y ON y.session_id = x.session_id
         JOIN sessions s ON s.id = x.session_id
        WHERE x.user_id = $1 AND y.user_id = $2
          AND x.status NOT IN ('removed', 'left', 'no_show') AND y.status NOT IN ('removed', 'left', 'no_show')
          AND s.status = 'scheduled' AND s.scheduled_at > NOW()
        ORDER BY s.scheduled_at ASC LIMIT 3`,
      [viewerId, targetId]),
    findPath(viewerId, targetId),
  ]);

  // The brief can be aimed at ANY member by id, so the fit is judged on the public card only:
  // the scorer counts private interests as offers and words its reason from what matched.
  const fit = me && them ? scoreFit(me, toPublicIntentProfile(them)) : null;
  const strength = !fit ? null : fit.score >= MATCH_THRESHOLD ? 'strong' : fit.score >= BROWSE_THRESHOLD ? 'close' : null;

  const e = enc.rows[0];
  const c = conv.rows[0];
  const metAtEvent = !!e && (e.times_met > 0 || !!e.last_session_id);
  const metOneToOne = !!(c?.joined_a && c?.joined_b);
  const state: RelationshipState =
    metAtEvent || metOneToOne ? 'met'
      : poke?.status === 'accepted' || !!c ? 'connected'
        : poke?.status === 'pending' ? (poke.sentByMe ? 'requested' : 'incoming')
          : poke?.status === 'declined' && poke.sentByMe ? 'declined'
            : 'none';

  const person = toPublicMember(target);
  // The opener says "what {first} can bring", so a member with no name at all is "they".
  const first = person.firstName || person.displayName.split(' ')[0] || 'they';
  // A blank answer ('' or only spaces) and one with nothing in it ('.', '…') are null, which is what falls
  // through to the next field.
  const theyCanBring = usableAnswer(them?.whatICanHelpWith) ?? usableAnswer(them?.expertiseText);
  const youAreLookingFor = usableAnswer(me?.whoIWantToMeet) ?? usableAnswer(me?.myIntent);
  const upcomingEvents = events.rows.map(r => ({ id: r.id, title: r.title, scheduledAt: r.scheduled_at.toISOString() }));
  const match: PersonBrief['match'] = fit && strength ? { reason: fit.reason, strength } : null;

  return {
    person,
    match,
    theyCanBring,
    youAreLookingFor,
    opener: openerFor({
      first, theyCanBring, youAreLookingFor, hasMatch: match !== null, sharedEvent: upcomingEvents[0]?.title ?? null,
    }),
    relationship: {
      state,
      pokeId: poke?.status === 'pending' && !poke.sentByMe ? poke.id : null,
      timesMet: Math.max(e?.times_met ?? 0, metAtEvent ? 1 : 0) + (metOneToOne ? 1 : 0),
      lastMetAt: metAtEvent && e ? e.last_met_at.toISOString() : null,
      saved: response === 'saved',
      passed: response === 'passed',
      outcomes: outcomeRows.rows.map(r => ({
        worthContinuing: r.worth_continuing, outcomes: r.outcome_keys, createdAt: r.created_at.toISOString(),
      })),
    },
    shared: { circles: circles.rows, pods: pods.rows, upcomingEvents },
    path,
  };
}

export async function listRecentConnections(userId: string): Promise<RecentConnection[]> {
  const r = await query<{ user_id: string; display_name: string; avatar_url: string | null; connected_at: Date }>(
    // One row per person: two members who each had a request accepted by the other have two
    // accepted rows between them, and are listed once, at the time of the newest.
    `SELECT u.id AS user_id, u.display_name, u.avatar_url, MAX(p.responded_at) AS connected_at
       FROM user_pokes p
       JOIN users u ON u.id = CASE WHEN p.sender_id = $1 THEN p.recipient_id ELSE p.sender_id END
      WHERE (p.sender_id = $1 OR p.recipient_id = $1)
        AND p.status = 'accepted' AND p.responded_at IS NOT NULL
        AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                            OR (b.blocker_id = u.id AND b.blocked_id = $1))
      GROUP BY u.id, u.display_name, u.avatar_url
      ORDER BY connected_at DESC
      LIMIT 5`,
    [userId],
  );
  return r.rows.map(row => ({
    userId: row.user_id, displayName: row.display_name, avatarUrl: row.avatar_url,
    connectedAt: row.connected_at.toISOString(),
  }));
}
