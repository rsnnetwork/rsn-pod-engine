// ─── The member's first matching agents (13 Aug 2026) ───────────────────────
//
// A member finishes the onboarding chat having described exactly who they want
// to meet, and then lands on an empty Suggestions page. Migration 087 seeded
// agents for members who already existed; nothing ever created one for someone
// new. This closes that gap at the moment the intent is captured.
//
// It follows 087's convention so new and old members look the same on the
// Suggestions page: one agent per designation the member named, a single
// "People I want to meet" agent when they named none, and never a duplicate
// of an agent the member already has — a member routed back through
// onboarding (migration 083) keeps what 087 gave them.

import * as agentRepo from './agent.repo';
import { recomputeAgent } from './agent-matching.service';
import { designationsWanted, ROLE_TAXONOMY } from './intent-signals';
import logger from '../../config/logger';
import type { MatchingAgent } from './agent.repo';

export const GENERIC_LABEL = 'People I want to meet';

// A sentence naming every role under the sun is not a plan; four standing
// searches is already more than anyone reads on their first visit.
const MAX_FIRST_AGENTS = 4;

/** Title-case a taxonomy label: "developers and engineers" → "Developers and engineers". */
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface FirstAgentSource {
  /** Who they want to meet, in their own words (desiredPeople + desiredRoles). */
  whoText: string | null | undefined;
  /** Why they came — the fallback when they never said who. */
  whyText: string | null | undefined;
}

export interface FirstAgentPlan {
  label: string;
  wantText: string;
}

/**
 * The designations a sentence asks for, in the order the member said them —
 * not taxonomy order, which would rank "founders" above the "business owners"
 * they mentioned first, and the cap below would then drop the wrong one.
 */
function wantedInOrderSaid(text: string): Array<{ key: string; label: string }> {
  const t = text.toLowerCase();
  return designationsWanted(text)
    .map(w => {
      const bucket = ROLE_TAXONOMY.find(b => b.key === w.key);
      const m = bucket ? (bucket.wants ?? bucket.is).exec(t) : null;
      return { ...w, at: m ? m.index : Number.MAX_SAFE_INTEGER };
    })
    .sort((a, b) => a.at - b.at)
    .map(({ key, label }) => ({ key, label }));
}

/**
 * Pure: what agents these answers describe, given the labels the member
 * already holds. Shared by the completion path and the one-off backfill so a
 * dry run shows exactly what the real run would make.
 */
export function planFirstAgents(source: FirstAgentSource, existingLabels: string[]): FirstAgentPlan[] {
  const who = (source.whoText || '').trim();
  const why = (source.whyText || '').trim();

  // The SAME taxonomy the matcher searches with names the agents — a label
  // that disagrees with the search is how "Marketing people" once ended up
  // on a search for executives.
  let text = who;
  let wanted = who ? wantedInOrderSaid(who) : [];
  if (!who) {
    // Nothing about WHO: fall back to why they came, but only when it names a
    // kind of person. A why that is really a self-description ("I am an
    // entrepreneur and builder") would make an agent hunt for people like the
    // member — the blob mistake migration 087 undid. No agent beats a wrong one.
    wanted = why ? wantedInOrderSaid(why) : [];
    if (!wanted.length) return [];
    text = why;
  }

  const held = new Set(existingLabels.map(l => l.trim().toLowerCase()));
  const plans: FirstAgentPlan[] = [];
  if (wanted.length === 1) {
    // One kind of person: keep the member's sentence as the search, so the
    // nuance ("react developers") still counts when scoring.
    plans.push({ label: title(wanted[0].label), wantText: text });
  } else if (wanted.length > 1) {
    // Several kinds: one agent each, searching for that designation alone,
    // so a stray word cannot pull the Founders agent toward investors.
    for (const w of wanted.slice(0, MAX_FIRST_AGENTS)) {
      plans.push({ label: title(w.label), wantText: w.label });
    }
  } else if (existingLabels.length === 0) {
    // Their own words, no known role in them — one agent carrying the
    // sentence verbatim. Only for a member with nothing yet: a member who
    // already holds agents does not need a vaguer one added on top.
    plans.push({ label: GENERIC_LABEL, wantText: text });
  }

  return plans.filter(p => !held.has(p.label.toLowerCase()));
}

/**
 * Build the agents a member's onboarding answers describe, and search each one
 * now. Returns the agents created — possibly none, when the member said nothing
 * searchable or already holds every agent their answers would produce.
 *
 * Never throws: this runs on the completion path, and a failure here must not
 * cost the member the onboarding they just finished.
 */
export async function createFirstAgents(
  userId: string,
  source: FirstAgentSource,
): Promise<MatchingAgent[]> {
  try {
    const existing = await agentRepo.listAgents(userId, { includeArchived: true });
    const plans = planFirstAgents(source, existing.map(a => a.label));

    const made: MatchingAgent[] = [];
    for (const plan of plans) {
      const agent = await agentRepo.createAgent(userId, plan);
      made.push(agent);

      // Score it now. Inserting a row runs no search — that is exactly why the
      // 087-seeded agents all read "0 potential matches" on 3 Aug.
      await recomputeAgent(agent).catch(err =>
        logger.warn({ err, agentId: agent.id }, 'first agent will be scored on next open'));
    }

    if (made.length) {
      logger.info({ userId, labels: made.map(a => a.label) }, 'First agents created from onboarding');
    }
    return made;
  } catch (err) {
    logger.error({ err, userId }, 'could not create first agents');
    return [];
  }
}
