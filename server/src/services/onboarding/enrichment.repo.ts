// ─── Profile Enrichment — persistence ────────────────────────────────────────
// Stores the enriched candidate (a guess to confirm) under inferred_profile, and
// applies the member-confirmed subset to the real profile. Both additive: the
// candidate never overwrites confirmed data, and apply only fills provided fields.

import { query } from '../../db';
import type { EnrichResult } from './enrichment.service';

/** Read a previously-cached enrichment (so reloads/re-tests don't re-run a paid search). */
export async function getCachedEnrichment(userId: string): Promise<EnrichResult | null> {
  const r = await query<{ enriched: EnrichResult | null }>(
    `SELECT inferred_profile->'enriched' AS enriched FROM user_intent_profiles WHERE user_id = $1`,
    [userId],
  );
  const e = r.rows[0]?.enriched;
  if (e && typeof e === 'object' && typeof (e as any).confidence === 'number') return e as EnrichResult;
  return null;
}

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

/** Drop the cached enrichment for a user so the next onboarding re-runs it (admin refresh). */
export async function clearEnrichment(userId: string): Promise<void> {
  await query(
    `UPDATE user_intent_profiles
        SET inferred_profile = COALESCE(inferred_profile, '{}'::jsonb) - 'enriched', updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
}

// ─── Enrichment state machine ────────────────────────────────────────────────
// Explicit state (enrichment_status + friends) replacing the implicit
// 0.15/0.35/0.6 confidence thresholds — single source of truth for A5's orchestrator.

export type EnrichmentStatus = 'none' | 'searching' | 'found' | 'partial' | 'not_found' | 'failed';

export interface EnrichmentDbState {
  status: EnrichmentStatus;
  source: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

const TERMINAL_ENRICHMENT_STATUSES = new Set<EnrichmentStatus>(['found', 'partial', 'not_found', 'failed']);

/**
 * Upsert enrichment state onto user_intent_profiles. Only fields present on
 * `state` are written — EXCEPT two behaviors enforced here (not left to
 * callers): status 'searching' always resets enrichment_error to null and
 * stamps enrichment_started_at (a fresh attempt); any terminal status always
 * stamps enrichment_completed_at.
 */
export async function setEnrichmentState(
  userId: string,
  state: Partial<EnrichmentDbState> & { status: EnrichmentStatus },
): Promise<void> {
  const { status } = state;
  const isSearching = status === 'searching';
  const isTerminal = TERMINAL_ENRICHMENT_STATUSES.has(status);
  const nowIso = new Date().toISOString();

  const sourceProvided = 'source' in state;
  const errorProvided = isSearching || 'error' in state;
  const startedAtProvided = isSearching || 'startedAt' in state;
  const completedAtProvided = isTerminal || 'completedAt' in state;

  const source = sourceProvided ? state.source ?? null : null;
  const error = isSearching ? null : errorProvided ? state.error ?? null : null;
  const startedAt = isSearching ? nowIso : startedAtProvided ? state.startedAt ?? null : null;
  const completedAt = isTerminal ? nowIso : completedAtProvided ? state.completedAt ?? null : null;

  await query(
    `INSERT INTO user_intent_profiles
       (user_id, enrichment_status, enrichment_source, enrichment_error, enrichment_started_at, enrichment_completed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       enrichment_status = $2,
       enrichment_source = CASE WHEN $7 THEN $3 ELSE user_intent_profiles.enrichment_source END,
       enrichment_error = CASE WHEN $8 THEN $4 ELSE user_intent_profiles.enrichment_error END,
       enrichment_started_at = CASE WHEN $9 THEN $5::timestamptz ELSE user_intent_profiles.enrichment_started_at END,
       enrichment_completed_at = CASE WHEN $10 THEN $6::timestamptz ELSE user_intent_profiles.enrichment_completed_at END,
       updated_at = NOW()`,
    [userId, status, source, error, startedAt, completedAt, sourceProvided, errorProvided, startedAtProvided, completedAtProvided],
  );
}

interface EnrichmentStateRow {
  enrichment_status: EnrichmentStatus;
  enrichment_source: string | null;
  enrichment_error: string | null;
  enrichment_started_at: string | Date | null;
  enrichment_completed_at: string | Date | null;
}

const toIsoOrNull = (v: string | Date | null): string | null => (v == null ? null : new Date(v).toISOString());

/** Read the current enrichment state for a user; `none` defaults when no profile row exists yet. */
export async function getEnrichmentState(userId: string): Promise<EnrichmentDbState> {
  const r = await query<EnrichmentStateRow>(
    `SELECT enrichment_status, enrichment_source, enrichment_error, enrichment_started_at, enrichment_completed_at
       FROM user_intent_profiles WHERE user_id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) {
    return { status: 'none', source: null, error: null, startedAt: null, completedAt: null };
  }
  return {
    status: row.enrichment_status,
    source: row.enrichment_source,
    error: row.enrichment_error,
    startedAt: toIsoOrNull(row.enrichment_started_at),
    completedAt: toIsoOrNull(row.enrichment_completed_at),
  };
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
