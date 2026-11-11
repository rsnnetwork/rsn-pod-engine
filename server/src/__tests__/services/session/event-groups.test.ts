// ─── An event's matching groups: stored, assigned, asked at registration (10 Nov 2026 spec, Part 2 Task 5) ───
//
// services/session/event-groups.service.ts keeps an event's groups and round rules and each person's groups;
// registerParticipant asks an event with groups which group the person is in. These run the real service and the
// real registerParticipant against a small fake database that keeps the rows each statement touches (and drops
// a transaction's writes when it throws), so what is stored, what is refused and what is audited are read back.
// The SQL itself is run against Postgres by the task's read-only probe (see the task report).
//
// Spec 05's "critical distinction" is pinned at the end: a group is never read from a platform role or
// designation, and a platform role is never read from a group.

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ─── The fake database ───────────────────────────────────────────────────────

interface Group { id: string; session_id: string; key: string; label: string; description: string | null; position: number }
interface Membership { session_id: string; user_id: string; group_id: string; assigned_by: string; assigned_by_user_id: string | null }
interface World {
  session: { id: string; status: string; config: unknown; host_user_id: string; pod_id: string; visibility: string | null };
  groups: Group[];
  matching: { group_question: string; allow_multiple: boolean; imbalance_fallback: string; override_by?: string } | null;
  rounds: Array<{ from_round: number; to_round: number; mode: string; allowed_pairs: string[] }>;
  memberships: Membership[];
  participants: Map<string, string>;
  audit: Array<{ actor_id: string | null; action: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>;
  organisers: Set<string>;
  /** users.role as the database holds it (Part 3 Task 12: who may choose who overrides); a member when not listed. */
  roles: Record<string, string>;
  sql: string[];
  failOn: RegExp | null;
}

const EVENT = '11111111-1111-4111-8111-111111111111';
let world: World;
let nextId = 0;

function freshWorld(): World {
  return {
    session: { id: EVENT, status: 'scheduled', config: { numberOfRounds: 5, maxParticipants: 100 }, host_user_id: 'host', pod_id: 'pod-1', visibility: null },
    groups: [],
    matching: null,
    rounds: [],
    memberships: [],
    participants: new Map(),
    audit: [],
    organisers: new Set(['host']),
    roles: {},
    sql: [],
    failOn: null,
  };
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const rows = <T>(r: T[]) => ({ rows: r, rowCount: r.length });
const keysOfUser = (userId: string) => world.memberships
  .filter((m) => m.user_id === userId)
  .map((m) => world.groups.find((g) => g.id === m.group_id)!)
  .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
  .map((g) => g.key);

function handle(raw: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const sql = flat(raw);
  world.sql.push(sql);
  if (world.failOn?.test(sql)) throw new Error('the database refused');
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return rows([]);

  // Part 2 Task 3: the account gate (status and kind) and an event guest's registration facts. An id starting
  // 'guest' is an event guest who came in through another event; everyone else is a member.
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') {
    return rows([{ status: 'active', account_kind: String(params[0]).startsWith('guest') ? 'event_guest' : 'member' }]);
  }
  if (/^SELECT u.guest_first_session_id, EXISTS \(SELECT 1 FROM session_participants sp/.test(sql)) {
    return rows([{ guest_first_session_id: 'another-event', holds_place: world.participants.has(params[1] as string) }]);
  }

  // registerParticipant
  if (/AS "hasEventGroups" FROM sessions WHERE id = \$1$/.test(sql)) {
    const s = world.session;
    return rows([{
      id: s.id, podId: s.pod_id, status: s.status, config: s.config, hostUserId: s.host_user_id, visibility: s.visibility,
      hasEventGroups: world.groups.some((g) => g.session_id === s.id),
    }]);
  }
  if (sql === 'SELECT visibility FROM pods WHERE id = $1') return rows([{ visibility: 'public' }]);
  if (/^SELECT role FROM pod_members WHERE pod_id = \$1 AND user_id = \$2/.test(sql)) return rows([{ role: 'member' }]);
  if (/^SELECT COUNT\(\*\) as count FROM session_participants/.test(sql)) return rows([{ count: String(world.participants.size) }]);
  if (sql === 'SELECT id, status, left_at FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const status = world.participants.get(params[1] as string);
    return rows(status ? [{ id: 'sp', status, left_at: null }] : []);
  }
  if (/^UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE/.test(sql)) {
    const status = world.participants.get(params[1] as string);
    if (!status || status === 'removed') return rows([]);
    world.participants.set(params[1] as string, 'registered');
    return rows([{ id: 'sp', sessionId: params[0], userId: params[1], status: 'registered' }]);
  }
  if (/^INSERT INTO session_participants/.test(sql)) {
    world.participants.set(params[1] as string, 'registered');
    return rows([{ id: 'sp', sessionId: params[0], userId: params[1], status: 'registered' }]);
  }
  if (/^UPDATE invites SET status = 'accepted'/.test(sql)) return rows([]);
  // Part 3 Task 3 (K3): a new place reads the person's row again under the capacity lock, then counts the places held
  // (the host left out; the fake has no co-hosts) against the event's capacity; a place given ends any waiting row.
  if (/^SELECT session_participants.id, .* FROM session_participants WHERE session_id = \$1 AND user_id = \$2$/.test(sql)) {
    const status = world.participants.get(params[1] as string);
    return rows(status ? [{ id: 'sp', sessionId: params[0], userId: params[1], status }] : []);
  }
  if (/^SELECT \(SELECT COUNT\(\*\)::int FROM session_participants ct .* AS taken, .* AS capacity, .* AS runs FROM sessions s WHERE s.id = \$1$/.test(sql)) {
    const taken = [...world.participants].filter(([id, st]) => st !== 'removed' && id !== world.session.host_user_id).length;
    const capacity = (world.session.config as { maxParticipants?: number }).maxParticipants ?? null;
    return rows([{ taken, capacity, runs: params[1] === world.session.host_user_id }]);
  }
  if (/^UPDATE event_waitlist SET status = 'promoted'/.test(sql)) return rows([]);

  // event-groups.service
  if (sql === 'SELECT key, label, description FROM event_groups WHERE session_id = $1 ORDER BY position, key') {
    return rows([...world.groups].sort((a, b) => a.position - b.position).map(({ key, label, description }) => ({ key, label, description })));
  }
  if (/^SELECT group_question, allow_multiple, imbalance_fallback, override_by FROM event_matching_rules/.test(sql)) {
    return rows(world.matching ? [world.matching] : []);
  }
  // Part 3 Task 12: whether the person changing who may override is the event's owner or a super admin.
  if (sql === 'SELECT s.host_user_id, (SELECT u.role FROM users u WHERE u.id = $2) AS role FROM sessions s WHERE s.id = $1') {
    return rows(params[0] === EVENT ? [{ host_user_id: world.session.host_user_id, role: world.roles[params[1] as string] ?? 'member' }] : []);
  }
  if (/^SELECT from_round, to_round, mode, allowed_pairs FROM event_round_rules/.test(sql)) {
    return rows([...world.rounds].sort((a, b) => a.from_round - b.from_round));
  }
  if (sql === 'SELECT id FROM sessions WHERE id = $1') return rows(params[0] === EVENT ? [{ id: EVENT }] : []);
  if (sql === 'SELECT status, config FROM sessions WHERE id = $1 FOR UPDATE') {
    return rows([{ status: world.session.status, config: world.session.config }]);
  }
  if (/^SELECT DISTINCT pg.user_id FROM event_participant_groups pg JOIN event_groups g .* NOT \(g.key = ANY\(\$2::text\[\]\)\)$/.test(sql)) {
    const keep = params[1] as string[];
    const gone = new Set(world.groups.filter((g) => !keep.includes(g.key)).map((g) => g.id));
    return rows([...new Set(world.memberships.filter((m) => gone.has(m.group_id)).map((m) => m.user_id))].map((user_id) => ({ user_id })));
  }
  if (/^SELECT DISTINCT user_id FROM event_participant_groups WHERE session_id = \$1$/.test(sql)) {
    return rows([...new Set(world.memberships.map((m) => m.user_id))].map((user_id) => ({ user_id })));
  }
  if (/^DELETE FROM event_groups WHERE session_id = \$1( AND NOT \(key = ANY\(\$2::text\[\]\)\))?$/.test(sql)) {
    const keep = (params[1] as string[] | undefined) ?? [];
    const gone = new Set(world.groups.filter((g) => !keep.includes(g.key)).map((g) => g.id));
    world.groups = world.groups.filter((g) => !gone.has(g.id));
    // ON DELETE CASCADE (migration 138)
    world.memberships = world.memberships.filter((m) => !gone.has(m.group_id));
    return rows([]);
  }
  if (/^INSERT INTO event_groups/.test(sql)) {
    const [, keys, labels, descriptions, positions] = params as [string, string[], string[], Array<string | null>, number[]];
    keys.forEach((key, i) => {
      const existing = world.groups.find((g) => g.key === key);
      if (existing) Object.assign(existing, { label: labels[i], description: descriptions[i], position: positions[i] });
      else world.groups.push({ id: `g-${++nextId}`, session_id: EVENT, key, label: labels[i], description: descriptions[i], position: positions[i] });
    });
    return rows([]);
  }
  if (/^INSERT INTO event_matching_rules/.test(sql)) {
    world.matching = {
      group_question: params[1] as string, allow_multiple: params[2] as boolean, imbalance_fallback: params[3] as string,
      override_by: params[5] as string,
    };
    return rows([]);
  }
  if (sql === 'DELETE FROM event_matching_rules WHERE session_id = $1') { world.matching = null; return rows([]); }
  if (sql === 'DELETE FROM event_round_rules WHERE session_id = $1') { world.rounds = []; return rows([]); }
  if (/^INSERT INTO event_round_rules/.test(sql)) {
    const [, froms, tos, modes, pairs] = params as [string, number[], number[], string[], string[]];
    froms.forEach((from, i) => world.rounds.push({
      from_round: from, to_round: tos[i], mode: modes[i], allowed_pairs: pairs[i] === '' ? [] : pairs[i].split(','),
    }));
    return rows([]);
  }
  if (/^INSERT INTO audit_log/.test(sql)) {
    world.audit.push({
      actor_id: params[0] as string | null, action: params[1] as string, entity_type: 'session', entity_id: params[2] as string,
      details: JSON.parse(params[3] as string),
    });
    return rows([]);
  }
  if (/^SELECT pg_advisory_xact_lock/.test(sql)) return rows([]);
  if (/^SELECT g.key FROM event_participant_groups pg JOIN event_groups g .* pg.user_id = \$2/.test(sql)) {
    return rows(keysOfUser(params[1] as string).map((key) => ({ key })));
  }
  if (/^DELETE FROM event_participant_groups pg USING event_groups g/.test(sql)) {
    const keep = params[2] as string[];
    world.memberships = world.memberships.filter((m) => m.user_id !== params[1]
      || keep.includes(world.groups.find((g) => g.id === m.group_id)!.key));
    return rows([]);
  }
  if (/^INSERT INTO event_participant_groups/.test(sql)) {
    const [, userId, keys, assignedBy, byUser] = params as [string, string, string[], string, string | null];
    for (const g of world.groups.filter((x) => keys.includes(x.key))) {
      if (!world.memberships.some((m) => m.user_id === userId && m.group_id === g.id)) {
        world.memberships.push({ session_id: EVENT, user_id: userId, group_id: g.id, assigned_by: assignedBy, assigned_by_user_id: byUser });
      }
    }
    return rows([]);
  }
  if (sql === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const status = world.participants.get(params[1] as string);
    return rows(status ? [{ status }] : []);
  }
  if (/^SELECT user_id FROM session_participants WHERE session_id = \$1 AND status <> 'removed'$/.test(sql)) {
    return rows([...world.participants].filter(([, s]) => s !== 'removed').map(([user_id]) => ({ user_id })));
  }
  // The people the organiser's capacity counts: a live place, the host left out (the fake has no co-hosts).
  const counted = () => [...world.participants]
    .filter(([id, st]) => !['removed', 'left', 'no_show'].includes(st) && id !== world.session.host_user_id)
    .map(([id]) => id);
  if (/^SELECT g.key, COUNT\(DISTINCT pg.user_id\) AS count FROM event_groups g LEFT JOIN event_participant_groups pg ON pg.group_id = g.id AND pg.user_id IN \(SELECT sp.user_id FROM session_participants sp JOIN sessions s/.test(sql)) {
    return rows(world.groups.map((g) => ({
      key: g.key,
      count: String(world.memberships.filter((m) => m.group_id === g.id && counted().includes(m.user_id)).length),
    })));
  }
  if (/^SELECT COUNT\(\*\) AS count FROM \(SELECT sp.user_id FROM session_participants sp JOIN sessions s/.test(sql)) {
    return rows([{ count: String(counted().filter((id) => keysOfUser(id).length === 0).length) }]);
  }
  if (sql === 'SELECT config FROM sessions WHERE id = $1') return rows([{ config: world.session.config }]);
  // groupsForParticipants: every person's keys, in the event's group order.
  if (/^SELECT pg.user_id, array_agg\(g.key ORDER BY g.position, g.key\) AS keys FROM event_participant_groups pg/.test(sql)) {
    return rows([...new Set(world.memberships.map((m) => m.user_id))].map((user_id) => ({ user_id, keys: keysOfUser(user_id) })));
  }
  throw new Error(`unexpected SQL in the fake database: ${sql}`);
}

jest.mock('../../../db', () => ({
  __esModule: true,
  query: jest.fn(async (sql: string, params?: unknown[]) => handle(sql, params)),
  transaction: jest.fn(async (cb: (client: { query: typeof handle }) => Promise<unknown>) => {
    const saved = JSON.stringify({ ...world, participants: [...world.participants], organisers: [...world.organisers], sql: [] });
    try {
      return await cb({ query: async (sql: string, params?: unknown[]) => handle(sql, params) } as never);
    } catch (err) {
      const back = JSON.parse(saved);
      world = { ...back, participants: new Map(back.participants), organisers: new Set(back.organisers), sql: world.sql, failOn: world.failOn };
      throw err;
    }
  }),
}));

jest.mock('../../../services/roles/effective-role.service', () => ({
  __esModule: true,
  canActAsHost: jest.fn(async (userId: string) => ({ allowed: world.organisers.has(userId), effectiveRole: 'participant' })),
}));

const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => ({}),
  emitEntities: (...a: unknown[]) => mockEmit(...a),
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  __esModule: true,
  resolveEventOrganiserIds: jest.fn(async () => ['host']),
}));

// draftFacts: the real visibility rule (Task 2's canSeeEvent) is asked about this event as a draft instead of the stand-in.
const mockFacts: { canSee: boolean; draftFacts: Record<string, unknown> | null } = { canSee: true, draftFacts: null };
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  return {
    __esModule: true,
    ...actual,
    readEventAccessFacts: jest.fn(async () => ({})),
    canSeeEvent: jest.fn((f: never, role: string | undefined) => (mockFacts.draftFacts ? actual.canSeeEvent(f, role) : mockFacts.canSee)),
  };
});

import { ErrorCodes, UserRole, type EventGroupRules } from '@rsn/shared';
import {
  applyRegistrationGroups, getEventGroupRules, groupsForParticipants, readEventGroups, saveEventGroupRules, setParticipantGroups,
} from '../../../services/session/event-groups.service';
import { registerParticipant } from '../../../services/session/session.service';
import { eventRoomRefusal } from '../../../services/orchestration/event-room-entry';
import { requireRole } from '../../../middleware/rbac';
import { query as dbQuery } from '../../../db';

const host = { userId: 'host', role: UserRole.MEMBER };
const stranger = { userId: 'stranger', role: UserRole.MEMBER };

const foundersFunders = (over: Partial<EventGroupRules> = {}): EventGroupRules => ({
  groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
  question: 'Are you a founder or a funder?',
  allowMultiple: false,
  fallback: 'leave_unmatched',
  rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
  ...over,
});

/** How a call failed: its HTTP status, code and words. */
async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode: number; code: string; message: string };
    return { status: e.statusCode, code: e.code, message: e.message };
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  world = freshWorld();
  nextId = 0;
  mockFacts.canSee = true;
  mockFacts.draftFacts = null;
  mockEmit.mockClear();
});

// ─── Rules ───────────────────────────────────────────────────────────────────

describe('getEventGroupRules', () => {
  it('an event without groups has no rules: null, after one read and nothing else (the inert path)', async () => {
    expect(await getEventGroupRules(EVENT)).toBeNull();
    expect(world.sql).toEqual(['SELECT key, label, description FROM event_groups WHERE session_id = $1 ORDER BY position, key']);
  });
});

describe('saveEventGroupRules', () => {
  it('stores the groups, the question, the round rules and audits group.rules_changed with before and after', async () => {
    const saved = await saveEventGroupRules(EVENT, host, foundersFunders());
    expect(saved).toEqual({
      groups: [{ key: 'founder', label: 'Founders', description: null }, { key: 'funder', label: 'Funders', description: null }],
      question: 'Are you a founder or a funder?',
      allowMultiple: false,
      fallback: 'leave_unmatched',
      rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
      overrideBy: 'owner',
    });
    expect(await getEventGroupRules(EVENT)).toEqual(saved);
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({ actor_id: 'host', action: 'group.rules_changed', entity_type: 'session', entity_id: EVENT });
    expect(world.audit[0].details).toMatchObject({ automatic: false, before: null, after: saved, subjectUserIds: [] });
    // The people running the event and everyone with a place are told.
    expect(mockEmit).toHaveBeenCalledWith({}, expect.arrayContaining(['host']), [`session:${EVENT}:groups`]);
  });

  it('writes custom pairs in their one form, without repeats', async () => {
    const saved = await saveEventGroupRules(EVENT, host, foundersFunders({
      rounds: [{ fromRound: 2, toRound: 3, mode: 'custom', allowedPairs: ['funder|founder', 'founder|funder', 'funder|funder'] }],
    }));
    expect(saved.rounds).toEqual([{ fromRound: 2, toRound: 3, mode: 'custom', allowedPairs: ['founder|funder', 'funder|funder'] }]);
  });

  it('is refused while the event is live, and nothing is written', async () => {
    world.session.status = 'round_active';
    expect(await refusal(saveEventGroupRules(EVENT, host, foundersFunders()))).toEqual({
      status: 409, code: ErrorCodes.SESSION_IN_PROGRESS, message: "Group rules can't change while the event is live.",
    });
    expect(world.groups).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  it('is refused once the event has ended or was cancelled', async () => {
    for (const status of ['completed', 'cancelled']) {
      world.session.status = status;
      expect(await refusal(saveEventGroupRules(EVENT, host, foundersFunders()))).toEqual({
        status: 409, code: ErrorCodes.EVENT_ENDED, message: "This event has ended, so its groups can't change.",
      });
    }
    expect(world.groups).toEqual([]);
  });

  it('an unknown event is unknown to everyone, before who is asking is looked at', async () => {
    expect(await refusal(saveEventGroupRules('99999999-9999-4999-8999-999999999999', stranger, foundersFunders()))).toMatchObject({
      status: 404, message: "We couldn't find that event.",
    });
  });

  it('a malformed custom pair is refused, not quietly repaired', async () => {
    const r = await refusal(saveEventGroupRules(EVENT, host, foundersFunders({
      rounds: [{ fromRound: 1, toRound: 2, mode: 'custom', allowedPairs: ['founder|funder|founder'] }],
    })));
    expect(r).toMatchObject({ status: 400, message: 'A pair names a group this event does not have.' });
  });

  it('is refused to someone who does not run the event', async () => {
    expect(await refusal(saveEventGroupRules(EVENT, stranger, foundersFunders()))).toMatchObject({ status: 403 });
    expect(world.groups).toEqual([]);
  });

  it('refuses rules the organiser\'s own check refuses, said at the field', async () => {
    const r = await refusal(saveEventGroupRules(EVENT, host, foundersFunders({
      rounds: [{ fromRound: 4, toRound: 7, mode: 'cross_group', allowedPairs: [] }],
    })));
    expect(r).toEqual({ status: 400, code: 'VALIDATION_ERROR', message: 'This event has 5 rounds, so a rule can cover rounds 1 to 5 only.' });
    expect(world.groups).toEqual([]);
  });

  it('removing a group removes its memberships, and names those people in the audit', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders({ allowMultiple: true }));
    world.participants.set('p1', 'registered');
    world.participants.set('p2', 'registered');
    await setParticipantGroups(EVENT, null, 'p1', ['founder'], 'self');
    await setParticipantGroups(EVENT, null, 'p2', ['founder', 'funder'], 'self');

    await saveEventGroupRules(EVENT, host, {
      ...foundersFunders(), groups: [{ key: 'funder', label: 'Funders' }], rounds: [],
    });
    expect(world.groups.map((g) => g.key)).toEqual(['funder']);
    expect(keysOfUser('p1')).toEqual([]);
    expect(keysOfUser('p2')).toEqual(['funder']);
    const last = world.audit[world.audit.length - 1];
    expect(last.action).toBe('group.rules_changed');
    expect((last.details.subjectUserIds as string[]).sort()).toEqual(['p1', 'p2']);
    expect((last.details.before as EventGroupRules).groups.map((g) => g.key)).toEqual(['founder', 'funder']);
    expect((last.details.after as EventGroupRules).groups.map((g) => g.key)).toEqual(['funder']);
  });

  it('no groups at all takes the event back to having none', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    world.participants.set('p1', 'registered');
    await setParticipantGroups(EVENT, null, 'p1', ['founder'], 'self');
    const saved = await saveEventGroupRules(EVENT, host, { ...foundersFunders(), groups: [], rounds: [] });
    expect(saved.groups).toEqual([]);
    expect(await getEventGroupRules(EVENT)).toBeNull();
    expect(world.memberships).toEqual([]);
    expect(world.matching).toBeNull();
  });
});

// ─── Part 3 Task 12: the owner chooses who may override the rules ───────────

describe('saveEventGroupRules: who may override (Part 3 Task 12)', () => {
  const cohost = { userId: 'cohost', role: UserRole.MEMBER };
  const director = { userId: 'director', role: UserRole.MEMBER };
  const superAdmin = { userId: 'super', role: UserRole.SUPER_ADMIN };
  const OWNER_ONLY = {
    status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: "Only the event's owner can choose who may override group rules.",
  };
  const ruleAudits = () => world.audit.filter((a) => a.action === 'group.rules_changed');

  beforeEach(() => {
    // A co-host and a pod director run the event (canActAsHost); a super admin, too. Only the host owns it.
    for (const id of ['cohost', 'director', 'super']) world.organisers.add(id);
    world.roles.super = 'super_admin';
  });

  it("nothing chosen is the owner (today's rule): stored, returned and read back as owner", async () => {
    const saved = await saveEventGroupRules(EVENT, host, foundersFunders());
    expect(saved.overrideBy).toBe('owner');
    expect(world.matching?.override_by).toBe('owner');
    expect((await readEventGroups(EVENT, host)).rules?.overrideBy).toBe('owner');
  });

  it('the owner chooses owner and co-hosts: saved, returned to the people running the event, audited before and after', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    const saved = await saveEventGroupRules(EVENT, host, foundersFunders({ overrideBy: 'owner_and_cohosts' }));
    expect(saved.overrideBy).toBe('owner_and_cohosts');
    expect(world.matching?.override_by).toBe('owner_and_cohosts');
    expect((await readEventGroups(EVENT, cohost)).rules?.overrideBy).toBe('owner_and_cohosts');
    const last = ruleAudits().at(-1)!;
    expect(last).toMatchObject({ actor_id: 'host', action: 'group.rules_changed' });
    expect((last.details.before as EventGroupRules).overrideBy).toBe('owner');
    expect((last.details.after as EventGroupRules).overrideBy).toBe('owner_and_cohosts');
    expect(mockEmit).toHaveBeenCalledWith({}, expect.arrayContaining(['host']), [`session:${EVENT}:groups`]);
  });

  it('a co-host sending a different choice is refused (403), and nothing is written or audited', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    const audits = world.audit.length;
    const r = await refusal(saveEventGroupRules(EVENT, cohost, foundersFunders({
      overrideBy: 'owner_and_cohosts', question: 'Changed at the same time?',
    })));
    expect(r).toEqual(OWNER_ONLY);
    expect(world.matching).toMatchObject({ override_by: 'owner', group_question: 'Are you a founder or a funder?' });
    expect(world.audit).toHaveLength(audits);
  });

  it('a co-host may not take the choice back either, once the owner has made it', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders({ overrideBy: 'owner_and_cohosts' }));
    expect(await refusal(saveEventGroupRules(EVENT, cohost, foundersFunders({ overrideBy: 'owner' })))).toEqual(OWNER_ONLY);
    expect(world.matching?.override_by).toBe('owner_and_cohosts');
  });

  it('on an event with no groups yet, a co-host may save groups but not choose co-hosts as overriders', async () => {
    expect(await refusal(saveEventGroupRules(EVENT, cohost, foundersFunders({ overrideBy: 'owner_and_cohosts' })))).toEqual(OWNER_ONLY);
    expect(world.groups).toEqual([]);
    expect((await saveEventGroupRules(EVENT, cohost, foundersFunders({ overrideBy: 'owner' }))).overrideBy).toBe('owner');
  });

  it("a co-host keeps their permission over everything else: a save without the choice, or with the same one, keeps the owner's", async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders({ overrideBy: 'owner_and_cohosts' }));
    const plain = await saveEventGroupRules(EVENT, cohost, foundersFunders({ question: 'Founder or funder?' }));
    expect(plain).toMatchObject({ question: 'Founder or funder?', overrideBy: 'owner_and_cohosts' });
    const same = await saveEventGroupRules(EVENT, cohost, foundersFunders({ allowMultiple: true, overrideBy: 'owner_and_cohosts' }));
    expect(same).toMatchObject({ allowMultiple: true, overrideBy: 'owner_and_cohosts' });
    expect(world.matching?.override_by).toBe('owner_and_cohosts');
  });

  it('a pod director who is not the owner is refused the choice too', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    expect(await refusal(saveEventGroupRules(EVENT, director, foundersFunders({ overrideBy: 'owner_and_cohosts' })))).toEqual(OWNER_ONLY);
  });

  it('a super admin may choose (their role read from the database)', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    const saved = await saveEventGroupRules(EVENT, superAdmin, foundersFunders({ overrideBy: 'owner_and_cohosts' }));
    expect(saved.overrideBy).toBe('owner_and_cohosts');
    expect(ruleAudits().at(-1)!.actor_id).toBe('super');
  });

  it('a super admin role in the token alone is not enough: the database decides', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    const claimed = { userId: 'cohost', role: UserRole.SUPER_ADMIN };
    expect(await refusal(saveEventGroupRules(EVENT, claimed, foundersFunders({ overrideBy: 'owner_and_cohosts' })))).toEqual(OWNER_ONLY);
  });

  it('someone who does not run the event is refused as before, whatever they send', async () => {
    expect(await refusal(saveEventGroupRules(EVENT, stranger, foundersFunders({ overrideBy: 'owner_and_cohosts' })))).toMatchObject({
      status: 403, message: 'Only the people running this event can change its groups.',
    });
  });

  it("the owner's check is read only when the choice changes (a plain save reads nothing new)", async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    world.sql = [];
    await saveEventGroupRules(EVENT, cohost, foundersFunders({ question: 'Founder or funder?' }));
    expect(world.sql.some((q) => q.startsWith('SELECT s.host_user_id'))).toBe(false);
  });

  it('removing every group takes the choice with it: the event is back to the owner only', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders({ overrideBy: 'owner_and_cohosts' }));
    const cleared = await saveEventGroupRules(EVENT, host, { ...foundersFunders(), groups: [], rounds: [] });
    expect(cleared.overrideBy).toBe('owner');
    expect(world.matching).toBeNull();
  });

  it('a participant reads no rules, so not the choice either', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders({ overrideBy: 'owner_and_cohosts' }));
    const view = await readEventGroups(EVENT, { userId: 'f3', role: UserRole.MEMBER });
    expect(view).not.toHaveProperty('rules');
  });
});

// ─── A person's groups ───────────────────────────────────────────────────────

describe('setParticipantGroups', () => {
  beforeEach(async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    world.audit = [];
    world.participants.set('p1', 'registered');
  });

  it('a person chooses their own group once; choosing again is refused', async () => {
    await setParticipantGroups(EVENT, null, 'p1', ['founder'], 'self');
    expect(keysOfUser('p1')).toEqual(['founder']);
    expect(world.memberships[0]).toMatchObject({ assigned_by: 'self', assigned_by_user_id: null });
    expect(await refusal(setParticipantGroups(EVENT, null, 'p1', ['funder'], 'self'))).toEqual({
      status: 409, code: ErrorCodes.EVENT_GROUP_ALREADY_CHOSEN,
      message: 'Your group for this event is already set. Ask the organiser to change it.',
    });
    expect(keysOfUser('p1')).toEqual(['founder']);
    // The same choice again changes nothing and is not an error.
    await expect(setParticipantGroups(EVENT, null, 'p1', ['founder'], 'self')).resolves.toBeUndefined();
  });

  it('one group only, unless the event allows more; a key the event does not have is a 400', async () => {
    expect(await refusal(setParticipantGroups(EVENT, null, 'p1', ['founder', 'funder'], 'self'))).toMatchObject({
      status: 400, code: ErrorCodes.EVENT_GROUP_UNKNOWN,
    });
    expect(await refusal(setParticipantGroups(EVENT, null, 'p1', ['mentor'], 'self'))).toEqual({
      status: 400, code: ErrorCodes.EVENT_GROUP_UNKNOWN, message: "That group isn't one of this event's groups.",
    });
    expect(keysOfUser('p1')).toEqual([]);
  });

  it('a person\'s own answer cannot be "no group"', async () => {
    expect(await refusal(setParticipantGroups(EVENT, null, 'p1', [], 'self'))).toMatchObject({
      status: 409, code: ErrorCodes.EVENT_GROUP_REQUIRED,
    });
  });

  it('the group an invitation carries is set once and never overrides a choice already made', async () => {
    await setParticipantGroups(EVENT, null, 'p1', ['funder'], 'invitation');
    expect(world.memberships[0]).toMatchObject({ assigned_by: 'invitation' });
    await setParticipantGroups(EVENT, null, 'p1', ['founder'], 'invitation');
    expect(keysOfUser('p1')).toEqual(['funder']);
  });

  it('an organiser regroups a person at any time, and it is audited group.assigned with before and after', async () => {
    await setParticipantGroups(EVENT, null, 'p1', ['founder'], 'self');
    await setParticipantGroups(EVENT, host, 'p1', ['funder'], 'organiser');
    expect(keysOfUser('p1')).toEqual(['funder']);
    expect(world.memberships[0]).toMatchObject({ assigned_by: 'organiser', assigned_by_user_id: 'host' });
    expect(world.audit).toEqual([{
      actor_id: 'host', action: 'group.assigned', entity_type: 'session', entity_id: EVENT,
      details: {
        automatic: false, scheduleVersion: null, round: null, subjectUserIds: ['p1'],
        before: { groupKeys: ['founder'] }, after: { groupKeys: ['funder'] }, reason: null,
      },
    }]);
    expect(mockEmit).toHaveBeenCalledWith({}, expect.arrayContaining(['host', 'p1']), [`session:${EVENT}:groups`]);
  });

  it('an organiser\'s regroup is refused to anyone else, and for someone not in the event', async () => {
    expect(await refusal(setParticipantGroups(EVENT, stranger, 'p1', ['funder'], 'organiser'))).toMatchObject({ status: 403 });
    expect(await refusal(setParticipantGroups(EVENT, null, 'p1', ['funder'], 'organiser'))).toMatchObject({ status: 403 });
    expect(await refusal(setParticipantGroups(EVENT, host, 'nobody', ['funder'], 'organiser'))).toMatchObject({
      status: 404, message: "That person isn't in this event.",
    });
    world.participants.set('kicked', 'removed');
    expect(await refusal(setParticipantGroups(EVENT, host, 'kicked', ['funder'], 'organiser'))).toMatchObject({ status: 404 });
    expect(world.audit).toEqual([]);
  });

  it('groupsForParticipants lists each person with a group', async () => {
    world.participants.set('p2', 'registered');
    await setParticipantGroups(EVENT, null, 'p1', ['founder'], 'self');
    await setParticipantGroups(EVENT, null, 'p2', ['funder'], 'self');
    // The fake answers the aggregate the way Postgres would: rebuild it from the rows.
    (dbQuery as jest.Mock).mockImplementationOnce(async () => ({
      rows: ['p1', 'p2'].map((user_id) => ({ user_id, keys: keysOfUser(user_id) })), rowCount: 2,
    }));
    expect(await groupsForParticipants(EVENT)).toEqual(new Map([['p1', ['founder']], ['p2', ['funder']]]));
  });
});

// ─── Registration asks the group question ────────────────────────────────────

describe('registerParticipant on an event with groups', () => {
  beforeEach(async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    world.sql = [];
  });

  it('refuses someone who has no group and chose none: 409 EVENT_GROUP_REQUIRED, and gives no place', async () => {
    expect(await refusal(registerParticipant(EVENT, 'p1', UserRole.MEMBER))).toEqual({
      status: 409, code: ErrorCodes.EVENT_GROUP_REQUIRED, message: 'Choose your group for this event first.',
    });
    expect(world.participants.has('p1')).toBe(false);
  });

  it('refuses a key the event does not have: 400, and gives no place', async () => {
    expect(await refusal(registerParticipant(EVENT, 'p1', UserRole.MEMBER, { groupKeys: ['mentor'] }))).toMatchObject({
      status: 400, code: ErrorCodes.EVENT_GROUP_UNKNOWN,
    });
    expect(world.participants.has('p1')).toBe(false);
  });

  it('with a group, writes it as the person\'s own choice and registers them', async () => {
    const p = await registerParticipant(EVENT, 'p1', UserRole.MEMBER, { groupKeys: ['funder'] });
    expect(p.isNewRegistration).toBe(true);
    expect(world.participants.get('p1')).toBe('registered');
    expect(keysOfUser('p1')).toEqual(['funder']);
    expect(world.memberships[0]).toMatchObject({ assigned_by: 'self' });
  });

  it('the group and the place are one transaction: a place that fails takes the group back', async () => {
    world.failOn = /^INSERT INTO session_participants/;
    await expect(registerParticipant(EVENT, 'p1', UserRole.MEMBER, { groupKeys: ['funder'] })).rejects.toThrow('the database refused');
    expect(keysOfUser('p1')).toEqual([]);
  });

  it('someone an organiser already put in a group registers without choosing', async () => {
    world.participants.set('p1', 'left');
    await setParticipantGroups(EVENT, host, 'p1', ['founder'], 'organiser');
    world.participants.delete('p1');
    await expect(registerParticipant(EVENT, 'p1', UserRole.MEMBER)).resolves.toMatchObject({ isNewRegistration: true });
  });

  it('the people running the event register without a group', async () => {
    await expect(registerParticipant(EVENT, 'host', UserRole.MEMBER)).resolves.toMatchObject({ isNewRegistration: true });
    expect(keysOfUser('host')).toEqual([]);
  });

  it('someone who already holds a place is told so, as before, and is not asked about groups', async () => {
    world.participants.set('p1', 'registered');
    expect(await refusal(registerParticipant(EVENT, 'p1', UserRole.MEMBER))).toMatchObject({
      code: 'SESSION_ALREADY_REGISTERED',
    });
  });

  // Fix round 1 (controller ruling): only a person's own first registration is asked to choose; nobody else is
  // ever stranded. They come in without a group and the organiser places them.

  it('an approved request registers the person without a group, and the organiser can then put them in one', async () => {
    const p = await registerParticipant(EVENT, 'p1', undefined, { approvedRequest: true });
    expect(p.isNewRegistration).toBe(true);
    expect(world.participants.get('p1')).toBe('registered');
    expect(keysOfUser('p1')).toEqual([]);
    // No deadlock: the person now holds a place, so the organiser's assignment works.
    await setParticipantGroups(EVENT, host, 'p1', ['funder'], 'organiser');
    expect(keysOfUser('p1')).toEqual(['funder']);
    expect(world.audit[world.audit.length - 1]).toMatchObject({ action: 'group.assigned', actor_id: 'host' });
  });

  it('an accepted invite registers the person without a group (the invite path, with or without a personal invite time)', async () => {
    await expect(registerParticipant(EVENT, 'p1', undefined, { viaInvite: true })).resolves.toMatchObject({ isNewRegistration: true });
    await expect(registerParticipant(EVENT, 'p2', undefined, { personalInviteCreatedAt: new Date(), viaInvite: true }))
      .resolves.toMatchObject({ isNewRegistration: true });
    expect(keysOfUser('p1')).toEqual([]);
    expect(keysOfUser('p2')).toEqual([]);
  });

  it('an accepted invite that carries a group writes it', async () => {
    await registerParticipant(EVENT, 'p1', undefined, { viaInvite: true, groupKeys: ['founder'] });
    expect(keysOfUser('p1')).toEqual(['founder']);
  });

  it('someone coming back to a place they held (left the live event, never grouped) is let back in, as before', async () => {
    world.participants.set('p1', 'left');
    const p = await registerParticipant(EVENT, 'p1', UserRole.MEMBER);
    expect(p.isNewRegistration).toBe(false);
    expect(world.participants.get('p1')).toBe('registered');
    expect(keysOfUser('p1')).toEqual([]);
  });

  it('a returning person who sends their old choice keeps the group the organiser gave them, without an error', async () => {
    world.participants.set('p1', 'left');
    await setParticipantGroups(EVENT, host, 'p1', ['funder'], 'organiser');
    await expect(registerParticipant(EVENT, 'p1', UserRole.MEMBER, { groupKeys: ['founder'] })).resolves.toMatchObject({ isNewRegistration: false });
    expect(keysOfUser('p1')).toEqual(['funder']);
  });

  it('the live page\'s own registration says the same in the live room\'s words', () => {
    expect(eventRoomRefusal('lobby_open', ErrorCodes.EVENT_GROUP_REQUIRED)).toEqual({
      code: ErrorCodes.EVENT_GROUP_REQUIRED, message: 'Choose your group for this event first, on the event page.',
    });
  });
});

describe('registerParticipant: the guest check comes before the group question (Part 2 Task 3 then Task 5)', () => {
  it('an event guest from another event is refused as a guest, not asked for a group, and gets no place', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    world.sql = [];
    expect(await refusal(registerParticipant(EVENT, 'guest-1', UserRole.MEMBER, { groupKeys: ['founder'] }))).toMatchObject({
      status: 403, code: ErrorCodes.GUEST_MEMBERSHIP_REQUIRED,
    });
    expect(world.participants.has('guest-1')).toBe(false);
    expect(keysOfUser('guest-1')).toEqual([]);
    expect(world.sql.some((s) => /event_participant_groups/.test(s))).toBe(false);
  });
});

describe('registerParticipant on an event without groups (dark: as before)', () => {
  it('registers as before, reads no group table but the one EXISTS in the event row, and ignores groupKeys', async () => {
    const p = await registerParticipant(EVENT, 'p1', UserRole.MEMBER, { groupKeys: ['founder'] });
    expect(p.isNewRegistration).toBe(true);
    const groupReads = world.sql.filter((s) => /event_groups|event_participant_groups|event_matching_rules|event_round_rules/.test(s));
    expect(groupReads).toHaveLength(1);
    expect(groupReads[0]).toMatch(/^SELECT .* EXISTS \(SELECT 1 FROM event_groups eg WHERE eg.session_id = sessions.id\) AS "hasEventGroups" FROM sessions WHERE id = \$1$/);
    expect(world.memberships).toEqual([]);
  });

  it('applyRegistrationGroups answers at once for an event that has lost its groups meanwhile', async () => {
    await expect(applyRegistrationGroups({ query: async (s: string, p?: unknown[]) => handle(s, p) } as never, EVENT, 'p1', UserRole.MEMBER, undefined, true))
      .resolves.toBeUndefined();
  });
});

// ─── What a screen reads ─────────────────────────────────────────────────────

describe('readEventGroups', () => {
  beforeEach(async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    for (let i = 0; i < 25; i++) {
      world.participants.set(`f${i}`, 'registered');
      await setParticipantGroups(EVENT, null, `f${i}`, ['founder'], 'self');
    }
    for (let i = 0; i < 8; i++) {
      world.participants.set(`v${i}`, 'registered');
      await setParticipantGroups(EVENT, null, `v${i}`, ['funder'], 'self');
    }
  });

  it('a participant reads the groups, the question and their own groups, and nothing an organiser reads', async () => {
    const view = await readEventGroups(EVENT, { userId: 'f3', role: UserRole.MEMBER });
    expect(view).toEqual({
      groups: [{ key: 'founder', label: 'Founders', description: null }, { key: 'funder', label: 'Funders', description: null }],
      question: 'Are you a founder or a funder?',
      allowMultiple: false,
      mine: ['founder'],
    });
  });

  it('an organiser also reads the rules, the counts and each round\'s capacity', async () => {
    const view = await readEventGroups(EVENT, host);
    expect(view.counts).toEqual({ founder: 25, funder: 8 });
    expect(view.rules?.rounds).toEqual([{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }]);
    expect(view.capacity).toHaveLength(5);
    expect(view.capacity?.[0]).toMatchObject({ round: 1, maxMeetings: 8, waiting: { founder: 17 }, ungrouped: 0 });
    expect(view.ungrouped).toBe(0);
    // Part 2 Task 11: each person's groups, for the organiser's participant list.
    expect(view.members?.f3).toEqual(['founder']);
    expect(view.members?.v0).toEqual(['funder']);
    expect(Object.keys(view.members ?? {})).toHaveLength(33);
  });

  it('a participant never reads anyone\'s groups but their own (Part 2 Task 11)', async () => {
    const view = await readEventGroups(EVENT, { userId: 'f3', role: UserRole.MEMBER });
    expect(view.members).toBeUndefined();
  });

  it('counts leave the host out, and people with a place but no group are counted as such in every restricted round', async () => {
    world.participants.set('host', 'registered');
    await setParticipantGroups(EVENT, host, 'host', ['funder'], 'organiser');
    world.participants.set('late1', 'registered');
    world.participants.set('late2', 'registered');
    const view = await readEventGroups(EVENT, host);
    expect(view.counts).toEqual({ founder: 25, funder: 8 });
    expect(view.ungrouped).toBe(2);
    expect(view.capacity?.[0]).toMatchObject({ maxMeetings: 8, waiting: { founder: 17 }, ungrouped: 2 });
    expect(view.capacity?.[0].sentence).toMatch(/2 people have no group yet, so this round cannot match them until they are put in a group\.$/);
  });

  it('someone who cannot see the event is told it does not exist', async () => {
    mockFacts.canSee = false;
    expect(await refusal(readEventGroups(EVENT, stranger))).toMatchObject({ status: 404, message: "We couldn't find that event." });
  });
});

describe('a draft (Part 2 Task 2): its groups exist only for the people who run it', () => {
  /** The facts of a published-later draft for someone who does not run it: a pod member, invited, holding no place. */
  const draft = (overrides: Record<string, unknown> = {}) => ({
    visibility: 'public', podId: 'pod-1', podVisibility: 'public', isHost: false, isCohost: false, isPodOrganiser: false,
    inAudience: true, isInvited: true, participantStatus: null, accountActive: true, myRequest: null,
    outsideClosedCircle: false, publication: 'draft', archived: false, registrationOpensAt: null, eventTimezone: null,
    isPodAdmin: false, placesHeld: 0, admissionMode: null, entitled: false, entitledVia: null, capacity: null, placesTaken: 0, waitlistPosition: null, waitlistAhead: 0, eventStatus: 'scheduled', ...overrides,
  });
  const NOT_FOUND = { status: 404, message: "We couldn't find that event." };

  beforeEach(async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    mockFacts.draftFacts = draft();
    const { readEventAccessFacts } = jest.requireMock('../../../services/session/event-access');
    (readEventAccessFacts as jest.Mock).mockImplementation(async () => mockFacts.draftFacts);
  });

  afterEach(() => {
    const { readEventAccessFacts } = jest.requireMock('../../../services/session/event-access');
    (readEventAccessFacts as jest.Mock).mockImplementation(async () => ({}));
  });

  it('reading its groups: anyone who does not run it is told it does not exist, even a pod member it invited', async () => {
    expect(await refusal(readEventGroups(EVENT, stranger))).toMatchObject(NOT_FOUND);
  });

  it('changing its groups or someone\'s group: not "only organisers", but that it does not exist', async () => {
    expect(await refusal(saveEventGroupRules(EVENT, stranger, foundersFunders()))).toMatchObject(NOT_FOUND);
    expect(await refusal(setParticipantGroups(EVENT, stranger, 'p1', ['funder'], 'organiser'))).toMatchObject(NOT_FOUND);
  });

  it('its host reads and changes them', async () => {
    mockFacts.draftFacts = draft({ isHost: true });
    expect((await readEventGroups(EVENT, host)).groups.map((g) => g.key)).toEqual(['founder', 'funder']);
    await expect(saveEventGroupRules(EVENT, host, foundersFunders())).resolves.toBeDefined();
  });

  it('once published, someone who may see it but does not run it gets the usual "only organisers"', async () => {
    mockFacts.draftFacts = draft({ publication: 'published' });
    expect(await refusal(saveEventGroupRules(EVENT, stranger, foundersFunders()))).toMatchObject({ status: 403 });
  });
});

describe('an event without groups reads as none', () => {
  it('everyone gets no groups; an organiser gets no rules, no counts, no capacity', async () => {
    expect(await readEventGroups(EVENT, stranger)).toEqual({ groups: [], question: 'Which group are you in?', allowMultiple: false, mine: [] });
    expect(await readEventGroups(EVENT, host)).toMatchObject({ groups: [], rules: null, counts: {}, capacity: [], members: {} });
  });
});

// ─── Spec 05: platform role, event role and event group are independent ─────

describe('spec 05, the critical distinction', () => {
  const serverSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');
  const withoutComments = (src: string) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const sqlOf = (src: string) => (withoutComments(src).match(/`[^`]*`/g) ?? []).join('\n');

  it('a super admin who is a participant in the group funder still passes requireRole(SUPER_ADMIN), without a group read', async () => {
    await saveEventGroupRules(EVENT, host, foundersFunders());
    world.participants.set('stefan', 'registered');
    await setParticipantGroups(EVENT, null, 'stefan', ['funder'], 'self');
    world.sql = [];
    const next = jest.fn();
    requireRole(UserRole.SUPER_ADMIN)({ user: { userId: 'stefan', role: UserRole.SUPER_ADMIN } } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(world.sql).toEqual([]);
  });

  it('and is kept out of matching as before: the host set (getAllHostIds) reads no group', () => {
    const src = serverSrc('services/session/host-set.ts');
    const start = src.indexOf('export async function getAllHostIds');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/u\.role = 'super_admin'/);
    expect(body).not.toMatch(/event_groups|event_participant_groups|groupsOf|groupsFor/);
  });

  it('no group lookup reads a platform role or a designation, and the SQL never asks for one', () => {
    for (const rel of ['services/session/event-groups.service.ts', 'services/matching/constraint-context.ts']) {
      const src = serverSrc(rel);
      expect(sqlOf(src)).not.toMatch(/\brole\b|designation/i);
      expect(withoutComments(src)).not.toMatch(/designation/i);
      // A role only ever decides who RUNS the event (canActAsHost, canSeeEvent), never which group anyone is in.
      const roleLines = withoutComments(src).split('\n').filter((line) => /\brole\b|\bRole\b/.test(line));
      for (const line of roleLines) {
        expect(line).toMatch(/^import |canActAsHost\(|canSeeEvent\(|role: UserRole|userRole: UserRole|UserRole \| undefined/);
      }
    }
  });

  it('nothing reads a permission from a group: the role checks never look at the group tables', () => {
    for (const rel of ['middleware/rbac.ts', 'services/roles/effective-role.service.ts', 'services/session/event-access.ts']) {
      expect(serverSrc(rel)).not.toMatch(/event_groups|event_participant_groups/);
    }
  });
});

describe('the service\'s SQL', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../services/session/event-groups.service.ts'), 'utf8');

  it('each INSERT … SELECT names its parameter types: Postgres cannot take them from the target there', () => {
    // Found by the task's read-only probe: `SELECT $1, $2, g.id … WHERE g.session_id = $1` is refused with
    // "inconsistent types deduced for parameter $1".
    expect(src).toMatch(/INSERT INTO event_groups \(session_id, key, label, description, position\)\s+SELECT \$1::uuid, /);
    expect(src).toMatch(/INSERT INTO event_round_rules \(session_id, from_round, to_round, mode, allowed_pairs\)\s+SELECT \$1::uuid, /);
    expect(src).toMatch(/SELECT \$1::uuid, \$2::uuid, g\.id, \$4::text, \$5::uuid FROM event_groups g WHERE g\.session_id = \$1::uuid /);
  });
});

// ─── Migration 138 ───────────────────────────────────────────────────────────

describe('migration 138 (event_groups, event_matching_rules, event_round_rules, event_participant_groups)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../db/migrations/138_event_groups.sql'), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');
  const flatCode = code.replace(/\s+/g, ' ');

  it('only creates: guarded, no transaction control, nothing dropped or rewritten', () => {
    expect(code.replace(/ON DELETE (CASCADE|SET NULL)/g, '')).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/i);
    for (const stmt of flatCode.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(stmt).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
    }
  });

  it('every table has a uuid id, a created_at, and every reference says what happens on delete', () => {
    for (const table of ['event_groups', 'event_matching_rules', 'event_round_rules', 'event_participant_groups']) {
      const body = flatCode.slice(flatCode.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
      const def = body.slice(0, body.indexOf(');'));
      expect(def).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
      expect(def).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
      for (const ref of def.match(/REFERENCES [a-z_]+\([a-z_]+\)[^,]*/g) ?? []) expect(ref).toMatch(/ON DELETE (CASCADE|SET NULL)/);
    }
  });

  it('holds the brief\'s limits', () => {
    expect(flatCode).toContain("key TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,32}$')");
    expect(flatCode).toContain('UNIQUE (session_id, key)');
    expect(flatCode).toContain("group_question TEXT NOT NULL DEFAULT 'Which group are you in?' CHECK (char_length(group_question) <= 120)");
    expect(flatCode).toContain("CHECK (imbalance_fallback IN ('leave_unmatched', 'same_group_meeting'))");
    expect(flatCode).toContain("mode TEXT NOT NULL CHECK (mode IN ('open', 'cross_group', 'custom'))");
    expect(flatCode).toContain('UNIQUE (session_id, from_round)');
    expect(flatCode).toContain("assigned_by TEXT NOT NULL CHECK (assigned_by IN ('self', 'organiser', 'invitation'))");
    expect(flatCode).toContain('UNIQUE (session_id, user_id, group_id)');
    expect(flatCode).toContain('ON event_participant_groups (session_id, user_id)');
  });
});
