// ─── Agent matching (Wave 2 core, 3 Aug 2026) ────────────────────────────────
//
// Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
//
// Scores one agent's want-text against everyone eligible and STORES the result.
// Platform matching has always scored in JS per request and discarded it, which
// is why a per-agent count could never be drawn. Everything the dashboard shows
// reads what this writes.
//
// Exclusions are deliberately per-agent (decision D3). Encounters and blocks are
// facts about two people and stay global; an introduction is about one REASON,
// so asking to meet someone through the Developer agent must not blank them
// from Investor, where they may fit for something else entirely.

import { query } from '../../db';
import logger from '../../config/logger';
import * as agentRepo from './agent.repo';
import { scoreWants, MATCH_THRESHOLD, IntentProfile } from './platform-match.service';

const CANDIDATE_COLUMNS = `
  u.id, u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
  u.professional_role AS "professionalRole", u.job_title AS "jobTitle",
  u.company, u.expertise_text AS "expertiseText",
  u.what_i_can_help_with AS "whatICanHelpWith",
  u.what_i_care_about AS "whatICareAbout",
  u.goals, u.interests, u.my_intent AS "myIntent",
  u.who_i_want_to_meet AS "whoIWantToMeet",
  u.why_i_want_to_meet AS "whyIWantToMeet"`;

/**
 * Who this agent may surface. Global exclusions (already met, blocked either
 * way) plus the per-agent one: an introduction already sent FROM THIS AGENT.
 * A poke sent from a different agent, or from a profile, leaves the person
 * available here — that is decision D3.
 */
async function loadCandidatesForAgent(agentId: string, ownerId: string): Promise<IntentProfile[]> {
  const r = await query<IntentProfile>(
    `SELECT ${CANDIDATE_COLUMNS}
       FROM users u
      WHERE u.id <> $1
        AND u.status = 'active'
        AND u.onboarding_completed = true
        AND NOT EXISTS (
          SELECT 1 FROM encounter_history e
           WHERE e.user_a_id = LEAST($1, u.id) AND e.user_b_id = GREATEST($1, u.id))
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1))
        AND NOT EXISTS (
          SELECT 1 FROM user_pokes p
           WHERE p.agent_id = $2
             AND ((p.sender_id = $1 AND p.recipient_id = u.id)
               OR (p.sender_id = u.id AND p.recipient_id = $1)))`,
    [ownerId, agentId],
  );
  return r.rows;
}

/**
 * Rescore one agent and persist the outcome. Never throws: this runs from
 * fire-and-forget paths (a member finishing onboarding, an agent being edited)
 * where a scoring hiccup must not break the request that triggered it.
 */
export async function recomputeAgent(agent: {
  id: string; userId: string; wantText: string; label: string;
}): Promise<number> {
  try {
    if (!agent.wantText.trim()) {
      await agentRepo.replaceMatches(agent.id, []);
      return 0;
    }
    const candidates = await loadCandidatesForAgent(agent.id, agent.userId);
    const scored = candidates
      .map(c => ({ c, fit: scoreWants([agent.wantText], c) }))
      .filter(x => x.fit.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.fit.score - a.fit.score)
      .slice(0, 50)
      .map(x => ({
        candidateUserId: x.c.id,
        score: Number(x.fit.score.toFixed(4)),
        reason: x.fit.reason,
      }));

    await agentRepo.replaceMatches(agent.id, scored);
    logger.info({ agentId: agent.id, matches: scored.length }, 'Agent rescored');
    return scored.length;
  } catch (err) {
    logger.warn({ err, agentId: agent.id }, 'Agent rescore failed (non-fatal)');
    return 0;
  }
}

/** Rescore every agent belonging to one member. */
export async function recomputeAgentsForUser(userId: string): Promise<void> {
  const agents = await agentRepo.listAgents(userId).catch(() => []);
  for (const a of agents) {
    if (a.status !== 'active') continue;
    await recomputeAgent(a);
  }
}

/**
 * A new member finished onboarding, so every OTHER member's active agents may
 * now have a new candidate. Rather than re-scoring the whole network, score the
 * newcomer against each active agent's want-text and add the hits.
 *
 * Returns the agents that gained the newcomer, so the caller can notify each
 * owner with the reason that particular agent was searching for.
 */
export async function scoreNewcomerAgainstAgents(
  newUserId: string,
): Promise<Array<{ agentId: string; ownerId: string; label: string; score: number; reason: string }>> {
  const gained: Array<{ agentId: string; ownerId: string; label: string; score: number; reason: string }> = [];
  try {
    const newcomer = await query<IntentProfile>(
      `SELECT ${CANDIDATE_COLUMNS} FROM users u WHERE u.id = $1 AND u.status = 'active'`,
      [newUserId],
    );
    const profile = newcomer.rows[0];
    if (!profile) return gained;

    const agents = await agentRepo.listActiveAgentsForMatching();
    for (const a of agents) {
      if (a.userId === newUserId) continue;
      if (!a.wantText.trim()) continue;
      const fit = scoreWants([a.wantText], profile);
      if (fit.score < MATCH_THRESHOLD) continue;

      // Respect the same exclusions a full rescore would apply.
      const blocked = await query<{ ok: boolean }>(
        `SELECT TRUE AS ok
           FROM users u
          WHERE u.id = $2
            AND NOT EXISTS (
              SELECT 1 FROM encounter_history e
               WHERE e.user_a_id = LEAST($1, $2) AND e.user_b_id = GREATEST($1, $2))
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
                  OR (b.blocker_id = $2 AND b.blocked_id = $1))`,
        [a.userId, newUserId],
      );
      if (blocked.rows.length === 0) continue;

      await query(
        `INSERT INTO agent_matches (agent_id, candidate_user_id, score, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id, candidate_user_id) DO UPDATE
           SET score = EXCLUDED.score, reason = EXCLUDED.reason, computed_at = NOW()`,
        [a.id, newUserId, Number(fit.score.toFixed(4)), fit.reason],
      );
      gained.push({
        agentId: a.id, ownerId: a.userId, label: a.label,
        score: fit.score, reason: fit.reason,
      });
    }
  } catch (err) {
    logger.warn({ err, newUserId }, 'Newcomer agent fan-out failed (non-fatal)');
  }
  return gained;
}
