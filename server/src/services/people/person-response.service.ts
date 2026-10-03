// ─── Save / Pass on a person (REASON milestone 1, 29 Sep 2026) ───────────────
// Save = "maybe later": kept, and marked. Pass = "not relevant right now":
// hidden from For You until undone. One row per (member, person); the latest
// choice wins. Private to the member who made it.

import { query } from '../../db';
import { ErrorCodes, type PersonResponse } from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';

export async function setResponse(userId: string, targetId: string, response: PersonResponse): Promise<void> {
  if (userId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot save or pass yourself');
  }
  const target = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [targetId]);
  if (target.rows.length === 0) throw new NotFoundError('User', targetId);
  await query(
    `INSERT INTO person_responses (user_id, target_user_id, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, target_user_id)
     DO UPDATE SET response = EXCLUDED.response, updated_at = NOW()`,
    [userId, targetId, response],
  );
}

export async function clearResponse(userId: string, targetId: string): Promise<void> {
  await query(`DELETE FROM person_responses WHERE user_id = $1 AND target_user_id = $2`, [userId, targetId]);
}

export async function getResponse(userId: string, targetId: string): Promise<PersonResponse | null> {
  const r = await query<{ response: PersonResponse }>(
    `SELECT response FROM person_responses WHERE user_id = $1 AND target_user_id = $2`,
    [userId, targetId],
  );
  return r.rows[0]?.response ?? null;
}
