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
import { scoreWants, MATCH_THRESHOLD, IntentProfile, displayRole } from './platform-match.service';

/**
 * Candidates the owner has a live introduction with (asked, or been asked by,
 * not declined). replaceMatches keeps these rows whatever the score, so their
 * stored reason must be refreshed here or it goes stale: on 3 Sep 2026 Stefan
 * stopped being a "developer" in the data and his card on Ali's Developers
 * agent kept saying he was one, because he no longer scored and the upsert
 * never touched his row.
 */
async function stickyCandidateIds(ownerId: string, candidateIds: string[]): Promise<Set<string>> {
  if (!candidateIds.length) return new Set();
  const r = await query<{ id: string }>(
    `SELECT DISTINCT CASE WHEN p.sender_id = $1 THEN p.recipient_id ELSE p.sender_id END AS id
       FROM user_pokes p
      WHERE p.status <> 'declined'
        AND (p.sender_id = $1 OR p.recipient_id = $1)`,
    [ownerId],
  );
  const wanted = new Set(candidateIds);
  return new Set(r.rows.map((x) => x.id).filter((id) => wanted.has(id)));
}

/** A reason for a kept row that no longer fits: say who they are, plainly. */
function keptReason(c: IntentProfile): string {
  const name = c.displayName || 'They';
  const role = displayRole(c);
  return role ? `${name} is a ${role}` : `You asked to meet ${name}`;
}

const CANDIDATE_COLUMNS = `
  u.id, u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
  u.professional_role AS "professionalRole", u.job_title AS "jobTitle",
  u.job_title_source AS "jobTitleSource",
  u.company, u.expertise_text AS "expertiseText",
  u.what_i_can_help_with AS "whatICanHelpWith",
  u.what_i_care_about AS "whatICareAbout",
  u.goals, u.interests, u.my_intent AS "myIntent",
  u.who_i_want_to_meet AS "whoIWantToMeet",
  u.why_i_want_to_meet AS "whyIWantToMeet"`;

/**
 * Who this agent may surface. Global exclusions (already met, blocked either
 * way) plus a declined introduction — a decline is the one answer that means
 * "not this person", so it is honoured in both directions.
 *
 * Someone you have merely ASKED stays in the pool. Dropping them here (the
 * original decision D3) is what made a person disappear from the agent that
 * found them the moment you asked to meet them; they now stay put, badged with
 * where the introduction got to (see agent.repo listMatches), and are simply
 * not counted as still outstanding.
 */
async function loadCandidatesForAgent(ownerId: string): Promise<IntentProfile[]> {
  const r = await query<IntentProfile>(
    `SELECT ${CANDIDATE_COLUMNS}
       FROM users u
      WHERE u.id <> $1
        AND u.status = 'active'
        AND u.onboarding_completed = true
        -- "Already met" hides people you have genuinely met, at an event or
        -- otherwise. It must NOT hide someone you reached through this
        -- platform: accepting an introduction writes an encounter row (with
        -- times_met = 0), so a person vanished from the agent that found them
        -- the moment they said yes — the same disappearance as delete-on-ask,
        -- through a different door. An introduction between the two keeps them
        -- visible; they show under "Already asked", not as outstanding.
        AND (
          NOT EXISTS (
            SELECT 1 FROM encounter_history e
             WHERE e.user_a_id = LEAST($1, u.id) AND e.user_b_id = GREATEST($1, u.id))
          OR EXISTS (
            SELECT 1 FROM user_pokes ip
             WHERE ip.status <> 'declined'
               AND ((ip.sender_id = $1 AND ip.recipient_id = u.id)
                 OR (ip.sender_id = u.id AND ip.recipient_id = $1))))
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1))
        AND NOT EXISTS (
          SELECT 1 FROM user_pokes p
           WHERE p.status = 'declined'
             AND ((p.sender_id = $1 AND p.recipient_id = u.id)
               OR (p.sender_id = u.id AND p.recipient_id = $1)))`,
    [ownerId],
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
    const candidates = await loadCandidatesForAgent(agent.userId);
    const all = candidates.map(c => ({ c, fit: scoreWants([agent.wantText], c) }));
    const fresh = all
      .filter(x => x.fit.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.fit.score - a.fit.score)
      .slice(0, 50);

    // Kept rows (a live introduction) travel with a CURRENT reason, at their
    // real score, so the card never describes who someone used to be.
    const freshIds = new Set(fresh.map(x => x.c.id));
    const sticky = await stickyCandidateIds(agent.userId, candidates.map(c => c.id));
    const kept = all.filter(x => sticky.has(x.c.id) && !freshIds.has(x.c.id));

    const scored = [...fresh, ...kept].map(x => ({
      candidateUserId: x.c.id,
      score: Number(x.fit.score.toFixed(4)),
      reason: x.fit.reason || keptReason(x.c),
    }));

    await agentRepo.replaceMatches(agent.id, scored);
    logger.info({ agentId: agent.id, matches: fresh.length, kept: kept.length }, 'Agent rescored');
    return fresh.length;
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
