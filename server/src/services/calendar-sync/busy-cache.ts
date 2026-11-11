// ─── Busy times, kept briefly in Redis (Shirley pilot S8, D7; S8 review I1) ──────────────────────────────────────────
//
// Key    rsn:calendar:busy:<userId>:<provider>        one string per member per provider
// Value  { entries: [{ field, at, busy }] }            at most MAX_ENTRIES ranges, newest first; `field` is
//                                                     "<connectedAt>|<from>|<to>|<zone>", `busy` only when the person is
//                                                     busy: never a title, attendee or place
// Every entry is thrown away 30 minutes after it was fetched (`at`), and the key's own TTL is set from its OLDEST entry,
// so no busy time is held anywhere for more than 30 minutes after it was read from the provider: a newer write never
// extends an older entry's life. Reads refuse anything older than 30 minutes, whatever Redis still holds. An entry is
// FRESH for 5 minutes (served without asking the provider) and STALE after that, kept only to answer while the provider
// is down or limiting us. A disconnect deletes the key. A connect again starts a new connectedAt, so nothing read under
// the old grant is served under the new one. Without Redis (getRedisClient() is null) nothing is cached and every read
// asks the provider. Busy times are never written to Postgres.
//
// A ticket (oauth-envelope.ts) is spent once: rsn:calendar:ticket:<sha256> is set with NX for the ticket's lifetime.
// Without Redis an in-process set does it (one instance); the provider refuses a reused code in any case.

import type { CalendarBusyInterval, CalendarProvider } from '@rsn/shared';
import logger from '../../config/logger';
import { getRedisClient } from '../redis/redis.client';
import { ENVELOPE_LIFETIME_MS } from './oauth-envelope';

export const BUSY_FRESH_MS = 5 * 60 * 1000;
/** The hard limit: no busy time is kept more than this after it was fetched. The consent text and the checklist say so. */
export const BUSY_MAX_AGE_MS = 30 * 60 * 1000;
/** At most this many ranges are kept per member per provider (the picker asks one range an hour, per time zone). */
export const MAX_ENTRIES = 4;

export const busyKey = (userId: string, provider: CalendarProvider) => `rsn:calendar:busy:${userId}:${provider}`;
export const busyField = (connectedAt: Date, from: number, to: number, zone: string) =>
  `${connectedAt.getTime()}|${from}|${to}|${zone}`;

export interface CachedBusy { at: number; busy: CalendarBusyInterval[] }
interface Entry extends CachedBusy { field: string }

const young = (e: Entry, now: number) => typeof e?.at === 'number' && now - e.at < BUSY_MAX_AGE_MS && Array.isArray(e.busy);

/** The entries still under 30 minutes old, newest first. */
function entriesOf(raw: string | null, now: number): Entry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed?.entries)) return [];
    return (parsed.entries as Entry[]).filter((e) => typeof e?.field === 'string' && young(e, now)).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function readBusy(userId: string, provider: CalendarProvider, field: string, now: number = Date.now()): Promise<CachedBusy | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const hit = entriesOf(await redis.get(busyKey(userId, provider)), now).find((e) => e.field === field);
    return hit ? { at: hit.at, busy: hit.busy } : null;
  } catch (err) {
    logger.warn({ err, provider }, 'calendar busy cache: read failed');
    return null;
  }
}

/** Seconds the key may live: until its OLDEST entry turns 30 minutes old (at least one second). */
export function keyTtlSeconds(entries: readonly CachedBusy[], now: number): number {
  const oldest = Math.min(...entries.map((e) => e.at));
  return Math.max(1, Math.floor((oldest + BUSY_MAX_AGE_MS - now) / 1000));
}

export async function writeBusy(userId: string, provider: CalendarProvider, field: string, busy: CalendarBusyInterval[], now: number = Date.now()): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const key = busyKey(userId, provider);
    const kept = entriesOf(await redis.get(key), now).filter((e) => e.field !== field);
    const entries: Entry[] = [{ field, at: now, busy }, ...kept].slice(0, MAX_ENTRIES);
    await redis.set(key, JSON.stringify({ entries }), 'EX', keyTtlSeconds(entries, now));
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
