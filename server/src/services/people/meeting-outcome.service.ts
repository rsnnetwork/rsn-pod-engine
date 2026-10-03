// ─── "Worth continuing?" / "What came from it?" (Foundation S10) ──────────────
// Asked after two people have met or connected. Private to the member who
// answers. Stored as a history (latest first), not a single overwrite, so
// REASON can later learn which introductions create value.

import { query } from '../../db';
import { ErrorCodes, type OutcomeKey, type WorthContinuing } from '@rsn/shared';
import { AppError, ConflictError } from '../../middleware/errors';

export interface RecordedOutcome {
  id: string;
  worthContinuing: WorthContinuing;
  outcomes: OutcomeKey[];
  createdAt: string;
}

export async function recordOutcome(
  userId: string,
  targetId: string,
  worthContinuing: WorthContinuing,
  keys: OutcomeKey[],
): Promise<RecordedOutcome> {
  if (userId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot record a meeting with yourself');
  }
  const [a, b] = userId < targetId ? [userId, targetId] : [targetId, userId];
  const link = await query<{ ok: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM encounter_history e WHERE e.user_a_id = $1 AND e.user_b_id = $2)
       OR EXISTS (SELECT 1 FROM dm_conversations c WHERE c.user_a_id = $1 AND c.user_b_id = $2)
     ) AS ok`,
    [a, b],
  );
  if (!link.rows[0]?.ok) {
    throw new ConflictError(ErrorCodes.VALIDATION_ERROR, 'You can record what happened once you two are connected.');
  }
  const outcomes = [...new Set(keys)];
  const inserted = await query<{ id: string; created_at: Date }>(
    `INSERT INTO meeting_outcomes (user_id, target_user_id, worth_continuing, outcome_keys)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [userId, targetId, worthContinuing, outcomes],
  );
  const row = inserted.rows[0];
  return { id: row.id, worthContinuing, outcomes, createdAt: row.created_at.toISOString() };
}
