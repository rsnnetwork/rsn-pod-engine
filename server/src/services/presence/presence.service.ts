// ─── App-level presence (8 Sep 2026, Ali; three states 11 Nov 2026, Shirley Palmer's RSN 07) ─────────────
//
// "Online" must mean the member is actually on the platform right now, not that a socket is lingering from a
// backgrounded or stale tab. The client emits `presence:ping` while the app is open and in the foreground; we stamp a
// Redis key with a short TTL, so a member reads as online only while those pings keep arriving.
//
// 11 Nov 2026: three states instead of two (shared PresenceState).
//   - online:  the key is there (a foreground ping in the last minute);
//   - away:    no key, but a live socket (REASON is open in a background tab or on a locked phone that still holds its
//              connection): a call still reaches them, by the banner and the bell;
//   - offline: no socket at all.
// A read that cannot tell (Redis down AND no socket server, or the socket lookup failing) leaves the member out of its
// answer, which every screen shows as "unknown", never as offline.
//
// Redis is the source of truth for "online" so this holds across multiple server instances (an in-process map would
// disagree between them; see the presence-staleness history). The sockets are asked across instances too, through the
// Socket.IO Redis adapter's fetchSockets. When Redis is unavailable each socket's own foreground flag
// (socket.data.foreground, set by its pings, cleared by its `presence:away`) stands in for the key.
//
// ONE INSTANCE ASSUMED WITHOUT REDIS. "Never offline wrongly without Redis" holds only while the API runs as a single
// Render instance (render.yaml today). With Redis down there is no Socket.IO Redis adapter either, so fetchSockets sees
// this instance's sockets only: a member connected to ANOTHER instance would read "offline", and requestCall would
// refuse to ring them. Before running more than one instance, either keep Redis a hard requirement for presence, or
// read "no socket here and no Redis" as unknown (null) instead of offline.
//
// The key is `rsn:presence:<userId>` (CLAUDE.md §9: every key under its domain, every key with a TTL). It was
// `presence:app:<userId>` before 11 Nov 2026; an old key lapses within its minute, and every client pings again as it
// reconnects to the new server, so the rename needs no fallback read.

import type { PresenceState } from '@rsn/shared';
import { getRedisClient } from '../redis/redis.client';
import { getRealtimeIo } from '../../realtime/emit';
import logger from '../../config/logger';

const key = (userId: string) => `rsn:presence:${userId}`;
// A little over twice the client's 25s ping cadence, so one missed ping doesn't
// flap someone offline.
export const PRESENCE_TTL_SECONDS = 60;
/** The most people one presence read answers for: an inbox is paged far below this. */
export const PRESENCE_READ_MAX = 500;

/**
 * Stamp this member as in front of REASON now. `true` when they were not online a moment ago (the key was not there:
 * a change the people who can see them are told of), `false` when it only kept them online, `null` when Redis is
 * unavailable (nothing stamped; the socket's own flag stands in).
 */
export async function markActive(userId: string): Promise<boolean | null> {
  const r = getRedisClient();
  if (!r) return null;
  try {
    const set = await r.set(key(userId), '1', 'EX', PRESENCE_TTL_SECONDS, 'NX');
    if (set === 'OK') return true;
    // The key was there a moment ago; if it lapsed between the SET and this EXPIRE (EXPIRE answers 0), stamp it again,
    // or a member who is pinging would read away until their next ping.
    if ((await r.expire(key(userId), PRESENCE_TTL_SECONDS)) === 1) return false;
    return (await r.set(key(userId), '1', 'EX', PRESENCE_TTL_SECONDS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn({ err, userId }, 'presence markActive failed (non-fatal)');
    return null;
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

/**
 * Clear "online" at once: their last socket went, or none of their tabs is in front of them any more. `true` when they
 * were online a moment ago, `false` when they were not, `null` when Redis is unavailable.
 */
export async function clearActive(userId: string): Promise<boolean | null> {
  const r = getRedisClient();
  if (!r) return null;
  try {
    return (await r.del(key(userId))) > 0;
  } catch (err) {
    logger.warn({ err, userId }, 'presence clearActive failed (non-fatal)');
    return null;
  }
}

/** Who of these has the key, in one round trip; null when Redis is unavailable or failed. */
async function onlineByKey(userIds: string[]): Promise<Record<string, boolean> | null> {
  const r = getRedisClient();
  if (!r) return null;
  try {
    const values = await r.mget(...userIds.map(key));
    const out: Record<string, boolean> = {};
    userIds.forEach((id, i) => { out[id] = values[i] !== null; });
    return out;
  } catch (err) {
    logger.warn({ err }, 'presence key read failed (non-fatal)');
    return null;
  }
}

/** For each member with a live socket anywhere: whether one of those sockets is in front of them. Null when unknown. */
async function socketsByMember(userIds: string[]): Promise<Map<string, { foreground: boolean }> | null> {
  const io = getRealtimeIo();
  if (!io) return null;
  try {
    const wanted = new Set(userIds.map((id) => `user:${id}`));
    const sockets = await io.in([...wanted]).fetchSockets();
    const out = new Map<string, { foreground: boolean }>();
    for (const s of sockets) {
      const foreground = (s.data as { foreground?: unknown } | undefined)?.foreground === true;
      for (const room of s.rooms) {
        if (!wanted.has(room)) continue;
        const id = room.slice('user:'.length);
        out.set(id, { foreground: (out.get(id)?.foreground ?? false) || foreground });
      }
    }
    return out;
  } catch (err) {
    logger.warn({ err, count: userIds.length }, 'presence socket lookup failed (non-fatal)');
    return null;
  }
}

/**
 * Where each of these members is now (PresenceState). A member the read could not place is left out: unknown, which a
 * screen never shows as offline. At most PRESENCE_READ_MAX are asked about.
 */
export async function presenceOf(userIds: string[]): Promise<Record<string, PresenceState>> {
  const out: Record<string, PresenceState> = {};
  const uniq = [...new Set(userIds.filter(Boolean))].slice(0, PRESENCE_READ_MAX);
  if (uniq.length === 0) return out;
  const byKey = await onlineByKey(uniq);
  if (byKey) uniq.forEach((id) => { if (byKey[id]) out[id] = 'online'; });
  const rest = uniq.filter((id) => !out[id]);
  if (rest.length === 0) return out;
  const sockets = await socketsByMember(rest);
  if (!sockets) return out;
  for (const id of rest) {
    const live = sockets.get(id);
    // With the key answering, a socket without it is away; without Redis, the socket's own flag says which.
    out[id] = !live ? 'offline' : !byKey && live.foreground ? 'online' : 'away';
  }
  return out;
}

/** One member's PresenceState, or null when the read could not tell. */
export async function presenceState(userId: string): Promise<PresenceState | null> {
  return (await presenceOf([userId]))[userId] ?? null;
}
