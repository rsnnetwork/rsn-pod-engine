// ─── Who may override an event's group rules: the owner chooses (Part 3 Task 12; product owner, 11 Nov 2026) ───────
//
// "THE EVENT OWNER, AND I AM NOT ABLE TO CHOOSE IN THE GROUPS WHO CAN DO IT - I SHOULD". event_matching_rules.override_by
// (migration 147) holds the owner's choice: 'owner' (the event's owner, host_user_id, and super admins: the rule before
// this choice existed, and the rule when nothing was chosen) or 'owner_and_cohosts' (the event's co-hosts too). It is
// read from the database on every request, never from the token. A pod director who is not a co-host of the event, a
// moderator and a platform admin gain nothing from it.
//
// Here: mayOverrideGroupRules (services/matching/live-room-guard.ts), which the matching board (canOverride) and every
// live hand-made room (judgeLiveRooms) ask, against a small fake that answers its one read from the rows it keeps. The
// owner-only choice on save is in event-groups.test.ts; the board and the live room in board-ops.test.ts and
// live-manual-checks.test.ts; the SQL itself ran on PGlite and read-only on production (task report).

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

interface Fake {
  /** No sessions row: an unknown event. */
  exists: boolean;
  host: string;
  roles: Record<string, string>;
  cohosts: Array<{ user_id: string; role: 'co_host' | 'moderator' }>;
  /** null: the event has no event_matching_rules row (no groups saved, or saved before migration 147). */
  overrideBy: 'owner' | 'owner_and_cohosts' | null;
  sql: string[];
}
let fake: Fake;

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const STANDING_SQL = /^SELECT s\.host_user_id, \(SELECT u\.role FROM users u WHERE u\.id = \$2\) AS role, \(SELECT r\.override_by FROM event_matching_rules r WHERE r\.session_id = s\.id\) AS override_by, EXISTS \(SELECT 1 FROM session_cohosts c WHERE c\.session_id = s\.id AND c\.user_id = \$2 AND c\.role = 'co_host'\) AS is_cohost FROM sessions s WHERE s\.id = \$1$/;

jest.mock('../../../db', () => ({
  __esModule: true,
  query: jest.fn(async (raw: string, params: unknown[] = []) => {
    const sql = flat(raw);
    fake.sql.push(sql);
    if (STANDING_SQL.test(sql)) {
      if (!fake.exists) return { rows: [], rowCount: 0 };
      const actor = params[1] as string;
      return {
        rows: [{
          host_user_id: fake.host,
          role: fake.roles[actor] ?? null,
          override_by: fake.overrideBy,
          is_cohost: fake.cohosts.some((c) => c.user_id === actor && c.role === 'co_host'),
        }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected SQL in the fake database: ${sql}`);
  }),
  transaction: jest.fn(),
}));
jest.mock('../../../services/session/event-groups.service', () => ({
  __esModule: true,
  getEventGroupRules: jest.fn(async () => null),
  groupsForParticipants: jest.fn(async () => new Map()),
}));
jest.mock('../../../services/matching/hard-exclusions', () => ({
  __esModule: true,
  loadHardExclusions: jest.fn(async () => ({ blocked: [] })),
}));
jest.mock('../../../services/audit/event-audit', () => ({ __esModule: true, recordEventAudit: jest.fn() }));

import {
  groupOverrideStanding, mayOverrideGroupRules, overrideForbiddenMessage,
} from '../../../services/matching/live-room-guard';

const EVENT = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner';
const CO = 'cohost';
const MOD = 'moderator';
const DIRECTOR = 'pod-director';
const ADMIN = 'platform-admin';
const SUPER = 'super-admin';
const MEMBER = 'member';

beforeEach(() => {
  fake = {
    exists: true,
    host: OWNER,
    roles: { [OWNER]: 'member', [CO]: 'member', [MOD]: 'member', [DIRECTOR]: 'member', [ADMIN]: 'admin', [SUPER]: 'super_admin', [MEMBER]: 'member' },
    cohosts: [{ user_id: CO, role: 'co_host' }, { user_id: MOD, role: 'moderator' }],
    overrideBy: null,
    sql: [],
  };
});

const allowedFor = async (ids: string[]) =>
  Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await mayOverrideGroupRules(EVENT, id)] as const)));
const EVERYONE = [OWNER, SUPER, CO, MOD, DIRECTOR, ADMIN, MEMBER];

describe('mayOverrideGroupRules: nothing chosen is today\'s rule', () => {
  it('no event_matching_rules row: the owner and a super admin only (co-host, moderator, pod director, admin, member: no)', async () => {
    expect(await allowedFor(EVERYONE)).toEqual({
      [OWNER]: true, [SUPER]: true, [CO]: false, [MOD]: false, [DIRECTOR]: false, [ADMIN]: false, [MEMBER]: false,
    });
  });

  it("override_by = 'owner' (the column's default on every earlier row): exactly the same", async () => {
    fake.overrideBy = 'owner';
    expect(await allowedFor(EVERYONE)).toEqual({
      [OWNER]: true, [SUPER]: true, [CO]: false, [MOD]: false, [DIRECTOR]: false, [ADMIN]: false, [MEMBER]: false,
    });
  });

  it('an unknown event: nobody, not even a super admin', async () => {
    fake.exists = false;
    expect(await mayOverrideGroupRules(EVENT, SUPER)).toBe(false);
    expect(await mayOverrideGroupRules(EVENT, OWNER)).toBe(false);
  });
});

describe("mayOverrideGroupRules: override_by = 'owner_and_cohosts'", () => {
  it('adds the event\'s co-hosts, and nobody else (a moderator, a pod director who is not a co-host, an admin, a member)', async () => {
    fake.overrideBy = 'owner_and_cohosts';
    expect(await allowedFor(EVERYONE)).toEqual({
      [OWNER]: true, [SUPER]: true, [CO]: true, [MOD]: false, [DIRECTOR]: false, [ADMIN]: false, [MEMBER]: false,
    });
  });

  it('a pod director who is made a co-host of the event may then override; one who is not, may not', async () => {
    fake.overrideBy = 'owner_and_cohosts';
    expect(await mayOverrideGroupRules(EVENT, DIRECTOR)).toBe(false);
    fake.cohosts.push({ user_id: DIRECTOR, role: 'co_host' });
    expect(await mayOverrideGroupRules(EVENT, DIRECTOR)).toBe(true);
  });

  it('a co-host taken off the event loses it at once (read from the database on every call)', async () => {
    fake.overrideBy = 'owner_and_cohosts';
    expect(await mayOverrideGroupRules(EVENT, CO)).toBe(true);
    fake.cohosts = fake.cohosts.filter((c) => c.user_id !== CO);
    expect(await mayOverrideGroupRules(EVENT, CO)).toBe(false);
  });

  it('the owner switching back to owner takes it from the co-hosts at once', async () => {
    fake.overrideBy = 'owner_and_cohosts';
    expect(await mayOverrideGroupRules(EVENT, CO)).toBe(true);
    fake.overrideBy = 'owner';
    expect(await mayOverrideGroupRules(EVENT, CO)).toBe(false);
  });
});

describe("the refusal's sentence matches the owner's choice (Part 3 Task 12 ruling)", () => {
  it("'owner' (and nothing chosen): only the owner is named; super admins are never named", async () => {
    expect(overrideForbiddenMessage('owner')).toBe("Only the event's owner can override group rules.");
    expect(await groupOverrideStanding(EVENT, CO)).toEqual({ allowed: false, overrideBy: 'owner' });
    fake.overrideBy = 'owner';
    expect(await groupOverrideStanding(EVENT, MOD)).toEqual({ allowed: false, overrideBy: 'owner' });
  });

  it("'owner_and_cohosts': the owner and co-hosts are named", async () => {
    fake.overrideBy = 'owner_and_cohosts';
    expect(overrideForbiddenMessage('owner_and_cohosts')).toBe("Only the event's owner and co-hosts can override group rules.");
    expect(await groupOverrideStanding(EVENT, DIRECTOR)).toEqual({ allowed: false, overrideBy: 'owner_and_cohosts' });
    expect(await groupOverrideStanding(EVENT, CO)).toEqual({ allowed: true, overrideBy: 'owner_and_cohosts' });
  });

  it('neither sentence names a super admin', () => {
    for (const by of ['owner', 'owner_and_cohosts'] as const) expect(overrideForbiddenMessage(by)).not.toMatch(/admin/i);
  });

  it('an unknown event reads as the owner only', async () => {
    fake.exists = false;
    expect(await groupOverrideStanding(EVENT, OWNER)).toEqual({ allowed: false, overrideBy: 'owner' });
  });
});

describe('the one read', () => {
  it('is a single statement per call, with the actor as a parameter (never the token\'s role)', async () => {
    fake.overrideBy = 'owner_and_cohosts';
    await mayOverrideGroupRules(EVENT, CO);
    expect(fake.sql).toHaveLength(1);
    expect(fake.sql[0]).toMatch(STANDING_SQL);
  });

  it('live-room-guard keeps the owner-or-super-admin rule, asks for a co-host only by the setting, and says moderators never count', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../services/matching/live-room-guard.ts'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('export async function groupOverrideStanding');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('row.host_user_id === actorId');
    expect(body).toContain('UserRole.SUPER_ADMIN');
    expect(body).toMatch(/overrideBy === 'owner_and_cohosts' && row\.is_cohost === true/);
    expect(body).toContain("c.role = 'co_host'");
    // The ruling, in a comment above it: a moderator never gains the override.
    const doc = src.slice(src.lastIndexOf('/**', start), start);
    expect(doc).toMatch(/moderator[^.]*never gains the\s+(\/\/\s*|\*\s*)?override/);
  });
});
