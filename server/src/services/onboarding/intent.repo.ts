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
import { OnboardingMessage, OnboardingStatus } from '@rsn/shared';
import { ExtractedIntent } from './intent.schema';

function orNull(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t || null;
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
  conversation: OnboardingMessage[]
): Promise<{ profileComplete: boolean }> {
  // ── Dual-write values for the existing users columns ──────────────────────
  const reasonsToConnect = cleanArr(
    intent.matchingTags.length ? intent.matchingTags : [intent.reasonForMeeting],
    10
  );
  const interests = cleanArr(intent.userInterests, 20);
  const professionalRole = cleanArr([intent.userRole], 5);
  const goals = cleanArr([intent.desiredOutcome], 5);

  const company = truncate(orNull(intent.userCompany), 200);
  const jobTitle = truncate(orNull(intent.userRole), 200);
  const industry = truncate(orNull(intent.userIndustry), 100);
  const whoIWantToMeet = joinList([...intent.desiredPeople, ...intent.desiredRoles]);
  const whyIWantToMeet = orNull(intent.reasonForMeeting);
  const myIntent = orNull(intent.desiredOutcome);
  const expertiseText = joinList(intent.userExpertise);
  const whatICanHelpWith = joinList(intent.userCanOffer);
  const whatICareAbout = joinList(intent.userInterests);
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
    const displayName = (row0.display_name || '').trim();
    if ((!firstName || !lastName) && displayName) {
      const parts = displayName.split(/\s+/).filter(Boolean);
      if (!firstName) firstName = parts[0] || displayName;
      if (!lastName) lastName = parts.length > 1 ? parts.slice(1).join(' ') : firstName;
    }

    await client.query(
      `UPDATE users SET
         company = $2,
         job_title = $3,
         industry = $4,
         professional_role = $5,
         goals = $6,
         interests = $7,
         reasons_to_connect = $8,
         expertise_text = $9,
         what_i_can_help_with = $10,
         what_i_care_about = $11,
         who_i_want_to_meet = $12,
         why_i_want_to_meet = $13,
         my_intent = $14,
         matching_notes = $15,
         first_name = $16,
         last_name = $17,
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

    return { profileComplete: isComplete };
  });
}
