// ─── Onboarding Intent Repository ────────────────────────────────────────────
//
// On confirm, this dual-writes the extracted intent in one transaction:
//   1. The rich blob → user_intent_profiles (flexible, future matching home).
//   2. The existing `users` columns the in-event matcher + UI already read
//      (interests, reasons_to_connect, company, job_title, industry, goals,
//       who/why_i_want_to_meet, my_intent, expertise_text, …).
//   3. Flips the existing onboarding gate (onboarding_completed + recomputed
//      profile_complete) using the SAME logic as POST /auth/onboarding/complete,
//      and sets onboarding_status='completed' + last_onboarded_at.

import { query, transaction } from '../../db';
import {
  OnboardingMessage,
  OnboardingStatus,
  OnboardingConfirmedProfile,
  OnboardingKnownProfile,
} from '@rsn/shared';
import { ExtractedIntent } from './intent.schema';
import { getCachedEnrichment } from './enrichment.repo';

function orNull(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t || null;
}

/** Merge two lists, primary (chat) first, de-duplicated case-insensitively. */
function mergeP(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...(primary || []), ...(secondary || [])]) {
    const k = (x ?? '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

function truncate(s: string | null, n: number): string | null {
  return s == null ? null : s.slice(0, n);
}

function cleanArr(arr: string[], cap: number): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean))).slice(0, cap);
}

function joinList(arr: string[]): string | null {
  const v = cleanArr(arr, 50).join(', ');
  return v || null;
}

export async function getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
  const r = await query<{ onboarding_status: OnboardingStatus }>(
    'SELECT onboarding_status FROM users WHERE id = $1',
    [userId]
  );
  return r.rows[0]?.onboarding_status ?? 'not_started';
}

/**
 * Everything the host should KNOW about the member — the LinkedIn enrichment plus
 * any saved fields — so it can answer "who am I", never re-ask, and personalise.
 * Prefers the member's saved/confirmed values, falls back to the enrichment.
 */
export async function getKnownProfileForHost(userId: string): Promise<{
  role: string | null;
  industry: string | null;
  about: string | null;
  wantsToMeet: string[];
  offers: string[];
  interests: string[];
  whyHere: string | null;
  conversationStarters: string[];
  questionsToVerify: string[];
}> {
  const empty = { role: null, industry: null, about: null, wantsToMeet: [] as string[], offers: [] as string[], interests: [] as string[], whyHere: null, conversationStarters: [] as string[], questionsToVerify: [] as string[] };
  try {
    const r = await query<{
      job_title: string | null;
      industry: string | null;
      bio: string | null;
      who_i_want_to_meet: string | null;
      what_i_can_help_with: string | null;
      why_i_want_to_meet: string | null;
      interests: string[] | null;
      enriched: any;
    }>(
      `SELECT u.job_title, u.industry, u.bio, u.who_i_want_to_meet, u.what_i_can_help_with,
              u.why_i_want_to_meet, u.interests, uip.inferred_profile->'enriched' AS enriched
         FROM users u
         LEFT JOIN user_intent_profiles uip ON uip.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    );
    const row = r.rows[0];
    if (!row) return empty;
    const enr = (row.enriched && typeof row.enriched === 'object' ? row.enriched.profile : null) || {};
    const splitList = (s: string | null) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
    const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string' && x.trim().length > 0) : []);
    const wants = row.who_i_want_to_meet ? splitList(row.who_i_want_to_meet) : arr(enr.likelyWantsToMeet);
    const offers = row.what_i_can_help_with ? splitList(row.what_i_can_help_with) : arr(enr.likelyOffers);
    const interests = Array.isArray(row.interests) && row.interests.length ? row.interests : arr(enr.skills);
    return {
      role: orNull(row.job_title) || orNull(enr.currentRole) || orNull(enr.headline),
      industry: orNull(row.industry) || orNull(enr.industry),
      about: orNull(row.bio) || orNull(enr.summary),
      wantsToMeet: wants.slice(0, 8),
      offers: offers.slice(0, 8),
      interests: interests.slice(0, 12),
      whyHere: orNull(row.why_i_want_to_meet),
      conversationStarters: arr(enr.conversationStarters).slice(0, 3),
      questionsToVerify: arr(enr.questionsToVerify).slice(0, 3),
    };
  } catch {
    return empty;
  }
}

/** Best-effort: move a fresh user into 'in_progress' on their first host turn. */
export async function markInProgress(userId: string): Promise<void> {
  await query(
    `UPDATE users SET onboarding_status = 'in_progress'
       WHERE id = $1 AND onboarding_status = 'not_started'`,
    [userId]
  );
}

/**
 * Save the extracted intent and complete onboarding. Returns whether the gate's
 * profile_complete flag ended up true.
 */
export async function saveIntentAndComplete(
  userId: string,
  intent: ExtractedIntent,
  conversation: OnboardingMessage[],
  profile?: OnboardingConfirmedProfile,
  inferred?: OnboardingKnownProfile
): Promise<{ profileComplete: boolean }> {
  // ── Dual-write values for the existing users columns ──────────────────────
  // Merge the chat-extracted lists with the LinkedIn-inferred prefill — chat first
  // (prioritized), nothing lost. The prefill is the enrichment cached on the user's
  // inferred_profile (preloaded at approval, or filled during onboarding).
  const cached = await getCachedEnrichment(userId).catch(() => null);
  const enr = cached?.profile;
  const enrWants = Array.isArray(enr?.likelyWantsToMeet) ? (enr!.likelyWantsToMeet as string[]) : [];
  const enrOffers = Array.isArray(enr?.likelyOffers) ? (enr!.likelyOffers as string[]) : [];
  const enrSkills = Array.isArray(enr?.skills) ? (enr!.skills as string[]) : [];

  const reasonsToConnect = cleanArr(
    intent.matchingTags.length ? intent.matchingTags : [intent.reasonForMeeting],
    10
  );
  const interests = cleanArr(mergeP(intent.userInterests, enrSkills), 20);
  const professionalRole = cleanArr([intent.userRole], 5);
  const goals = cleanArr([intent.desiredOutcome], 5);

  // Confirmed known data (from the confirm-known card) wins over chat-extracted.
  const company = truncate(orNull(profile?.company) || orNull(intent.userCompany), 200);
  // Confirmed role (from the card) wins over chat-extracted.
  const jobTitle = truncate(orNull(profile?.role) || orNull(intent.userRole), 200);
  const industry = truncate(orNull(intent.userIndustry), 100);
  const location = truncate(orNull(profile?.country), 200);
  const linkedin = truncate(orNull(profile?.linkedin), 1000);
  const displayNameOverride = truncate(orNull(profile?.name), 100);
  const whoIWantToMeet = joinList(mergeP([...intent.desiredPeople, ...intent.desiredRoles], enrWants));
  const whyIWantToMeet = orNull(intent.reasonForMeeting);
  const myIntent = orNull(intent.desiredOutcome);
  const expertiseText = joinList(intent.userExpertise);
  const whatICanHelpWith = joinList(mergeP(intent.userCanOffer, enrOffers));
  const whatICareAbout = joinList(mergeP(intent.userInterests, enrSkills));
  const matchingNotes = truncate(orNull(intent.userProfileSummary), 1000);

  // ── Intent-profile blob ───────────────────────────────────────────────────
  const matchingIntent = JSON.stringify(intent);
  const confidence = JSON.stringify(intent.confidenceScores);
  const conversationJson = JSON.stringify(conversation);
  const matchingTags = cleanArr(intent.matchingTags, 24);
  const avoidPreferences = cleanArr(intent.avoidPreferences, 24);
  const privacyPreference = truncate(orNull(intent.privacyRecommendation), 40) ?? 'normal';
  const profileStrength = truncate(intent.profileStrength, 20);
  const embeddingText = orNull(intent.embeddingText);
  const profileSummary = orNull(intent.userProfileSummary);

  // Confirmed (what the member confirmed on the card) vs inferred (what we
  // guessed + which fields were guesses) — stored separately per Stefan's doc.
  const confirmedProfileJson = JSON.stringify({
    name: orNull(profile?.name),
    country: orNull(profile?.country),
    company: orNull(profile?.company),
    role: orNull(profile?.role),
    linkedin: orNull(profile?.linkedin),
  });
  const inferredProfileJson = JSON.stringify(inferred ?? {});

  return transaction(async (client) => {
    // Backfill first/last name from display_name when missing — same reasoning as
    // POST /auth/onboarding/complete (magic-link signups start nameless).
    const cur = await client.query<{
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>('SELECT display_name, first_name, last_name FROM users WHERE id = $1', [userId]);
    const row0 = cur.rows[0] || { display_name: null, first_name: null, last_name: null };
    let firstName = (row0.first_name || '').trim();
    let lastName = (row0.last_name || '').trim();
    const displayName = (displayNameOverride || row0.display_name || '').trim();
    // If the member corrected their name on the confirm card, re-derive first/last.
    if (displayNameOverride) {
      firstName = '';
      lastName = '';
    }
    if ((!firstName || !lastName) && displayName) {
      const parts = displayName.split(/\s+/).filter(Boolean);
      if (!firstName) firstName = parts[0] || displayName;
      if (!lastName) lastName = parts.length > 1 ? parts.slice(1).join(' ') : firstName;
    }

    await client.query(
      `UPDATE users SET
         company = COALESCE($2, company),
         job_title = COALESCE($3, job_title),
         industry = COALESCE($4, industry),
         professional_role = $5,
         goals = $6,
         interests = $7,
         reasons_to_connect = $8,
         expertise_text = $9,
         what_i_can_help_with = $10,
         what_i_care_about = $11,
         who_i_want_to_meet = $12,
         why_i_want_to_meet = COALESCE($13, why_i_want_to_meet),
         my_intent = $14,
         matching_notes = $15,
         first_name = $16,
         last_name = $17,
         location = COALESCE($18, location),
         display_name = COALESCE($19, display_name),
         linkedin_url = COALESCE($20, linkedin_url),
         onboarding_completed = true,
         onboarding_status = 'completed',
         last_onboarded_at = NOW()
       WHERE id = $1`,
      [
        userId,
        company,
        jobTitle,
        industry,
        professionalRole,
        goals,
        interests,
        reasonsToConnect,
        expertiseText,
        whatICanHelpWith,
        whatICareAbout,
        whoIWantToMeet,
        whyIWantToMeet,
        myIntent,
        matchingNotes,
        firstName || null,
        lastName || null,
        location,
        displayNameOverride,
        linkedin,
      ]
    );

    // Recompute profile_complete with the SAME rule the existing gate uses.
    const check = await client.query<{
      first_name: string | null;
      last_name: string | null;
      display_name: string | null;
      company: string | null;
      job_title: string | null;
      industry: string | null;
      reasons_to_connect: string[] | null;
    }>(
      `SELECT first_name, last_name, display_name, company, job_title, industry, reasons_to_connect
         FROM users WHERE id = $1`,
      [userId]
    );
    const r = check.rows[0];
    const isComplete = !!(
      r &&
      r.first_name &&
      r.last_name &&
      r.display_name &&
      r.company &&
      r.job_title &&
      r.industry &&
      Array.isArray(r.reasons_to_connect) &&
      r.reasons_to_connect.length > 0
    );
    await client.query('UPDATE users SET profile_complete = $1 WHERE id = $2', [
      isComplete,
      userId,
    ]);

    await client.query(
      `INSERT INTO user_intent_profiles
         (user_id, matching_intent, matching_tags, embedding_text, profile_summary,
          avoid_preferences, privacy_preference, confidence, profile_strength,
          onboarding_conversation, confirmed_profile, inferred_profile, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         matching_intent = EXCLUDED.matching_intent,
         matching_tags = EXCLUDED.matching_tags,
         embedding_text = EXCLUDED.embedding_text,
         profile_summary = EXCLUDED.profile_summary,
         avoid_preferences = EXCLUDED.avoid_preferences,
         privacy_preference = EXCLUDED.privacy_preference,
         confidence = EXCLUDED.confidence,
         profile_strength = EXCLUDED.profile_strength,
         onboarding_conversation = EXCLUDED.onboarding_conversation,
         confirmed_profile = EXCLUDED.confirmed_profile,
         inferred_profile = EXCLUDED.inferred_profile,
         updated_at = NOW()`,
      [
        userId,
        matchingIntent,
        matchingTags,
        embeddingText,
        profileSummary,
        avoidPreferences,
        privacyPreference,
        confidence,
        profileStrength,
        conversationJson,
        confirmedProfileJson,
        inferredProfileJson,
      ]
    );

    return { profileComplete: isComplete };
  });
}

/**
 * Per-answer extraction (Round B): upsert the running intent blob + transcript
 * after each host turn, WITHOUT flipping the onboarding gate, so the profile
 * updates live and a member can resume an in-progress conversation. Best-effort:
 * callers fire-and-forget this; it must never block or break the chat turn.
 */
export async function savePartialIntent(
  userId: string,
  intent: ExtractedIntent,
  conversation: OnboardingMessage[]
): Promise<void> {
  // Don't clobber a finished profile if a stray background extraction lands late.
  const st = await query<{ onboarding_status: OnboardingStatus }>(
    'SELECT onboarding_status FROM users WHERE id = $1',
    [userId]
  );
  if (st.rows[0]?.onboarding_status === 'completed') return;

  const matchingIntent = JSON.stringify(intent);
  const confidence = JSON.stringify(intent.confidenceScores);
  const conversationJson = JSON.stringify(conversation);
  const matchingTags = cleanArr(intent.matchingTags, 24);
  const avoidPreferences = cleanArr(intent.avoidPreferences, 24);
  const privacyPreference = truncate(orNull(intent.privacyRecommendation), 40) ?? 'normal';
  const profileStrength = truncate(intent.profileStrength, 20);
  const embeddingText = orNull(intent.embeddingText);
  const profileSummary = orNull(intent.userProfileSummary);

  await query(
    `INSERT INTO user_intent_profiles
       (user_id, matching_intent, matching_tags, embedding_text, profile_summary,
        avoid_preferences, privacy_preference, confidence, profile_strength,
        onboarding_conversation, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       matching_intent = EXCLUDED.matching_intent,
       matching_tags = EXCLUDED.matching_tags,
       embedding_text = EXCLUDED.embedding_text,
       profile_summary = EXCLUDED.profile_summary,
       avoid_preferences = EXCLUDED.avoid_preferences,
       privacy_preference = EXCLUDED.privacy_preference,
       confidence = EXCLUDED.confidence,
       profile_strength = EXCLUDED.profile_strength,
       onboarding_conversation = EXCLUDED.onboarding_conversation,
       updated_at = NOW()`,
    [
      userId,
      matchingIntent,
      matchingTags,
      embeddingText,
      profileSummary,
      avoidPreferences,
      privacyPreference,
      confidence,
      profileStrength,
      conversationJson,
    ]
  );

  await query(
    `UPDATE users SET onboarding_status = 'in_progress'
       WHERE id = $1 AND onboarding_status IN ('not_started', 'in_progress')`,
    [userId]
  );
}

/**
 * Load any in-progress onboarding so the member can resume where they left off.
 * Returns the saved transcript (empty if none) plus the current status.
 */
export async function getResume(
  userId: string
): Promise<{ status: OnboardingStatus; messages: OnboardingMessage[] }> {
  const r = await query<{
    onboarding_status: OnboardingStatus;
    onboarding_conversation: OnboardingMessage[] | null;
  }>(
    `SELECT u.onboarding_status, p.onboarding_conversation
       FROM users u
       LEFT JOIN user_intent_profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  const row = r.rows[0];
  const status = row?.onboarding_status ?? 'not_started';
  const conv = row?.onboarding_conversation;
  return { status, messages: Array.isArray(conv) ? conv : [] };
}
