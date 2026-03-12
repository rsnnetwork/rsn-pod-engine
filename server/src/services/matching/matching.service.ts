// ─── Matching Service ────────────────────────────────────────────────────────
// Coordinates between the matching engine, database, and session service.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  MatchingInput, MatchingOutput, MatchingConfig, MatchingWeights,
  MatchingParticipant, EncounterHistoryEntry, RoundAssignment,
  MatchStatus, Match,
} from '@rsn/shared';
import { matchingEngine } from './matching.engine';
import { pairKey } from './matching.interface';
import * as sessionService from '../session/session.service';
import { NotFoundError } from '../../middleware/errors';

// ─── Default Weights ────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS: MatchingWeights = {
  sharedInterests: 0.25,
  sharedReasons: 0.25,
  industryDiversity: 0.15,
  companyDiversity: 0.15,
  languageMatch: 0.10,
  encounterFreshness: 0.10,
};

// ─── Generate Full Schedule for Session ─────────────────────────────────────

export async function generateSessionSchedule(
  sessionId: string,
  customConfig?: Partial<MatchingConfig>
): Promise<MatchingOutput> {
  const session = await sessionService.getSessionById(sessionId);
  const sessionConfig = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;

  // Get registered participants with profile data
  const participantsResult = await query<MatchingParticipant>(
    `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
            u.industry, u.company, u.languages, u.timezone,
            '{}'::jsonb AS attributes
     FROM session_participants sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show')`,
    [sessionId]
  );

  const participants = participantsResult.rows;

  // Get encounter history for all participant pairs
  const userIds = participants.map((p) => p.userId);
  const encounterHistory = await getEncounterHistoryForUsers(userIds);

  // Get any pre-existing round assignments
  const existingRounds = await getExistingRounds(sessionId);

  // Build matching config
  const config: MatchingConfig = {
    weights: customConfig?.weights || DEFAULT_WEIGHTS,
    hardConstraints: customConfig?.hardConstraints || [],
    numberOfRounds: customConfig?.numberOfRounds || sessionConfig.numberOfRounds || 5,
    avoidDuplicates: customConfig?.avoidDuplicates ?? true,
    globalOptimize: customConfig?.globalOptimize ?? true,
  };

  const input: MatchingInput = {
    sessionId,
    participants,
    config,
    encounterHistory,
    previousRounds: existingRounds,
  };

  // Generate schedule
  const output = await matchingEngine.generateSchedule(input);

  // Persist matches to database
  await persistMatches(sessionId, output.rounds);

  return output;
}

// ─── Generate Single Round ──────────────────────────────────────────────────

export async function generateSingleRound(
  sessionId: string,
  roundNumber: number,
  excludeUserIds?: string[]
): Promise<RoundAssignment> {
  const session = await sessionService.getSessionById(sessionId);
  const sessionConfig = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;

  // Get active participants (excluding host or other specified users)
  const participantsResult = excludeUserIds && excludeUserIds.length > 0
    ? await query<MatchingParticipant>(
        `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
                u.industry, u.company, u.languages, u.timezone,
                '{}'::jsonb AS attributes
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1 AND sp.status IN ('in_lobby', 'checked_in', 'registered')
           AND sp.user_id != ALL($2::uuid[])`,
        [sessionId, excludeUserIds]
      )
    : await query<MatchingParticipant>(
        `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
                u.industry, u.company, u.languages, u.timezone,
                '{}'::jsonb AS attributes
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1 AND sp.status IN ('in_lobby', 'checked_in', 'registered')`,
        [sessionId]
      );

  // Get encounter history
  const userIds = participantsResult.rows.map((p) => p.userId);
  const encounterHistory = await getEncounterHistoryForUsers(userIds);

  // Get excluded pairs (already matched in this session)
  const excludedResult = await query<{ participant_a_id: string; participant_b_id: string }>(
    `SELECT participant_a_id, participant_b_id FROM matches WHERE session_id = $1`,
    [sessionId]
  );
  const excludedPairs = new Set(
    excludedResult.rows.map((r) => pairKey(r.participant_a_id, r.participant_b_id))
  );

  // Build hard constraints: inviter-invitee avoidance
  const inviterInviteeResult = await query<{ inviter_id: string; accepted_by_user_id: string }>(
    `SELECT inviter_id, accepted_by_user_id FROM invites
     WHERE session_id = $1 AND accepted_by_user_id IS NOT NULL AND status = 'accepted'`,
    [sessionId]
  );
  const inviterInviteePairs = inviterInviteeResult.rows
    .filter(r => r.inviter_id && r.accepted_by_user_id)
    .map(r => `${r.inviter_id}:${r.accepted_by_user_id}`);

  const hardConstraints = inviterInviteePairs.length > 0
    ? [{ type: 'inviter_invitee_block' as const, params: { pairs: inviterInviteePairs } }]
    : [];

  const config: MatchingConfig = {
    weights: DEFAULT_WEIGHTS,
    hardConstraints,
    numberOfRounds: sessionConfig.numberOfRounds,
    avoidDuplicates: true,
    globalOptimize: false,
  };

  const round = matchingEngine.generateRound(
    participantsResult.rows,
    config,
    excludedPairs,
    encounterHistory,
    roundNumber
  );

  // Persist this round's matches
  await persistMatches(sessionId, [round]);

  return round;
}

// ─── Get Matches for Session/Round ──────────────────────────────────────────

export async function getMatchesBySession(sessionId: string): Promise<Match[]> {
  const result = await query<Match>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            room_id AS "roomId", status, score, reason_tags AS "reasonTags",
            started_at AS "startedAt", ended_at AS "endedAt", created_at AS "createdAt"
     FROM matches WHERE session_id = $1
     ORDER BY round_number, created_at`,
    [sessionId]
  );
  return result.rows;
}

export async function getMatchesByRound(sessionId: string, roundNumber: number): Promise<Match[]> {
  const result = await query<Match>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            room_id AS "roomId", status, score, reason_tags AS "reasonTags",
            started_at AS "startedAt", ended_at AS "endedAt", created_at AS "createdAt"
     FROM matches WHERE session_id = $1 AND round_number = $2
     ORDER BY created_at`,
    [sessionId, roundNumber]
  );
  return result.rows;
}

export async function getMatchById(matchId: string): Promise<Match> {
  const result = await query<Match>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            room_id AS "roomId", status, score, reason_tags AS "reasonTags",
            started_at AS "startedAt", ended_at AS "endedAt", created_at AS "createdAt"
     FROM matches WHERE id = $1`,
    [matchId]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Match', matchId);
  }
  return result.rows[0];
}

export async function updateMatchStatus(
  matchId: string,
  status: MatchStatus,
  roomId?: string
): Promise<void> {
  const setClauses = ['status = $1'];
  const values: unknown[] = [status];
  let paramIdx = 2;

  if (roomId !== undefined) {
    setClauses.push(`room_id = $${paramIdx}`);
    values.push(roomId);
    paramIdx++;
  }

  if (status === MatchStatus.ACTIVE) {
    setClauses.push(`started_at = COALESCE(started_at, NOW())`);
  }

  if (status === MatchStatus.COMPLETED || status === MatchStatus.NO_SHOW || status === MatchStatus.CANCELLED) {
    setClauses.push(`ended_at = NOW()`);
  }

  values.push(matchId);
  await query(
    `UPDATE matches SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
    values
  );
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

async function getEncounterHistoryForUsers(userIds: string[]): Promise<EncounterHistoryEntry[]> {
  if (userIds.length === 0) return [];

  const result = await query<EncounterHistoryEntry>(
    `SELECT user_a_id AS "userAId", user_b_id AS "userBId", times_met AS "timesMet",
            last_met_at AS "lastMetAt"
     FROM encounter_history
     WHERE user_a_id = ANY($1) AND user_b_id = ANY($1)`,
    [userIds]
  );
  return result.rows;
}

async function getExistingRounds(sessionId: string): Promise<RoundAssignment[]> {
  const matches = await getMatchesBySession(sessionId);
  const roundMap = new Map<number, RoundAssignment>();

  for (const match of matches) {
    if (!roundMap.has(match.roundNumber)) {
      roundMap.set(match.roundNumber, {
        roundNumber: match.roundNumber,
        pairs: [],
        byeParticipant: null,
      });
    }

    roundMap.get(match.roundNumber)!.pairs.push({
      participantAId: match.participantAId,
      participantBId: match.participantBId,
      score: match.score || 0,
      reasonTags: match.reasonTags || [],
    });
  }

  return Array.from(roundMap.values()).sort((a, b) => a.roundNumber - b.roundNumber);
}

async function persistMatches(sessionId: string, rounds: RoundAssignment[]): Promise<void> {
  await transaction(async (client) => {
    for (const round of rounds) {
      for (const pair of round.pairs) {
        await client.query(
          `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, score, reason_tags, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
           ON CONFLICT (session_id, round_number, participant_a_id) DO UPDATE
           SET participant_b_id = $4, score = $5, reason_tags = $6`,
          [
            sessionId,
            round.roundNumber,
            pair.participantAId < pair.participantBId ? pair.participantAId : pair.participantBId,
            pair.participantAId < pair.participantBId ? pair.participantBId : pair.participantAId,
            pair.score,
            pair.reasonTags,
          ]
        );
      }
    }
  });

  logger.info({
    sessionId,
    rounds: rounds.length,
    totalPairs: rounds.reduce((sum, r) => sum + r.pairs.length, 0),
  }, 'Matches persisted');
}
