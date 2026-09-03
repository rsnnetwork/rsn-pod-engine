// ─── Platform Match Service ──────────────────────────────────────────────────
//
// REASON platform v1 Phase 1 (17 Jul 2026) — the STANDING match check.
// Until now matching only existed inside a live event. This is the platform
// layer Stefan described: after onboarding the system looks in the database
// for people who fit you and shows you "we matched you with this profile".
//
// The v1 rule is Stefan's, verbatim ("Yes" on 17 Jul): if what A WANTS
// matches what B IS or OFFERS, we show A the suggestion. One-way fit is
// enough to SHOW; nobody is introduced until BOTH say yes. The double-opt-in
// itself rides the existing poke rails (send interest → notified → accept
// unlocks the DM + conversation), so this service only computes suggestions
// and composes the introduction.
//
// Deliberately no AI (June 19 doc: "No AI required initially. Just
// matching."): designation buckets + token overlap over the intent columns
// the chatbot onboarding already fills.

import { query } from '../../db';
import logger from '../../config/logger';
import { normalizeDesignation, tokenizeTerms, termOverlap, designationsWanted } from './intent-signals';
import * as pokeService from '../poke/poke.service';
import { UserPoke } from '../poke/poke.service';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IntentProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: unknown;  // text[] in DB (e.g. {Founder}) — never assume string
  jobTitle: string | null;
  /** 13 Aug (B1): stated = the member's own; inferred = enrichment's proposal, accepted unchanged; null = pre-089. */
  jobTitleSource?: 'stated' | 'inferred' | null;
  company: string | null;
  expertiseText: string | null;
  whatICanHelpWith: string | null;
  whatICareAbout: string | null;
  goals: unknown;             // text[] in DB
  interests: unknown;         // text[] in DB
  myIntent: string | null;
  whoIWantToMeet: string | null;
  whyIWantToMeet: string | null;
}

export interface PlatformMatch {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: string | null;
  company: string | null;
  reason: string;
  score: number;
}

export interface PlatformMatchesResult {
  matches: PlatformMatch[];
  profileIncomplete: boolean;
  nextEvent: { id: string; title: string; scheduledAt: Date } | null;
}

// A suggestion must clear this; a designation hit alone (0.6) qualifies, and
// so does strong token overlap. Browse mode ("find other people based on
// profiling", the no-match option) relaxes to BROWSE_THRESHOLD.
export const MATCH_THRESHOLD = 0.45;
export const BROWSE_THRESHOLD = 0.12;

// ── The fit rule (pure — unit-tested directly) ───────────────────────────────

// What A wants, as free text. who_i_want_to_meet is the primary signal; intent
// and goals often carry the same information phrased differently.
function wantSources(p: IntentProfile): Array<string | null | undefined> {
  return [p.whoIWantToMeet, p.myIntent, p.whyIWantToMeet, flatten(p.goals)];
}

// What B is / offers. Stefan: "what B is or offers".
function offerSources(p: IntentProfile): Array<string | null | undefined> {
  return [
    flatten(p.professionalRole), p.jobTitle, p.company,
    p.expertiseText, p.whatICanHelpWith, p.whatICareAbout,
    flatten(p.interests),
  ];
}

function flatten(v: unknown, sep = ' '): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.filter(Boolean).join(sep) || null;
  return String(v);
}

/** The role as shown to humans (cards, reasons): "Founder, Investor". */
export function displayRole(p: IntentProfile): string | null {
  return flatten(p.professionalRole, ', ') || p.jobTitle;
}

// The want side reads the SAME taxonomy the person side does (ROLE_TAXONOMY in
// intent-signals). A second, rival list lived here until 3 Aug 2026: it had 8
// buckets to that one's 12 and no developer bucket at all, so "find me
// developers" could never score a role match and fell through to loose word
// overlap — which is how a Developers agent surfaced a CEO.

export function wantedDesignations(p: IntentProfile): Array<{ key: string; label: string }> {
  return wantedDesignationsFrom(wantSources(p));
}

/** Same scan over raw want-text, so a matching agent can use it (Wave 2). */
export function wantedDesignationsFrom(
  wants: Array<string | null | undefined>,
): Array<{ key: string; label: string }> {
  return designationsWanted(wants.filter(Boolean).join(' '));
}

/**
 * Stefan's one-way rule, scored. Returns 0 when there is no fit; the reason is
 * human-readable and shown on the match card AND used as the introduction text.
 */
export function scoreFit(me: IntentProfile, other: IntentProfile): { score: number; reason: string } {
  return scoreWants(wantSources(me), other);
}

/**
 * The same rule, with the want side supplied directly instead of read off a
 * user row. Wave 2 (matching agents): a member holds several concurrent wants,
 * each its own agent, so the thing being matched is a want-text — not a person.
 * `scoreFit` is now a thin wrapper, keeping the profile-level behaviour and its
 * tests exactly as they were.
 */
export function scoreWants(
  wants: Array<string | null | undefined>,
  other: IntentProfile,
): { score: number; reason: string } {
  const f = analyzeWants(wants, other);
  return { score: f.score, reason: f.score <= 0 ? '' : formatForSeeker(f) };
}

/**
 * The SAME fit, addressed to the person who was found rather than the person
 * searching. An introduction is read by the recipient, so the sentence has to
 * name the sender as the one doing the looking:
 *
 *   seeker:    "You're looking to meet developers — jack rajaa is a frontend engineer"
 *   recipient: "Raja Ali King is looking to meet developers — you're a frontend engineer"
 *
 * Until now the introduction dodged this by scoring the RECIPIENT's wants
 * instead, which reads fine but states the wrong cause: jack was told "you're
 * looking to meet founders" when what actually reached him was Ali's Developers
 * agent. Same facts, wrong reason — so the flip is done in the wording, not by
 * swapping whose want it is.
 */
export function scoreWantsForRecipient(
  wants: Array<string | null | undefined>,
  recipient: IntentProfile,
  senderName: string,
): { score: number; reason: string } {
  const f = analyzeWants(wants, recipient);
  return { score: f.score, reason: f.score <= 0 ? '' : formatForRecipient(f, senderName) };
}

interface WantFit {
  score: number;
  /** "developers and engineers" — the bucket that matched, if any. */
  designationLabel: string | null;
  /** The title that actually produced the hit ("frontend engineer"). */
  matchedTitle: string | null;
  sharedTerms: string[];
  name: string;
}

const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

function formatForSeeker(f: WantFit): string {
  if (f.designationLabel && f.matchedTitle) {
    return `You're looking to meet ${f.designationLabel} — ${f.name} is ${article(f.matchedTitle)} ${f.matchedTitle}`;
  }
  if (f.designationLabel) return `You're looking to meet ${f.designationLabel} — ${f.name} fits`;
  return f.sharedTerms.length
    ? `What you're looking for matches their profile: ${f.sharedTerms.join(', ')}`
    : `Their profile matches what you're looking for`;
}

function formatForRecipient(f: WantFit, senderName: string): string {
  if (f.designationLabel && f.matchedTitle) {
    return `${senderName} is looking to meet ${f.designationLabel} — you're ${article(f.matchedTitle)} ${f.matchedTitle}`;
  }
  if (f.designationLabel) return `${senderName} is looking to meet ${f.designationLabel} — you fit`;
  return f.sharedTerms.length
    ? `What ${senderName} is looking for matches your profile: ${f.sharedTerms.join(', ')}`
    : `Your profile matches what ${senderName} is looking for`;
}

function analyzeWants(
  wants: Array<string | null | undefined>,
  other: IntentProfile,
): WantFit {
  const wantTokens = tokenizeTerms(wants);
  const offerTokens = tokenizeTerms(offerSources(other));
  const overlap = termOverlap(wantTokens, offerTokens);

  // Designation direction: I want founders + they are a founder. A person can
  // hold SEVERAL roles (professional_role is text[]), and they count as each
  // of them — so bucket every role separately, not the concatenated string
  // (where the first rule in the list would always win).
  const roleValues = Array.isArray(other.professionalRole)
    ? other.professionalRole
    : [flatten(other.professionalRole)];
  // Keep the TITLE that produced each designation, not just the bucket. The
  // reason below names it, so "you want developers, X is a Manager" (matched on
  // a job title of "frontend engineer" while displaying a role of "Manager")
  // can no longer contradict itself.
  const titleByDesignation = new Map<string, string>();
  // 13 Aug (B1): a title the member STATED is the most specific thing we know,
  // so it names the introduction ahead of a generic role bucket. An inferred
  // one (enrichment's proposal, accepted unchanged) or an unknown provenance
  // keeps roles first, so a guess never becomes the reason we give when a
  // stated role covers the same bucket. Scoring is unchanged either way.
  const ordered = other.jobTitleSource === 'stated'
    ? [other.jobTitle, ...roleValues]
    : [...roleValues, other.jobTitle];
  for (const r of ordered) {
    const title = typeof r === 'string' ? r.trim() : null;
    if (!title) continue;
    const key = normalizeDesignation(title);
    if (key && !titleByDesignation.has(key)) titleByDesignation.set(key, title);
  }
  const wanted = wantedDesignationsFrom(wants);
  const designationHit = wanted.find(w => titleByDesignation.has(w.key)) ?? null;
  const matchedTitle = designationHit ? titleByDesignation.get(designationHit.key)! : null;

  const score = 0.7 * overlap + (designationHit ? 0.6 : 0);
  const name = other.displayName || 'They';
  // Name the title that actually matched; fall back to their headline role.
  const role = matchedTitle || displayRole(other);
  const shared = designationHit
    ? []
    : wantTokens.filter(w =>
      offerTokens.some(o => o === w || (w.length >= 4 && o.includes(w)) || (o.length >= 4 && w.includes(o)))
    ).slice(0, 3);

  return {
    score: Math.min(1, score),
    designationLabel: designationHit ? designationHit.label : null,
    matchedTitle: designationHit && role ? role : null,
    sharedTerms: shared,
    name,
  };
}

// ── Data access ──────────────────────────────────────────────────────────────

const PROFILE_COLUMNS = `
  u.id, u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
  u.professional_role AS "professionalRole", u.job_title AS "jobTitle",
  u.job_title_source AS "jobTitleSource",
  u.company, u.expertise_text AS "expertiseText",
  u.what_i_can_help_with AS "whatICanHelpWith",
  u.what_i_care_about AS "whatICareAbout",
  u.goals, u.interests, u.my_intent AS "myIntent",
  u.who_i_want_to_meet AS "whoIWantToMeet",
  u.why_i_want_to_meet AS "whyIWantToMeet"`;

async function loadProfile(userId: string): Promise<(IntentProfile & { onboardingCompleted: boolean }) | null> {
  const r = await query<IntentProfile & { onboardingCompleted: boolean }>(
    `SELECT ${PROFILE_COLUMNS}, u.onboarding_completed AS "onboardingCompleted"
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/**
 * Candidates someone can be matched with: active, onboarded, and NEW to them —
 * no prior encounter (met people can already DM), no poke in either direction
 * (pending = already suggested; declined = don't pester), no block.
 */
async function loadCandidates(userId: string): Promise<IntentProfile[]> {
  const r = await query<IntentProfile>(
    `SELECT ${PROFILE_COLUMNS}
     FROM users u
     WHERE u.id <> $1
       AND u.status = 'active'
       AND u.onboarding_completed = true
       AND NOT EXISTS (
         SELECT 1 FROM encounter_history e
         WHERE e.user_a_id = LEAST($1, u.id) AND e.user_b_id = GREATEST($1, u.id))
       AND NOT EXISTS (
         SELECT 1 FROM user_pokes p
         WHERE (p.sender_id = $1 AND p.recipient_id = u.id)
            OR (p.sender_id = u.id AND p.recipient_id = $1))
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = $1))`,
    [userId],
  );
  return r.rows;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getPlatformMatches(
  userId: string,
  opts: { browse?: boolean; limit?: number } = {},
): Promise<PlatformMatchesResult> {
  const limit = Math.min(opts.limit ?? 10, 50);
  const me = await loadProfile(userId);

  const nextEventRes = await query<{ id: string; title: string; scheduledAt: Date }>(
    `SELECT id, title, scheduled_at AS "scheduledAt"
     FROM sessions
     WHERE status = 'scheduled' AND scheduled_at > NOW()
     ORDER BY scheduled_at ASC LIMIT 1`,
  );
  const nextEvent = nextEventRes.rows[0] ?? null;

  if (!me || !me.onboardingCompleted) {
    return { matches: [], profileIncomplete: true, nextEvent };
  }

  const threshold = opts.browse ? BROWSE_THRESHOLD : MATCH_THRESHOLD;
  const candidates = await loadCandidates(userId);
  const matches = candidates
    .map(c => ({ c, fit: scoreFit(me, c) }))
    .filter(x => x.fit.score >= threshold)
    .sort((a, b) => b.fit.score - a.fit.score)
    .slice(0, limit)
    .map(x => ({
      userId: x.c.id,
      displayName: x.c.displayName,
      avatarUrl: x.c.avatarUrl,
      professionalRole: displayRole(x.c),
      company: x.c.company,
      reason: x.fit.reason,
      score: Number(x.fit.score.toFixed(3)),
    }));

  return { matches, profileIncomplete: false, nextEvent };
}

/**
 * "I want to meet" — the platform introduces on A's behalf. Rides the poke
 * rails: the recipient gets notified, accepts or declines, and a mutual accept
 * unlocks the DM + creates the conversation (existing acceptPoke behaviour).
 * The poke message carries the introduction (why these two fit).
 */
export async function expressInterest(
  userId: string,
  targetUserId: string,
  /** Which matching agent produced this introduction, when it came from one.
   *  Recorded on the poke so the exclusion it creates is scoped to that agent
   *  (Wave 2, decision D3) rather than hiding the person everywhere. */
  agentId?: string,
): Promise<UserPoke> {
  const [me, target] = await Promise.all([loadProfile(userId), loadProfile(targetUserId)]);
  let message = 'We think you two should meet.';
  if (me && target) {
    const senderName = me.displayName || 'This member';
    // Say WHY this introduction exists, strongest known cause first.
    //
    // 1. An agent sent it → that agent is the cause, and nothing else may
    //    stand in for it. Reading the recipient's own wants instead (what this
    //    did until 5 Aug) yields a true sentence about the wrong thing: jack
    //    rajaa was told "you're looking to meet founders" when what actually
    //    reached him was Ali's Developers agent.
    // 2. No agent, but the sender stated who they want → that is the cause.
    // 3. Neither, but the recipient's own want fits the sender → the best
    //    honest explanation of the fit that is left, and useful to them.
    // 4. Nothing to say → a neutral sentence, never an invented reason.
    const agentWant = agentId ? await agentWantText(agentId) : null;
    const fromSender = scoreWantsForRecipient(
      agentWant ? [agentWant] : wantSources(me), target, senderName,
    );
    const toRecipient = agentWant ? { reason: '' } : scoreFit(target, me);
    const reason = fromSender.reason || toRecipient.reason;
    message = reason
      ? `${reason}. We think you two should meet.`
      : `${senderName} thinks you fit what they're looking for. We think you two should meet.`;
  }
  return pokeService.sendPoke(userId, targetUserId, message.slice(0, 500), agentId);
}

/** The want-text of one agent, for wording the introduction it produced. */
async function agentWantText(agentId: string): Promise<string | null> {
  try {
    const r = await query<{ want_text: string | null }>(
      `SELECT want_text FROM matching_agents WHERE id = $1`,
      [agentId],
    );
    return r.rows[0]?.want_text ?? null;
  } catch {
    return null;
  }
}

/**
 * New-batch trigger (fire-and-forget after onboarding completes): existing
 * members whose "want" fits the NEW user get one bell notification pointing at
 * /matches — Stefan's "he will get notified when there is a new batch".
 * Deduped per-recipient per-24h so a signup wave can't spam anyone.
 *
 * Wave 2: agents run FIRST and own the notification when one of them wanted
 * this person, because "your Developer agent found someone" says far more than
 * "someone new matches what you're looking for". This profile-level pass then
 * covers members who have no agent yet, and skips anyone an agent already told.
 */
export async function notifyMatchesOfNewUser(newUserId: string): Promise<number> {
  try {
    const newcomer = await loadProfile(newUserId);
    if (!newcomer || !newcomer.onboardingCompleted) return 0;

    const notifiedByAgent = await notifyAgentsOfNewUser(newUserId);

    const existing = await query<IntentProfile>(
      `SELECT ${PROFILE_COLUMNS}
       FROM users u
       WHERE u.id <> $1 AND u.status = 'active' AND u.onboarding_completed = true
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1))`,
      [newUserId],
    );

    let notified = 0;
    for (const member of existing.rows) {
      if (notified >= 25) break; // signup-wave guard
      // An agent already told this member, with a better reason. Don't repeat.
      if (notifiedByAgent.has(member.id)) continue;
      const fit = scoreFit(member, newcomer);
      if (fit.score < MATCH_THRESHOLD) continue;

      const dedupe = await query<{ id: string }>(
        `SELECT id FROM notifications
         WHERE user_id = $1 AND type = 'platform_match'
           AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
        [member.id],
      );
      if (dedupe.rows.length > 0) continue;

      const inserted = await query<{ id: string; created_at: Date }>(
        `INSERT INTO notifications (id, user_id, type, title, body, link)
         VALUES (gen_random_uuid(), $1, 'platform_match', $2, $3, '/matches')
         RETURNING id, created_at`,
        [member.id, 'Someone new matches what you\'re looking for', fit.reason],
      );
      notified++;
      try {
        const { io } = await import('../../index');
        io.to(`user:${member.id}`).emit('notification:new', {
          id: inserted.rows[0].id,
          type: 'platform_match',
          title: 'Someone new matches what you\'re looking for',
          body: fit.reason,
          link: '/matches',
          isRead: false,
          createdAt: inserted.rows[0].created_at,
        });
      } catch { /* socket push is non-fatal */ }
    }
    if (notified > 0) {
      logger.info({ newUserId, notified }, 'Platform-match notifications sent for new user');
    }
    return notified + notifiedByAgent.size;
  } catch (err) {
    logger.warn({ err, newUserId }, 'notifyMatchesOfNewUser failed (non-fatal)');
    return 0;
  }
}

/**
 * Wave 2 continuous matching: a member who joins today is scored against every
 * ACTIVE agent in the network, and each owner whose agent wanted them is told
 * by that agent's name. Stefan's brief: "if Stefan is searching for a developer
 * and Ali joins tomorrow, Ali should automatically become a potential match."
 *
 * Dedupe is per (owner, agent) rather than the blanket 24h window the profile
 * pass uses, so a member running three agents can hear about three different
 * people on the same day — one notification each, not one in total.
 *
 * Returns the owners it notified so the profile-level pass can skip them.
 */
async function notifyAgentsOfNewUser(newUserId: string): Promise<Set<string>> {
  const owners = new Set<string>();
  try {
    // Imported lazily: agent-matching imports this module for the scorer, and a
    // static import both ways would be a cycle.
    const { scoreNewcomerAgainstAgents } = await import('./agent-matching.service');
    const gained = await scoreNewcomerAgainstAgents(newUserId);

    for (const g of gained) {
      const dedupe = await query<{ id: string }>(
        `SELECT id FROM notifications
          WHERE user_id = $1 AND type = 'platform_match'
            AND link = $2
            AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
        [g.ownerId, `/agents/${g.agentId}`],
      );
      if (dedupe.rows.length > 0) continue;

      const title = `Your ${g.label} agent found someone`;
      const inserted = await query<{ id: string; created_at: Date }>(
        `INSERT INTO notifications (id, user_id, type, title, body, link)
         VALUES (gen_random_uuid(), $1, 'platform_match', $2, $3, $4)
         RETURNING id, created_at`,
        [g.ownerId, title, g.reason, `/agents/${g.agentId}`],
      );
      owners.add(g.ownerId);
      try {
        const { io } = await import('../../index');
        io.to(`user:${g.ownerId}`).emit('notification:new', {
          id: inserted.rows[0].id,
          type: 'platform_match',
          title,
          body: g.reason,
          link: `/agents/${g.agentId}`,
          isRead: false,
          createdAt: inserted.rows[0].created_at,
        });
      } catch { /* socket push is non-fatal */ }
    }
    if (owners.size > 0) {
      logger.info({ newUserId, agents: gained.length, owners: owners.size }, 'Agent match notifications sent');
    }
  } catch (err) {
    logger.warn({ err, newUserId }, 'notifyAgentsOfNewUser failed (non-fatal)');
  }
  return owners;
}
