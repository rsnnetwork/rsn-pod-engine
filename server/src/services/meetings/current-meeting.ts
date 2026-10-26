// ─── The meeting a conversation names (26 Oct 2026) ──────────────────────────
//
// dm_conversations.current_meeting_id names the meetings row that the conversation's meeting_*
// columns describe (migration 110), and every server from 26 Oct writes the two together. The
// server before it books and moves meetings on the conversation alone and never touches the
// pointer. It still answers while a release deploys (the old instance serves until the new one
// has started), and again after a rollback, so it can leave the pointer at a row that no longer
// describes the conversation's meeting: one already over when it booked the next, one at the time
// it moved the meeting away from, or one cancelled.
//
// So the pointer is read through this guard wherever it is read: it names a meeting only while that
// row is scheduled and starts when the conversation says its meeting starts. A stale pointer reads
// as none: a booking writes a new row instead of moving a finished meeting, a cancel of the stale
// row leaves the conversation's own meeting standing, and no attendance is stamped on it.
//
// A guard where it is read, rather than a repair at startup: the old server writes after the new
// one has started (the deploy's overlap) or while no new server runs at all (a rollback), so a
// startup repair would come too early or not at all; and the guard writes nothing to anyone's rows.

import type { PoolClient } from 'pg';

/**
 * The guarded pointer, as a column of a query whose FROM is dm_conversations (not aliased).
 *
 * Never in a statement that locks the conversation row (lockConversation says why).
 */
export const CURRENT_MEETING_ID = `(SELECT m.id FROM meetings m
       WHERE m.id = dm_conversations.current_meeting_id
         AND m.status = 'scheduled'
         AND m.start_at = dm_conversations.meeting_start_at) AS current_meeting_id`;

/**
 * Lock the conversation row until the transaction ends, in a statement of its own; then read it,
 * with CURRENT_MEETING_ID, in the next statement.
 *
 * A statement that has to wait for the row lock re-reads that row at its newest version once the
 * lock is free, but reads everything else as of the moment it began. With the guard inside it, a
 * cancel or a Confirm that waited behind a booking or a move saw the conversation as that booking
 * left it and the meetings as they were before it: the meeting the booking had just written or
 * moved read as stale, so the waiting Confirm wrote a second meeting, and the waiting cancel left
 * the conversation naming the meeting it had cancelled (26 Oct 2026 review). The statement after
 * the lock begins after the booking it waited for has committed, and sees both as it left them.
 */
export async function lockConversation(client: Pick<PoolClient, 'query'>, conversationId: string): Promise<void> {
  await client.query(`SELECT 1 FROM dm_conversations WHERE id = $1 FOR UPDATE`, [conversationId]);
}
