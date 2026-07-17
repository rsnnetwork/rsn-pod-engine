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
import { normalizeDesignation, tokenizeTerms, termOverlap } from './intent-signals';
import * as pokeService from '../poke/poke.service';
import { UserPoke } from '../poke/poke.service';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IntentProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: unknown;  // text[] in DB (e.g. {Founder}) — never assume string
  jobTitle: string | null;
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

// Designations someone says they WANT to meet, scanned from their want-text.
// normalizeDesignation() maps a single title to one bucket; a want-sentence
// ("founders and investors") can name several, so scan per-bucket here.
const WANT_DESIGNATIONS: Array<[RegExp, string, string]> = [
  [/\b(co[-\s]?founder|founder)s?\b/, 'founder', 'founders'],
  [/\b(investor|angel|venture|vc)s?\b/, 'investor', 'investors'],
  [/\b(advisor|adviser|mentor)s?\b/, 'advisor', 'mentors and advisors'],
  [/\b(consultant|freelancer)s?\b/, 'consultant', 'consultants'],
  [/\b(ceo|chief executive)s?\b/, 'ceo', 'CEOs'],
  [/\b(student|intern)s?\b/, 'student', 'students'],
  [/\b(recruit|hire|hiring|talent|candidate)/, 'job_seeker', 'candidates'],
  [/\b(job|role|work|position)\b.*\b(find|seek|look)|\b(find|seek|look)\w*\b.*\b(job|role|position)\b/, 'employer', 'people hiring'],
];

export function wantedDesignations(p: IntentProfile): Array<{ key: string; label: string }> {
  const text = wantSources(p).filter(Boolean).join(' ').toLowerCase();
  const out: Array<{ key: string; label: string }> = [];
  for (const [re, key, label] of WANT_DESIGNATIONS) {
    if (re.test(text)) out.push({ key, label });
  }
  return out;
}

/**
 * Stefan's one-way rule, scored. Returns 0 when there is no fit; the reason is
 * human-readable and shown on the match card AND used as the introduction text.
 */
export function scoreFit(me: IntentProfile, other: IntentProfile): { score: number; reason: string } {
  const wantTokens = tokenizeTerms(wantSources(me));
  const offerTokens = tokenizeTerms(offerSources(other));
  const overlap = termOverlap(wantTokens, offerTokens);

  // Designation direction: I want founders + they are a founder. A person can
  // hold SEVERAL roles (professional_role is text[]), and they count as each
  // of them — so bucket every role separately, not the concatenated string
  // (where the first rule in the list would always win).
  const roleValues = Array.isArray(other.professionalRole)
    ? other.professionalRole
    : [flatten(other.professionalRole)];
  const otherDesignations = new Set(
    [...roleValues, other.jobTitle]
      .map(r => normalizeDesignation(typeof r === 'string' ? r : null))
      .filter((d): d is string => Boolean(d)),
  );
  const wanted = wantedDesignations(me);
  const designationHit = wanted.find(w => otherDesignations.has(w.key)) ?? null;

  const score = 0.7 * overlap + (designationHit ? 0.6 : 0);
  if (score <= 0) return { score: 0, reason: '' };

  const name = other.displayName || 'They';
  const role = displayRole(other);
  let reason: string;
  if (designationHit && role) {
    reason = `You're looking to meet ${designationHit.label} — ${name} is ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`;
  } else if (designationHit) {
    reason = `You're looking to meet ${designationHit.label} — ${name} fits`;
  } else {
    const shared = wantTokens.filter(w =>
      offerTokens.some(o => o === w || (w.length >= 4 && o.includes(w)) || (o.length >= 4 && w.includes(o)))
    ).slice(0, 3);
    reason = shared.length
      ? `What you're looking for matches their profile: ${shared.join(', ')}`
      : `Their profile matches what you're looking for`;
  }
  return { score: Math.min(1, score), reason };
}

// ── Data access ──────────────────────────────────────────────────────────────

const PROFILE_COLUMNS = `
  u.id, u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
  u.professional_role AS "professionalRole", u.job_title AS "jobTitle",
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
export async function expressInterest(userId: string, targetUserId: string): Promise<UserPoke> {
  const [me, target] = await Promise.all([loadProfile(userId), loadProfile(targetUserId)]);
  let message = 'We think you two should meet.';
  if (me && target) {
    // The message is read by the RECIPIENT, so it must be written from THEIR
    // perspective. If their own wants fit the sender, say so ("You're looking
    // to meet X — SENDER is a Y"). If they never stated wants, the sender-side
    // reason would read backwards to them ("You're looking to meet investors"
    // about someone who never said that — caught on the 17 Jul prod run), so
    // fall back to a neutral sentence instead.
    const toRecipient = scoreFit(target, me);
    if (toRecipient.reason) {
      message = `${toRecipient.reason}. We think you two should meet.`;
    } else {
      const myName = me.displayName || 'This member';
      message = `${myName} thinks you fit what they're looking for. We think you two should meet.`;
    }
  }
  return pokeService.sendPoke(userId, targetUserId, message.slice(0, 500));
}

/**
 * New-batch trigger (fire-and-forget after onboarding completes): existing
 * members whose "want" fits the NEW user get one bell notification pointing at
 * /matches — Stefan's "he will get notified when there is a new batch".
 * Deduped per-recipient per-24h so a signup wave can't spam anyone.
 */
export async function notifyMatchesOfNewUser(newUserId: string): Promise<number> {
  try {
    const newcomer = await loadProfile(newUserId);
    if (!newcomer || !newcomer.onboardingCompleted) return 0;

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
    return notified;
  } catch (err) {
    logger.warn({ err, newUserId }, 'notifyMatchesOfNewUser failed (non-fatal)');
    return 0;
  }
}
