// ─── Already met (REASON, Stefan 10 Nov 2026) ────────────────────────────────
// "I don't see a button to categorise people as folks I have already met (outside the platform)." A member marks
// a person they have met elsewhere, and that person stops being suggested to them: not in For You, not in their
// searches. It is private to the marker and one-sided (the other person's suggestions do not change). It is
// not a connection: it writes no encounter_history row, so a meeting request to the person still goes through.

import { query } from '../../db';
import { ErrorCodes } from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';

export async function markAlreadyMet(userId: string, targetId: string): Promise<void> {
  if (userId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot mark yourself as met');
  }
  const target = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [targetId]);
  if (target.rows.length === 0) throw new NotFoundError('User', targetId);
  // Marking twice is the same as marking once.
  await query(
    `INSERT INTO already_met (user_id, target_user_id) VALUES ($1, $2)
     ON CONFLICT (user_id, target_user_id) DO NOTHING`,
    [userId, targetId],
  );
  // Searches store their results, so the person is taken off the member's own searches now; a later rescore
  // keeps them off (loadCandidatesFor reads already_met).
  await query(
    `DELETE FROM agent_matches am
      USING matching_agents a
      WHERE am.agent_id = a.id AND a.user_id = $1 AND am.candidate_user_id = $2`,
    [userId, targetId],
  );
}

export async function unmarkAlreadyMet(userId: string, targetId: string): Promise<void> {
  await query(`DELETE FROM already_met WHERE user_id = $1 AND target_user_id = $2`, [userId, targetId]);
}

export async function isAlreadyMet(userId: string, targetId: string): Promise<boolean> {
  const r = await query<{ marked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM already_met WHERE user_id = $1 AND target_user_id = $2) AS marked`,
    [userId, targetId],
  );
  return r.rows[0]?.marked === true;
}
