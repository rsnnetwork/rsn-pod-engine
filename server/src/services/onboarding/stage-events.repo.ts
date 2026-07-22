// ─── Onboarding Stage-Event Telemetry ────────────────────────────────────────
//
// Per-stage timing + failure trail for the admin inspector (task E1; spec:
// "time taken for each stage", "failed searches and errors"). Fire-and-forget
// from every call site: record() NEVER throws — a telemetry write failing
// (DB down, etc.) must never affect the onboarding flow it's observing, only
// degrade the admin inspector's visibility into it.

import { query } from '../../db';
import logger from '../../config/logger';

export type StageEventStage =
  | 'enrich_started'
  | 'enrich_found'
  | 'enrich_partial'
  | 'enrich_not_found'
  | 'enrich_failed'
  | 'photo_captured'
  | 'photo_failed'
  | 'chat_started'
  | 'confirmed'
  | 'fallback_form'
  | 'extract_failed';

export interface StageEvent {
  id: string;
  userId: string;
  stage: StageEventStage;
  detail: Record<string, unknown>;
  durationMs: number | null;
  createdAt: string;
}

interface StageEventRow {
  id: string;
  user_id: string;
  stage: StageEventStage;
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  created_at: string | Date;
}

/**
 * Record one onboarding stage event. Never throws — any failure (DB down,
 * constraint violation, etc.) is caught and logged as a warning so the
 * caller's own flow (enrichment, chat, confirm, ...) is never affected.
 */
export async function record(
  userId: string,
  stage: StageEventStage,
  detail?: Record<string, unknown>,
  durationMs?: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO onboarding_stage_events (user_id, stage, detail, duration_ms)
         VALUES ($1, $2, $3::jsonb, $4)`,
      [userId, stage, JSON.stringify(detail ?? {}), durationMs ?? null],
    );
  } catch (err) {
    logger.warn({ err, userId, stage }, 'stage-events: record failed (non-fatal)');
  }
}

/** Read a user's stage-event trail, most recent first — consumed by the admin inspector. */
export async function listForUser(userId: string): Promise<StageEvent[]> {
  const r = await query<StageEventRow>(
    `SELECT id, user_id, stage, detail, duration_ms, created_at
       FROM onboarding_stage_events
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    stage: row.stage,
    detail: row.detail ?? {},
    durationMs: row.duration_ms,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
