// ─── One event's matching board in memory (10 Nov 2026 spec, Part 2 Task 8) ─────────────────────────────────
//
// Postgres is not part of the unit suite, so the board's services run against this stand-in. It keeps the rows the
// board reads and writes (the event, its people and co-hosts, the draft's seats, locks and absences, played
// matches, audit rows) and answers the statements the real code sends, matched on their text. Any write it does
// not know throws, so an unexpected statement fails the test instead of passing silently.
//
// It models the one thing concurrent editing rests on: `SELECT ... FROM event_schedules ... FOR UPDATE`. A
// transaction asking for the event's schedule row waits until the transaction holding it commits or rolls back,
// as Postgres does, and every statement yields to the event loop first, so two transactions that are NOT
// serialised interleave. `honourLocks: false` turns the lock into a no-op; the test that uses it shows the harness
// does see the race, so a green run means the lock did the work. A transaction that throws rolls back.
//
// The board's SQL itself is run against Postgres by the task's read-only probe (see the task report).

import type { EventGroupRules } from '@rsn/shared';

export const EVENT = '00000000-0000-4000-8000-0000000000ee';
export const HOST = 'host';
export const COHOST = 'cohost';

export interface SeatRow {
  round_number: number; room_number: number; user_id: string; slot_locked: boolean; source: string;
  override: boolean; fallback: boolean; created_at: number;
}
export interface LiveMatch {
  id: string; round_number: number; a: string; b: string | null; c: string | null; status: string; is_manual: boolean;
  locked: boolean; schedule_version: number | null; assignment_source: string | null; is_override: boolean; created_at: number;
}
export interface VersionRow {
  session_id: string; version: number; published_by: string | null; automatic: boolean; reason: string | null;
  note: string | null; impacted_count: number; snapshot: string; created_at: string;
}
export interface ScheduleWorld {
  session: {
    id: string; host_user_id: string; status: string; current_round: number; config: Record<string, unknown>;
    scheduled_at: string | null; event_format: string;
  };
  cohosts: string[];
  /**
   * event_matching_rules.override_by (Part 3 Task 12, migration 147): who may override the group rules. null: no row
   * (the event has no groups saved), which reads as 'owner', as does 'owner'.
   */
  overrideBy: 'owner' | 'owner_and_cohosts' | null;
  participants: Array<{ user_id: string; status: string; created_at: number }>;
  users: Map<string, { display_name: string; role: string; status: string }>;
  schedule: { revision: number; published_version: number | null; generated_at: number | null; updated_by: string | null; live_conflicts?: unknown[] } | null;
  seats: SeatRow[];
  locks: Array<{ round_number: number; room_number: number; locked_by: string | null }>;
  absences: Array<{ user_id: string; kind: string; from_round: number; to_round: number | null; created_by: string | null }>;
  /** The live matches table (Part 2 Task 9): planned, active, completed and cancelled rows. */
  matches: LiveMatch[];
  /** Published versions (Part 2 Task 9), in the order written. */
  versions: VersionRow[];
  /** Bells written (Part 2 Task 9). */
  notifications: Array<{ id: string; user_id: string; type: string; title: string; body: string; link: string }>;
  /** Socket emits through the fake io (Part 2 Task 9). */
  emits: Array<{ room: string; event: string; payload: unknown }>;
  audit: Array<{ actor_id: string | null; action: string; details: Record<string, unknown> }>;
  rules: EventGroupRules | null;
  groups: Map<string, string[]>;
  blocks: Array<[string, string]>;
  organisers: Set<string>;
  sql: string[];
  honourLocks: boolean;
  /** The "is there a published version?" read fails (a database error), as on a connection drop. */
  failVersionRead: boolean;
  /** The second check (any live match written from a published schedule?) fails too. */
  failBoardCheck: boolean;
}

let clock = 0;
const tick = () => ++clock;

export function freshWorld(): ScheduleWorld {
  return {
    session: {
      id: EVENT, host_user_id: HOST, status: 'scheduled', current_round: 0,
      config: { numberOfRounds: 5, roundDurationSeconds: 480, ratingWindowSeconds: 30, matchingPolicy: 'within_event' },
      scheduled_at: '2026-12-01T18:00:00.000Z', event_format: 'speed_networking',
    },
    cohosts: [COHOST],
    overrideBy: null,
    participants: [],
    users: new Map([
      [HOST, { display_name: 'Hana Host', role: 'member', status: 'active' }],
      [COHOST, { display_name: 'Cody Cohost', role: 'member', status: 'active' }],
    ]),
    schedule: null,
    seats: [],
    locks: [],
    absences: [],
    matches: [],
    versions: [],
    notifications: [],
    emits: [],
    audit: [],
    rules: null,
    groups: new Map(),
    blocks: [],
    organisers: new Set([HOST, COHOST]),
    sql: [],
    honourLocks: true,
    failVersionRead: false,
    failBoardCheck: false,
  };
}

export let world: ScheduleWorld = freshWorld();
export function resetWorld(): ScheduleWorld {
  world = freshWorld();
  lockHolder = null;
  waiters.length = 0;
  return world;
}

/** A person with a place in the event, registered after everyone added before them. */
export function addPerson(id: string, name = id, status = 'registered'): void {
  world.users.set(id, { display_name: name, role: 'member', status: 'active' });
  world.participants.push({ user_id: id, status, created_at: tick() });
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const rows = <T>(r: T[]) => ({ rows: r, rowCount: r.length });
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─── The row lock on event_schedules ─────────────────────────────────────────

let lockHolder: symbol | null = null;
const waiters: Array<() => void> = [];

async function takeLock(tx: symbol): Promise<void> {
  if (!world.honourLocks) return;
  while (lockHolder !== null && lockHolder !== tx) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  lockHolder = tx;
}

function releaseLock(tx: symbol): void {
  if (lockHolder !== tx) return;
  lockHolder = null;
  const next = waiters.splice(0);
  for (const wake of next) wake();
}

type Snapshot = Pick<ScheduleWorld, 'schedule' | 'seats' | 'locks' | 'absences' | 'audit' | 'versions'>;
const snapshot = (): Snapshot => JSON.parse(JSON.stringify({
  schedule: world.schedule, seats: world.seats, locks: world.locks, absences: world.absences, audit: world.audit,
  versions: world.versions,
}));

let matchIds = 0;
/** The number in the id the next match row will get (rows are numbered in the order written). */
export const nextMatchNumber = () => matchIds + 1;
/** A live match row, as the engine or a test writes one (the id is new). */
export function addMatch(m: Partial<LiveMatch> & Pick<LiveMatch, 'round_number' | 'a' | 'b'>): LiveMatch {
  const row: LiveMatch = {
    id: `m${++matchIds}`, c: null, status: 'scheduled', is_manual: false, locked: false, schedule_version: null,
    assignment_source: null, is_override: false, created_at: tick(), ...m,
  };
  world.matches.push(row);
  return row;
}

/** What the tests mock realtime/emit's getRealtimeIo with: every emit is kept in world.emits. */
export const fakeIo = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => { world.emits.push({ room, event, payload }); } }),
};

// ─── Statements ──────────────────────────────────────────────────────────────

function handle(raw: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const sql = flat(raw);
  world.sql.push(sql);
  const s = world.session;

  // Events and people
  if (sql === 'SELECT id FROM sessions WHERE id = $1') return rows(params[0] === s.id ? [{ id: s.id }] : []);
  if (/^SELECT host_user_id, status, current_round, config, scheduled_at, event_format FROM sessions WHERE id = \$1$/.test(sql)) {
    return rows(params[0] === s.id ? [{ ...s }] : []);
  }
  // mayOverrideGroupRules (Part 3 Task 12): the owner, the actor's role, the owner's choice and whether they co-host.
  if (/^SELECT s\.host_user_id, \(SELECT u\.role FROM users u WHERE u\.id = \$2\) AS role, \(SELECT r\.override_by FROM event_matching_rules r WHERE r\.session_id = s\.id\) AS override_by, EXISTS \(SELECT 1 FROM session_cohosts c WHERE c\.session_id = s\.id AND c\.user_id = \$2 AND c\.role = 'co_host'\) AS is_cohost FROM sessions s WHERE s\.id = \$1$/.test(sql)) {
    return rows(params[0] === s.id ? [{
      host_user_id: s.host_user_id,
      role: world.users.get(params[1] as string)?.role ?? null,
      override_by: world.overrideBy,
      is_cohost: world.cohosts.includes(params[1] as string),
    }] : []);
  }
  if (/^SELECT host_user_id AS user_id FROM sessions WHERE id = \$1 AND host_user_id IS NOT NULL UNION SELECT user_id FROM session_cohosts WHERE session_id = \$1$/.test(sql)) {
    return rows([...new Set([s.host_user_id, ...world.cohosts])].map((user_id) => ({ user_id })));
  }
  if (sql === 'SELECT user_id FROM session_cohosts WHERE session_id = $1') return rows(world.cohosts.map((user_id) => ({ user_id })));
  if (/^SELECT sp\.user_id FROM session_participants sp JOIN users u ON u\.id = sp\.user_id WHERE sp\.session_id = \$1 AND u\.role = 'super_admin'$/.test(sql)) {
    return rows(world.participants.filter((p) => world.users.get(p.user_id)?.role === 'super_admin').map((p) => ({ user_id: p.user_id })));
  }
  if (sql === "SELECT user_id FROM session_participants WHERE session_id = $1 AND status <> 'removed'") {
    return rows(world.participants.filter((p) => p.status !== 'removed').map((p) => ({ user_id: p.user_id })));
  }
  if (/^SELECT sp\.user_id, sp\.status::text AS status, u\.display_name, u\.avatar_url, \(u\.status = 'active'\) AS active FROM session_participants sp JOIN users u ON u\.id = sp\.user_id WHERE sp\.session_id = \$1 ORDER BY sp\.created_at, sp\.user_id$/.test(sql)) {
    return rows([...world.participants].sort((a, b) => a.created_at - b.created_at).map((p) => {
      const u = world.users.get(p.user_id)!;
      return { user_id: p.user_id, status: p.status, display_name: u.display_name, avatar_url: null, active: u.status === 'active' };
    }));
  }
  if (/^SELECT id AS user_id, NULL::text AS status, display_name, avatar_url, \(status = 'active'\) AS active FROM users WHERE id = ANY\(\$1::uuid\[\]\) ORDER BY id$/.test(sql)) {
    return rows((params[0] as string[]).filter((id) => world.users.has(id)).sort().map((id) => {
      const u = world.users.get(id)!;
      return { user_id: id, status: null, display_name: u.display_name, avatar_url: null, active: u.status === 'active' };
    }));
  }
  // The engine's people rows (prepareBoardRoundGenerator)
  if (/^SELECT u\.id AS "userId", .* FROM users u WHERE u\.id = ANY\(\$1::uuid\[\]\)$/.test(sql)) {
    return rows((params[0] as string[]).filter((id) => world.users.has(id)).map((userId) => ({
      userId, interests: [], reasonsToConnect: [], industry: null, company: null, languages: ['english'], timezone: 'UTC',
      attributes: {}, isPremium: false,
    })));
  }
  if (sql === "SELECT round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches WHERE session_id = $1 AND status IN ('completed', 'active') AND is_manual = FALSE") {
    return rows(world.matches.filter((m) => (m.status === 'completed' || m.status === 'active') && !m.is_manual));
  }
  const live = handleLive(sql, params);
  if (live) return live;

  // The schedule row
  if (sql === 'INSERT INTO event_schedules (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING') {
    if (!world.schedule) world.schedule = { revision: 0, published_version: null, generated_at: null, updated_by: null, live_conflicts: [] };
    return rows([]);
  }
  if (/^SELECT revision, published_version, live_conflicts FROM event_schedules WHERE session_id = \$1( FOR UPDATE)?$/.test(sql)) {
    return rows(world.schedule ? [{
      revision: world.schedule.revision, published_version: world.schedule.published_version, live_conflicts: world.schedule.live_conflicts ?? [],
    }] : []);
  }
  if (/^UPDATE event_schedules SET revision = revision \+ 1, updated_by = \$2, updated_at = NOW\(\), generated_at = CASE WHEN \$3::boolean THEN NOW\(\) ELSE generated_at END WHERE session_id = \$1 AND revision = \$4 RETURNING revision$/.test(sql)) {
    const sched = world.schedule!;
    if (sched.revision !== params[3]) return rows([]);
    sched.revision += 1;
    sched.updated_by = params[1] as string;
    if (params[2]) sched.generated_at = tick();
    return rows([{ revision: sched.revision }]);
  }

  // Seats
  if (/^SELECT round_number, room_number, user_id, slot_locked, source, override, fallback FROM event_schedule_assignments WHERE session_id = \$1 ORDER BY round_number, room_number, created_at, user_id$/.test(sql)) {
    return rows([...world.seats].sort((a, b) => a.round_number - b.round_number || a.room_number - b.room_number
      || a.created_at - b.created_at || a.user_id.localeCompare(b.user_id)));
  }
  if (sql === 'DELETE FROM event_schedule_assignments WHERE session_id = $1 AND round_number = ANY($2::int[])') {
    const gone = params[1] as number[];
    world.seats = world.seats.filter((r) => !gone.includes(r.round_number));
    return rows([]);
  }
  if (/^INSERT INTO event_schedule_assignments \(session_id, round_number, room_number, user_id, slot_locked, source, override, fallback\) SELECT \$1::uuid, .* FROM unnest\(/.test(sql)) {
    const [, rounds, rooms, users, slots, sources, overrides, fallbacks] = params as [string, number[], number[], string[], boolean[], string[], boolean[], boolean[]];
    rounds.forEach((round, i) => {
      if (world.seats.some((r) => r.round_number === round && r.user_id === users[i])) {
        throw new Error('duplicate key value violates unique constraint "event_schedule_assignments_session_id_round_number_user_id_key"');
      }
      world.seats.push({
        round_number: round, room_number: rooms[i], user_id: users[i], slot_locked: slots[i], source: sources[i],
        override: overrides[i], fallback: fallbacks[i], created_at: tick(),
      });
    });
    return rows([]);
  }

  // Locks
  if (sql === 'SELECT round_number, room_number FROM event_schedule_room_locks WHERE session_id = $1') {
    return rows(world.locks.map(({ round_number, room_number }) => ({ round_number, room_number })));
  }
  if (/^INSERT INTO event_schedule_room_locks .* ON CONFLICT \(session_id, round_number, room_number\) DO NOTHING$/.test(sql)) {
    const [, rounds, rooms, by] = params as [string, number[], number[], string];
    rounds.forEach((round, i) => {
      if (!world.locks.some((l) => l.round_number === round && l.room_number === rooms[i])) {
        world.locks.push({ round_number: round, room_number: rooms[i], locked_by: by });
      }
    });
    return rows([]);
  }
  if (/^DELETE FROM event_schedule_room_locks l USING unnest/.test(sql)) {
    const [, rounds, rooms] = params as [string, number[], number[]];
    world.locks = world.locks.filter((l) => !rounds.some((r, i) => r === l.round_number && rooms[i] === l.room_number));
    return rows([]);
  }

  // Absences
  if (sql === 'SELECT user_id, kind, from_round, to_round, (created_by IS NULL) AS automatic FROM event_schedule_absences WHERE session_id = $1') {
    return rows(world.absences.map(({ user_id, kind, from_round, to_round, created_by }) => ({
      user_id, kind, from_round, to_round, automatic: created_by === null,
    })));
  }
  if (/^INSERT INTO event_schedule_absences .* ON CONFLICT \(session_id, user_id\) DO UPDATE/.test(sql)) {
    const [, user_id, kind, from_round, to_round, created_by] = params as [string, string, string, number, number | null, string];
    world.absences = world.absences.filter((a) => a.user_id !== user_id);
    world.absences.push({ user_id, kind, from_round, to_round, created_by });
    return rows([]);
  }
  if (sql === 'DELETE FROM event_schedule_absences WHERE session_id = $1 AND user_id = $2') {
    world.absences = world.absences.filter((a) => a.user_id !== params[1]);
    return rows([]);
  }

  // The audit trail
  if (/^INSERT INTO audit_log \(actor_id, action, entity_type, entity_id, details\)/.test(sql)) {
    world.audit.push({ actor_id: params[0] as string | null, action: params[1] as string, details: JSON.parse(params[3] as string) });
    return rows([]);
  }

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return rows([]);
  // Reads the engine makes that this event has nothing for (invites, reports, premium requests, intent profiles).
  if (/^SELECT /.test(sql)) return rows([]);
  throw new Error(`schedule-world does not know this statement: ${sql}`);
}

// ─── Published versions and the live matches (Part 2 Task 9) ─────────────────

const membersOf = (m: LiveMatch) => [m.a, m.b, m.c].filter((id): id is string => !!id);

function handleLive(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } | null {
  const s = world.session;
  // Versions
  if (sql === 'SELECT snapshot FROM event_schedule_versions WHERE session_id = $1 AND version = $2') {
    const v = world.versions.find((x) => x.version === params[1]);
    return rows(v ? [{ snapshot: JSON.parse(v.snapshot) }] : []);
  }
  if (sql === 'SELECT version, snapshot FROM event_schedule_versions WHERE session_id = $1 ORDER BY version DESC LIMIT 1'
    || sql === 'SELECT version, created_at, snapshot FROM event_schedule_versions WHERE session_id = $1 ORDER BY version DESC LIMIT 1') {
    const v = [...world.versions].sort((a, b) => b.version - a.version)[0];
    return rows(v ? [{ version: v.version, created_at: v.created_at, snapshot: JSON.parse(v.snapshot) }] : []);
  }
  if (/^INSERT INTO event_schedule_versions \(session_id, version, published_by, automatic, reason, note, impacted_count, snapshot\) VALUES/.test(sql)) {
    const [session_id, version, published_by, automatic, reason, note, impacted_count, snapshot] = params as [string, number, string | null, boolean, string | null, string | null, number, string];
    if (world.versions.some((v) => v.version === version)) throw new Error('duplicate key value violates unique constraint "event_schedule_versions_session_id_version_key"');
    world.versions.push({ session_id, version, published_by, automatic, reason, note, impacted_count, snapshot, created_at: new Date(1_800_000_000_000 + tick() * 1000).toISOString() });
    return rows([]);
  }
  if (/^UPDATE event_schedule_versions/.test(sql)) throw new Error('A published schedule version cannot be changed');
  if (/^SELECT v\.version, v\.created_at, v\.published_by, u\.display_name/.test(sql)) {
    return rows([...world.versions].sort((a, b) => b.version - a.version).map((v) => {
      const u = v.published_by ? world.users.get(v.published_by) : undefined;
      return {
        version: v.version, created_at: v.created_at, published_by: v.published_by, display_name: u?.display_name ?? null,
        active: u ? u.status === 'active' : null, automatic: v.automatic, reason: v.reason, note: v.note, impacted_count: v.impacted_count,
      };
    }));
  }
  if (sql === "UPDATE event_schedules SET published_version = $2, revision = revision + 1, updated_at = NOW(), live_conflicts = CASE WHEN $3::boolean THEN '[]'::jsonb ELSE live_conflicts END WHERE session_id = $1 RETURNING revision") {
    const sched = world.schedule!;
    sched.published_version = params[1] as number;
    sched.revision += 1;
    if (params[2]) sched.live_conflicts = [];
    return rows([{ revision: sched.revision }]);
  }
  if (sql === 'SELECT EXISTS (SELECT 1 FROM matches WHERE session_id = $1 AND (locked OR schedule_version IS NOT NULL)) AS board') {
    if (world.failBoardCheck) throw new Error('Connection terminated unexpectedly');
    return rows([{ board: world.matches.some((m) => m.locked || m.schedule_version !== null) }]);
  }
  if (sql === "UPDATE event_schedules SET live_conflicts = '[]'::jsonb WHERE session_id = $1") {
    world.schedule!.live_conflicts = [];
    return rows([]);
  }
  if (sql === 'UPDATE event_schedules SET live_conflicts = live_conflicts || $2::jsonb WHERE session_id = $1') {
    const sched = world.schedule!;
    sched.live_conflicts = [...(sched.live_conflicts ?? []), ...JSON.parse(params[1] as string)];
    return rows([]);
  }
  if (sql === 'SELECT host_user_id FROM sessions WHERE id = $1') return rows([{ host_user_id: s.host_user_id }]);
  if (sql === 'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])') {
    return rows((params[0] as string[]).filter((id) => world.users.has(id)).map((id) => ({ id, display_name: world.users.get(id)!.display_name })));
  }
  if (sql === 'SELECT published_version FROM event_schedules WHERE session_id = $1') {
    if (world.failVersionRead) throw new Error('Connection terminated unexpectedly');
    return rows(world.schedule ? [{ published_version: world.schedule.published_version }] : []);
  }
  if (sql === 'SELECT user_id FROM event_schedule_absences WHERE session_id = $1 AND created_by IS NULL') {
    return rows(world.absences.filter((a) => a.created_by === null).map((a) => ({ user_id: a.user_id })));
  }

  // The event and its people
  if (sql === 'SELECT title FROM sessions WHERE id = $1') return rows([{ title: 'Founders Night' }]);
  if (sql === 'SELECT current_round FROM sessions WHERE id = $1') return rows([{ current_round: s.current_round }]);
  if (sql === 'SELECT config, scheduled_at FROM sessions WHERE id = $1') {
    return rows(params[0] === s.id ? [{ config: s.config, scheduled_at: s.scheduled_at }] : []);
  }
  if (sql === 'SELECT user_id, status::text AS status FROM session_participants WHERE session_id = $1') {
    return rows(world.participants.map(({ user_id, status }) => ({ user_id, status })));
  }
  if (sql === 'SELECT status::text AS status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    return rows(world.participants.filter((p) => p.user_id === params[1]).map(({ status }) => ({ status })));
  }
  if (sql === 'SELECT role FROM users WHERE id = $1') {
    const u = world.users.get(params[0] as string);
    return rows(u ? [{ role: u.role }] : []);
  }
  if (sql === "SELECT id, display_name, avatar_url, (status = 'active') AS active FROM users WHERE id = ANY($1::uuid[])") {
    return rows((params[0] as string[]).filter((id) => world.users.has(id)).map((id) => {
      const u = world.users.get(id)!;
      return { id, display_name: u.display_name, avatar_url: `https://pics.example/${id}.jpg`, active: u.status === 'active' };
    }));
  }

  // Bells
  if (/^INSERT INTO notifications \(user_id, type, title, body, link\) SELECT t\.user_id/.test(sql)) {
    const [users, titles, type, body, link] = params as [string[], string[], string, string, string];
    const made = users.map((user_id, i) => ({ id: `n${tick()}`, user_id, type, title: titles[i], body, link }));
    world.notifications.push(...made);
    return rows(made.map((n) => ({ id: n.id, user_id: n.user_id, title: n.title, created_at: new Date(0) })));
  }

  // The live matches
  if (sql === 'SELECT id, round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, status::text AS status, is_manual, locked, schedule_version, assignment_source, is_override FROM matches WHERE session_id = $1 AND round_number >= $2') {
    return rows(world.matches.filter((m) => m.round_number >= (params[1] as number)).map((m) => ({ ...m })));
  }
  if (sql === "DELETE FROM matches WHERE id = ANY($1::uuid[]) AND status = 'scheduled'") {
    const ids = params[0] as string[];
    world.matches = world.matches.filter((m) => !(ids.includes(m.id) && m.status === 'scheduled'));
    return rows([]);
  }
  if (/^UPDATE matches m SET locked = t\.locked, schedule_version = \$2, assignment_source = t\.source, is_override = t\.override FROM unnest/.test(sql)) {
    const [ids, version, locked, sources, overrides] = params as [string[], number, boolean[], string[], boolean[]];
    ids.forEach((id, i) => {
      const m = world.matches.find((x) => x.id === id && x.status === 'scheduled');
      if (m) Object.assign(m, { locked: locked[i], schedule_version: version, assignment_source: sources[i], is_override: overrides[i] });
    });
    return rows([]);
  }
  if (/^INSERT INTO matches \(session_id, round_number, participant_a_id, participant_b_id, participant_c_id, status, reason_tags, match_reason, locked, schedule_version, assignment_source, is_override\) SELECT/.test(sql)) {
    const [, version, rounds, as, bs, cs, locked, sources, overrides] = params as [string, number, number[], string[], string[], Array<string | null>, boolean[], string[], boolean[]];
    rounds.forEach((round, i) => {
      for (const id of [as[i], bs[i], cs[i]].filter(Boolean)) {
        if (world.matches.some((m) => m.round_number === round && m.status === 'scheduled' && membersOf(m).includes(id!))) {
          throw new Error(`schedule-world: ${id} would sit in two planned rooms of round ${round}`);
        }
      }
      addMatch({ round_number: round, a: as[i], b: bs[i], c: cs[i], locked: locked[i], schedule_version: version, assignment_source: sources[i], is_override: overrides[i] });
    });
    return rows([]);
  }
  if (sql === "SELECT round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches WHERE session_id = $1 AND status = 'scheduled' AND is_manual = FALSE ORDER BY round_number, created_at") {
    return rows(world.matches.filter((m) => m.status === 'scheduled' && !m.is_manual)
      .sort((x, y) => x.round_number - y.round_number || x.created_at - y.created_at)
      .map(({ round_number, a, b, c }) => ({ round_number, a, b, c })));
  }
  if (sql === "SELECT participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled' AND locked") {
    return rows(world.matches.filter((m) => m.round_number === params[1] && m.status === 'scheduled' && m.locked).map(({ a, b, c }) => ({ a, b, c })));
  }
  if (sql === 'SELECT EXISTS (SELECT 1 FROM matches WHERE id = ANY($1::uuid[]) AND locked) AS locked') {
    return rows([{ locked: world.matches.some((m) => (params[0] as string[]).includes(m.id) && m.locked) }]);
  }
  if (sql === "SELECT id, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, is_override FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled' AND schedule_version IS NOT NULL") {
    return rows(world.matches.filter((m) => m.round_number === params[1] && m.status === 'scheduled' && m.schedule_version !== null)
      .map(({ id, a, b, c, is_override }) => ({ id, a, b, c, is_override })));
  }
  if (sql === "UPDATE matches SET status = 'cancelled', ended_at = NOW() WHERE id = ANY($1::uuid[]) AND status = 'scheduled'") {
    for (const m of world.matches) if ((params[0] as string[]).includes(m.id) && m.status === 'scheduled') m.status = 'cancelled';
    return rows([]);
  }
  // The live engine's own statements (generateSingleRound and persistMatches), and the host's Re-match wipe
  if (/^SELECT u\.id AS "userId", .* FROM session_participants sp JOIN users u ON u\.id = sp\.user_id WHERE sp\.session_id = \$1 AND sp\.status NOT IN \('removed', 'left', 'no_show'\) AND sp\.user_id != ALL\(\$2::uuid\[\]\) AND NOT EXISTS/.test(sql)) {
    const excluded = params[1] as string[];
    const inActive = new Set(world.matches.filter((m) => m.status === 'active').flatMap(membersOf));
    return rows(world.participants
      .filter((p) => !['removed', 'left', 'no_show'].includes(p.status) && !excluded.includes(p.user_id) && !inActive.has(p.user_id))
      .map((p) => ({
        userId: p.user_id, interests: [], reasonsToConnect: [], industry: null, company: null, languages: ['english'], timezone: 'UTC',
        attributes: {}, isPremium: false,
      })));
  }
  if (sql === "SELECT participant_a_id, participant_b_id, participant_c_id FROM matches WHERE session_id = $1 AND round_number != $2 AND status IN ('completed', 'active') AND is_manual = FALSE") {
    return rows(world.matches.filter((m) => m.round_number !== params[1] && (m.status === 'completed' || m.status === 'active') && !m.is_manual)
      .map((m) => ({ participant_a_id: m.a, participant_b_id: m.b, participant_c_id: m.c })));
  }
  // repairFutureRounds' own wipe on today's path (an event without a published schedule)
  if (sql === "DELETE FROM matches WHERE session_id = $1 AND round_number >= $2 AND status = 'scheduled' AND locked = FALSE") {
    world.matches = world.matches.filter((m) => !(m.round_number >= (params[1] as number) && m.status === 'scheduled' && !m.locked));
    return rows([]);
  }
  if (sql === "DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled') AND locked = FALSE"
    || sql === 'DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND locked = FALSE') {
    const statuses = /status IN/.test(sql) ? ['scheduled', 'cancelled'] : null;
    world.matches = world.matches.filter((m) => !(m.round_number === params[1] && !m.locked && (!statuses || statuses.includes(m.status))));
    return rows([]);
  }
  if (/^INSERT INTO matches \(session_id, round_number, participant_a_id, participant_b_id, participant_c_id, score, reason_tags, status, match_reason, fallback_used, repeat_in_event, premium_influenced, matching_template_id, confidence\) VALUES/.test(sql)) {
    for (let i = 0; i < params.length; i += 13) {
      const round = params[i + 1] as number;
      const people = [params[i + 2], params[i + 3], params[i + 4]].filter(Boolean) as string[];
      for (const id of people) {
        if (world.matches.some((m) => m.round_number === round && m.status === 'scheduled' && membersOf(m).includes(id))) {
          throw new Error(`schedule-world: ${id} would sit in two planned rooms of round ${round}`);
        }
      }
      addMatch({ round_number: round, a: people[0], b: people[1] ?? null, c: people[2] ?? null });
    }
    return rows([]);
  }
  if (sql === "SELECT participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches WHERE session_id = $1 AND round_number = $2 AND status IN ('active', 'completed') AND is_manual = FALSE") {
    return rows(world.matches.filter((m) => m.round_number === params[1] && (m.status === 'active' || m.status === 'completed') && !m.is_manual)
      .map(({ a, b, c }) => ({ a, b, c })));
  }
  return null;
}

// ─── What the tests mock `db` with ───────────────────────────────────────────

export async function query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  await yieldToLoop();
  return handle(sql, params);
}

export async function transaction<T>(cb: (client: { query: typeof query }) => Promise<T>): Promise<T> {
  const tx = Symbol('tx');
  let before: Snapshot | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      await yieldToLoop();
      if (/FROM event_schedules WHERE session_id = \$1 FOR UPDATE$/.test(flat(sql))) {
        await takeLock(tx);
        before = snapshot();
      }
      return handle(sql, params);
    },
  };
  try {
    return await cb(client);
  } catch (err) {
    if (before) Object.assign(world, before);
    throw err;
  } finally {
    releaseLock(tx);
  }
}

/** getSessionById as the engine's generator reads it. */
export async function getSessionById(): Promise<Record<string, unknown>> {
  const s = world.session;
  return { id: s.id, podId: null, hostUserId: s.host_user_id, config: s.config };
}
