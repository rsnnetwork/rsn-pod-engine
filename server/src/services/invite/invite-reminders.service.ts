// ─── How often an invite may be reminded, and how many reminders a member may send (fix round 3, 26 Oct 2026) ───────────
//
// Round 2 limited reminders to 60 requests an hour per member. A request is not a person: Remind All on the event page
// is one request that can email every invitee (a host could do that 60 times an hour), while the pod page's Remind All
// posts one request per invite (a third press within the hour, on a pod with 30 pending invites, failed red). The limit
// now counts what matters:
//
//   per invite  an invite reminded in the last hour is not emailed again, whoever asks (the host, a co-host, an admin,
//               the pod page's loop): the invitee has had a reminder within the hour;
//   per member  at most REMINDER_EMAILS_PER_HOUR reminder emails an hour, however many requests they come in.
//
// The state lives an hour, so it is kept in Redis (rsn:invite-reminded:<invite>, rsn:invite-reminders-sent:<member>, each
// with a life of an hour) and, where Redis is not configured or does not answer, in this process's memory: the same
// graceful step down the rate limits and presence take. A reminder is never refused because the ledger could not be
// reached. The claim on an invite is one SET ... NX, so two requests for it at the same moment send one email.

import type Redis from 'ioredis';
import logger from '../../config/logger';
import { getRedisClient } from '../redis/redis.client';

/** An invite that has been reminded is not emailed again for this long. */
export const REMINDER_COOLDOWN_SECONDS = 60 * 60;
/** A member sends at most REMINDER_EMAILS_PER_HOUR reminder emails in a window this long, counted from the first of them. */
const ALLOWANCE_WINDOW_SECONDS = 60 * 60;
/** A member sends at most this many reminder emails in an hour (emails, not requests: Remind All is many emails). */
export const REMINDER_EMAILS_PER_HOUR = 300;

/** A Remind All claims its invites this many at a time. */
const CLAIMS_AT_ONCE = 50;
/** The memory is swept of what has ended once it holds this many keys. */
const MEMORY_SWEEP_AT = 5000;

const remindedKey = (inviteId: string) => `rsn:invite-reminded:${inviteId}`;
const sentKey = (userId: string) => `rsn:invite-reminders-sent:${userId}`;

/** The few things the ledger asks of wherever it keeps its state. */
interface Store {
  /** Sets the key unless it is there; true when this call set it. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  del(keys: string[]): Promise<void>;
  /** Adds to a count that ends ttlSeconds after the moment it was first made (later additions do not stretch it). */
  add(key: string, by: number, ttlSeconds: number): Promise<void>;
}

// ─── Memory: what the system steps down to without Redis ─────────────────────────────────────

const memory = new Map<string, { value: string; expiresAt: number }>();

function live(key: string): { value: string; expiresAt: number } | undefined {
  const entry = memory.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return entry;
}

function sweepMemory(): void {
  if (memory.size < MEMORY_SWEEP_AT) return;
  const now = Date.now();
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
}

const memoryStore: Store = {
  async setIfAbsent(key, value, ttlSeconds) {
    if (live(key)) return false;
    sweepMemory();
    memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  },
  async get(key) {
    return live(key)?.value ?? null;
  },
  async del(keys) {
    for (const key of keys) memory.delete(key);
  },
  async add(key, by, ttlSeconds) {
    const entry = live(key);
    if (entry) {
      entry.value = String(Number(entry.value) + by);
      return;
    }
    sweepMemory();
    memory.set(key, { value: String(by), expiresAt: Date.now() + ttlSeconds * 1000 });
  },
};

// ─── Redis ──────────────────────────────────────────────────────────────────────────────────────

const redisStore = (redis: Redis): Store => ({
  async setIfAbsent(key, value, ttlSeconds) {
    return (await redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  },
  async get(key) {
    return redis.get(key);
  },
  async del(keys) {
    if (keys.length > 0) await redis.del(...keys);
  },
  async add(key, by, ttlSeconds) {
    // The count is made WITH its life first, then added to: a count can never be left without an end.
    await redis.set(key, '0', 'EX', ttlSeconds, 'NX');
    await redis.incrby(key, by);
  },
});

/** One step, on Redis when it is there and on memory when it is not or does not answer. */
async function withStore<T>(step: (store: Store) => Promise<T>): Promise<T> {
  const redis = getRedisClient();
  if (redis) {
    try {
      return await step(redisStore(redis));
    } catch (err) {
      logger.warn({ err }, 'Reminder ledger: Redis did not answer, carrying on in memory');
    }
  }
  return step(memoryStore);
}

/** The moment a claim was made, as it was stored; null when it cannot be read. */
function readTime(stored: string | null): Date | null {
  const ms = Number(stored);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

// ─── What the routes use ────────────────────────────────────────────────────────────────────────

export interface ReminderClaims {
  /** The invites that may be emailed now, in the order given: nobody has reminded them within the hour. */
  claimed: string[];
  /** The invites reminded within the hour already, with when (null when that cannot be read). */
  recent: Map<string, Date | null>;
}

/**
 * Claims the right to email a reminder for each of these invites, in the order given. An invite reminded within the hour
 * is not claimed and comes back in `recent`. With a `limit`, the claiming stops as soon as that many are claimed, and the
 * rest are left alone (not claimed, not looked at): invites already reminded do not use the limit up. Give a claim back
 * with releaseReminders when its email could not be sent.
 */
export async function claimReminders(inviteIds: string[], limit = Number.POSITIVE_INFINITY): Promise<ReminderClaims> {
  const claimed: string[] = [];
  const recent = new Map<string, Date | null>();
  const now = String(Date.now());
  let next = 0;
  while (next < inviteIds.length && claimed.length < limit) {
    const chunk = inviteIds.slice(next, next + Math.min(CLAIMS_AT_ONCE, limit - claimed.length));
    next += chunk.length;
    const won = await withStore((store) =>
      Promise.all(chunk.map((id) => store.setIfAbsent(remindedKey(id), now, REMINDER_COOLDOWN_SECONDS))));
    const lost: string[] = [];
    chunk.forEach((id, at) => {
      if (won[at]) claimed.push(id);
      else lost.push(id);
    });
    if (lost.length > 0) {
      const times = await withStore((store) => Promise.all(lost.map((id) => store.get(remindedKey(id)))));
      lost.forEach((id, at) => recent.set(id, readTime(times[at])));
    }
  }
  return { claimed, recent };
}

/** Gives claims back: their emails were not sent, so the invites are not "reminded within the hour". */
export async function releaseReminders(inviteIds: string[]): Promise<void> {
  if (inviteIds.length === 0) return;
  await withStore((store) => store.del(inviteIds.map(remindedKey)));
}

/** How many more reminder emails this member may send in the hour. */
export async function reminderAllowance(userId: string): Promise<number> {
  const stored = await withStore((store) => store.get(sentKey(userId)));
  const used = Number(stored ?? 0);
  return Math.max(0, REMINDER_EMAILS_PER_HOUR - (Number.isFinite(used) ? used : 0));
}

/** Counts reminder emails that went out against the member's allowance for the hour. */
export async function countRemindersSent(userId: string, emails: number): Promise<void> {
  if (emails <= 0) return;
  await withStore((store) => store.add(sentKey(userId), emails, ALLOWANCE_WINDOW_SECONDS));
}
