// ─── Profile Enrichment — persistence ────────────────────────────────────────
// Stores the enriched candidate (a guess to confirm) under inferred_profile, and
// applies the member-confirmed subset to the real profile. Both additive: the
// candidate never overwrites confirmed data, and apply only fills provided fields.

import { query } from '../../db';
import type { EnrichResult } from './enrichment.service';

/** Save the enriched candidate under user_intent_profiles.inferred_profile.enriched (merge, no clobber). */
export async function saveEnrichedCandidate(userId: string, result: EnrichResult): Promise<void> {
  await query(
    `INSERT INTO user_intent_profiles (user_id, inferred_profile, updated_at)
       VALUES ($1, jsonb_build_object('enriched', $2::jsonb), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       inferred_profile = COALESCE(user_intent_profiles.inferred_profile, '{}'::jsonb)
                          || jsonb_build_object('enriched', $2::jsonb),
       updated_at = NOW()`,
    [userId, JSON.stringify(result)],
  );
}

export interface ApplyFields {
  jobTitle?: string | null;
  company?: string | null;
  industry?: string | null;
  location?: string | null;
  bio?: string | null;
  linkedin?: string | null;
}

/** Write the confirmed/edited fields to the real profile. COALESCE → only provided fields change. */
export async function applyEnrichedToProfile(userId: string, f: ApplyFields): Promise<void> {
  await query(
    `UPDATE users SET
       job_title    = COALESCE($2, job_title),
       company      = COALESCE($3, company),
       industry     = COALESCE($4, industry),
       location     = COALESCE($5, location),
       bio          = COALESCE($6, bio),
       linkedin_url = COALESCE($7, linkedin_url),
       updated_at   = NOW()
     WHERE id = $1`,
    [userId, f.jobTitle ?? null, f.company ?? null, f.industry ?? null, f.location ?? null, f.bio ?? null, f.linkedin ?? null],
  );
}
