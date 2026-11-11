// ─── Busy times, kept briefly in Redis (Shirley pilot S8, D7) ────────────────────────────────────────────────────────
//
// Key   rsn:calendar:busy:<userId>:<provider>      a hash; one field per range read, "<connectedAt>|<from>|<to>|<zone>"
// Value { at, busy: [{start, end}] }                 only when the person is busy: never a title, attendee or place
// TTL   30 minutes for the whole key. An entry is FRESH for 5 minutes (served without asking the provider) and STALE
//       after that, kept only to answer when the provider is down or limiting us.
// A disconnect deletes the key. A connect again starts a new connectedAt, so nothing read under the old grant is
// served under the new one. Without Redis (getRedisClient() is null) nothing is cached and every read asks the
// provider. Busy times are never written to Postgres.
//
// A ticket (oauth-envelope.ts) is spent once: rsn:calendar:ticket:<sha256> is set with NX for the ticket's lifetime.
// Without Redis an in-process set does it (one instance); the provider refuses a reused code in any case.

import type { CalendarBusyInterval, CalendarProvider } from '@rsn/shared';
import logger from '../../config/logger';
import { getRedisClient } from '../redis/redis.client';
import { ENVELOPE_LIFETIME_MS } from './oauth-envelope';

export const BUSY_FRESH_MS = 5 * 60 * 1000;
export const BUSY_KEEP_SECONDS = 30 * 60;

export const busyKey = (userId: string, provider: CalendarProvider) => `rsn:calendar:busy:${userId}:${provider}`;
export const busyField = (connectedAt: Date, from: number, to: number, zone: string) =>
  `${connectedAt.getTime()}|${from}|${to}|${zone}`;

export interface CachedBusy { at: number; busy: CalendarBusyInterval[] }

export async function readBusy(userId: string, provider: CalendarProvider, field: string): Promise<CachedBusy | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.hget(busyKey(userId, provider), field);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedBusy;
    if (typeof parsed?.at !== 'number' || !Array.isArray(parsed.busy)) return null;
    return Date.now() - parsed.at <= BUSY_KEEP_SECONDS * 1000 ? parsed : null;
  } catch (err) {
    logger.warn({ err, provider }, 'calendar busy cache: read failed');
    return null;
  }
}

export async function writeBusy(userId: string, provider: CalendarProvider, field: string, busy: CalendarBusyInterval[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const key = busyKey(userId, provider);
    await redis.hset(key, field, JSON.stringify({ at: Date.now(), busy } satisfies CachedBusy));
    await redis.expire(key, BUSY_KEEP_SECONDS);
  } catch (err) {
    logger.warn({ err, provider }, 'calendar busy cache: write failed');
  }
}

export async function forgetBusy(userId: string, providers: readonly CalendarProvider[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis || providers.length === 0) return;
  try {
    await redis.del(...providers.map((p) => busyKey(userId, p)));
  } catch (err) {
    logger.warn({ err }, 'calendar busy cache: delete failed');
  }
}

const spentHere = new Map<string, number>();

/** True the first time a ticket fingerprint is spent within its lifetime, false after. */
export async function spendTicketOnce(fingerprint: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const set = await redis.set(`rsn:calendar:ticket:${fingerprint}`, '1', 'PX', ENVELOPE_LIFETIME_MS, 'NX');
      return set === 'OK';
    } catch (err) {
      logger.warn({ err }, 'calendar ticket: Redis spend failed, spending in this process');
    }
  }
  const now = Date.now();
  for (const [k, until] of spentHere) if (until <= now) spentHere.delete(k);
  if (spentHere.has(fingerprint)) return false;
  spentHere.set(fingerprint, now + ENVELOPE_LIFETIME_MS);
  return true;
}
