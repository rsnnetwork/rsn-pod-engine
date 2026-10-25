// ─── A meeting changed: tell both people's screens (26 Oct 2026) ─────────────
//
// Booked, moved, cancelled, attended or reminded: each person is sent their own meetings list
// (user:<id>:meetings, the Events list and its count) and the meeting itself (meeting:<id>, its page).
// Best-effort: the change is already saved, and a socket hiccup must never look like it failed.

import logger from '../../config/logger';

export async function emitMeetingChanged(meetingId: string, userIds: string[]): Promise<void> {
  try {
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await Promise.all([...new Set(userIds)].filter(Boolean).map((userId) =>
      emitEntities(io, [userId], [E.userMeetings(userId), E.meeting(meetingId)])));
  } catch (err) {
    logger.warn({ err, meetingId }, 'meeting entity emit failed (non-fatal)');
  }
}
