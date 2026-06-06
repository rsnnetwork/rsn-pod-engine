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
  meet_again AS "meetAgain", feedback,
  excluded_from_quality_stats AS "excludedFromQualityStats",
  created_at AS "createdAt"
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
  const matchResult = await query<Match & { participantCId: string | null; ended_at: Date | null }>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            participant_c_id AS "participantCId",
            departed_user_ids AS "departedUserIds",
            status, created_at AS "createdAt", ended_at
     FROM matches WHERE id = $1`,
    [input.matchId]
  );

  if (matchResult.rows.length === 0) {
    throw new NotFoundError('Match not found');
  }

  const match = matchResult.rows[0];

  // Check user was in this match — current slots ∪ DEPARTED members.
  // S14 (live-test 2026-06-05, Ali's trio repro): demoting a trio leaver
  // re-canonicalises the slots, so the leaver was no longer "a participant"
  // here and their early-leave rating 403'd (latent since Phase 3); the
  // SAME check on toUserId below silently blocked the survivors' round-end
  // rating OF the departed. departed_user_ids (migration 066) restores
  // rating reachability in both directions.
  const matchParticipants = [match.participantAId, match.participantBId];
  if (match.participantCId) matchParticipants.push(match.participantCId);
  for (const departedId of match.departedUserIds ?? []) {
    if (!matchParticipants.includes(departedId)) matchParticipants.push(departedId);
  }
  if (!matchParticipants.includes(fromUserId)) {
    throw new ForbiddenError('You are not a participant in this match');
  }

  // Check match status allows rating — accept broadly so ratings survive
  // session state transitions (closing_lobby, round_transition race conditions)
  // and host-remove flows where match is cancelled but partner still has rating window.
  const RATABLE = ['completed', 'active', 'no_show', 'scheduled', 'reassigned'];
  if (!RATABLE.includes(match.status)) {
    // Cancelled matches are ratable for 30s after ended_at (covers host-remove
    // flow — partner sees rating screen and submits after status flip).
    const CANCELLED_GRACE_MS = 30_000;
    if (match.status === 'cancelled' && match.ended_at) {
      const elapsed = Date.now() - new Date(match.ended_at).getTime();
      if (elapsed > CANCELLED_GRACE_MS) {
        throw new ValidationError('Match is not in a ratable state');
      }
    } else {
      throw new ValidationError('Match is not in a ratable state');
    }
  }

  // Validate quality score
  if (input.qualityScore < 1 || input.qualityScore > 5 || !Number.isInteger(input.qualityScore)) {
    throw new ValidationError('Quality score must be an integer between 1 and 5');
  }

  // Determine rating target
  // For trios: client sends toUserId to specify which partner they're rating
  // For pairs: infer automatically (backward compat)
  let toUserId: string;
  if ((input as any).toUserId && matchParticipants.includes((input as any).toUserId)) {
    toUserId = (input as any).toUserId;
  } else {
    // Backward compat: 2-person match — rate the other person
    toUserId = match.participantAId === fromUserId ? match.participantBId : match.participantAId;
  }

  // Check for duplicate rating (per from+to pair within this match)
  const existingRating = await query(
    'SELECT id FROM ratings WHERE match_id = $1 AND from_user_id = $2 AND to_user_id = $3',
    [input.matchId, fromUserId, toUserId]
  );

  if (existingRating.rows.length > 0) {
    throw new ConflictError(ErrorCodes.MATCH_ALREADY_RATED, 'You have already rated this partner for this match');
  }

  const ratingId = uuid();

  // Use transaction to submit rating + update encounter history atomically
  return transaction(async (client) => {
    // Insert the rating
    const result = await client.query<Rating>(
      `INSERT INTO ratings (id, match_id, from_user_id, to_user_id, quality_score, meet_again, feedback, excluded_from_quality_stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (match_id, from_user_id, to_user_id) DO UPDATE SET
         quality_score = EXCLUDED.quality_score,
         meet_again = EXCLUDED.meet_again,
         feedback = EXCLUDED.feedback,
         excluded_from_quality_stats = EXCLUDED.excluded_from_quality_stats
       RETURNING ${RATING_COLUMNS}`,
      [
        ratingId, input.matchId, fromUserId, toUserId, input.qualityScore, input.meetAgain, input.feedback || null,
        // WS3/H5 — exclusion is user-initiated (didntWork) OR automatic:
        // a no_show / cancelled match was never a real conversation, so a
        // rating filed against it (the present partner rating the absent
        // one, a host-remove grace rating) must not skew quality averages.
        input.didntWork === true || match.status === 'no_show' || match.status === 'cancelled',
      ]
    );

    const rating = result.rows[0];

    // WS3/S12 — an excluded rating (user clicked "didn't work", or the
    // match was no_show/cancelled) must not surface as a real quality
    // score anywhere: the connections card reads
    // encounter_history.last_quality_score and the recap reads
    // meeting_records.rating_given. The encounter/meeting still counts
    // (they DID meet) — only the score is withheld.
    const scoreForAggregates = rating.excludedFromQualityStats ? null : input.qualityScore;

    // Update encounter history
    await upsertEncounterHistory(
      client, fromUserId, toUserId, match.sessionId, input.matchId, scoreForAggregates, input.meetAgain
    );

    // Phase 2 (1 May spec) — also update meeting_records so recap counts
    // stay deterministic. Encounter history is a cross-session aggregate;
    // meeting_records is the per-meeting record the recap reads from.
    try {
      const { upsertRatingForMeeting } = await import('../meeting-records/meeting-records.service');
      await upsertRatingForMeeting({
        sessionId: match.sessionId,
        roundNumber: match.roundNumber,
        matchId: input.matchId,
        raterUserId: fromUserId,
        ratedUserId: toUserId,
        qualityScore: scoreForAggregates,
        meetAgain: input.meetAgain,
      });
    } catch (mrErr) {
      logger.error({ mrErr, ratingId, matchId: input.matchId },
        'Failed to update meeting_records — recap will rebuild from matches × ratings on next aggregation');
    }

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
  matchId: string,
  // null = excluded rating (didn't work / no_show / cancelled): the
  // encounter still counts, the score is withheld from the surfaces.
  qualityScore: number | null,
  meetAgain: boolean
): Promise<void> {
  // Determine ordered IDs
  const [userAId, userBId] = fromUserId < toUserId
    ? [fromUserId, toUserId]
    : [toUserId, fromUserId];

  const isFromA = fromUserId === userAId;

  // Bug 6 (13 May live test) — pre-fix the increment guard used
  //   last_session_id !== sessionId
  // which meant a pair meeting in two rounds of the SAME event stayed
  // at times_met = 1. The correct discriminator is the match, not the
  // session: each match represents one meeting, and the second rater on
  // that match must not double-count. Count any ratings on this match
  // from anyone other than us. Zero means we are the first rater for
  // this specific match → increment. One or more means the partner
  // already rated → suppress.
  const otherRatingsRes = (await client.query(
    `SELECT COUNT(*)::text AS cnt FROM ratings WHERE match_id = $1 AND from_user_id <> $2`,
    [matchId, fromUserId],
  )) as { rows: { cnt: string }[] };
  const isFirstRatingForThisMatch = otherRatingsRes.rows[0]?.cnt === '0';

  // Try to find existing encounter
  const existing = await client.query(
    'SELECT id, last_meet_again_a, last_meet_again_b, last_session_id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 FOR UPDATE',
    [userAId, userBId]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const meetAgainA = isFromA ? meetAgain : row.last_meet_again_a;
    const meetAgainB = isFromA ? row.last_meet_again_b : meetAgain;
    const mutual = meetAgainA === true && meetAgainB === true;

    await client.query(
      `UPDATE encounter_history
       SET times_met = ${isFirstRatingForThisMatch ? 'times_met + 1' : 'times_met'},
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
    `SELECT id FROM matches WHERE id = $1 AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)`,
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
  // Get session info including config for totalRounds
  const sessionResult = await query<{ title: string; scheduledAt: Date; config: any; currentRound: number }>(
    `SELECT title, scheduled_at AS "scheduledAt", config, current_round AS "currentRound" FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    throw new NotFoundError('Session not found');
  }

  const session = sessionResult.rows[0];
  const config = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;
  const totalRounds = config?.numberOfRounds || session.currentRound || 0;
  // Bug 28 (19 May Ali + Stefan) — pass the bonus count through so the
  // recap can show "3 rounds + 1 bonus" instead of just "4 rounds".
  const bonusRoundsAdded = typeof config?.bonusRoundsAdded === 'number'
    ? config.bonusRoundsAdded
    : 0;

  // Get rounds attended count — include all states where user actually participated
  // (completed, active, no_show, reassigned all mean the user was in that round).
  // S20 (live-test z1, 2026-06-06) — a member demoted mid-round (throttled
  // browser → 15s grace expiry) is re-canonicalised OUT of the slots but DID
  // attend that round: they talked, rated, and were rated. Count slots ∪
  // departed, or saif/waseem read "attended 3 of 5" after one flaky round.
  const roundsResult = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT round_number)::text AS count
     FROM matches
     WHERE session_id = $1
       AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2
            OR $2 = ANY(departed_user_ids))
       AND status NOT IN ('cancelled', 'scheduled')`,
    [sessionId, userId]
  );
  const roundsAttended = parseInt(roundsResult.rows[0]?.count || '0', 10);

  // Get all matches the user participated in for this session
  // Uses LATERAL to handle 2-person and 3-person rooms uniformly
  // Now also returns theirMeetAgain (whether the partner rated meet_again for us)
  // S20 — the partner expansion and the membership filter both union
  // departed_user_ids: a demoted member's recap must list the partners from
  // that round (mutual count came from meeting_records and already included
  // them — count 3 vs visible list 1 was exactly this drift), and the
  // survivors' recaps must list the demoted member. DISTINCT guards the
  // pair case where the departed id is still in the slots.
  const connectionsResult = await query<ConnectionResult>(
    `SELECT
       u.id AS "userId",
       u.display_name AS "displayName",
       u.avatar_url AS "avatarUrl",
       u.company,
       u.job_title AS "jobTitle",
       COALESCE(r_given.quality_score, 0) AS "qualityScore",
       COALESCE(r_given.meet_again, FALSE) AS "meetAgain",
       COALESCE(r_received.meet_again, FALSE) AS "theirMeetAgain",
       COALESCE(eh.mutual_meet_again, FALSE) AS "mutualMeetAgain",
       m.round_number AS "roundNumber",
       COALESCE(m.is_manual, FALSE) AS "isManual"
     FROM matches m
     CROSS JOIN LATERAL (
       SELECT DISTINCT pid AS partner_id
       FROM unnest(
         ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]
         || COALESCE(m.departed_user_ids, '{}'::uuid[])
       ) AS pid
       WHERE pid IS NOT NULL AND pid != $1
     ) AS partners
     JOIN users u ON u.id = partners.partner_id
     LEFT JOIN ratings r_given ON r_given.match_id = m.id AND r_given.from_user_id = $1 AND r_given.to_user_id = u.id
     LEFT JOIN ratings r_received ON r_received.match_id = m.id AND r_received.from_user_id = u.id AND r_received.to_user_id = $1
     LEFT JOIN encounter_history eh ON (
       (eh.user_a_id = LEAST($1, u.id) AND eh.user_b_id = GREATEST($1, u.id))
     )
     WHERE m.session_id = $2
       AND (m.participant_a_id = $1 OR m.participant_b_id = $1 OR m.participant_c_id = $1
            OR $1 = ANY(m.departed_user_ids))
       AND m.status NOT IN ('cancelled', 'scheduled')
       AND partners.partner_id IS NOT NULL
     ORDER BY m.round_number ASC`,
    [userId, sessionId]
  );

  const connections = connectionsResult.rows;

  // Phase 2 (1 May spec) — surface deterministic counts from meeting_records.
  // Phase 7A.3 (7 May spec) — Stefan #5: pre-fix, the headline mutualMatches
  // count came from meeting_records (canonical aggregate) but the
  // mutualConnections LIST was derived from encounter_history's
  // mutual_meet_again field on each connection row. Two sources →
  // potential drift if encounter_history writes lag the meeting_records
  // write. Fix: derive mutualConnections from meeting_records too.
  // Both the count and the list now come from the same source — they
  // can no longer disagree even if a rating writes mid-render.
  let counts = { uniquePeopleMet: 0, totalMeetings: 0, mutualMatches: 0 };
  let mutualPartnerIds = new Set<string>();
  try {
    const { getMeetingCounts } = await import('../meeting-records/meeting-records.service');
    counts = await getMeetingCounts(userId, sessionId);
    // Fetch the mutual partner IDs from the SAME aggregate so the list
    // matches the count exactly.
    const mutualRows = await query<{ partner_id: string }>(
      `SELECT DISTINCT partner_id FROM meeting_records
        WHERE user_id = $1 AND session_id = $2
          AND is_mutual = TRUE AND is_recap_eligible = TRUE`,
      [userId, sessionId],
    );
    mutualPartnerIds = new Set(mutualRows.rows.map(r => r.partner_id));
  } catch (err) {
    logger.warn({ err, userId, sessionId }, 'Falling back to derived counts (meeting_records read failed)');
    // Legacy fallback — unchanged behaviour.
    const fallbackMutual = connections.filter(c => c.mutualMeetAgain);
    counts = {
      uniquePeopleMet: new Set(connections.map(c => c.userId)).size,
      totalMeetings: connections.length,
      mutualMatches: fallbackMutual.length,
    };
    mutualPartnerIds = new Set(fallbackMutual.map(c => c.userId));
  }

  // Bug 24 (18 May Ali) — recap pages used to render TWO rows for the
  // same partner when the pair matched in multiple rounds (fallback
  // ladder, "Another Round" path, or explicit re-pair). Now we dedupe
  // by userId, keep the best-quality row, and surface a meetCount so
  // the UI can render "Met 2 times" on a single row instead.
  const dedupeByUser = (rows: ConnectionResult[]): (ConnectionResult & { meetCount: number })[] => {
    const byUser = new Map<string, ConnectionResult & { meetCount: number }>();
    for (const r of rows) {
      const existing = byUser.get(r.userId);
      if (!existing) {
        byUser.set(r.userId, { ...r, meetCount: 1 });
        continue;
      }
      existing.meetCount += 1;
      // Keep the highest quality + the most generous mutual signals so
      // the single row reflects the best of the multiple meetings.
      if ((r.qualityScore || 0) > (existing.qualityScore || 0)) {
        existing.qualityScore = r.qualityScore;
      }
      if (r.meetAgain) existing.meetAgain = true;
      if (r.theirMeetAgain) existing.theirMeetAgain = true;
      if (r.mutualMeetAgain) existing.mutualMeetAgain = true;
      // Latest round wins for the "you met them in round X" hint when
      // the meetCount is 1; for meetCount > 1 the client renders the
      // count badge instead, so this fallback is fine.
      if ((r.roundNumber || 0) > (existing.roundNumber || 0)) {
        existing.roundNumber = r.roundNumber;
      }
    }
    return Array.from(byUser.values());
  };

  // Filter mutual rows from the dedup'd set so the Mutual Matches card
  // never repeats a person, and each row carries the meet count.
  const dedupedMutual = dedupeByUser(
    connections.filter(c => mutualPartnerIds.has(c.userId)),
  );

  return {
    sessionId,
    sessionTitle: session.title,
    sessionDate: session.scheduledAt,
    totalRounds,
    roundsAttended,
    bonusRoundsAdded,
    // connections stays per-match so the per-round breakdown is intact.
    connections,
    mutualConnections: dedupedMutual,
    // New Phase 2 fields. Existing clients that read connections.length and
    // mutualConnections.length keep working; new consumers use these.
    uniquePeopleMet: counts.uniquePeopleMet,
    totalMeetings: counts.totalMeetings,
    mutualMatches: counts.mutualMatches,
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
  const matchesResult = await query<Match & { participantCId?: string | null }>(
    `SELECT id, participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            participant_c_id AS "participantCId"
     FROM matches
     WHERE session_id = $1 AND round_number = $2 AND status IN ('completed', 'reassigned')`,
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

  // Phase 2 (1 May spec) — write canonical meeting records for this round.
  // Stored, deterministic, never recalculated. All recap consumers will read
  // from meeting_records instead of re-deriving from matches × ratings.
  try {
    const { recordRoundMeetings } = await import('../meeting-records/meeting-records.service');
    await recordRoundMeetings(sessionId, roundNumber, matchesResult.rows.map(m => ({
      id: m.id, participantAId: m.participantAId, participantBId: m.participantBId,
      participantCId: m.participantCId ?? null,
    })));
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Failed to write meeting_records — recap will rebuild from matches × ratings');
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
       COALESCE(AVG(quality_score) FILTER (WHERE NOT excluded_from_quality_stats), 0)::text AS "avgQualityScore",
       COUNT(*) FILTER (WHERE meet_again = TRUE)::text AS "meetAgainCount"
     FROM ratings r
     JOIN matches m ON m.id = r.match_id
     WHERE m.session_id = $1`,
    [sessionId]
  );

  const mutualResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM encounter_history eh
     WHERE eh.mutual_meet_again = TRUE
       AND eh.last_session_id = $1`,
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

/**
 * Phase 5 (29 April 2026 spec) — get every partner the user met but hasn't
 * rated yet for a given session. Used by the recap missed-rating fallback:
 * "at the end of event the missed rating forms should also appear to the
 * users ... that rating form must appear with proper distinction like
 * 'rate your manual room with this partner' so this user knows for who
 * I am actually writing".
 *
 * Returns one row per (user, partner) — for a trio the user gets two rows
 * (one for each of the other two participants). Each row carries
 * `roundNumber` and `isManual` so the client can render a clear context
 * label ("Round 3 trio with Charlie" vs "Manual Breakout Room").
 *
 * Only returns results for sessions that are completed or closing_lobby —
 * per-round missed ratings are still handled by the existing
 * rating-window replay during the event itself; this endpoint is the
 * end-of-event fallback per Q6/Q7.
 */
export async function getUnratedPartners(sessionId: string, userId: string): Promise<{
  matchId: string;
  partnerId: string;
  partnerDisplayName: string;
  roundNumber: number;
  isManual: boolean;
  isTrio: boolean;
}[]> {
  const result = await query<{
    match_id: string;
    partner_id: string;
    partner_display_name: string;
    round_number: number;
    is_manual: boolean;
    is_trio: boolean;
  }>(`
    WITH user_partners AS (
      SELECT
        m.id AS match_id,
        m.round_number,
        m.is_manual,
        (m.participant_c_id IS NOT NULL) AS is_trio,
        CASE
          WHEN m.participant_a_id = $2 THEN m.participant_b_id
          WHEN m.participant_b_id = $2 THEN m.participant_a_id
          ELSE m.participant_a_id
        END AS partner_id
      FROM matches m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = $1
        AND (m.participant_a_id = $2 OR m.participant_b_id = $2 OR m.participant_c_id = $2)
        AND m.status IN ('completed', 'no_show')
        AND s.status IN ('completed', 'closing_lobby')

      UNION ALL

      SELECT
        m.id AS match_id,
        m.round_number,
        m.is_manual,
        TRUE AS is_trio,
        m.participant_c_id AS partner_id
      FROM matches m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = $1
        AND (m.participant_a_id = $2 OR m.participant_b_id = $2)
        AND m.participant_c_id IS NOT NULL
        AND m.status IN ('completed', 'no_show')
        AND s.status IN ('completed', 'closing_lobby')

      UNION ALL

      SELECT
        m.id AS match_id,
        m.round_number,
        m.is_manual,
        TRUE AS is_trio,
        CASE
          WHEN m.participant_a_id != $2 THEN m.participant_a_id
          ELSE m.participant_b_id
        END AS partner_id
      FROM matches m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = $1
        AND m.participant_c_id = $2
        AND m.status IN ('completed', 'no_show')
        AND s.status IN ('completed', 'closing_lobby')
    )
    SELECT
      up.match_id,
      up.partner_id,
      COALESCE(NULLIF(TRIM(u.display_name), ''), SPLIT_PART(u.email, '@', 1), 'Partner ' || SUBSTRING(up.partner_id::text, 1, 6)) AS partner_display_name,
      up.round_number,
      up.is_manual,
      up.is_trio
    FROM user_partners up
    JOIN users u ON u.id = up.partner_id
    WHERE NOT EXISTS (
      SELECT 1 FROM ratings r
      WHERE r.match_id = up.match_id
        AND r.from_user_id = $2
        AND r.to_user_id = up.partner_id
    )
    ORDER BY up.is_manual ASC, up.round_number ASC
  `, [sessionId, userId]);

  return result.rows.map(r => ({
    matchId: r.match_id,
    partnerId: r.partner_id,
    partnerDisplayName: r.partner_display_name,
    roundNumber: r.round_number,
    isManual: r.is_manual,
    isTrio: r.is_trio,
  }));
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
     WHERE session_id = $1 AND status IN ('completed', 'active', 'reassigned')`,
    [sessionId]
  );

  // F4 (21 May Ali) — pre-fix this loop awaited each INSERT serially, so
  // for an N-match event the function took N × DB-roundtrip-ms before
  // returning. completeSession used to await this before emitting
  // session:completed, contributing the bulk of the observed 10 s
  // "stale host UI after End Event". completeSession now fires-and-
  // forgets this call, AND the inserts run in parallel here so the
  // background work also clears in a few hundred ms rather than seconds.
  // Promise.allSettled because each row is independent — one failure
  // shouldn't poison the others.
  const results = await Promise.allSettled(
    matchesResult.rows.map(match => {
      const [userAId, userBId] = match.participantAId < match.participantBId
        ? [match.participantAId, match.participantBId]
        : [match.participantBId, match.participantAId];
      return query(
        `INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at, last_session_id)
         VALUES ($1, $2, $3, 1, NOW(), $4)
         ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
        [uuid(), userAId, userBId, sessionId],
      );
    }),
  );

  let created = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.rowCount && r.value.rowCount > 0) created++;
  }

  logger.info({ sessionId, totalMatches: matchesResult.rows.length, newEncounters: created },
    'Session encounters finalized');
  return created;
}
