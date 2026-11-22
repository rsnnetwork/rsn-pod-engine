// ─── When a member last had REASON in front of them (22 Nov 2026) ─────────────────────────────────────────────
//
// users.last_seen_at (migration 160) is stamped from the foreground presence ping (presence-socket.ts), so the
// notification email gate can tell "was on REASON since this happened" from "was away the whole time" (Stefan: "I
// should only get notifications if I am not online on the platform"). The presence key in Redis only says "online right
// now" and lapses within a minute; this keeps the moment.
//
// A ping comes every 25 seconds from every open tab in front of its member, so the stamp is written at most once per
// STAMP_EVERY_MS per member on this instance, and never awaited by the ping. A failed write is logged and forgotten:
// the next ping writes again.

import { query } from '../../db';
import logger from '../../config/logger';

export const STAMP_EVERY_MS = 60_000;
/** Members remembered between stamps; past this the map starts over (each member then stamps once more). */
const REMEMBERED_MAX = 20_000;

const stampedAt = new Map<string, number>();

/** Whether a member last stamped at `last` (or never) should be stamped again at `now`. */
export function dueForStamp(last: number | undefined, now: number): boolean {
  return last === undefined || now - last >= STAMP_EVERY_MS;
}

/** Note that the member has REASON in front of them now. Never throws, never waits on the database for the caller. */
export function noteSeen(userId: string, now: number = Date.now()): void {
  if (!dueForStamp(stampedAt.get(userId), now)) return;
  if (stampedAt.size >= REMEMBERED_MAX) stampedAt.clear();
  stampedAt.set(userId, now);
  Promise.resolve().then(() => query(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [userId])).catch((err) => {
    stampedAt.delete(userId);
    logger.warn({ err, userId }, 'last_seen_at stamp failed (non-fatal)');
  });
}

/** Tests only: forget every stamp. */
export function __resetLastSeenForTests(): void {
  stampedAt.clear();
}
