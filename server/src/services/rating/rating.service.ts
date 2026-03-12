// ─── Rating & Encounter Service ──────────────────────────────────────────────
// Handles rating submission, encounter history tracking, mutual meet-again
// detection, and people-met / connection-result queries.

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  Rating, CreateRatingInput, EncounterHistory, ConnectionResult,
  PeopleMet, Match,
} from '@rsn/shared';
import { ErrorCodes } from '@rsn/shared';
import { NotFoundError, ConflictError, ValidationError, ForbiddenError } from '../../middleware/errors';

// ─── Column Aliases ─────────────────────────────────────────────────────────

const RATING_COLUMNS = `
  id, match_id AS "matchId", from_user_id AS "fromUserId",
  to_user_id AS "toUserId", quality_score AS "qualityScore",
  meet_again AS "meetAgain", feedback, created_at AS "createdAt"
`;

const ENCOUNTER_COLUMNS = `
  id, user_a_id AS "userAId", user_b_id AS "userBId",
  times_met AS "timesMet", last_met_at AS "lastMetAt",
  last_session_id AS "lastSessionId", last_quality_score AS "lastQualityScore",
  last_meet_again_a AS "lastMeetAgainA", last_meet_again_b AS "lastMeetAgainB",
  mutual_meet_again AS "mutualMeetAgain",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// ─── Submit Rating ──────────────────────────────────────────────────────────

export async function submitRating(
  fromUserId: string,
  input: CreateRatingInput
): Promise<Rating> {
  // Validate the match exists and the user is a participant
  const matchResult = await query<Match>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            status, created_at AS "createdAt"
     FROM matches WHERE id = $1`,
    [input.matchId]
  );

  if (matchResult.rows.length === 0) {
    throw new NotFoundError('Match not found');
  }

  const match = matchResult.rows[0];

  // Check user was in this match
  const isParticipantA = match.participantAId === fromUserId;
  const isParticipantB = match.participantBId === fromUserId;
  if (!isParticipantA && !isParticipantB) {
    throw new ForbiddenError('You are not a participant in this match');
  }

  // Check match status allows rating (completed, active, or no_show — no_show can happen
  // when heartbeat detection fires prematurely but users were still in the call)
  if (!['completed', 'active', 'no_show'].includes(match.status)) {
    throw new ValidationError('Match is not in a ratable state');
  }

  // Validate quality score
  if (input.qualityScore < 1 || input.qualityScore > 5 || !Number.isInteger(input.qualityScore)) {
    throw new ValidationError('Quality score must be an integer between 1 and 5');
  }

  // Determine rating target
  const toUserId = isParticipantA ? match.participantBId : match.participantAId;

  // Check for duplicate rating
  const existingRating = await query(
    'SELECT id FROM ratings WHERE match_id = $1 AND from_user_id = $2',
    [input.matchId, fromUserId]
  );

  if (existingRating.rows.length > 0) {
    throw new ConflictError(ErrorCodes.MATCH_ALREADY_RATED, 'You have already rated this match');
  }

  const ratingId = uuid();

  // Use transaction to submit rating + update encounter history atomically
  return transaction(async (client) => {
    // Insert the rating
    const result = await client.query<Rating>(
      `INSERT INTO ratings (id, match_id, from_user_id, to_user_id, quality_score, meet_again, feedback)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${RATING_COLUMNS}`,
      [ratingId, input.matchId, fromUserId, toUserId, input.qualityScore, input.meetAgain, input.feedback || null]
    );

    const rating = result.rows[0];

    // Update encounter history
    await upsertEncounterHistory(
      client, fromUserId, toUserId, match.sessionId, input.qualityScore, input.meetAgain
    );

    logger.info({ ratingId, matchId: input.matchId, fromUserId, toUserId }, 'Rating submitted');
    return rating;
  });
}

// ─── Upsert Encounter History ───────────────────────────────────────────────
// Always stores user IDs in ordered fashion (user_a_id < user_b_id) per the
// CHECK constraint in the schema.

async function upsertEncounterHistory(
  client: any,
  fromUserId: string,
  toUserId: string,
  sessionId: string,
  qualityScore: number,
  meetAgain: boolean
): Promise<void> {
  // Determine ordered IDs
  const [userAId, userBId] = fromUserId < toUserId
    ? [fromUserId, toUserId]
    : [toUserId, fromUserId];

  const isFromA = fromUserId === userAId;

  // Try to find existing encounter
  const existing = await client.query(
    'SELECT id, last_meet_again_a, last_meet_again_b FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 FOR UPDATE',
    [userAId, userBId]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const meetAgainA = isFromA ? meetAgain : row.last_meet_again_a;
    const meetAgainB = isFromA ? row.last_meet_again_b : meetAgain;
    const mutual = meetAgainA === true && meetAgainB === true;

    // Only increment times_met when this is the FIRST rating for this encounter
    // (i.e. when the other side hasn't rated yet for this session).
    // This prevents double-counting when both participants rate the same match.
    const isFirstRating = isFromA
      ? row.last_meet_again_b === null || row.last_session_id !== sessionId
      : row.last_meet_again_a === null || row.last_session_id !== sessionId;

    await client.query(
      `UPDATE encounter_history
       SET times_met = ${isFirstRating ? 'times_met + 1' : 'times_met'},
           last_met_at = NOW(),
           last_session_id = $3,
           last_quality_score = $4,
           ${isFromA ? 'last_meet_again_a' : 'last_meet_again_b'} = $5,
           mutual_meet_again = $6,
           updated_at = NOW()
       WHERE user_a_id = $1 AND user_b_id = $2`,
      [userAId, userBId, sessionId, qualityScore, meetAgain, mutual]
    );
  } else {
    const meetAgainA = isFromA ? meetAgain : null;
    const meetAgainB = isFromA ? null : meetAgain;

    await client.query(
      `INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at, last_session_id,
                                       last_quality_score, last_meet_again_a, last_meet_again_b, mutual_meet_again)
       VALUES ($1, $2, $3, 1, NOW(), $4, $5, $6, $7, FALSE)`,
      [uuid(), userAId, userBId, sessionId, qualityScore, meetAgainA, meetAgainB]
    );
  }
}

// ─── Check if user is a participant in a match ─────────────────────────────

export async function isMatchParticipant(matchId: string, userId: string): Promise<boolean> {
  const result = await query(
    `SELECT id FROM matches WHERE id = $1 AND (participant_a_id = $2 OR participant_b_id = $2)`,
    [matchId, userId]
  );
  return result.rows.length > 0;
}

// ─── Check Mutual Meet-Again for a Specific Match ───────────────────────────

export async function checkMutualMeetAgain(matchId: string): Promise<boolean> {
  const ratingsResult = await query<{ fromUserId: string; meetAgain: boolean }>(
    `SELECT from_user_id AS "fromUserId", meet_again AS "meetAgain"
     FROM ratings WHERE match_id = $1`,
    [matchId]
  );

  if (ratingsResult.rows.length < 2) return false;

  return ratingsResult.rows.every(r => r.meetAgain);
}

// ─── Get Ratings for a Match ────────────────────────────────────────────────

export async function getRatingsByMatch(matchId: string): Promise<Rating[]> {
  const result = await query<Rating>(
    `SELECT ${RATING_COLUMNS} FROM ratings WHERE match_id = $1`,
    [matchId]
  );
  return result.rows;
}

// ─── Get Ratings Given by User ──────────────────────────────────────────────

export async function getRatingsByUser(
  userId: string,
  sessionId?: string
): Promise<Rating[]> {
  let sql = `SELECT ${RATING_COLUMNS} FROM ratings WHERE from_user_id = $1`;
  const params: any[] = [userId];

  if (sessionId) {
    sql += ` AND match_id IN (SELECT id FROM matches WHERE session_id = $2)`;
    params.push(sessionId);
  }

  sql += ' ORDER BY created_at DESC';

  const result = await query<Rating>(sql, params);
  return result.rows;
}

// ─── Get Ratings Received by User ───────────────────────────────────────────

export async function getRatingsReceived(
  userId: string,
  sessionId?: string
): Promise<Rating[]> {
  let sql = `SELECT ${RATING_COLUMNS} FROM ratings WHERE to_user_id = $1`;
  const params: any[] = [userId];

  if (sessionId) {
    sql += ` AND match_id IN (SELECT id FROM matches WHERE session_id = $2)`;
    params.push(sessionId);
  }

  sql += ' ORDER BY created_at DESC';

  const result = await query<Rating>(sql, params);
  return result.rows;
}

// ─── Get People Met ─────────────────────────────────────────────────────────
// Returns the "people met" summary for a user in a specific session, including
// mutual meet-again highlights.

export async function getPeopleMet(
  userId: string,
  sessionId: string
): Promise<PeopleMet> {
  // Get session info
  const sessionResult = await query<{ title: string; scheduledAt: Date }>(
    `SELECT title, scheduled_at AS "scheduledAt" FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    throw new NotFoundError('Session not found');
  }

  const session = sessionResult.rows[0];

  // Get all matches the user participated in for this session
  const connectionsResult = await query<ConnectionResult>(
    `SELECT
       u.id AS "userId",
       u.display_name AS "displayName",
       u.avatar_url AS "avatarUrl",
       u.company,
       u.job_title AS "jobTitle",
       COALESCE(r_given.quality_score, 0) AS "qualityScore",
       COALESCE(r_given.meet_again, FALSE) AS "meetAgain",
       COALESCE(eh.mutual_meet_again, FALSE) AS "mutualMeetAgain",
       m.round_number AS "roundNumber"
     FROM matches m
     JOIN users u ON u.id = CASE
       WHEN m.participant_a_id = $1 THEN m.participant_b_id
       ELSE m.participant_a_id
     END
     LEFT JOIN ratings r_given ON r_given.match_id = m.id AND r_given.from_user_id = $1
     LEFT JOIN encounter_history eh ON (
       (eh.user_a_id = LEAST($1, u.id) AND eh.user_b_id = GREATEST($1, u.id))
     )
     WHERE m.session_id = $2
       AND (m.participant_a_id = $1 OR m.participant_b_id = $1)
       AND m.status IN ('completed', 'active')
     ORDER BY m.round_number ASC`,
    [userId, sessionId]
  );

  const connections = connectionsResult.rows;
  const mutualConnections = connections.filter(c => c.mutualMeetAgain);

  return {
    sessionId,
    sessionTitle: session.title,
    sessionDate: session.scheduledAt,
    connections,
    mutualConnections,
  };
}

// ─── Get Encounter History Between Two Users ────────────────────────────────

export async function getEncounterHistory(
  userAId: string,
  userBId: string
): Promise<EncounterHistory | null> {
  const [orderedA, orderedB] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];

  const result = await query<EncounterHistory>(
    `SELECT ${ENCOUNTER_COLUMNS} FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2`,
    [orderedA, orderedB]
  );

  return result.rows[0] || null;
}

// ─── Get All Encounters for a User ──────────────────────────────────────────

export async function getUserEncounters(
  userId: string,
  mutualOnly: boolean = false
): Promise<any[]> {
  let sql = `
    SELECT
      eh.id, eh.times_met AS "timesMet", eh.last_met_at AS "lastMetAt",
      eh.last_session_id AS "lastSessionId",
      eh.last_quality_score AS "lastQualityScore",
      eh.last_meet_again_a AS "lastMeetAgainA",
      eh.last_meet_again_b AS "lastMeetAgainB",
      eh.mutual_meet_again AS "mutualMeetAgain",
      u.display_name AS "displayName",
      u.avatar_url AS "avatarUrl",
      u.company,
      u.job_title AS "jobTitle",
      s.title AS "sessionTitle",
      s.scheduled_at AS "sessionDate",
      CASE WHEN eh.user_a_id = $1 THEN eh.user_b_id ELSE eh.user_a_id END AS "otherUserId",
      CASE WHEN eh.user_a_id = $1 THEN eh.last_meet_again_a ELSE eh.last_meet_again_b END AS "myMeetAgain",
      eh.mutual_meet_again AS "mutual"
    FROM encounter_history eh
    JOIN users u ON u.id = CASE WHEN eh.user_a_id = $1 THEN eh.user_b_id ELSE eh.user_a_id END
    LEFT JOIN sessions s ON s.id = eh.last_session_id
    WHERE (eh.user_a_id = $1 OR eh.user_b_id = $1)`;

  if (mutualOnly) {
    sql += ' AND eh.mutual_meet_again = TRUE';
  }

  sql += ' ORDER BY eh.last_met_at DESC';

  const result = await query<any>(sql, [userId]);
  return result.rows.map(row => ({
    ...row,
    rating: row.lastQualityScore,
    connectIntent: row.myMeetAgain,
  }));
}

// ─── Finalize Round Ratings ─────────────────────────────────────────────────
// Called after a round's rating window closes. Updates encounter history
// for any matches that received both ratings, detecting mutual meet-agains.

export async function finalizeRoundRatings(
  sessionId: string,
  roundNumber: number
): Promise<{ totalMatches: number; ratedMatches: number; mutualConnections: number }> {
  const matchesResult = await query<Match>(
    `SELECT id, participant_a_id AS "participantAId", participant_b_id AS "participantBId"
     FROM matches
     WHERE session_id = $1 AND round_number = $2 AND status = 'completed'`,
    [sessionId, roundNumber]
  );

  let ratedMatches = 0;
  let mutualConnections = 0;

  for (const match of matchesResult.rows) {
    const isMutual = await checkMutualMeetAgain(match.id);
    if (isMutual) mutualConnections++;

    const ratings = await getRatingsByMatch(match.id);
    if (ratings.length > 0) ratedMatches++;
  }

  logger.info({
    sessionId, roundNumber,
    totalMatches: matchesResult.rows.length,
    ratedMatches, mutualConnections
  }, 'Round ratings finalized');

  return {
    totalMatches: matchesResult.rows.length,
    ratedMatches,
    mutualConnections,
  };
}

// ─── Get Session Statistics ─────────────────────────────────────────────────

export async function getSessionRatingStats(sessionId: string): Promise<{
  totalRatings: number;
  avgQualityScore: number;
  meetAgainRate: number;
  mutualMeetAgainCount: number;
}> {
  const statsResult = await query<{
    totalRatings: string;
    avgQualityScore: string;
    meetAgainCount: string;
  }>(
    `SELECT
       COUNT(*)::text AS "totalRatings",
       COALESCE(AVG(quality_score), 0)::text AS "avgQualityScore",
       COUNT(*) FILTER (WHERE meet_again = TRUE)::text AS "meetAgainCount"
     FROM ratings r
     JOIN matches m ON m.id = r.match_id
     WHERE m.session_id = $1`,
    [sessionId]
  );

  const mutualResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM encounter_history eh
     JOIN matches m ON m.session_id = $1
       AND (
         (m.participant_a_id = eh.user_a_id AND m.participant_b_id = eh.user_b_id)
         OR (m.participant_a_id = eh.user_b_id AND m.participant_b_id = eh.user_a_id)
       )
     WHERE eh.mutual_meet_again = TRUE`,
    [sessionId]
  );

  const stats = statsResult.rows[0];
  const totalRatings = parseInt(stats.totalRatings, 10);
  const meetAgainCount = parseInt(stats.meetAgainCount, 10);

  return {
    totalRatings,
    avgQualityScore: parseFloat(parseFloat(stats.avgQualityScore).toFixed(2)),
    meetAgainRate: totalRatings > 0 ? parseFloat((meetAgainCount / totalRatings).toFixed(4)) : 0,
    mutualMeetAgainCount: parseInt(mutualResult.rows[0]?.count || '0', 10),
  };
}

// ─── Export Session Data ────────────────────────────────────────────────────
// Generates a structured export object for post-event reporting.

export async function exportSessionData(sessionId: string): Promise<{
  session: any;
  participants: any[];
  rounds: any[];
  ratings: any[];
  encounters: any[];
  stats: any;
}> {
  // Session info
  const sessionResult = await query(
    `SELECT id, title, scheduled_at, started_at, ended_at, status, current_round, config
     FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    throw new NotFoundError('Session not found');
  }

  // Participants
  const participantsResult = await query(
    `SELECT sp.user_id, u.display_name, u.email, u.company, u.job_title,
            sp.status, sp.is_no_show, sp.rounds_completed, sp.joined_at
     FROM session_participants sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = $1
     ORDER BY u.display_name`,
    [sessionId]
  );

  // All matches by round
  const matchesResult = await query(
    `SELECT m.round_number, m.participant_a_id, m.participant_b_id,
            ua.display_name AS a_name, ub.display_name AS b_name,
            m.status, m.score, m.started_at, m.ended_at
     FROM matches m
     JOIN users ua ON ua.id = m.participant_a_id
     JOIN users ub ON ub.id = m.participant_b_id
     WHERE m.session_id = $1
     ORDER BY m.round_number, m.created_at`,
    [sessionId]
  );

  // All ratings
  const ratingsResult = await query(
    `SELECT r.match_id, r.from_user_id, r.to_user_id,
            uf.display_name AS from_name, ut.display_name AS to_name,
            r.quality_score, r.meet_again, r.feedback, r.created_at,
            m.round_number
     FROM ratings r
     JOIN matches m ON m.id = r.match_id
     JOIN users uf ON uf.id = r.from_user_id
     JOIN users ut ON ut.id = r.to_user_id
     WHERE m.session_id = $1
     ORDER BY m.round_number, r.created_at`,
    [sessionId]
  );

  // Mutual encounters from this session
  const encountersResult = await query(
    `SELECT eh.user_a_id, eh.user_b_id, eh.times_met,
            eh.mutual_meet_again, eh.last_quality_score,
            ua.display_name AS a_name, ub.display_name AS b_name
     FROM encounter_history eh
     JOIN users ua ON ua.id = eh.user_a_id
     JOIN users ub ON ub.id = eh.user_b_id
     WHERE eh.last_session_id = $1
     ORDER BY eh.mutual_meet_again DESC, ua.display_name`,
    [sessionId]
  );

  const stats = await getSessionRatingStats(sessionId);

  return {
    session: sessionResult.rows[0],
    participants: participantsResult.rows,
    rounds: matchesResult.rows,
    ratings: ratingsResult.rows,
    encounters: encountersResult.rows,
    stats,
  };
}

// ─── Finalize Session Encounters ────────────────────────────────────────────
// Called once at session completion. Ensures encounter_history is fully
// up-to-date even for matches where one or both participants skipped rating.

export async function finalizeSessionEncounters(sessionId: string): Promise<number> {
  const matchesResult = await query<{
    participantAId: string;
    participantBId: string;
    roundNumber: number;
  }>(
    `SELECT participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            round_number AS "roundNumber"
     FROM matches
     WHERE session_id = $1 AND status IN ('completed', 'active')`,
    [sessionId]
  );

  let created = 0;

  for (const match of matchesResult.rows) {
    const [userAId, userBId] = match.participantAId < match.participantBId
      ? [match.participantAId, match.participantBId]
      : [match.participantBId, match.participantAId];

    // Ensure an encounter_history row exists (INSERT ... ON CONFLICT DO NOTHING)
    const result = await query(
      `INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at, last_session_id)
       VALUES ($1, $2, $3, 1, NOW(), $4)
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
      [uuid(), userAId, userBId, sessionId]
    );
    if (result.rowCount && result.rowCount > 0) created++;
  }

  logger.info({ sessionId, totalMatches: matchesResult.rows.length, newEncounters: created },
    'Session encounters finalized');
  return created;
}
