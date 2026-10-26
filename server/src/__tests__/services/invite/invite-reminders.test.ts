// ─── How often an invite may be reminded, and how many reminders a member may send (fix round 3, 26 Oct 2026) ───────────
//
// Round 2 limited reminders to 60 REQUESTS an hour per member. A request is not a person: Remind All on the event page is one
// request that can email every invitee (a host could do that 60 times an hour), while the pod page's Remind All posts one
// request per invite (a third press within the hour, on a pod with 30 pending invites, failed red). The limit now counts
// what matters: an invite reminded in the last hour is not emailed again, and a member sends at most 300 reminder EMAILS
// an hour, however many requests they come in.
//
// The state lives an hour, so it is kept in Redis and, where Redis is not there or does not answer, in the process's
// memory. Both are run through the same tests below.

const mockGetRedisClient = jest.fn();
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => mockGetRedisClient(),
  __esModule: true,
}));

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../../config/logger', () => ({ default: mockLogger, __esModule: true }));

import {
  claimReminders, releaseReminders, reminderAllowance, countRemindersSent,
  REMINDER_COOLDOWN_SECONDS, REMINDER_EMAILS_PER_HOUR,
} from '../../../services/invite/invite-reminders.service';

/** The few commands the ledger uses, with Redis's rules: SET ... EX n NX sets only a key that is not there, keys end. */
function fakeRedis() {
  const keys = new Map<string, { value: string; expiresAt: number | null }>();
  const commands: string[] = [];
  const alive = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) { keys.delete(key); return undefined; }
    return entry;
  };
  return {
    keys, commands, failing: false,
    async set(key: string, value: string, ...options: Array<string | number>) {
      if (this.failing) throw new Error('Redis is down');
      commands.push(`set ${key} ${options.join(' ')}`);
      const ex = options.indexOf('EX');
      const nx = options.includes('NX');
      if (nx && alive(key)) return null;
      keys.set(key, { value, expiresAt: ex >= 0 ? Date.now() + Number(options[ex + 1]) * 1000 : null });
      return 'OK';
    },
    async get(key: string) {
      if (this.failing) throw new Error('Redis is down');
      commands.push(`get ${key}`);
      return alive(key)?.value ?? null;
    },
    async del(...names: string[]) {
      if (this.failing) throw new Error('Redis is down');
      commands.push(`del ${names.join(' ')}`);
      return names.filter((name) => keys.delete(name)).length;
    },
    async incrby(key: string, by: number) {
      if (this.failing) throw new Error('Redis is down');
      commands.push(`incrby ${key} ${by}`);
      const entry = alive(key);
      const next = Number(entry?.value ?? 0) + by;
      keys.set(key, { value: String(next), expiresAt: entry ? entry.expiresAt : null });
      return next;
    },
  };
}

let serial = 0;
/** Every test names its own invites and members: the memory the ledger falls back on lives as long as the process. */
const invites = (n: number) => Array.from({ length: n }, () => { serial += 1; return `invite-${serial}`; });
const member = () => { serial += 1; return `member-${serial}`; };
const at = (iso: string) => jest.setSystemTime(new Date(iso));

let redis: ReturnType<typeof fakeRedis>;

beforeEach(() => {
  jest.useFakeTimers();
  at('2026-10-26T08:00:00.000Z');
  redis = fakeRedis();
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});
afterEach(() => {
  jest.useRealTimers();
});

describe.each([['memory (no Redis configured)', false], ['Redis', true]])('the reminder ledger, on %s', (_where, useRedis) => {
  beforeEach(() => {
    mockGetRedisClient.mockReturnValue(useRedis ? redis : null);
  });

  describe('an invite reminded in the last hour is not reminded again', () => {
    it('the first reminder of an invite is claimed', async () => {
      const [a] = invites(1);
      const result = await claimReminders([a]);
      expect(result.claimed).toEqual([a]);
      expect([...result.recent.keys()]).toEqual([]);
    });

    it('a second one within the hour is not, and says when the first was', async () => {
      const [a] = invites(1);
      await claimReminders([a]);
      at('2026-10-26T08:25:00.000Z');
      const again = await claimReminders([a]);
      expect(again.claimed).toEqual([]);
      expect(again.recent.get(a)).toEqual(new Date('2026-10-26T08:00:00.000Z'));
    });

    it('after the hour it can be reminded again, and the hour starts from that reminder', async () => {
      const [a] = invites(1);
      await claimReminders([a]);
      at('2026-10-26T08:59:59.000Z');
      expect((await claimReminders([a])).claimed).toEqual([]);
      at('2026-10-26T09:00:01.000Z');
      expect((await claimReminders([a])).claimed).toEqual([a]);
      at('2026-10-26T09:30:00.000Z');
      expect((await claimReminders([a])).claimed).toEqual([]);
    });

    it('whoever asks: the claim is the invite\'s, not the person\'s', async () => {
      // The ledger is not told who asks; the host, a co-host, an admin and the pod page\'s loop all meet the same one.
      const [a] = invites(1);
      expect(REMINDER_COOLDOWN_SECONDS).toBe(3600);
      await claimReminders([a]);
      expect((await claimReminders([a])).claimed).toEqual([]);
    });

    it('a claim given back (the email could not be sent) can be made again at once', async () => {
      const [a] = invites(1);
      await claimReminders([a]);
      await releaseReminders([a]);
      expect((await claimReminders([a])).claimed).toEqual([a]);
    });

    it('giving back what was never claimed, or nothing, is harmless', async () => {
      await expect(releaseReminders(invites(2))).resolves.toBeUndefined();
      await expect(releaseReminders([])).resolves.toBeUndefined();
    });

    it('two requests at the same moment for one invite: exactly one wins, so it is emailed once', async () => {
      const [a] = invites(1);
      const [first, second] = await Promise.all([claimReminders([a]), claimReminders([a])]);
      expect(first.claimed.length + second.claimed.length).toBe(1);
      expect(first.recent.size + second.recent.size).toBe(1);
    });

    it('a list: the ones due are claimed in the order given, the ones reminded within the hour are named with their time', async () => {
      const [a, b, c, d] = invites(4);
      await claimReminders([b]);
      at('2026-10-26T08:10:00.000Z');
      await claimReminders([d]);
      at('2026-10-26T08:20:00.000Z');
      const result = await claimReminders([a, b, c, d]);
      expect(result.claimed).toEqual([a, c]);
      expect([...result.recent.entries()]).toEqual([[b, new Date('2026-10-26T08:00:00.000Z')], [d, new Date('2026-10-26T08:10:00.000Z')]]);
    });

    it('a limit claims at most that many and leaves the rest unclaimed, so they can still be reminded', async () => {
      const ids = invites(5);
      const result = await claimReminders(ids, 3);
      expect(result.claimed).toEqual(ids.slice(0, 3));
      expect((await claimReminders(ids.slice(3))).claimed).toEqual(ids.slice(3));
    });

    it('invites already reminded do not use up the limit: it is spent on invites that are due', async () => {
      const ids = invites(5);
      await claimReminders(ids.slice(0, 2));
      const result = await claimReminders(ids, 2);
      expect(result.claimed).toEqual([ids[2], ids[3]]);
      expect([...result.recent.keys()]).toEqual([ids[0], ids[1]]);
      // The fifth was never asked about.
      expect((await claimReminders([ids[4]])).claimed).toEqual([ids[4]]);
    });

    it('a limit of nothing claims nothing', async () => {
      const ids = invites(3);
      const result = await claimReminders(ids, 0);
      expect(result.claimed).toEqual([]);
      expect(result.recent.size).toBe(0);
      expect((await claimReminders(ids)).claimed).toEqual(ids);
    });

    it('a long list (many more than are claimed at once) is claimed whole, in order', async () => {
      const ids = invites(130);
      const result = await claimReminders(ids);
      expect(result.claimed).toEqual(ids);
    });

    it('...and a limit inside a long list stops exactly there', async () => {
      const ids = invites(130);
      const result = await claimReminders(ids, 75);
      expect(result.claimed).toEqual(ids.slice(0, 75));
      expect((await claimReminders(ids.slice(75))).claimed).toEqual(ids.slice(75));
    });

    it('an empty list claims nothing', async () => {
      const result = await claimReminders([]);
      expect(result.claimed).toEqual([]);
      expect(result.recent.size).toBe(0);
    });
  });

  describe('a member sends at most 300 reminder emails an hour', () => {
    it('has the whole allowance to begin with', async () => {
      expect(REMINDER_EMAILS_PER_HOUR).toBe(300);
      await expect(reminderAllowance(member())).resolves.toBe(300);
    });

    it('counts emails, not requests: 120 in one go leave 180', async () => {
      const who = member();
      await countRemindersSent(who, 120);
      await expect(reminderAllowance(who)).resolves.toBe(180);
      await countRemindersSent(who, 1);
      await expect(reminderAllowance(who)).resolves.toBe(179);
    });

    it('never goes below nothing, however far over it is counted', async () => {
      const who = member();
      await countRemindersSent(who, 250);
      await countRemindersSent(who, 100);
      await expect(reminderAllowance(who)).resolves.toBe(0);
    });

    it('is each member\'s own', async () => {
      const [ann, bob] = [member(), member()];
      await countRemindersSent(ann, 300);
      await expect(reminderAllowance(ann)).resolves.toBe(0);
      await expect(reminderAllowance(bob)).resolves.toBe(300);
    });

    it('comes back an hour after the first email of the hour, and later emails do not stretch it', async () => {
      const who = member();
      await countRemindersSent(who, 100);
      at('2026-10-26T08:40:00.000Z');
      await countRemindersSent(who, 200);
      await expect(reminderAllowance(who)).resolves.toBe(0);
      at('2026-10-26T08:59:00.000Z');
      await expect(reminderAllowance(who)).resolves.toBe(0);
      at('2026-10-26T09:01:00.000Z');
      await expect(reminderAllowance(who)).resolves.toBe(300);
    });

    it('counting nothing, or less, changes nothing', async () => {
      const who = member();
      await countRemindersSent(who, 0);
      await countRemindersSent(who, -5);
      await expect(reminderAllowance(who)).resolves.toBe(300);
    });
  });
});

describe('what is written to Redis', () => {
  beforeEach(() => {
    mockGetRedisClient.mockReturnValue(redis);
  });

  it('each invite has one key, prefixed with its domain, that lives an hour and holds the time of the reminder', async () => {
    const [a] = invites(1);
    await claimReminders([a]);
    const key = `rsn:invite-reminded:${a}`;
    expect(redis.commands).toContain(`set ${key} EX 3600 NX`);
    expect(redis.keys.get(key)).toEqual({ value: String(new Date('2026-10-26T08:00:00.000Z').getTime()), expiresAt: Date.now() + 3600 * 1000 });
  });

  it('a member\'s count is made WITH its hour before anything is added to it, so no count can be left without an end', async () => {
    const who = member();
    await countRemindersSent(who, 7);
    const key = `rsn:invite-reminders-sent:${who}`;
    const made = redis.commands.findIndex((c) => c === `set ${key} EX 3600 NX`);
    const added = redis.commands.findIndex((c) => c === `incrby ${key} 7`);
    expect(made).toBeGreaterThanOrEqual(0);
    expect(added).toBeGreaterThan(made);
    expect(redis.keys.get(key)?.expiresAt).toBe(Date.now() + 3600 * 1000);
  });

  it('only what a claim lost is read back for its time (one read each), and nothing for a claim that won', async () => {
    const [a, b] = invites(2);
    await claimReminders([a]);
    redis.commands.length = 0;
    await claimReminders([a, b]);
    expect(redis.commands.filter((c) => c.startsWith('get '))).toEqual([`get rsn:invite-reminded:${a}`]);
  });

  it('giving claims back deletes their keys', async () => {
    const [a, b] = invites(2);
    await claimReminders([a, b]);
    await releaseReminders([a, b]);
    expect(redis.keys.has(`rsn:invite-reminded:${a}`)).toBe(false);
    expect(redis.keys.has(`rsn:invite-reminded:${b}`)).toBe(false);
  });

  it('a count that is not a number is read as nothing sent, not as a block', async () => {
    const who = member();
    redis.keys.set(`rsn:invite-reminders-sent:${who}`, { value: 'garbage', expiresAt: null });
    await expect(reminderAllowance(who)).resolves.toBe(300);
  });

  it('a reminder time that cannot be read is null, and the invite is still not reminded again', async () => {
    const [a] = invites(1);
    redis.keys.set(`rsn:invite-reminded:${a}`, { value: 'garbage', expiresAt: Date.now() + 3600 * 1000 });
    const result = await claimReminders([a]);
    expect(result.claimed).toEqual([]);
    expect(result.recent.get(a)).toBeNull();
  });
});

describe('when Redis does not answer', () => {
  beforeEach(() => {
    redis.failing = true;
    mockGetRedisClient.mockReturnValue(redis);
  });

  it('a reminder is never refused for that: the ledger carries on in memory, and says so in the log', async () => {
    const [a] = invites(1);
    const first = await claimReminders([a]);
    expect(first.claimed).toEqual([a]);
    expect(mockLogger.warn).toHaveBeenCalled();
    // ...and the memory it fell back on holds the claim, so the invite is still not reminded twice by this process.
    const second = await claimReminders([a]);
    expect(second.claimed).toEqual([]);
  });

  it('the allowance and the count carry on in memory too', async () => {
    const who = member();
    await expect(reminderAllowance(who)).resolves.toBe(300);
    await countRemindersSent(who, 40);
    await expect(reminderAllowance(who)).resolves.toBe(260);
  });

  it('giving a claim back never throws', async () => {
    await expect(releaseReminders(invites(2))).resolves.toBeUndefined();
  });
});
