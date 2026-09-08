// ─── App-level presence (8 Sep 2026, Ali) ───────────────────────────────────
//
// "Online" must mean the member is actually on the platform right now, not that
// a socket is lingering from a backgrounded or stale tab. The client emits
// `presence:ping` while the app is open and in the foreground; we stamp a Redis
// key with a short TTL, so a member reads as online only while those pings keep
// arriving. When they close or background the app the pings stop and the key
// expires within a minute.
//
// Redis is the source of truth so this holds across multiple server instances
// (an in-process map would disagree between them — see the presence-staleness
// history). When Redis is unavailable we return `null` = "unknown", and callers
// fall back to a live socket check.

import { getRedisClient } from '../redis/redis.client';
import logger from '../../config/logger';

const key = (userId: string) => `presence:app:${userId}`;
// A little over twice the client's 25s ping cadence, so one missed ping doesn't
// flap someone offline.
export const PRESENCE_TTL_SECONDS = 60;

/** Stamp this member as active-now. No-op (safe) when Redis is down. */
export async function markActive(userId: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  try {
    await r.set(key(userId), '1', 'EX', PRESENCE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, userId }, 'presence markActive failed (non-fatal)');
  }
}

/**
 * Is the member active on the platform right now?
 *  - true / false when Redis answered
 *  - null when Redis is unavailable, so the caller can fall back to a socket check
 */
export async function isActive(userId: string): Promise<boolean | null> {
  const r = getRedisClient();
  if (!r) return null;
  try {
    return (await r.exists(key(userId))) === 1;
  } catch (err) {
    logger.warn({ err, userId }, 'presence isActive failed (non-fatal)');
    return null;
  }
}

/** Clear presence immediately — used when a member's last socket disconnects
 *  (they closed the app), so they don't linger "online" for the TTL. */
export async function clearActive(userId: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  try {
    await r.del(key(userId));
  } catch (err) {
    logger.warn({ err, userId }, 'presence clearActive failed (non-fatal)');
  }
}

/** Batch presence for a set of members → { userId: online }. Empty map when
 *  Redis is unavailable (dots simply don't show during an outage). */
export async function areActive(userIds: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const r = getRedisClient();
  if (!r || userIds.length === 0) return out;
  try {
    const uniq = [...new Set(userIds)];
    const results = await Promise.all(uniq.map((id) => r.exists(key(id))));
    uniq.forEach((id, i) => { out[id] = results[i] === 1; });
  } catch (err) {
    logger.warn({ err }, 'presence areActive failed (non-fatal)');
  }
  return out;
}
