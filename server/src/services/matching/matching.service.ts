// ─── Matching Service ────────────────────────────────────────────────────────
// Coordinates between the matching engine, database, and session service.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  MatchingInput, MatchingOutput, MatchingConfig, MatchingWeights,
  MatchingParticipant, EncounterHistoryEntry, RoundAssignment,
  MatchStatus, Match, HardConstraint, MatchPair, MatchingGroupRules, EventGroupRules,
  explainRoundCapacity, groupPairKey, groupsAllowed, questionAffinity, ruleForRound,
} from '@rsn/shared';
import { getMatchingEngine, DEFAULT_ENGINE_ID } from './matching.registry';
import { IMatchingEngine, pairKey } from './matching.interface';
import { groupGate } from './matching.engine';
import { getEventGroupRules, groupsForParticipants } from '../session/event-groups.service';
import { loadQuestionSignals } from '../session/event-questions.service';
import { reduceRepeatPairs } from './repeat-reduction';
import * as sessionService from '../session/session.service';
import { loadHardExclusions, type HardExclusions } from './hard-exclusions';
import { normalizeDesignation, pairConfidence, profileCompleteness, withinCooldown } from './intent-signals';
import { NotFoundError } from '../../middleware/errors';
import { templateIdOf } from './matching-template-choice';
import { recordEventAudit } from '../audit/event-audit';

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
  // Onboarding-intent enhancement — additive relevance from data we already
  // capture (who you want to meet, who you avoid, your designation). Modest so
  // they sharpen relevance without dominating the existing diversity/freshness.
  intentAlignment: 0.20,
  designationDiversity: 0.10,
  avoidPenalty: 0.15,
  // Phase 2 — per-event check-in intention overlay.
  eventIntentionAlignment: 0.15,
};

/**
 * Onboarding-intent enrichment — attach designation / wantsToMeet / avoid to
 * each participant from data we already capture (job_title, who_i_want_to_meet,
 * and user_intent_profiles). Best-effort: on any failure participants simply
 * lack these optional fields and the engine scores them neutrally. Never throws
 * into the matching flow, and never relaxes an exclusion.
 */
async function attachIntentSignals(
  participants: MatchingParticipant[],
  sessionId?: string,
): Promise<void> {
  if (!participants.length) return;
  try {
    const ids = participants.map((p) => p.userId);
    const res = await query<{
      id: string;
      job_title: string | null;
      who_i_want_to_meet: string | null;
      avoid_preferences: string[] | null;
      matching_intent: any;
    }>(
      `SELECT u.id, u.job_title, u.who_i_want_to_meet,
              p.avoid_preferences, p.matching_intent
         FROM users u
         LEFT JOIN user_intent_profiles p ON p.user_id = u.id
        WHERE u.id = ANY($1::uuid[])`,
      [ids]
    );
    const byId = new Map(res.rows.map((r) => [r.id, r]));
    const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    for (const part of participants) {
      const r = byId.get(part.userId);
      if (!r) continue;
      const mi = r.matching_intent && typeof r.matching_intent === 'object' ? r.matching_intent : {};
      // Phase 2 — prefer the structured designation when onboarding captured it,
      // else derive from the free-text job title.
      part.designation = str(mi.userDesignation) || normalizeDesignation(r.job_title);
      part.wantsToMeet = [
        ...arr(mi.desiredRoles),
        ...arr(mi.desiredPeople),
        ...arr(mi.desiredIndustries),
        ...arr(mi.desiredDesignations),
        ...(r.who_i_want_to_meet ? [r.who_i_want_to_meet] : []),
      ];
      part.avoid = [
        ...arr(r.avoid_preferences),
        ...arr(mi.avoidPreferences),
        ...arr(mi.avoidDesignations),
      ];
      // Phase 2 — tiered scoring input.
      part.completeness = profileCompleteness(part);
    }

    // Phase 2 — per-event intention captured at check-in (scoped to THIS event).
    if (sessionId) {
      const sp = await query<{ user_id: string; event_intention: string | null; openness: string | null }>(
        `SELECT user_id, event_intention, openness
           FROM session_participants
          WHERE session_id = $1 AND user_id = ANY($2::uuid[])`,
        [sessionId, ids]
      );
      const intentById = new Map(sp.rows.map((r) => [r.user_id, r]));
      for (const part of participants) {
        const r = intentById.get(part.userId);
        if (!r) continue;
        part.eventIntention = r.event_intention;
        part.openness = r.openness;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'attachIntentSignals failed — matching proceeds without onboarding signals');
  }
}

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
  // Onboarding-intent enhancement — designation / wantsToMeet / avoid + per-event intent.
  await attachIntentSignals(participants, sessionId);

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

  // 10 Nov 2026 (Part 2 Task 7) — the plan made at Start keeps apart the same people every later round does: a
  // block either way, a report not dismissed, an inviter and the person they invited. It loaded none of them
  // before, so the plan could seat two people who blocked each other together (and handleHostGenerateMatches
  // shows that plan as the round's preview). Same loader, same reads, same failure behaviour as generateSingleRound.
  const exclusions = await loadHardExclusions(sessionId, userIds);
  // Part 2 Task 7 — the event's groups and round rules; none for an event without groups (config unchanged).
  const groupRules = await loadGroupRules(sessionId);

  // Build matching config
  const config: MatchingConfig = {
    weights: customConfig?.weights || (await templateWeightsFor(session, sessionConfig)).weights,
    hardConstraints: [...(customConfig?.hardConstraints ?? []), ...hardConstraintsOf(exclusions)],
    numberOfRounds: customConfig?.numberOfRounds || sessionConfig.numberOfRounds || 5,
    avoidDuplicates: customConfig?.avoidDuplicates ?? true,
    globalOptimize: customConfig?.globalOptimize ?? true,
    ...(groupRules && { groupRules }),
  };
  // Part 3 Task 5 (K5) — the event's extra matching questions, a soft preference inside the pair score; none for an
  // event without questions (one read, config unchanged).
  const eventQuestions = await loadQuestionSignals(sessionId, userIds);
  if (eventQuestions) config.eventQuestions = eventQuestions;

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

  // Generate schedule. An event with groups plans round by round through generateGroupedRound, so each round
  // gets the organiser's fallback and its capacity sentence; an event without groups takes the engine's own path.
  const output = groupRules ? planGroupedSchedule(engine, input) : await engine.generateSchedule(input);

  // Persist matches to database
  await persistMatches(sessionId, output.rounds, templateIdOf(sessionConfig));

  return output;
}

/**
 * Phase 3 — the weights an event pairs people with: its own template (a preset or an admin's), else its pod's,
 * else the engine defaults. A template's `weights` JSONB holds the FULL engine weight set; it is merged over
 * DEFAULT_WEIGHTS so any unset signal falls back to the engine default. Pre-072 templates (no JSONB) fall back to
 * the legacy 5-column mapping so their behaviour is unchanged.
 *
 * 30 Oct 2026 — the pre-event plan (generateSessionSchedule) reads them too: it used the engine defaults whatever
 * the event chose, so a preset changed only rounds made one at a time. Only the weights are taken: a template's
 * matching_policy and cooldown_months are never applied over the event's own rule (resolveMatchingPolicy), and
 * nothing here adds a hard constraint, so a preset makes some pairings likelier and forbids none. A stored id that
 * is not a UUID reads as no template (templateIdOf) instead of failing the read.
 */
async function templateWeightsFor(
  session: { podId?: string | null },
  sessionConfig: unknown,
): Promise<{ weights: MatchingWeights; templateId: string | null }> {
  let weights = DEFAULT_WEIGHTS;

  let effectiveTemplateId: string | null = templateIdOf(sessionConfig);
  if (!effectiveTemplateId && session.podId) {
    effectiveTemplateId = await query<{ matching_template_id: string | null }>(
      `SELECT matching_template_id FROM pods WHERE id = $1`,
      [session.podId]
    ).then((r) => r.rows[0]?.matching_template_id || null).catch(() => null);
  }

  if (effectiveTemplateId) {
    const tplResult = await query<{
      weights: any;
      weight_industry: number | null; weight_interests: number | null; weight_intent: number | null;
      weight_experience: number | null; weight_location: number | null;
      same_company_allowed: boolean;
    }>(`SELECT * FROM matching_templates WHERE id = $1`, [effectiveTemplateId]);
    if (tplResult.rows.length > 0) {
      const t = tplResult.rows[0];
      if (t.weights && typeof t.weights === 'object') {
        // Phase 3 — full, correctly-named weight set, merged over defaults.
        weights = { ...DEFAULT_WEIGHTS, ...(t.weights as Partial<typeof DEFAULT_WEIGHTS>) };
      } else {
        // Legacy template (pre-072): map the 5 columns; premium/learning/intent
        // stay at engine defaults — identical to pre-Phase-3 behaviour.
        weights = {
          ...DEFAULT_WEIGHTS,
          sharedInterests: t.weight_interests ?? DEFAULT_WEIGHTS.sharedInterests,
          sharedReasons: t.weight_intent ?? DEFAULT_WEIGHTS.sharedReasons,
          industryDiversity: t.weight_industry ?? DEFAULT_WEIGHTS.industryDiversity,
          companyDiversity: t.same_company_allowed ? 0 : DEFAULT_WEIGHTS.companyDiversity,
          languageMatch: t.weight_location ?? DEFAULT_WEIGHTS.languageMatch,
          encounterFreshness: t.weight_experience ?? DEFAULT_WEIGHTS.encounterFreshness,
        };
      }
      logger.info({ templateId: effectiveTemplateId }, 'Using matching template weights');
    }
  }
  return { weights, templateId: effectiveTemplateId };
}

// ─── Matching groups (Part 2 Task 7, 10 Nov 2026 spec sections 05 and 07) ────────────────────────────────
//
// An event's groups and per-round rules are hard constraints: the engine never makes a pair the round's rule does
// not allow (matching.engine.ts groupGate), the L0-L4 ladder relaxes repeats only, never a group rule, and the
// people a rule leaves without a partner either wait or, when the organiser chose it, meet their own group. An
// event without groups loads no rules (one read of event_groups) and every path below is skipped.

const SAME_GROUP_FALLBACK = 'same_group_fallback';

/** The event's groups and each person's group keys, or undefined for an event without groups. */
async function loadGroupRules(sessionId: string): Promise<MatchingGroupRules | undefined> {
  const rules = await getEventGroupRules(sessionId);
  if (!rules) return undefined;
  const groups = await groupsForParticipants(sessionId);
  return { rules, groupsByUser: Object.fromEntries(groups) };
}

/** Each group's size among these people (someone in two groups counts in each) and how many have no group. */
function groupCounts(group: MatchingGroupRules, participants: MatchingParticipant[]): { counts: Record<string, number>; ungrouped: number } {
  const known = new Set(group.rules.groups.map((g) => g.key));
  const counts: Record<string, number> = {};
  let ungrouped = 0;
  for (const p of participants) {
    const keys = (group.groupsByUser[p.userId] ?? []).filter((k) => known.has(k));
    if (keys.length === 0) ungrouped++;
    for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  }
  return { counts, ungrouped };
}

/**
 * The rule the organiser's same-group fallback meets people under: whatever the round's rule allows, and two people
 * of the same group. Someone with no group still meets nobody (the room checker says the same).
 */
function fallbackRules(rules: EventGroupRules, round: number): EventGroupRules {
  const rule = ruleForRound(rules, round);
  const keys = rules.groups.map((g) => g.key);
  const allowed = new Set<string>();
  for (const a of keys) {
    for (const b of keys) if (a === b || groupsAllowed(rule, [a], [b])) allowed.add(groupPairKey(a, b));
  }
  return { ...rules, rounds: [{ fromRound: round, toRound: round, mode: 'custom', allowedPairs: [...allowed].sort() }] };
}

/** Whether two people may sit together this round: the rule allows it, or the organiser's fallback does. */
function groupedMayMeet(group: MatchingGroupRules, config: MatchingConfig, round: number): ((a: string, b: string) => boolean) | undefined {
  const gate = groupGate(config, round);
  if (!gate) return undefined;
  if (group.rules.fallback !== 'same_group_meeting') return gate;
  const fallbackGate = groupGate({ ...config, groupRules: { ...group, rules: fallbackRules(group.rules, round) } }, round);
  return (a, b) => gate(a, b) || (fallbackGate ? fallbackGate(a, b) : true);
}

function roomMembers(p: { participantAId: string; participantBId: string; participantCId?: string | null }): string[] {
  return [p.participantAId, p.participantBId, p.participantCId].filter((x): x is string => !!x);
}

/** Marks the pairs only the organiser's fallback lets meet (and unmarks any a repeat swap made rule-abiding). */
function tagFallbackPairs(pairs: MatchPair[], gate: ((a: string, b: string) => boolean) | null): void {
  if (!gate) return;
  for (const [i, p] of pairs.entries()) {
    const m = roomMembers(p);
    const breaksRule = m.some((a, x) => m.slice(x + 1).some((b) => !gate(a, b)));
    const tagged = p.reasonTags.includes(SAME_GROUP_FALLBACK);
    if (breaksRule && !tagged) {
      pairs[i] = { ...p, reasonTags: [...p.reasonTags, SAME_GROUP_FALLBACK], matchReason: SAME_GROUP_FALLBACK };
    } else if (!breaksRule && tagged) {
      const reasonTags = p.reasonTags.filter((t) => t !== SAME_GROUP_FALLBACK);
      pairs[i] = { ...p, reasonTags, matchReason: reasonTags[0] || 'best_available' };
    }
  }
}

/**
 * How many people a round of an event with groups can seat: everyone (an even count) in an open round; otherwise
 * the meetings the rule allows, plus, under the same-group fallback, those left waiting paired among their own
 * group. The fallback ladder stops there instead of relaxing repeats for people no repeat could seat.
 */
function groupedPlacementTarget(
  group: MatchingGroupRules, participants: MatchingParticipant[], round: number, numberOfRounds: number, eligibleEvenCount: number,
): number {
  if (ruleForRound(group.rules, round).mode === 'open') return eligibleEvenCount;
  const { counts, ungrouped } = groupCounts(group, participants);
  const capacity = explainRoundCapacity(group.rules, round, counts, Math.max(numberOfRounds || 0, round), ungrouped);
  const fallbackSeats = group.rules.fallback === 'same_group_meeting'
    ? Object.values(capacity.waiting).reduce((s, w) => s + w - (w % 2), 0)
    : 0;
  return Math.min(eligibleEvenCount, 2 * capacity.maxMeetings + fallbackSeats);
}

/**
 * One round of an event with groups. Phase 1: the engine under the round's rule. Then, when people are left waiting
 * and the organiser chose 'same_group_meeting', phase 2 pairs them among themselves under the fallback rule (hard
 * exclusions and no-repeat still apply), each such pair tagged 'same_group_fallback'; a single person left over
 * joins a pair only as the engine's trio rule allows, else waits. 'groupShortfall' says how many meetings the
 * rule allows for the people in the round and who waits; its sentence goes into 'warnings'. Without groups in
 * the config this is exactly the engine's generateRound.
 */
export function generateGroupedRound(input: {
  participants: MatchingParticipant[];
  config: MatchingConfig;
  excludedPairs: Set<string>;
  encounterHistory: EncounterHistoryEntry[];
  round: number;
  regenerate?: boolean;
  engine?: IMatchingEngine;
}): RoundAssignment {
  const { participants, config, excludedPairs, encounterHistory, round } = input;
  const engine = input.engine ?? getMatchingEngine(DEFAULT_ENGINE_ID);
  const options = { regenerate: input.regenerate === true };
  const first = engine.generateRound(participants, config, excludedPairs, encounterHistory, round, options);
  const group = config.groupRules;
  if (!group) return first;

  const pairs = [...first.pairs];
  const placed = new Set(pairs.flatMap(roomMembers));
  let waiting = participants.filter((p) => !placed.has(p.userId));
  const gate = groupGate(config, round);
  if (gate && group.rules.fallback === 'same_group_meeting' && waiting.length >= 2) {
    const fallbackConfig: MatchingConfig = { ...config, groupRules: { ...group, rules: fallbackRules(group.rules, round) } };
    const second = engine.generateRound(waiting, fallbackConfig, excludedPairs, encounterHistory, round, options);
    pairs.push(...second.pairs);
    tagFallbackPairs(pairs, gate);
    const seated = new Set(pairs.flatMap(roomMembers));
    waiting = participants.filter((p) => !seated.has(p.userId));
  }

  const { counts, ungrouped } = groupCounts(group, participants);
  const groupShortfall = explainRoundCapacity(group.rules, round, counts, Math.max(config.numberOfRounds || 0, round), ungrouped);
  const warnings = [...(first.warnings ?? [])];
  if (groupShortfall.sentence) warnings.push(groupShortfall.sentence);
  const byes = waiting.map((p) => p.userId);
  return {
    ...first,
    pairs,
    byeParticipant: byes[0] ?? null,
    byeParticipants: byes,
    ...(warnings.length > 0 && { warnings }),
    groupShortfall,
  };
}

/** Every pair key a room makes meet: the pair, and the three of a trio. */
function addRoomPairs(used: Set<string>, p: { participantAId: string; participantBId: string; participantCId?: string | null }): void {
  const m = roomMembers(p);
  for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) used.add(pairKey(m[i], m[j]));
}

/**
 * The plan made at Start for an event with groups: every round through generateGroupedRound, each avoiding every
 * pair (and every trio's three pairs) already planned or held, in the shape the engine's generateSchedule returns.
 */
function planGroupedSchedule(engine: IMatchingEngine, input: MatchingInput): MatchingOutput {
  const startTime = Date.now();
  engine.validateInput(input);
  const used = new Set<string>();
  for (const r of input.previousRounds) for (const p of r.pairs) addRoomPairs(used, p);
  const rounds: RoundAssignment[] = [];
  for (let r = 1; r <= input.config.numberOfRounds; r++) {
    const round = generateGroupedRound({
      participants: input.participants, config: input.config, excludedPairs: used,
      encounterHistory: input.encounterHistory, round: r, engine,
    });
    for (const p of round.pairs) addRoomPairs(used, p);
    rounds.push(round);
  }
  const scores = rounds.flatMap((r) => r.pairs.map((p) => p.score));
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const min = scores.length > 0 ? Math.min(...scores) : 0;
  return {
    sessionId: input.sessionId,
    rounds,
    generatedAt: new Date(),
    durationMs: Date.now() - startTime,
    metadata: {
      participantCount: input.participants.length,
      roundCount: rounds.length,
      avgScore: Math.round(avg * 10000) / 10000,
      minScore: Math.round(min * 10000) / 10000,
      duplicatesAvoided: used.size,
    },
  };
}

/**
 * The engine's hard constraints for the pairs that must never meet: the inviter and invitee pairs, then the blocks
 * and reports, each only when there is one (the order and shape generateSingleRound has always passed).
 */
function hardConstraintsOf(exclusions: HardExclusions): HardConstraint[] {
  const constraints: HardConstraint[] = [];
  if (exclusions.inviterInvitee.length > 0) {
    constraints.push({ type: 'inviter_invitee_block', params: { pairs: exclusions.inviterInvitee } });
  }
  if (exclusions.blocked.length > 0) {
    constraints.push({ type: 'user_block', params: { pairs: exclusions.blocked } });
  }
  return constraints;
}

// ─── The matching board's engine (Part 2 Task 8) ────────────────────────────

/** Pairs a round for the board: `people` (who to seat), `avoid` (pairKeys already planned or met in the event). */
export type BoardRoundGenerator = ((people: string[], round: number, avoid: ReadonlySet<string>) => RoundAssignment) & {
  /**
   * Part 3 Task 5 (K5) — how well two people's answers to the event's matching questions suit each other (0..1), for the
   * board's redistribution to prefer among the people it may seat; absent for an event without questions.
   */
  affinity?: (a: string, b: string) => number;
};

/**
 * The engine as the matching board drives it, prepared once for an event: the same people rows, premium requests,
 * intent signals, matching policy, hard exclusions, group rules and template weights the plan made at Start reads,
 * then one round at a time through generateGroupedRound (an event without groups takes the engine's own round).
 * `avoid` is kept apart first; when that seats fewer people than the round can (the rule's capacity, or an even
 * count), the round is made again with repeats allowed and marked `usedRepeats`. Hard exclusions and group rules
 * are never relaxed. Reads only; writes nothing.
 */
export async function prepareBoardRoundGenerator(sessionId: string, userIds: string[]): Promise<BoardRoundGenerator> {
  const session = await sessionService.getSessionById(sessionId);
  const sessionConfig = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;
  const rows = userIds.length === 0 ? [] : (await query<MatchingParticipant>(
    `SELECT u.id AS "userId", u.interests, u.reasons_to_connect AS "reasonsToConnect",
            u.industry, u.company, u.languages, u.timezone,
            '{}'::jsonb AS attributes,
            COALESCE(u.is_premium, FALSE) AS "isPremium"
       FROM users u
      WHERE u.id = ANY($1::uuid[])`,
    [userIds],
  )).rows;
  const requests = await loadMatchRequestsForEvent(sessionId, rows.map((p) => p.userId));
  for (const p of rows) p.requestedUserIds = requests.get(p.userId) || [];
  await attachIntentSignals(rows, sessionId);

  const matchingPolicy = resolveMatchingPolicy(sessionConfig);
  const encounterHistory = await getEncounterHistoryForUsers(rows.map((p) => p.userId), { sessionId, matchingPolicy });
  // Meetings in earlier events that the policy forbids repeating, as generateSingleRound keeps them apart.
  const earlierEvents = new Set<string>();
  for (const e of encounterHistory) {
    if (matchingPolicy === 'platform_wide'
      || (matchingPolicy === 'cooldown' && withinCooldown(e.lastMetAt, Number(sessionConfig?.cooldownMonths) || 12))) {
      earlierEvents.add(pairKey(e.userAId, e.userBId));
    }
  }
  const exclusions = await loadHardExclusions(sessionId, rows.map((p) => p.userId));
  const groupRules = await loadGroupRules(sessionId);
  const { weights } = await templateWeightsFor(session, sessionConfig);
  // Part 3 Task 5 (K5) — the event's matching questions; none for an event without them (config unchanged).
  const eventQuestions = await loadQuestionSignals(sessionId, rows.map((p) => p.userId));
  const config: MatchingConfig = {
    weights,
    hardConstraints: hardConstraintsOf(exclusions),
    numberOfRounds: sessionConfig.numberOfRounds || 5,
    avoidDuplicates: true,
    globalOptimize: false,
    ...(groupRules && { groupRules }),
    ...(eventQuestions && { eventQuestions }),
  };
  const engine = getMatchingEngine(sessionConfig.matchingAlgorithmId || DEFAULT_ENGINE_ID);
  const byId = new Map(rows.map((p) => [p.userId, p]));
  const seatedBy = (round: RoundAssignment) => round.pairs.reduce((n, p) => n + roomMembers(p).length, 0);

  const generator: BoardRoundGenerator = (people, round, avoid) => {
    const participants = people.map((id) => byId.get(id)).filter((p): p is MatchingParticipant => !!p);
    const evenCount = participants.length - (participants.length % 2);
    const target = groupRules
      ? groupedPlacementTarget(groupRules, participants, round, config.numberOfRounds, evenCount)
      : evenCount;
    const withinEvent = matchingPolicy === 'none' ? [] : [...avoid];
    const strict = generateGroupedRound({
      participants, config, excludedPairs: new Set([...withinEvent, ...earlierEvents]), encounterHistory, round, engine,
    });
    if (seatedBy(strict) >= target || withinEvent.length === 0) return strict;
    const relaxed = generateGroupedRound({
      participants, config, excludedPairs: new Set(earlierEvents), encounterHistory, round, engine,
    });
    return seatedBy(relaxed) > seatedBy(strict) ? { ...relaxed, usedRepeats: true } : strict;
  };
  if (eventQuestions) {
    const { questions, answersByUser } = eventQuestions;
    generator.affinity = (a, b) => questionAffinity(answersByUser[a], answersByUser[b], questions);
  }
  return generator;
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
      // June-14 (Ali bonus-round test) — count only rounds that have actually
      // been PLAYED (completed/active), NOT pre-planned future rounds. The pre-
      // plan (generateSessionSchedule, run at Start) inserts every future round as
      // status='scheduled'; the old `status NOT IN ('cancelled','no_show')` swept
      // those in, so the live no-repeat set already contained pairings the people
      // hadn't met yet. For a small pool the pre-plan covers ALL possible pairings,
      // so EVERY live round found zero fresh candidates → the fallback ladder was
      // forced to L4 and the first "Match People" surfaced a repeat ("Met 1×")
      // while fresh pairs were still available (they only appeared on Re-match).
      // The preview met-count (matching-flow) already scoped to prior rounds only —
      // which is why the label read correctly while the engine was repeating.
      `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches
       WHERE session_id = $1 AND round_number != $2
         AND status IN ('completed', 'active')
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
  } else if (matchingPolicy === 'cooldown') {
    // Phase 2 — hard-exclude only pairs that met within the cooldown window;
    // older pairs remain in encounterHistory so the engine's freshness penalty
    // still deprioritises them, but they CAN be re-paired after the window.
    const months = Number(sessionConfig?.cooldownMonths) || 12;
    for (const e of encounterHistory) {
      if (withinCooldown(e.lastMetAt, months)) {
        excludedPairs.add(pairKey(e.userAId, e.userBId));
      }
    }
  }

  // 23 May (#5b) — Re-match rotation. excludePairKeys carries the CURRENT
  // preview arrangement; Re-match must always produce a DIFFERENT one. These are
  // applied as a HARD exclusion at EVERY fallback level below (unlike the
  // no-repeat history, which the ladder relaxes), so the engine can never
  // reproduce the current arrangement: it rotates to a fresh pairing while fresh
  // options exist, then to a different already-met pairing once they're gone.

  // Build hard constraints: inviter-invitee avoidance + user-block exclusions.
  // Phase B (1 May 2026 spec) — blocked pairs (in either direction) never meet; the same blocks gate DM sends.
  // P3-2: non-dismissed violation reports between two participants are folded in with the blocks (same
  // hard-exclusion path, so they flow into both the engine constraint and the swap guard below). Part 2 Task 5
  // (10 Nov 2026): loaded by hard-exclusions.ts, the one loader the room checker's context also reads, with the
  // same reads in the same order and the same failure behaviour as before.
  const participantIds = participantsResult.rows.map(p => p.userId);
  const exclusions = await loadHardExclusions(sessionId, participantIds);
  const { inviterInvitee: inviterInviteePairs, blocked: blockedPairs } = exclusions;
  const hardConstraints = hardConstraintsOf(exclusions);

  // Part 2 Task 7 — the event's groups and round rules: hard constraints the ladder below never relaxes. None for
  // an event without groups, whose config and every engine call stay exactly as before.
  const groupRules = await loadGroupRules(sessionId);

  const { weights, templateId: effectiveTemplateId } = await templateWeightsFor(session, sessionConfig);

  const config: MatchingConfig = {
    weights,
    hardConstraints,
    numberOfRounds: sessionConfig.numberOfRounds,
    avoidDuplicates: true,
    globalOptimize: false,
    ...(groupRules && { groupRules }),
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
  // Onboarding-intent enhancement — designation / wantsToMeet / avoid + per-event intent.
  await attachIntentSignals(participantsResult.rows, sessionId);
  // Part 3 Task 5 (K5) — the event's extra matching questions: a soft preference inside the pair score, which every
  // level of the ladder below keeps (the ladder relaxes repeats only). None for an event without questions (one read,
  // config unchanged).
  const eventQuestions = await loadQuestionSignals(sessionId, participantsResult.rows.map((p) => p.userId));
  if (eventQuestions) config.eventQuestions = eventQuestions;

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
  // With groups, "complete" is as many people as the round's rule can seat (and the organiser's fallback): relaxing
  // repeats cannot seat the people a group rule leaves waiting, so it must not be tried for them.
  const placementTarget = groupRules
    ? groupedPlacementTarget(groupRules, participantsResult.rows, roundNumber, config.numberOfRounds, eligibleEvenCount)
    : eligibleEvenCount;
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

    round = groupRules
      ? generateGroupedRound({
        participants: participantsResult.rows, config: levelConfig, excludedPairs: levelExcluded, encounterHistory,
        round: roundNumber, regenerate: options?.regenerate === true, engine,
      })
      : engine.generateRound(
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
    if (matchedIds.size >= placementTarget) break;

    if (level === 4) {
      logger.warn(
        { sessionId, roundNumber, level, matched: matchedIds.size, eligibleEvenCount },
        'Fallback ladder exhausted at L4 — accepting incomplete matching',
      );
    }
  }

  // #6 (June-10 debrief) — when the ladder had to reuse already-met pairs,
  // minimize them so the first "Match People" of a bonus round shows fresh pairs
  // whenever fresh pairs exist (TESTEVENT R5 produced 2 repeats where 1 was
  // forced). Bounded 2-opt; runs ONLY when repeats were needed (landedAtLevel>0),
  // so the all-fresh L0 path is untouched. Respects the landed level's hard
  // exclusions plus the never-relax current-preview keys, and can only reduce
  // repeats (never increase them, never drop a participant). Tagging below then
  // recomputes repeatInEvent / usedRepeats on the final pairing.
  if (landedAtLevel > 0 && round) {
    // The already-met pairs (excludedPairs / its relaxed halves) are exactly what
    // we MINIMIZE — they must NOT block a swap. (Earlier this passed the level's
    // half-excluded set as "hard", which at L3 blocked the very repeat-reducing
    // swap we want — pairing the two "met-everyone" people together — leaving an
    // avoidable repeat ~40% of the time.) The only pairs that may never be created
    // are genuine hard constraints — user blocks and inviter↔invitee avoidance —
    // plus, on Re-match, the current arrangement we must rotate away from.
    const neverPair = new Set<string>();
    for (const s of [...blockedPairs, ...inviterInviteePairs]) {
      const [a, b] = s.split(':');
      if (a && b) neverPair.add(pairKey(a, b));
    }
    if (options?.excludePairKeys?.length) {
      for (const k of options.excludePairKeys) neverPair.add(k);
    }
    // With groups, a swap may only make pairs the round's rule (or the organiser's fallback) allows.
    const groupMayMeet = groupRules ? groupedMayMeet(groupRules, config, roundNumber) : undefined;
    reduceRepeatPairs(round.pairs, excludedPairs, neverPair, groupMayMeet);
    if (groupRules) tagFallbackPairs(round.pairs, groupGate(config, roundNumber));
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
      // A pair seated by the organiser's same-group fallback keeps saying so.
      if (pair.reasonTags.includes(SAME_GROUP_FALLBACK)) continue;
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

  // Persist this round's matches (store the resolved template id, if any).
  await persistMatches(sessionId, [round], effectiveTemplateId || null);

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
            departed_user_ids AS "departedUserIds",
            room_id AS "roomId", status, score, reason_tags AS "reasonTags",
            is_manual AS "isManual", locked,
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
            departed_user_ids AS "departedUserIds",
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
  // S14 — recordDeparted=false for NO-SHOW demotions: the absentee never met
  // the room, so they must stay OUT of departed_user_ids (which drives both
  // the survivors' rating lists and the late-return rating replay).
  options: { recordDeparted?: boolean } = {},
): Promise<{ remainingUserIds: string[]; matchStillActive: boolean }> {
  const recordDeparted = options.recordDeparted !== false;
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
      // WS2 (27 May remaining work) — record the departed id so round-end
      // rating emission can still have the survivors rate them (the slot
      // re-canonicalisation below erases them from the row otherwise).
      // departed_user_ids is RATING-ONLY: matching/presence never read it.
      const sorted = [...remaining].sort();
      const newA = sorted[0];
      const newB = sorted[1];
      const newC = sorted[2] || null; // 4-person rooms not supported, but safe
      await client.query(
        `UPDATE matches SET participant_a_id = $1, participant_b_id = $2, participant_c_id = $3,
                departed_user_ids = CASE WHEN $6::boolean
                  THEN array_append(departed_user_ids, $5::uuid)
                  ELSE departed_user_ids END
         WHERE id = $4`,
        [newA, newB, newC, matchId, userId, recordDeparted],
      );
      return { remainingUserIds: remaining, matchStillActive: true };
    }

    // 1 or 0 remain — terminal. The departed append still happens so a
    // 3→2→1 double-leave preserves BOTH departed ids on the terminal row —
    // the lone survivor's early-end rating form covers both of them.
    await client.query(
      `UPDATE matches SET status = $2, ended_at = NOW(),
              departed_user_ids = CASE WHEN $4::boolean
                THEN array_append(departed_user_ids, $3::uuid)
                ELSE departed_user_ids END
       WHERE id = $1 AND status = 'active'`,
      [matchId, terminalStatusIfRoomEmpties, userId, recordDeparted],
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
      || sessionConfig?.matchingPolicy === 'none'
      || sessionConfig?.matchingPolicy === 'cooldown') {
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
         AND NOT r.excluded_from_quality_stats
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

  // Part 2 Task 9 (10 Nov 2026, Key decision D4) — an event with a published schedule repairs through the matching
  // board instead: the draft is edited (locked meetings kept), an automatic version is published, and only the rooms
  // that changed are rewritten. Loaded when used: the schedule services load this module (the board drives the engine).
  const scheduleLive = await import('../schedule/schedule-live.service');
  if (await scheduleLive.hasPublishedSchedule(sessionId)) {
    const { getAllHostIds } = await import('../session/host-set');
    return scheduleLive.repairPublishedFromLive(
      sessionId, fromRoundNumber, reason, await getAllHostIds(sessionId, session.hostUserId), presentUserIds,
    );
  }

  // Wipe all 'scheduled' matches for fromRound and beyond. Active/completed
  // rounds are immutable per spec §9 and are NOT touched. Part 2 Task 9 — nor is a
  // meeting locked on the matching board (none exists without a published schedule).
  await query(
    `DELETE FROM matches
       WHERE session_id = $1 AND round_number >= $2 AND status = 'scheduled' AND locked = FALSE`,
    [sessionId, fromRoundNumber],
  );

  // Regenerate each future round in order. Each call's excludedPairs picks
  // up the previously-completed rounds AND any rounds already regenerated
  // in this loop (so cross-round no-repeat is preserved).
  // Host set = director + formally-assigned cohosts + super_admins. MUST stay
  // in lockstep with getAllHostIds() in orchestration/handlers/host-actions.ts;
  // it can't be imported here because host-actions imports this module, which
  // would create a require cycle in the hot matching path. Two divergences fixed
  // in the 10-Jun audit: (1) super_admins were never queried, so a repair re-made
  // Stefan matchable and could pair him into a breakout — the 9-Jun policy says a
  // super_admin is ALWAYS a host; (2) the opt-in/opt-out host overrides were
  // dropped — the self-select picker was removed 23 May, so the set is
  // role-derived only and those overrides must not reappear.
  const hostIdSet = new Set<string>();
  if (session.hostUserId) hostIdSet.add(session.hostUserId);
  try {
    const cohostsRes = await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
      [sessionId],
    );
    for (const r of cohostsRes.rows) hostIdSet.add(r.user_id);
    const superAdminRes = await query<{ user_id: string }>(
      `SELECT sp.user_id FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
        WHERE sp.session_id = $1 AND u.role = 'super_admin'`,
      [sessionId],
    );
    for (const r of superAdminRes.rows) hostIdSet.add(r.user_id);
  } catch (err) {
    logger.warn({ err, sessionId }, 'repairFutureRounds — failed to fetch host exclusions');
  }
  const allHostIds = Array.from(hostIdSet);

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

  if (regeneratedRounds.length > 0 || errors.length > 0) {
    void recordEventAudit({
      sessionId, actorId: null, action: 'match.repaired', automatic: true, round: fromRoundNumber, reason,
      after: { regeneratedRounds, failedRounds: errors.map((e) => e.roundNumber) },
    });
  }

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

async function persistMatches(
  sessionId: string,
  rounds: RoundAssignment[],
  templateId: string | null = null,
): Promise<void> {
  await transaction(async (client) => {
    for (const round of rounds) {
      // Delete any existing scheduled matches for this round before inserting new ones
      // (handles rematch/regeneration — cancelled/scheduled rows still hold unique constraint).
      // Part 2 Task 9 — a meeting locked on the matching board stays: Re-match leaves its people
      // out of the engine and keeps their room (no row is locked without a published schedule).
      await client.query(
        `DELETE FROM matches
         WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled') AND locked = FALSE`,
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

        const fallbackLevel = round.fallbackLevel || 0;
        for (const pair of round.pairs) {
          const pA = pair.participantAId < pair.participantBId ? pair.participantAId : pair.participantBId;
          const pB = pair.participantAId < pair.participantBId ? pair.participantBId : pair.participantAId;
          placeholders.push(
            `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, 'scheduled', $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, $${paramIdx + 10}, $${paramIdx + 11}, $${paramIdx + 12})`,
          );
          values.push(
            sessionId, round.roundNumber, pA, pB, pair.participantCId || null,
            pair.score, pair.reasonTags,
            pair.matchReason || null,
            pair.fallbackUsed === true,
            pair.repeatInEvent === true,
            pair.premiumInfluenced === true,
            templateId,
            pairConfidence(pair.score, fallbackLevel),
          );
          paramIdx += 13;
        }

        await client.query(
          `INSERT INTO matches
             (session_id, round_number, participant_a_id, participant_b_id, participant_c_id,
              score, reason_tags, status,
              match_reason, fallback_used, repeat_in_event, premium_influenced,
              matching_template_id, confidence)
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
