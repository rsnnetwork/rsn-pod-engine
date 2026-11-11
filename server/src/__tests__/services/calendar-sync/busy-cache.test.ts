// ─── Calendar free/busy: the busy-time cache keeps nothing past 30 minutes, and keeps little (S8 review I1) ──────────

jest.mock('../../../config/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const store = new Map<string, { value: string; ex: number | null }>();
let redisOn = true;
const fakeRedis = {
  get: async (k: string) => store.get(k)?.value ?? null,
  set: async (k: string, value: string, ...rest: unknown[]) => {
    if (rest.includes('NX') && store.has(k)) return null;
    const at = rest.indexOf('EX');
    store.set(k, { value, ex: at >= 0 ? Number(rest[at + 1]) : null });
    return 'OK';
  },
  del: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length,
};
jest.mock('../../../services/redis/redis.client', () => ({ __esModule: true, getRedisClient: () => (redisOn ? fakeRedis : null) }));

import {
  BUSY_MAX_AGE_MS, MAX_ENTRIES, busyKey, forgetBusy, keyTtlSeconds, readBusy, writeBusy,
} from '../../../services/calendar-sync/busy-cache';

const U = 'a0000000-0000-4000-8000-0000000000a1';
const T0 = Date.parse('2026-12-01T09:00:00Z');
const MIN = 60_000;
const busy = [{ start: '2026-12-01T10:00:00.000Z', end: '2026-12-01T11:00:00.000Z' }];

beforeEach(() => { store.clear(); redisOn = true; });

describe('the busy-time cache', () => {
  it('serves a range while it is under 30 minutes old and refuses it after, whatever Redis still holds', async () => {
    await writeBusy(U, 'google', 'f1', busy, T0);
    expect(await readBusy(U, 'google', 'f1', T0 + 29 * MIN)).toEqual({ at: T0, busy });
    expect(await readBusy(U, 'google', 'f1', T0 + BUSY_MAX_AGE_MS)).toBeNull();
    expect(store.has(busyKey(U, 'google'))).toBe(true); // still in the fake: only the read's own rule refused it
    expect(await readBusy(U, 'google', 'other', T0)).toBeNull();
  });

  it('sets the key to expire 30 minutes after its OLDEST entry, so a new write never extends an older one', async () => {
    await writeBusy(U, 'google', 'f1', busy, T0);
    expect(store.get(busyKey(U, 'google'))!.ex).toBe(1800);
    await writeBusy(U, 'google', 'f2', busy, T0 + 10 * MIN);
    expect(store.get(busyKey(U, 'google'))!.ex).toBe(1200); // f1 has 20 minutes left: the key goes with it
    // Once f1 is past 30 minutes it is dropped on the next write, and the key follows f2.
    await writeBusy(U, 'google', 'f3', busy, T0 + 31 * MIN);
    const entries = JSON.parse(store.get(busyKey(U, 'google'))!.value).entries as Array<{ field: string }>;
    expect(entries.map((e) => e.field)).toEqual(['f3', 'f2']);
    expect(store.get(busyKey(U, 'google'))!.ex).toBe(Math.floor((T0 + 10 * MIN + BUSY_MAX_AGE_MS - (T0 + 31 * MIN)) / 1000));
  });

  it('keeps at most four ranges per member per provider, newest first, and one entry per range', async () => {
    for (let i = 0; i < 9; i++) await writeBusy(U, 'microsoft', `f${i}`, busy, T0 + i * 1000);
    await writeBusy(U, 'microsoft', 'f8', busy, T0 + 20_000);
    const entries = JSON.parse(store.get(busyKey(U, 'microsoft'))!.value).entries as Array<{ field: string; at: number }>;
    expect(entries.map((e) => e.field)).toEqual(['f8', 'f7', 'f6', 'f5']);
    expect(entries).toHaveLength(MAX_ENTRIES);
  });

  it('holds only when, never what: each entry is its range, when it was read and the busy stretches', async () => {
    await writeBusy(U, 'google', 'f1', busy, T0);
    const entries = JSON.parse(store.get(busyKey(U, 'google'))!.value).entries as object[];
    expect(Object.keys(entries[0]).sort()).toEqual(['at', 'busy', 'field']);
  });

  it('a ttl is never under a second, and a disconnect deletes the key', async () => {
    expect(keyTtlSeconds([{ at: T0, busy }], T0 + BUSY_MAX_AGE_MS + 5000)).toBe(1);
    await writeBusy(U, 'google', 'f1', busy, T0);
    await forgetBusy(U, ['google']);
    expect(store.size).toBe(0);
  });

  it('without Redis nothing is cached and nothing fails', async () => {
    redisOn = false;
    await writeBusy(U, 'google', 'f1', busy, T0);
    expect(await readBusy(U, 'google', 'f1', T0)).toBeNull();
    await expect(forgetBusy(U, ['google'])).resolves.toBeUndefined();
  });
});
