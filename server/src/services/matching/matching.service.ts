// ─── Matching Service ────────────────────────────────────────────────────────
// Coordinates between the matching engine, database, and session service.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  MatchingInput, MatchingOutput, MatchingConfig, MatchingWeights,
  MatchingParticipant, EncounterHistoryEntry, RoundAssignment,
  MatchStatus, Match,
} from '@rsn/shared';
import { getMatchingEngine, DEFAULT_ENGINE_ID } from './matching.registry';
import { pairKey } from './matching.interface';
import * as sessionService from '../session/session.service';
import * as blockService from '../block/block.service';
import { NotFoundError } from '../../middleware/errors';

// ─── Default Weights ────────────────────────────────────────────────────────

// Matching Engine 1.0 spec, Section 11 — defaults.
//   - intent-priority via sharedInterests + sharedReasons (cumulative 0.40)
//   - new-connection priority via encounterFreshness 0.10
//   - premium boosts capped so they never dominate (combined ≤ 0.30, less
//     than sharedInterests+sharedReasons)
//   - mutualMeetAgainBoost (Section 8 learning) wired but small (0.05)
//     since within_event policy makes it irrelevant most of the time
const DEFAULT_WEIGHTS: MatchingWeights = {
  sharedInterests: 0.25,
  sharedReasons: 0.25,
  industryDiversity: 0.15,
  companyDiversity: 0.15,
  languageMatch: 0.10,
  encounterFreshness: 0.10,
  // Section 7 — premium tier signals.
  mutualPremiumRequest: 0.20,
  singlePremiumRequest: 0.10,
  premiumBoost: 0.03,
  // Section 8 — feedback learning lift (tiny by default, only matters when
  // policy allows repeats).
  mutualMeetAgainBoost: 0.05,
};

/**
 * Matching Engine 1.0 spec, Section 7 — load all pending premium match
 * requests for this event, returning a Map<requesterUserId, requestedUserIds[]>.
 * Direction matters: A requesting B does NOT auto-imply B requesting A —
 * the engine's mutual-detection looks up both directions explicitly.
 */
async function loadMatchRequestsForEvent(
  sessionId: string,
  participantUserIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (participantUserIds.length === 0) return out;
  try {
    const result = await query<{ requester_id: string; requested_id: string }>(
      `SELECT requester_id, requested_id
       FROM match_requests
       WHERE event_id = $1 AND status = 'pending'
         AND requester_id = ANY($2::uuid[])
         AND requested_id = ANY($2::uuid[])`,
      [sessionId, participantUserIds],
    );
    for (const row of result.rows) {
      const list = out.get(row.requester_id) || [];
      list.push(row.requested_id);
      out.set(row.requester_id, list);
    }
  } catch (err) {
    // Non-fatal — engine still works with no premium requests.
    logger.warn({ err, sessionId }, 'Failed to load match_requests; engine runs without premium request signals');
  }
  return out;
}

// ─── Generate Full Schedule for Session ─────────────────────────────────────

export async function generateSessionSchedule(
  sessionId: string,
  customConfig?: Partial<MatchingConfig>,
  excludeUserIds?: string[],
  presentUserIds?: Set<string>,
): Promise<MatchingOutput> {
  const session = await sessionService.getSessionById(sessionId);
  const sessionConfig = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;

  // Phase 7A.2 (7 May spec) — host + cohorts must be excluded from
  // pre-event planning. Stefan #8: pre-plan was including the host
  // (and any cohorts) as regular participants because this query had
  // no exclusion. The legacy generateSingleRound path correctly
  // filtered via excludeUserIds; bringing the same behaviour here.
  // Honours session_participants.role='co_host' + EXCLUDE_FROM_MATCHMAKING
  // semantic via the caller building excludeUserIds with getAllHostIds().
  const participantsResult = excludeUserIds && excludeUserIds.length > 0
    ? await query<MatchingParticipant>(
        `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
                u.industry, u.company, u.languages, u.timezone,
                '{}'::jsonb AS attributes,
                COALESCE(u.is_premium, FALSE) AS "isPremium"
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show')
           AND sp.user_id != ALL($2::uuid[])`,
        [sessionId, excludeUserIds]
      )
    : await query<MatchingParticipant>(
        `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
                u.industry, u.company, u.languages, u.timezone,
                '{}'::jsonb AS attributes,
                COALESCE(u.is_premium, FALSE) AS "isPremium"
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show')`,
        [sessionId]
      );

  // Phase 8A.2 (8 May spec) — Stefan #2 ("Wazim case"): pre-plan was
  // including registered-but-never-connected users. Filter the DB rows
  // by who is actually in presenceMap right now. Per-round generation
  // already does this (Phase 7A.2 wired presentUserIds into
  // generateSingleRound); the pre-plan path was the missing leg.
  const participants = (presentUserIds && presentUserIds.size > 0)
    ? participantsResult.rows.filter(p => presentUserIds.has(p.userId))
    : participantsResult.rows;

  // Section 7 — load premium match requests scoped to this event. Engine
  // uses these to detect mutual requests (highest priority pairing).
  const requests = await loadMatchRequestsForEvent(sessionId, participants.map(p => p.userId));
  for (const p of participants) {
    p.requestedUserIds = requests.get(p.userId) || [];
  }

  // Phase 4 (29 April 2026 spec) — matching policy chosen at event creation.
  // Replaces the legacy binary `crossEventMemory` flag with a tri-state
  // policy. Default 'within_event' = no rematch within this event but
  // people CAN meet again in future events. Pod-level legacy flag still
  // honored as a fallback for sessions created before the policy field.
  const userIds = participants.map((p) => p.userId);
  const matchingPolicy = resolveMatchingPolicy(sessionConfig);
  const encounterHistory = await getEncounterHistoryForUsers(userIds, {
    sessionId,
    matchingPolicy,
  });

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

  // Phase 3 (1 May spec) — engine lookup via registry. Speed-networking
  // events use 'speed_networking_v1' (the default Engine V1.0). Future
  // event types pick a different sessionConfig.matchingAlgorithmId and
  // their engine self-registers in matching.registry.ts.
  const engine = getMatchingEngine(sessionConfig.matchingAlgorithmId || DEFAULT_ENGINE_ID);

  // Generate schedule
  const output = await engine.generateSchedule(input);

  // Persist matches to database
  await persistMatches(sessionId, output.rounds);

  return output;
}

// ─── Generate Single Round ──────────────────────────────────────────────────

/**
 * 27 May — presence gate. Intersect a DB-eligible candidate list with the live
 * "present in the main room" set so absent participants (registered-but-never-
 * joined, or who left) are never matched. FAIL-OPEN: when the present set is
 * absent or empty, or when intersecting would leave nobody, fall back to the DB
 * list and warn — we never silently match zero people.
 */
function gatePresentRows<T>(
  rows: T[],
  getId: (row: T) => string,
  presentUserIds: Set<string> | undefined,
  sessionId: string,
  where: string,
): T[] {
  if (!presentUserIds) return rows;
  if (presentUserIds.size === 0) {
    logger.warn({ sessionId, where }, 'presence gate: empty present-set — falling open to DB-eligible');
    return rows;
  }
  const gated = rows.filter((r) => presentUserIds.has(getId(r)));
  if (gated.length === 0) {
    logger.warn({ sessionId, where, dbEligible: rows.length },
      'presence gate: zero overlap with present-set — falling open to DB-eligible');
    return rows;
  }
  return gated;
}

export async function generateSingleRound(
  sessionId: string,
  roundNumber: number,
  excludeUserIds?: string[],
  options?: { regenerate?: boolean; excludePairKeys?: string[] },
  presentUserIds?: Set<string>,
): Promise<RoundAssignment> {
  const session = await sessionService.getSessionById(sessionId);
  const sessionConfig = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;

  // Get active participants (excluding host/co-hosts and any users currently in
  // active matches — including manual breakout rooms). This guarantees the
  // algorithm never double-pairs someone who's already in a manual room.
  //
  // Bug 4 (18 May Stefan) — eligibility filter widened to include
  // `disconnected`. Pre-fix the narrow `IN ('in_lobby','checked_in',
  // 'registered')` excluded anyone whose DB status was momentarily
  // 'disconnected' even though their socket had already reconnected.
  // Result: the lobby header counted them (status NOT IN
  // 'removed/left/no_show') but matching skipped them. Shradha Uni and
  // Wazim were both in the room but not matched until they refreshed.
  // The broader rule mirrors the header rule; the matching engine
  // already handles late-no-show via match status='no_show' post-start.
  const participantsResult = excludeUserIds && excludeUserIds.length > 0
    ? await query<MatchingParticipant>(
        `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
                u.industry, u.company, u.languages, u.timezone,
                '{}'::jsonb AS attributes,
                COALESCE(u.is_premium, FALSE) AS "isPremium"
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show')
           AND sp.user_id != ALL($2::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE m.session_id = $1 AND m.status = 'active'
               AND (m.participant_a_id = u.id OR m.participant_b_id = u.id OR m.participant_c_id = u.id)
           )`,
        [sessionId, excludeUserIds]
      )
    : await query<MatchingParticipant>(
        `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
                u.industry, u.company, u.languages, u.timezone,
                '{}'::jsonb AS attributes,
                COALESCE(u.is_premium, FALSE) AS "isPremium"
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show')
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE m.session_id = $1 AND m.status = 'active'
               AND (m.participant_a_id = u.id OR m.participant_b_id = u.id OR m.participant_c_id = u.id)
           )`,
        [sessionId]
      );

  // 27 May (presence gate) — re-introduce the live-presence intersection that
  // Phase H removed, but as an OPTIONAL fail-open filter: live-path callers
  // (host press Match / re-match / auto-repair) pass the set of users actually
  // in the main room, so a registered-but-absent participant is never matched;
  // callers without a presence signal pass undefined and keep DB-status behaviour.
  participantsResult.rows = gatePresentRows(
    participantsResult.rows, (p) => p.userId, presentUserIds, sessionId, 'generateSingleRound',
  );

  // Phase 4 — same matching-policy resolution as generateSessionSchedule.
  const userIds = participantsResult.rows.map((p) => p.userId);
  const matchingPolicy = resolveMatchingPolicy(sessionConfig);
  const encounterHistory = await getEncounterHistoryForUsers(userIds, {
    sessionId,
    matchingPolicy,
  });

  // Within-event exclusion (excludedPairs) — pairs that already met in
  // OTHER rounds of THIS session shouldn't be re-paired. Manual breakout
  // rooms (is_manual=TRUE) are architecturally independent from algorithm
  // rounds and MUST NOT poison the algorithm's "already matched" set.
  //
  // Phase 4 — under matchingPolicy='none', this exclusion is disabled so
  // people CAN be re-paired even within the same event. Under 'within_event'
  // (default) and 'platform_wide' it stays on.
  //
  // M3 fix (21 May Ali) — also read participant_c_id and expand 3-way
  // matches into all three pair-tuples (a,b) (a,c) (b,c). Pre-fix the
  // query selected only a and b, so for a 3-way match {a, b, c} the engine
  // only recorded that a met b; it never recorded a-c or b-c. During the
  // 21 May event Alex was participant_c in three of four rounds and
  // got re-paired with Saif (his perpetual co-occurrence partner) in
  // every round — the exclusion never fired because the c column was
  // invisible to this read.
  const excludedPairs = new Set<string>();
  if (matchingPolicy !== 'none') {
    const excludedResult = await query<{
      participant_a_id: string;
      participant_b_id: string;
      participant_c_id: string | null;
    }>(
      `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches
       WHERE session_id = $1 AND round_number != $2
         AND status NOT IN ('cancelled', 'no_show')
         AND is_manual = FALSE`,
      [sessionId, roundNumber]
    );
    for (const r of excludedResult.rows) {
      excludedPairs.add(pairKey(r.participant_a_id, r.participant_b_id));
      if (r.participant_c_id) {
        excludedPairs.add(pairKey(r.participant_a_id, r.participant_c_id));
        excludedPairs.add(pairKey(r.participant_b_id, r.participant_c_id));
      }
    }
  }

  // Fix #1 (25 May Stefan) — platform_wide = HARD exclusion of prior meetings.
  // The UI promises "never matched again", so under platform_wide every pair
  // that has met in ANY prior event (loaded into encounterHistory above; it's
  // empty for within_event/none) must become a HARD exclusion, identical to
  // within-event prior-round pairs — not just the soft encounterFreshness
  // score penalty it used to be. Adding them to the SAME excludedPairs set
  // means the engine's candidate-build skip covers them AND the fallback
  // ladder (L0→L4) is the only relaxation: L3/L4 relax these cross-event
  // pairs exactly when no complete fresh matching is possible. within_event
  // and none load no cross-event history, so their behaviour is unchanged.
  if (matchingPolicy === 'platform_wide') {
    for (const e of encounterHistory) {
      excludedPairs.add(pairKey(e.userAId, e.userBId));
    }
  }

  // 23 May (#5b) — Re-match rotation. excludePairKeys carries the CURRENT
  // preview arrangement; Re-match must always produce a DIFFERENT one. These are
  // applied as a HARD exclusion at EVERY fallback level below (unlike the
  // no-repeat history, which the ladder relaxes), so the engine can never
  // reproduce the current arrangement: it rotates to a fresh pairing while fresh
  // options exist, then to a different already-met pairing once they're gone.

  // Build hard constraints: inviter-invitee avoidance + user-block exclusions.
  const inviterInviteeResult = await query<{ inviter_id: string; accepted_by_user_id: string }>(
    `SELECT inviter_id, accepted_by_user_id FROM invites
     WHERE session_id = $1 AND accepted_by_user_id IS NOT NULL AND status = 'accepted'`,
    [sessionId]
  );
  const inviterInviteePairs = inviterInviteeResult.rows
    .filter(r => r.inviter_id && r.accepted_by_user_id)
    .map(r => `${r.inviter_id}:${r.accepted_by_user_id}`);

  // Phase B (1 May 2026 spec) — user-block exclusions. Blocked pairs (in
  // either direction) are added as a hard constraint so the matching engine
  // never pairs them. The same blocks gate DM sends, so this is the single
  // source of truth for "these two should never interact".
  const blockedPairs = await blockService.getBlockedPairsForUsers(participantsResult.rows.map(p => p.userId));

  const hardConstraints: { type: 'inviter_invitee_block' | 'user_block'; params: { pairs: string[] } }[] = [];
  if (inviterInviteePairs.length > 0) {
    hardConstraints.push({ type: 'inviter_invitee_block', params: { pairs: inviterInviteePairs } });
  }
  if (blockedPairs.length > 0) {
    hardConstraints.push({ type: 'user_block', params: { pairs: blockedPairs } });
  }

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
        // Carry the Engine 1.0 spec defaults forward when a template is in
        // use — template only configures the legacy six weights, premium +
        // learning weights stay at engine defaults.
        mutualPremiumRequest: DEFAULT_WEIGHTS.mutualPremiumRequest,
        singlePremiumRequest: DEFAULT_WEIGHTS.singlePremiumRequest,
        premiumBoost: DEFAULT_WEIGHTS.premiumBoost,
        mutualMeetAgainBoost: DEFAULT_WEIGHTS.mutualMeetAgainBoost,
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

  // Matching Engine 1.0 spec, Section 7 — hydrate per-participant premium
  // request lists for the engine's mutual-detection.
  const requestsForRound = await loadMatchRequestsForEvent(
    sessionId,
    participantsResult.rows.map(p => p.userId),
  );
  for (const p of participantsResult.rows) {
    p.requestedUserIds = requestsForRound.get(p.userId) || [];
  }

  // Phase 3 (1 May spec) — engine lookup via registry.
  const engine = getMatchingEngine(sessionConfig.matchingAlgorithmId || DEFAULT_ENGINE_ID);

  // Phase 2.8 (5 May spec §10) — fallback ladder.
  //
  // Spec §10 mandates a 4-level escalation when the strict no-repeat
  // constraint can't produce a complete matching:
  //
  //   L0 — strict (default). Cross-event encounters get the
  //        encounterFreshness signal as a soft penalty. Within-event
  //        repeats are HARD excluded.
  //   L1 — encounterFreshness penalty halved. Cross-event repeats are
  //        more acceptable.
  //   L2 — encounterFreshness penalty zero. Cross-event repeats neutral.
  //   L3 — half of within-event excludedPairs relaxed (deterministic
  //        pick — alphabetical-keyed lower half). Allows targeted
  //        within-event repeats only when forced.
  //   L4 — drop within-event exclusion entirely. All pairs allowed
  //        (current single-step fallback behavior).
  //
  // Iteration stops at the first level that produces a complete matching
  // (every eligible participant placed in a pair or trio). Each pair
  // records the level it landed at via match_reason for audit trail.
  const eligibleEvenCount = participantsResult.rows.length - (participantsResult.rows.length % 2);
  const sortedExcludedKeys = Array.from(excludedPairs).sort();
  const halfExcludedPairs = new Set(sortedExcludedKeys.slice(Math.floor(sortedExcludedKeys.length / 2)));

  let round: RoundAssignment | null = null;
  let landedAtLevel = 0;

  for (let level = 0; level <= 4; level++) {
    const baseExcluded = level >= 4 ? new Set<string>()
                       : level >= 3 ? halfExcludedPairs
                       : excludedPairs;
    // #5b — excludePairKeys (the current preview arrangement) is NEVER relaxed,
    // even at L4, so Re-match always rotates to a different arrangement.
    const levelExcluded = options?.excludePairKeys?.length
      ? new Set<string>([...baseExcluded, ...options.excludePairKeys])
      : baseExcluded;
    const freshnessScale = level >= 2 ? 0
                         : level >= 1 ? 0.5
                         : 1;
    const levelConfig: MatchingConfig = {
      ...config,
      weights: {
        ...config.weights,
        encounterFreshness: (config.weights.encounterFreshness ?? 0.10) * freshnessScale,
      },
    };

    round = engine.generateRound(
      participantsResult.rows,
      levelConfig,
      levelExcluded,
      encounterHistory,
      roundNumber,
      { regenerate: options?.regenerate === true },
    );

    const matchedIds = new Set<string>();
    for (const p of round.pairs) {
      matchedIds.add(p.participantAId);
      matchedIds.add(p.participantBId);
      if (p.participantCId) matchedIds.add(p.participantCId);
    }
    landedAtLevel = level;

    // Complete: every eligible participant (rounded down to even) is placed.
    // Above-even-count leftover gets handled by the engine's trio path.
    if (matchedIds.size >= eligibleEvenCount) break;

    if (level === 4) {
      logger.warn(
        { sessionId, roundNumber, level, matched: matchedIds.size, eligibleEvenCount },
        'Fallback ladder exhausted at L4 — accepting incomplete matching',
      );
    }
  }

  // Tag pairs with the level they landed at for audit (Spec §13).
  if (landedAtLevel > 0 && round) {
    const reasonByLevel: Record<number, string> = {
      1: 'fallback_l1_freshness_softened',
      2: 'fallback_l2_freshness_neutral',
      3: 'fallback_l3_partial_event_repeats',
      4: 'fallback_l4_event_repeats',
    };
    for (const pair of round.pairs) {
      pair.fallbackUsed = true;
      const isRepeat = excludedPairs.has(pairKey(pair.participantAId, pair.participantBId));
      pair.repeatInEvent = isRepeat;
      pair.matchReason = reasonByLevel[landedAtLevel] || pair.matchReason || 'fallback';
    }
    logger.info(
      { sessionId, roundNumber, fallbackLevel: landedAtLevel, pairCount: round.pairs.length },
      'Phase 2.8 — round produced via fallback ladder',
    );
  }

  if (!round) {
    // Defensive — should never happen since the loop always assigns at L0.
    throw new Error('Fallback ladder produced no round — engine misconfigured');
  }

  // Fix #9 (25 May Stefan) — surface the fallback level to the caller so the
  // host can be told "no fresh pairings left — showing closest available"
  // instead of the Re-match button silently re-rolling. usedRepeats is true
  // whenever any pair this round reused an excluded (already-met) pair —
  // either a within-event prior round or, under platform_wide, a prior-event
  // pair (Fix #1). At L0 every pair is fresh, so both stay clean.
  round.fallbackLevel = landedAtLevel;
  round.usedRepeats = round.pairs.some(
    p => excludedPairs.has(pairKey(p.participantAId, p.participantBId)),
  );
  // TODO (Fix #9 UI): thread round.fallbackLevel / round.usedRepeats through
  // matching-flow.ts (host:matches_ready / Re-match emit) into the host
  // preview so the client can render the "No fresh pairings left — showing
  // closest available" banner + a "finding next person" state on Re-match.
  // The return-value plumbing lands here; the client string is a follow-up.

  // Persist this round's matches
  await persistMatches(sessionId, [round]);

  return round;
}

// ─── Get Eligible Participants ─────────────────────────────────────────────
//
// Returns user IDs that are eligible to be matched in a new algorithm round —
// i.e. registered/in-lobby/checked-in AND not currently in any active match
// (including manual breakout rooms). Optionally excludes host/co-hosts.
//
// This is the single source of truth used by both the algorithm guard
// (handleMatchPeople) and the host dashboard's eligibleMainRoomCount.

export async function getEligibleParticipants(
  sessionId: string,
  excludeUserIds: string[] = [],
  presentUserIds?: Set<string>,
): Promise<string[]> {
  // Phase A1 (10 May spec) — DB is the single source of truth for matching
  // eligibility. `disconnected` was previously eligible (filter only excluded
  // removed/left/no_show); the live path compensated by intersecting with an
  // in-memory presenceMap. That intersection masked ghost-user bugs whenever
  // the two diverged. Excluding `disconnected` here means matching can trust
  // the DB exclusively — no in-memory crutch needed in the live path.
  const result = excludeUserIds.length > 0
    ? await query<{ user_id: string }>(
        `SELECT sp.user_id FROM session_participants sp
         WHERE sp.session_id = $1
           AND sp.status NOT IN ('removed', 'left', 'no_show', 'disconnected')
           AND sp.user_id != ALL($2::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE m.session_id = $1 AND m.status = 'active'
               AND (m.participant_a_id = sp.user_id OR m.participant_b_id = sp.user_id OR m.participant_c_id = sp.user_id)
           )`,
        [sessionId, excludeUserIds]
      )
    : await query<{ user_id: string }>(
        `SELECT sp.user_id FROM session_participants sp
         WHERE sp.session_id = $1
           AND sp.status NOT IN ('removed', 'left', 'no_show', 'disconnected')
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE m.session_id = $1 AND m.status = 'active'
               AND (m.participant_a_id = sp.user_id OR m.participant_b_id = sp.user_id OR m.participant_c_id = sp.user_id)
           )`,
        [sessionId]
      );
  return gatePresentRows(result.rows, (r) => r.user_id, presentUserIds, sessionId, 'getEligibleParticipants')
    .map(r => r.user_id);
}

// ─── Get Matches for Session/Round ──────────────────────────────────────────

export async function getMatchesBySession(sessionId: string): Promise<Match[]> {
  const result = await query<Match>(
    `SELECT id, session_id AS "sessionId", round_number AS "roundNumber",
            participant_a_id AS "participantAId", participant_b_id AS "participantBId",
            participant_c_id AS "participantCId",
            room_id AS "roomId", status, score, reason_tags AS "reasonTags",
            is_manual AS "isManual",
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
            is_manual AS "isManual",
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
            is_manual AS "isManual",
            started_at AS "startedAt", ended_at AS "endedAt", created_at AS "createdAt"
     FROM matches WHERE id = $1`,
    [matchId]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Match', matchId);
  }
  return result.rows[0];
}

/**
 * Phase 3 (29 April 2026 spec) — remove a single participant from a match.
 *
 * Pre-fix, `handleLeaveConversation` and `handleHostRemoveFromRoom` both
 * marked the entire match as `'completed'` / `'cancelled'` the moment ANY
 * participant left, even if 2+ participants remained (i.e. it was a trio).
 * That broke the user's spec rule:
 *
 *   "3-person room, 1 leaves → other 2 keep talking uninterrupted"
 *
 * This helper handles all three room sizes cleanly:
 *
 *   - 2+ remaining (trio with 1 leaver): NULL out the leaver's slot and keep
 *     match status='active'. Slots are re-canonicalised so the remaining
 *     two are sorted into A/B (matching the A < B convention used by INSERT
 *     paths). The remaining participants continue their conversation; the
 *     LiveKit room is unaffected.
 *   - 1 remaining (was a 2-person room): mark match `terminalStatus`
 *     (default 'completed'). Caller handles return-to-lobby and
 *     auto-reassign for the solo partner.
 *   - 0 remaining (rare; last person leaves a 1-person manual breakout):
 *     mark match `terminalStatus`.
 *
 * Returns:
 *   - remainingUserIds — IDs still in the match after demotion
 *   - matchStillActive — true when 2+ remained and the match continues
 *
 * Atomicity: SELECT … FOR UPDATE prevents two concurrent leaves from racing
 * (e.g. two users hitting "leave" within milliseconds). Whichever runs
 * second sees the post-demotion slot layout and acts accordingly.
 */
export async function demoteParticipantFromMatch(
  matchId: string,
  userId: string,
  terminalStatusIfRoomEmpties: 'completed' | 'cancelled' | 'reassigned' = 'completed',
): Promise<{ remainingUserIds: string[]; matchStillActive: boolean }> {
  return transaction(async (client) => {
    const result = await client.query<{
      participant_a_id: string;
      participant_b_id: string | null;
      participant_c_id: string | null;
    }>(
      `SELECT participant_a_id, participant_b_id, participant_c_id
       FROM matches WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [matchId],
    );
    if (result.rows.length === 0) {
      return { remainingUserIds: [], matchStillActive: false };
    }
    const m = result.rows[0];
    const remaining = [m.participant_a_id, m.participant_b_id, m.participant_c_id]
      .filter((id): id is string => !!id && id !== userId);

    if (remaining.length >= 2) {
      // Trio with 1 leaver — keep match active, re-canonicalise slots.
      const sorted = [...remaining].sort();
      const newA = sorted[0];
      const newB = sorted[1];
      const newC = sorted[2] || null; // 4-person rooms not supported, but safe
      await client.query(
        `UPDATE matches SET participant_a_id = $1, participant_b_id = $2, participant_c_id = $3 WHERE id = $4`,
        [newA, newB, newC, matchId],
      );
      return { remainingUserIds: remaining, matchStillActive: true };
    }

    // 1 or 0 remain — terminal.
    await client.query(
      `UPDATE matches SET status = $2, ended_at = NOW() WHERE id = $1 AND status = 'active'`,
      [matchId, terminalStatusIfRoomEmpties],
    );
    return { remainingUserIds: remaining, matchStillActive: false };
  });
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

import type { MatchingPolicy } from '@rsn/shared';

/**
 * Phase 4 (29 April 2026 spec) — resolve the matching policy for a session
 * config. Defaults to 'within_event' (the new spec default) when the field
 * is missing. Backwards-compatible with the legacy `crossEventMemory` flag:
 * if matchingPolicy is unset and crossEventMemory was explicitly false, we
 * treat that as 'none' (the user-visible behaviour stays identical).
 */
export function resolveMatchingPolicy(sessionConfig: any): MatchingPolicy {
  if (sessionConfig?.matchingPolicy === 'platform_wide'
      || sessionConfig?.matchingPolicy === 'within_event'
      || sessionConfig?.matchingPolicy === 'none') {
    return sessionConfig.matchingPolicy;
  }
  // Legacy fallback: pre-Phase-4 sessions used a binary crossEventMemory
  // boolean. crossEventMemory=true → platform_wide (strictest, was the
  // implicit pre-Phase-4 default). crossEventMemory=false → none.
  if (sessionConfig?.crossEventMemory === false) return 'none';
  if (sessionConfig?.crossEventMemory === true) return 'platform_wide';
  // Default for new sessions without either field set.
  return 'within_event';
}

/**
 * Fetch encounter history for a set of users, scoped by matching policy.
 *
 * Phase 4 — `matchingPolicy` (29 April 2026 spec) is the source of truth:
 *
 *   'platform_wide' — return all encounters EXCEPT those from this same
 *     session (within-session uniqueness is enforced by the engine's
 *     usedPairs set, so re-including this session's encounters would
 *     double-count and falsely surface "already met N times" in round 2+).
 *     This is the strictest policy: never re-pair if they've ever met
 *     anywhere on RSN.
 *   'within_event' — return EMPTY. Within-event uniqueness is handled
 *     separately via the excludedPairs query against this session's
 *     `matches` table. People CAN be re-matched in future events.
 *   'none' — return EMPTY. No encounter exclusion at all. People can be
 *     paired again even if they've met before.
 *
 * Legacy fallback (pre-Phase-4 callers may still pass `crossEventMemory`):
 * `crossEventMemory: false` → treated as `matchingPolicy: 'none'`.
 *
 * `sessionId` is recommended whenever available so this-session encounters
 * are filtered out of platform-wide history (avoids the double-count above).
 */
async function getEncounterHistoryForUsers(
  userIds: string[],
  options: {
    sessionId?: string;
    crossEventMemory?: boolean;
    matchingPolicy?: MatchingPolicy;
  } = {},
): Promise<EncounterHistoryEntry[]> {
  if (userIds.length === 0) return [];

  // Resolve the effective policy. matchingPolicy wins over crossEventMemory.
  const policy: MatchingPolicy = options.matchingPolicy
    ?? (options.crossEventMemory === false ? 'none'
        : options.crossEventMemory === true ? 'platform_wide'
        : 'within_event');

  // Within-event and none policies don't consult cross-event encounter
  // history — return empty. Within-event uniqueness is enforced by the
  // excludedPairs query in generateSingleRound; no encounter_history needed.
  if (policy === 'within_event' || policy === 'none') return [];

  // platform_wide — query encounter_history, excluding rows tagged with
  // this same session_id (those pairs are already in excludedPairs).
  const params: unknown[] = [userIds];
  let extraWhere = '';
  if (options.sessionId) {
    extraWhere = ` AND (last_session_id IS NULL OR last_session_id != $2)`;
    params.push(options.sessionId);
  }

  // Matching Engine 1.0 spec, Section 4 (Pair Relationship) + Section 8
  // (Feedback Learning) — surface mutual_meet_again and a derived
  // average rating for the pair so the engine's mutualMeetAgainBoost
  // weight can lift previously-positive pairs.
  const result = await query<EncounterHistoryEntry>(
    `SELECT
       eh.user_a_id AS "userAId",
       eh.user_b_id AS "userBId",
       eh.times_met AS "timesMet",
       eh.last_met_at AS "lastMetAt",
       COALESCE(eh.mutual_meet_again, FALSE) AS "mutualMeetAgain",
       (
         SELECT AVG(r.quality_score)::float
         FROM ratings r
         JOIN matches m ON m.id = r.match_id
         WHERE (
           (m.participant_a_id = eh.user_a_id AND m.participant_b_id = eh.user_b_id)
           OR
           (m.participant_a_id = eh.user_b_id AND m.participant_b_id = eh.user_a_id)
         )
       ) AS "averageRating"
     FROM encounter_history eh
     WHERE eh.user_a_id = ANY($1) AND eh.user_b_id = ANY($1)${extraWhere}`,
    params,
  );
  return result.rows;
}

/**
 * Phase 2.5D (5 May spec compliance) — future-only repair.
 *
 * Stefan's matching spec §9: "Never change a live session. Only update
 * future sessions." When a participant joins late or leaves mid-event,
 * we must regenerate ONLY the rounds that haven't started yet, leaving
 * completed and active rounds untouched.
 *
 * Behaviour:
 *   1. Validates fromRound is a future round (no scheduled-only rows for
 *      it would be in 'active' / 'completed' state — those are immutable).
 *   2. Deletes pre-planned matches at status='scheduled' for rounds >= fromRound.
 *   3. Regenerates each future round in order via generateSingleRound, which
 *      queries "matches in OTHER rounds" for the no-repeat constraint —
 *      so iteration N picks pairs that don't repeat completed rounds OR
 *      already-regenerated future rounds N-1, N-2, ...
 *   4. Returns the count of rounds regenerated + any errors per round.
 *
 * Throttling is the caller's responsibility (see participant-flow.ts join
 * path, which throttles to one repair per 5s per session).
 */
export async function repairFutureRounds(
  sessionId: string,
  fromRoundNumber: number,
  reason: 'late_joiner' | 'left' | 'host_request',
  presentUserIds?: Set<string>,
): Promise<{ regeneratedRounds: number[]; errors: Array<{ roundNumber: number; error: string }> }> {
  const session = await sessionService.getSessionById(sessionId);
  const sessionConfig = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;
  const totalRounds: number = sessionConfig.numberOfRounds || 5;

  if (fromRoundNumber > totalRounds) {
    logger.info({ sessionId, fromRoundNumber, totalRounds, reason },
      'repairFutureRounds: fromRound exceeds totalRounds — nothing to repair');
    return { regeneratedRounds: [], errors: [] };
  }

  // Wipe all 'scheduled' matches for fromRound and beyond. Active/completed
  // rounds are immutable per spec §9 and are NOT touched.
  await query(
    `DELETE FROM matches
       WHERE session_id = $1 AND round_number >= $2 AND status = 'scheduled'`,
    [sessionId, fromRoundNumber],
  );

  // Regenerate each future round in order. Each call's excludedPairs picks
  // up the previously-completed rounds AND any rounds already regenerated
  // in this loop (so cross-round no-repeat is preserved).
  const allHostIds: string[] = [];
  if (session.hostUserId) allHostIds.push(session.hostUserId);
  // Phase R6 (20 May 2026) — session_cohosts is the canonical cohort table.
  // Pre-fix queried session_participants.role which doesn't exist; the silent
  // catch swallowed the missing-column error and returned [], so cohosts were
  // never excluded from matching for any event with cohosts. Also honours
  // Phase M (12 May spec) acting_as_host overrides so admin opt-ins get
  // excluded too and admin opt-outs stay matchable.
  try {
    const cohostsRes = await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
      [sessionId],
    );
    for (const r of cohostsRes.rows) allHostIds.push(r.user_id);
    const overrideRes = await query<{ user_id: string; acting_as_host: boolean }>(
      `SELECT user_id, acting_as_host FROM session_participants
       WHERE session_id = $1 AND acting_as_host IS NOT NULL`,
      [sessionId],
    );
    for (const r of overrideRes.rows) {
      if (r.acting_as_host === true) {
        if (!allHostIds.includes(r.user_id)) allHostIds.push(r.user_id);
      } else if (r.acting_as_host === false) {
        const idx = allHostIds.indexOf(r.user_id);
        if (idx >= 0) allHostIds.splice(idx, 1);
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Phase R6 — failed to fetch cohost / acting_as_host exclusions');
  }

  const regeneratedRounds: number[] = [];
  const errors: Array<{ roundNumber: number; error: string }> = [];

  for (let r = fromRoundNumber; r <= totalRounds; r++) {
    try {
      await generateSingleRound(sessionId, r, allHostIds, undefined, presentUserIds);
      regeneratedRounds.push(r);
    } catch (err: any) {
      logger.warn({ err, sessionId, roundNumber: r, reason },
        'repairFutureRounds: generateSingleRound failed for round — continuing');
      errors.push({ roundNumber: r, error: err?.message || String(err) });
    }
  }

  logger.info(
    { sessionId, fromRoundNumber, totalRounds, regeneratedRounds: regeneratedRounds.length, errors: errors.length, reason },
    'Phase 2.5D — future rounds repaired',
  );

  return { regeneratedRounds, errors };
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

      // Batch insert all matches for this round in one multi-row INSERT.
      // Matching Engine 1.0 spec, Section 13 — each row stores the engine's
      // explicit logging fields (match_reason, fallback_used, repeat_in_event,
      // premium_influenced) so admin surfaces and future learning loops have
      // structured metadata, not just the reasonTags string array.
      if (round.pairs.length > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let paramIdx = 1;

        for (const pair of round.pairs) {
          const pA = pair.participantAId < pair.participantBId ? pair.participantAId : pair.participantBId;
          const pB = pair.participantAId < pair.participantBId ? pair.participantBId : pair.participantAId;
          placeholders.push(
            `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, 'scheduled', $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, $${paramIdx + 10})`,
          );
          values.push(
            sessionId, round.roundNumber, pA, pB, pair.participantCId || null,
            pair.score, pair.reasonTags,
            pair.matchReason || null,
            pair.fallbackUsed === true,
            pair.repeatInEvent === true,
            pair.premiumInfluenced === true,
          );
          paramIdx += 11;
        }

        await client.query(
          `INSERT INTO matches
             (session_id, round_number, participant_a_id, participant_b_id, participant_c_id,
              score, reason_tags, status,
              match_reason, fallback_used, repeat_in_event, premium_influenced)
           VALUES ${placeholders.join(', ')}`,
          values,
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
