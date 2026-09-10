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
//
// 4 Sep 2026 (Ali): four agents searching at once was more than a first visit
// can read, and the spec only ever asked for a first agent. So ONE agent is
// active, the first kind of person the member named, and the others are
// created paused: drafts they can resume from the Suggestions page. The toast
// at the end of onboarding tells them both things.

import * as agentRepo from './agent.repo';
import { recomputeAgent } from './agent-matching.service';
import { designationsWanted, ROLE_TAXONOMY } from './intent-signals';
import { expandWantTags } from './want-synonyms';
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
  /**
   * Shared, NON-designation criteria — industries, stage, seniority, company
   * size — that apply across every agent the member's answers produce. 7 Sep
   * 2026 (Stefan): naming more than one kind of person collapsed each agent to a
   * bare designation label and dropped these. They ride onto every agent's
   * search text now (the scorer reads want_text), never onto the OTHER agents'
   * designation words, so precision is kept.
   */
  qualifiers?: string[];
  /** Structured want-side slice stored on each agent (designations + qualifiers)
   *  for analytics and later semantic matching. */
  tags?: string[];
}

export interface FirstAgentPlan {
  label: string;
  wantText: string;
  matchingTags: string[];
  /** The main agent searches now; every other one waits as a paused draft. */
  status: 'active' | 'paused';
}

/** Trim, drop empties, de-dupe case-insensitively, preserve order. */
function cleanList(xs?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of xs ?? []) {
    const v = (raw || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Append qualifier terms that are not already present in the base text. */
function withQualifiers(base: string, quals: string[]): string {
  const low = base.toLowerCase();
  const add = quals.filter(q => !low.includes(q.toLowerCase()));
  return add.length ? `${base}, ${add.join(', ')}` : base;
}

/**
 * The designations a sentence asks for, the kind of person named most often
 * first, ties in the order the member said them — not taxonomy order, which
 * would rank "founders" above the "business owners" they mentioned first, and
 * the cap below would then drop the wrong one.
 *
 * 7 Sep 2026 (Stefan): "…businesses with more than 20 employees, founders,
 * founder, owner, operator" names owners and founders three times and the
 * stray word once; what they repeat is what they mean.
 */
function wantedInOrderSaid(text: string): Array<{ key: string; label: string }> {
  const t = text.toLowerCase();
  return designationsWanted(text)
    .map(w => {
      const bucket = ROLE_TAXONOMY.find(b => b.key === w.key);
      const re = bucket ? (bucket.wants ?? bucket.is) : null;
      const first = re ? re.exec(t) : null;
      const mentions = re ? (t.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length : 0;
      return { ...w, at: first ? first.index : Number.MAX_SAFE_INTEGER, mentions };
    })
    .sort((a, b) => b.mentions - a.mentions || a.at - b.at)
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
  const quals = cleanList(source.qualifiers);
  const tags = cleanList(source.tags);

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
  let bases: Array<{ label: string; wantText: string }> = [];
  if (wanted.length === 1) {
    // One kind of person: keep the member's sentence as the search (its nuance
    // like "react developers" already counts) and add any qualifier not in it.
    // 10 Sep 2026 (Claus: the wish becomes visible in their words): a short,
    // specific phrase names the agent ("Country manager in Nairobi") instead of
    // the taxonomy bucket ("Managers and leads"); a long sentence keeps the bucket.
    // Only the WHO phrase names the agent; a "why" fallback sentence is a reason,
    // not a kind of person, so it keeps the bucket.
    const phrase = who ? text.split(',')[0].trim() : '';
    const words = phrase.split(/\s+/).filter(Boolean).length;
    const label = phrase && words <= 6 ? title(phrase) : title(wanted[0].label);
    bases = [{ label, wantText: withQualifiers(text, quals) }];
  } else if (wanted.length > 1) {
    // Several kinds: one agent each, searching for that designation PLUS the
    // shared qualifiers (industries/stage/seniority) — never the other agents'
    // designation words, so a stray designation cannot pull one toward another.
    bases = wanted.map(w => ({ label: title(w.label), wantText: withQualifiers(w.label, quals) }));
  } else if (existingLabels.length === 0) {
    // Their own words, no known role in them — one agent carrying the sentence
    // (plus qualifiers). Only for a member with nothing yet.
    bases = [{ label: GENERIC_LABEL, wantText: withQualifiers(text, quals) }];
  }

  // Remove labels the member already holds BEFORE capping — 7 Sep 2026: the cap
  // used to run first, so a held label consumed a slot and silently dropped a
  // genuinely-new want off the end. The first NEW agent searches; the rest are
  // drafts, in the order the member said them.
  return bases
    .filter(b => !held.has(b.label.toLowerCase()))
    .slice(0, MAX_FIRST_AGENTS)
    .map((b, i) => ({
      ...b,
      // W4: store the structured tags PLUS high-confidence synonyms (zero-cost,
      // no LLM) so the scorer — which reads matching_tags — matches related
      // meaning, not just the exact words. Only when there ARE structured tags;
      // a generic "People I want to meet" agent carries none, so it stays empty
      // rather than storing its own label as noise.
      matchingTags: tags.length ? expandWantTags([...tags, b.label]) : [],
      status: i === 0 ? 'active' as const : 'paused' as const,
    }));
}

/**
 * Build the agents a member's onboarding answers describe, and search the main
 * one now; drafts are scored when the member resumes them (the status route
 * rescores on activation). Returns the agents created — possibly none, when the
 * member said nothing searchable or already holds every agent their answers
 * would produce.
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
      if (plan.status !== 'active') continue;

      // Score the main agent now. Inserting a row runs no search — that is
      // exactly why the 087-seeded agents all read "0 potential matches" on 3 Aug.
      await recomputeAgent(agent).catch(err =>
        logger.warn({ err, agentId: agent.id }, 'first agent will be scored on next open'));
    }

    if (made.length) {
      logger.info(
        { userId, active: made.filter(a => a.status === 'active').map(a => a.label), drafts: made.filter(a => a.status === 'paused').map(a => a.label) },
        'First agents created from onboarding');
    }
    return made;
  } catch (err) {
    logger.error({ err, userId }, 'could not create first agents');
    return [];
  }
}
