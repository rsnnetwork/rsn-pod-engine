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
  excludeUserIds?: string[],
  presentUserIds?: Set<string>
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

  // Phase 2 (Redis): presentUserIds will come from Redis presence instead of in-memory map.
  // Filter to only participants who are actually connected (prevents phantom matches).
  if (presentUserIds && presentUserIds.size > 0) {
    participantsResult.rows = participantsResult.rows.filter(
      (p) => presentUserIds.has(p.userId)
    );
  }

  // Get encounter history
  const userIds = participantsResult.rows.map((p) => p.userId);
  const encounterHistory = await getEncounterHistoryForUsers(userIds);

  // Get excluded pairs (completed/in-progress matches in OTHER rounds — not the current round being regenerated)
  const excludedResult = await query<{ participant_a_id: string; participant_b_id: string }>(
    `SELECT participant_a_id, participant_b_id FROM matches
     WHERE session_id = $1 AND round_number != $2 AND status NOT IN ('cancelled', 'no_show')`,
    [sessionId, roundNumber]
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

  // Load matching template weights from pod's template (or session config template, or default)
  const templateId = sessionConfig.matchingTemplateId || null;
  let weights = DEFAULT_WEIGHTS;

  // Try session-level template first, then pod-level, then default
  const tplId = templateId || (session as any).podId
    ? await query<{ matching_template_id: string | null }>(
        `SELECT matching_template_id FROM pods WHERE id = $1`,
        [(session as any).podId]
      ).then(r => r.rows[0]?.matching_template_id).catch(() => null)
    : null;

  if (tplId || templateId) {
    const tplResult = await query<{
      weight_industry: number; weight_interests: number; weight_intent: number;
      weight_experience: number; weight_location: number;
      same_company_allowed: boolean;
    }>(
      templateId
        ? `SELECT * FROM matching_templates WHERE id = $1`
        : `SELECT * FROM matching_templates WHERE id = $1`,
      [templateId || tplId]
    );
    if (tplResult.rows.length > 0) {
      const t = tplResult.rows[0];
      weights = {
        sharedInterests: t.weight_interests,
        sharedReasons: t.weight_intent,
        industryDiversity: t.weight_industry,
        companyDiversity: t.same_company_allowed ? 0 : 0.15,
        languageMatch: t.weight_location,
        encounterFreshness: t.weight_experience,
      };
      logger.info({ templateId: templateId || tplId, weights }, 'Using matching template weights');
    }
  }

  const config: MatchingConfig = {
    weights,
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

  // Belt-and-suspenders: verify no returned pair exists in excludedPairs
  const violatingPairs: typeof round.pairs = [];
  for (const pair of round.pairs) {
    const key = pairKey(pair.participantAId, pair.participantBId);
    if (excludedPairs.has(key)) {
      logger.error({ sessionId, roundNumber, pairKey: key },
        'MATCHING VIOLATION: generated pair exists in excludedPairs — removing pair');
      violatingPairs.push(pair);
    }
  }
  if (violatingPairs.length > 0) {
    const byeList = round.byeParticipants ?? [];
    const warnList = round.warnings ?? [];
    for (const vp of violatingPairs) {
      round.pairs = round.pairs.filter(p => p !== vp);
      byeList.push(vp.participantAId, vp.participantBId);
      warnList.push(`Pair ${vp.participantAId}/${vp.participantBId} violated no-repeat rule and was removed`);
    }
    round.byeParticipants = byeList;
    round.warnings = warnList;
  }

  // Persist this round's matches
  await persistMatches(sessionId, [round]);

  return round;
}

// ─── Get Matches for Session/Round ──────────────────────────────────────────

export async function getMatchesBySession(sessionId: string): Promise<Match[]> {
  const result = await query<Match>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            participant_c_id AS "participantCId",
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
            participant_c_id AS "participantCId",
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
            participant_c_id AS "participantCId",
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

    const pair: any = {
      participantAId: match.participantAId,
      participantBId: match.participantBId,
      score: match.score || 0,
      reasonTags: match.reasonTags || [],
    };
    if (match.participantCId) pair.participantCId = match.participantCId;
    roundMap.get(match.roundNumber)!.pairs.push(pair);
  }

  return Array.from(roundMap.values()).sort((a, b) => a.roundNumber - b.roundNumber);
}

async function persistMatches(sessionId: string, rounds: RoundAssignment[]): Promise<void> {
  await transaction(async (client) => {
    for (const round of rounds) {
      // Delete any existing scheduled matches for this round before inserting new ones
      // (handles rematch/regeneration — cancelled/scheduled rows still hold unique constraint)
      await client.query(
        `DELETE FROM matches
         WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled')`,
        [sessionId, round.roundNumber]
      );

      // Batch insert all matches for this round in one multi-row INSERT
      if (round.pairs.length > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let paramIdx = 1;

        for (const pair of round.pairs) {
          const pA = pair.participantAId < pair.participantBId ? pair.participantAId : pair.participantBId;
          const pB = pair.participantAId < pair.participantBId ? pair.participantBId : pair.participantAId;
          placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, 'scheduled')`);
          values.push(sessionId, round.roundNumber, pA, pB, pair.participantCId || null, pair.score, pair.reasonTags);
          paramIdx += 7;
        }

        await client.query(
          `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, score, reason_tags, status)
           VALUES ${placeholders.join(', ')}`,
          values
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
