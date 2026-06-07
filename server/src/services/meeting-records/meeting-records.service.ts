// ─── Meeting Records Service ────────────────────────────────────────────────
//
// Phase 2 (1 May 2026 spec) — stored counts + recap stability.
//
// Stefan's spec items 3+4: counts must be deterministic, stored backend-side,
// never recalculated from UI. Pre-Phase-2, recap counts were derived via
// JOINs over matches × ratings × encounter_history at every render, with
// three different SQL bodies producing three slightly different numbers.
// encounter_history.mutual_meet_again also mutated as later rounds finalised
// so refreshing the recap mid-event changed displayed counts.
//
// meeting_records (migration 054) is now the canonical per-meeting record.
// Written exactly once when the round's rating window closes. Updated only
// when the partner submits their rating. Three deterministic metrics:
//
//   - getUniquePeopleMet: COUNT(DISTINCT partner_id)
//   - getTotalMeetings:   COUNT(*)
//   - getMutualMatches:   COUNT(DISTINCT partner_id) WHERE is_mutual
//
// Bug 5 (13 May live test) — getMutualMatches and getMeetingCounts.mutual
// previously used COUNT(*) which counted one row per round-pair, so a pair
// that hit mutual yes across N rounds showed as N mutual matches instead
// of 1. The dedup matches getUniquePeopleMet: a mutual match is a unique
// partner relationship, not a per-round occurrence.
//
// All recap consumers read from here. encounter_history becomes purely the
// cross-session aggregate, no longer driving per-event counts.

import { query } from '../../db';
import logger from '../../config/logger';

export interface MeetingRecordRow {
  id: string;
  sessionId: string;
  roundNumber: number;
  matchId: string;
  userId: string;
  partnerId: string;
  ratingGiven: number | null;
  meetAgainSelf: boolean | null;
  meetAgainPartner: boolean | null;
  isMutual: boolean;
  isRecapEligible: boolean;
  recordedAt: Date;
}

export interface MeetingRecordCounts {
  uniquePeopleMet: number;
  totalMeetings: number;
  mutualMatches: number;
}

/**
 * Idempotent upsert. Called from finalizeRoundRatings for each match in the
 * round. Ratings may not exist yet at finalize time (one or both participants
 * skipped); the row is created with NULL rating fields and updated later via
 * upsertRatingForMeeting when the rating lands.
 */
export async function recordMeeting(input: {
  sessionId: string;
  roundNumber: number;
  matchId: string;
  userId: string;
  partnerId: string;
  ratingGiven?: number | null;
  meetAgainSelf?: boolean | null;
  meetAgainPartner?: boolean | null;
}): Promise<void> {
  const {
    sessionId, roundNumber, matchId, userId, partnerId,
    ratingGiven = null, meetAgainSelf = null, meetAgainPartner = null,
  } = input;

  if (userId === partnerId) {
    logger.warn({ userId, partnerId, matchId }, 'recordMeeting: refused self-meeting');
    return;
  }

  await query(
    `INSERT INTO meeting_records (
       session_id, round_number, match_id, user_id, partner_id,
       rating_given, meet_again_self, meet_again_partner, is_recap_eligible
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     ON CONFLICT (session_id, round_number, user_id, partner_id) DO UPDATE
     SET rating_given = COALESCE(EXCLUDED.rating_given, meeting_records.rating_given),
         meet_again_self = COALESCE(EXCLUDED.meet_again_self, meeting_records.meet_again_self),
         meet_again_partner = COALESCE(EXCLUDED.meet_again_partner, meeting_records.meet_again_partner)`,
    [sessionId, roundNumber, matchId, userId, partnerId, ratingGiven, meetAgainSelf, meetAgainPartner],
  );
}

/**
 * Called when a rating lands. Updates the rater's row with their own vote,
 * AND the partner's row with `meet_again_partner = my vote` so both sides'
 * is_mutual recompute correctly.
 */
export async function upsertRatingForMeeting(input: {
  sessionId: string;
  roundNumber: number;
  matchId: string;
  raterUserId: string;
  ratedUserId: string;
  // null = excluded rating (didn't work / no_show / cancelled): the
  // meeting record still counts, the score is withheld from the recap.
  qualityScore: number | null;
  meetAgain: boolean;
}): Promise<void> {
  const { sessionId, roundNumber, matchId, raterUserId, ratedUserId, qualityScore, meetAgain } = input;

  // Update the rater's row (rating_given + meet_again_self).
  await query(
    `INSERT INTO meeting_records (
       session_id, round_number, match_id, user_id, partner_id,
       rating_given, meet_again_self, is_recap_eligible
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     ON CONFLICT (session_id, round_number, user_id, partner_id) DO UPDATE
     SET rating_given = EXCLUDED.rating_given,
         meet_again_self = EXCLUDED.meet_again_self`,
    [sessionId, roundNumber, matchId, raterUserId, ratedUserId, qualityScore, meetAgain],
  );

  // Update the partner's row (meet_again_partner = the rater's vote).
  await query(
    `INSERT INTO meeting_records (
       session_id, round_number, match_id, user_id, partner_id,
       meet_again_partner, is_recap_eligible
     ) VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     ON CONFLICT (session_id, round_number, user_id, partner_id) DO UPDATE
     SET meet_again_partner = EXCLUDED.meet_again_partner`,
    [sessionId, roundNumber, matchId, ratedUserId, raterUserId, meetAgain],
  );
}

/** Distinct count of partners the user met in this session. */
export async function getUniquePeopleMet(userId: string, sessionId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT partner_id)::text AS count
     FROM meeting_records
     WHERE user_id = $1 AND session_id = $2 AND is_recap_eligible = TRUE`,
    [userId, sessionId],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/** Total meetings (counts repeats — same partner across multiple rounds). */
export async function getTotalMeetings(userId: string, sessionId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM meeting_records
     WHERE user_id = $1 AND session_id = $2 AND is_recap_eligible = TRUE`,
    [userId, sessionId],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/** Mutual matches: distinct partners where both said yes in at least one round. */
export async function getMutualMatches(userId: string, sessionId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT partner_id)::text AS count
     FROM meeting_records
     WHERE user_id = $1 AND session_id = $2
       AND is_recap_eligible = TRUE AND is_mutual = TRUE`,
    [userId, sessionId],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/** All three counts in one round-trip for the recap UI. */
export async function getMeetingCounts(userId: string, sessionId: string): Promise<MeetingRecordCounts> {
  const result = await query<{ unique_people: string; total: string; mutual: string }>(
    `SELECT
       COUNT(DISTINCT partner_id)::text AS unique_people,
       COUNT(*)::text AS total,
       COUNT(DISTINCT partner_id) FILTER (WHERE is_mutual = TRUE)::text AS mutual
     FROM meeting_records
     WHERE user_id = $1 AND session_id = $2 AND is_recap_eligible = TRUE`,
    [userId, sessionId],
  );
  const row = result.rows[0];
  return {
    uniquePeopleMet: parseInt(row?.unique_people || '0', 10),
    totalMeetings: parseInt(row?.total || '0', 10),
    mutualMatches: parseInt(row?.mutual || '0', 10),
  };
}

/**
 * Bulk-record meetings for an entire round. Called from finalizeRoundRatings
 * with the matches that just ended. Generates the user×partner edges from
 * each match (one per direction so each user gets their own row) and upserts
 * them all. Existing ratings (if already submitted) are populated; missing
 * ratings stay NULL until upsertRatingForMeeting fills them.
 */
export async function recordRoundMeetings(
  sessionId: string,
  roundNumber: number,
  matches: { id: string; participantAId: string; participantBId: string | null; participantCId?: string | null; departedUserIds?: string[] | null }[],
): Promise<{ recorded: number }> {
  let recorded = 0;
  for (const m of matches) {
    // "People met" must count anyone who was in the room — INCLUDING someone
    // who left within seconds (2026-06-08: waseem departed a trio immediately;
    // his recap showed People Met 0 while the round list correctly showed the 2
    // he was with). departed_user_ids holds exactly the people who WERE in the
    // room (no-show absentees use recordDeparted=false and never land here), so
    // union them in: every pair among slots ∪ departed gets a meeting_record.
    const ids = Array.from(new Set(
      [m.participantAId, m.participantBId, m.participantCId, ...(m.departedUserIds ?? [])]
        .filter((x): x is string => !!x),
    ));
    // Existing ratings for this match (if any) so we populate fields on first insert.
    const ratingsRes = await query<{ from_user_id: string; to_user_id: string; quality_score: number; meet_again: boolean }>(
      `SELECT from_user_id, to_user_id, quality_score, meet_again FROM ratings WHERE match_id = $1`,
      [m.id],
    );
    const ratingMap = new Map<string, { quality_score: number; meet_again: boolean }>();
    for (const r of ratingsRes.rows) {
      ratingMap.set(`${r.from_user_id}|${r.to_user_id}`, { quality_score: r.quality_score, meet_again: r.meet_again });
    }
    // For each (user, partner) directed pair, write one row.
    for (const userId of ids) {
      for (const partnerId of ids) {
        if (userId === partnerId) continue;
        const own = ratingMap.get(`${userId}|${partnerId}`);
        const partner = ratingMap.get(`${partnerId}|${userId}`);
        await recordMeeting({
          sessionId, roundNumber, matchId: m.id, userId, partnerId,
          ratingGiven: own?.quality_score ?? null,
          meetAgainSelf: own?.meet_again ?? null,
          meetAgainPartner: partner?.meet_again ?? null,
        });
        recorded++;
      }
    }
  }
  return { recorded };
}
