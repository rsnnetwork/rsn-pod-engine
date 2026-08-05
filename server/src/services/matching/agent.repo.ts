// ─── Matching Agents repository (Wave 2 core, 3 Aug 2026) ────────────────────
//
// Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
//
// A member has MANY agents — matching_agents.user_id is deliberately not
// unique, unlike user_intent_profiles whose PRIMARY KEY is user_id. That table
// keeps being "who I am" (the offer side, genuinely one per person); an agent
// is one active reason to meet people, and a person can hold several at once.
//
// Matches are STORED (agent_matches). Platform matching has always scored in
// JS per request and thrown the result away, which is precisely why a count
// like "Developer: 3 matches" could not be rendered. Every count here reads the
// stored table; nothing re-scores the network to draw a number.

import { query } from '../../db';

export type AgentStatus = 'active' | 'paused' | 'archived';

export interface MatchingAgent {
  id: string;
  userId: string;
  label: string;
  wantText: string;
  matchingTags: string[];
  status: AgentStatus;
  lastMatchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** From agent_matches — the number the dashboard shows. */
  matchCount: number;
}

export interface AgentMatchInput {
  candidateUserId: string;
  score: number;
  reason: string;
}

interface AgentRow {
  id: string; user_id: string; label: string; want_text: string;
  matching_tags: string[] | null; status: AgentStatus;
  last_matched_at: Date | null; created_at: Date; updated_at: Date;
  match_count?: number | string | null;
}

function mapAgent(r: AgentRow): MatchingAgent {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    wantText: r.want_text ?? '',
    matchingTags: Array.isArray(r.matching_tags) ? r.matching_tags : [],
    status: r.status,
    lastMatchedAt: r.last_matched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    matchCount: Number(r.match_count ?? 0),
  };
}

const SELECT_WITH_COUNT = `
  SELECT a.id, a.user_id, a.label, a.want_text, a.matching_tags, a.status,
         a.last_matched_at, a.created_at, a.updated_at,
         (SELECT COUNT(*) FROM agent_matches m WHERE m.agent_id = a.id) AS match_count
  FROM matching_agents a`;

/**
 * A member's agents for the dashboard, oldest first. Archived are hidden unless
 * asked for: archiving is reversible ("archive it once the need is solved" is
 * not "delete it"), so the dashboard needs a way to list them and bring one
 * back. Without this the UI had no screen that could reach an archived agent.
 */
export async function listAgents(
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<MatchingAgent[]> {
  const r = await query<AgentRow>(
    `${SELECT_WITH_COUNT}
     WHERE a.user_id = $1 ${opts.includeArchived ? '' : `AND a.status <> 'archived'`}
     ORDER BY a.created_at ASC`,
    [userId],
  );
  return r.rows.map(mapAgent);
}

export async function getAgent(agentId: string, userId: string): Promise<MatchingAgent | null> {
  const r = await query<AgentRow>(
    `${SELECT_WITH_COUNT} WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  );
  return r.rows[0] ? mapAgent(r.rows[0]) : null;
}

export async function createAgent(
  userId: string,
  input: { label: string; wantText: string; matchingTags?: string[] },
): Promise<MatchingAgent> {
  const r = await query<AgentRow>(
    `INSERT INTO matching_agents (user_id, label, want_text, matching_tags)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, label, want_text, matching_tags, status,
               last_matched_at, created_at, updated_at, 0 AS match_count`,
    [userId, input.label.trim(), input.wantText.trim(), input.matchingTags ?? []],
  );
  return mapAgent(r.rows[0]);
}

/** Ownership is enforced in the WHERE clause, never assumed by the caller. */
export async function updateAgent(
  agentId: string,
  userId: string,
  input: { label?: string; wantText?: string },
): Promise<MatchingAgent | null> {
  const r = await query<AgentRow>(
    `UPDATE matching_agents
        SET label = COALESCE($3, label),
            want_text = COALESCE($4, want_text),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, label, want_text, matching_tags, status,
                last_matched_at, created_at, updated_at,
                (SELECT COUNT(*) FROM agent_matches m WHERE m.agent_id = matching_agents.id) AS match_count`,
    [agentId, userId, input.label?.trim() ?? null, input.wantText?.trim() ?? null],
  );
  return r.rows[0] ? mapAgent(r.rows[0]) : null;
}

/** Pause, resume or archive. Archiving stamps archived_at — never a hard delete. */
export async function setStatus(
  agentId: string,
  userId: string,
  status: AgentStatus,
): Promise<MatchingAgent | null> {
  const r = await query<AgentRow>(
    `UPDATE matching_agents
        SET status = $3,
            archived_at = CASE WHEN $3 = 'archived' THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, label, want_text, matching_tags, status,
                last_matched_at, created_at, updated_at,
                (SELECT COUNT(*) FROM agent_matches m WHERE m.agent_id = matching_agents.id) AS match_count`,
    [agentId, userId, status],
  );
  return r.rows[0] ? mapAgent(r.rows[0]) : null;
}

/**
 * Swap in a freshly scored set for one agent. Always deletes first: an agent
 * whose matches all became stale must fall to zero rather than keep showing a
 * count nobody can explain.
 */
export async function replaceMatches(agentId: string, matches: AgentMatchInput[]): Promise<void> {
  await query(`DELETE FROM agent_matches WHERE agent_id = $1`, [agentId]);
  if (matches.length > 0) {
    const values: string[] = [];
    const params: unknown[] = [agentId];
    matches.forEach((m, i) => {
      const base = i * 3 + 2;
      values.push(`($1, $${base}, $${base + 1}, $${base + 2})`);
      params.push(m.candidateUserId, m.score, m.reason);
    });
    await query(
      `INSERT INTO agent_matches (agent_id, candidate_user_id, score, reason)
       VALUES ${values.join(', ')}
       ON CONFLICT (agent_id, candidate_user_id) DO UPDATE
         SET score = EXCLUDED.score, reason = EXCLUDED.reason, computed_at = NOW()`,
      params,
    );
  }
  await query(`UPDATE matching_agents SET last_matched_at = NOW() WHERE id = $1`, [agentId]);
}

export interface StoredAgentMatch {
  candidateUserId: string;
  score: number;
  reason: string;
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: unknown;
  jobTitle: string | null;
  company: string | null;
}

/** The people one agent found, best first — the agent detail screen. */
export async function listMatches(agentId: string, limit = 25): Promise<StoredAgentMatch[]> {
  const r = await query<StoredAgentMatch>(
    `SELECT m.candidate_user_id AS "candidateUserId", m.score, m.reason,
            u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
            u.professional_role AS "professionalRole", u.job_title AS "jobTitle",
            u.company
       FROM agent_matches m
       JOIN users u ON u.id = m.candidate_user_id
      WHERE m.agent_id = $1 AND u.status = 'active'
      ORDER BY m.score DESC
      LIMIT $2`,
    [agentId, limit],
  );
  return r.rows.map(row => ({ ...row, score: Number(row.score) }));
}

/** Every agent the continuous matcher should consider. Active only. */
export async function listActiveAgentsForMatching(): Promise<MatchingAgent[]> {
  const r = await query<AgentRow>(
    `SELECT a.id, a.user_id, a.label, a.want_text, a.matching_tags, a.status,
            a.last_matched_at, a.created_at, a.updated_at, 0 AS match_count
       FROM matching_agents a
       JOIN users u ON u.id = a.user_id
      WHERE a.status = 'active' AND u.status = 'active'`,
  );
  return r.rows.map(mapAgent);
}

/** Drop one candidate from one agent's results (per-agent exclusion, D3). */
export async function removeMatch(agentId: string, candidateUserId: string): Promise<void> {
  await query(
    `DELETE FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`,
    [agentId, candidateUserId],
  );
}
