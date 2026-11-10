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
export interface ScheduleWorld {
  session: {
    id: string; host_user_id: string; status: string; current_round: number; config: Record<string, unknown>;
    scheduled_at: string | null; event_format: string;
  };
  cohosts: string[];
  participants: Array<{ user_id: string; status: string; created_at: number }>;
  users: Map<string, { display_name: string; role: string; status: string }>;
  schedule: { revision: number; published_version: number | null; generated_at: number | null; updated_by: string | null } | null;
  seats: SeatRow[];
  locks: Array<{ round_number: number; room_number: number; locked_by: string | null }>;
  absences: Array<{ user_id: string; kind: string; from_round: number; to_round: number | null; created_by: string | null }>;
  matches: Array<{ round_number: number; a: string; b: string; c: string | null }>;
  audit: Array<{ actor_id: string | null; action: string; details: Record<string, unknown> }>;
  rules: EventGroupRules | null;
  groups: Map<string, string[]>;
  blocks: Array<[string, string]>;
  organisers: Set<string>;
  sql: string[];
  honourLocks: boolean;
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
    audit: [],
    rules: null,
    groups: new Map(),
    blocks: [],
    organisers: new Set([HOST, COHOST]),
    sql: [],
    honourLocks: true,
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

type Snapshot = Pick<ScheduleWorld, 'schedule' | 'seats' | 'locks' | 'absences' | 'audit'>;
const snapshot = (): Snapshot => JSON.parse(JSON.stringify({
  schedule: world.schedule, seats: world.seats, locks: world.locks, absences: world.absences, audit: world.audit,
}));

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
  if (/^SELECT s\.host_user_id, \(SELECT u\.role FROM users u WHERE u\.id = \$2\) AS role FROM sessions s WHERE s\.id = \$1$/.test(sql)) {
    return rows([{ host_user_id: s.host_user_id, role: world.users.get(params[1] as string)?.role ?? null }]);
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
  if (/^SELECT round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches/.test(sql)) {
    return rows(world.matches);
  }

  // The schedule row
  if (sql === 'INSERT INTO event_schedules (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING') {
    if (!world.schedule) world.schedule = { revision: 0, published_version: null, generated_at: null, updated_by: null };
    return rows([]);
  }
  if (/^SELECT revision, published_version FROM event_schedules WHERE session_id = \$1( FOR UPDATE)?$/.test(sql)) {
    return rows(world.schedule ? [{ revision: world.schedule.revision, published_version: world.schedule.published_version }] : []);
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
  if (sql === 'SELECT user_id, kind, from_round, to_round FROM event_schedule_absences WHERE session_id = $1') {
    return rows(world.absences.map(({ user_id, kind, from_round, to_round }) => ({ user_id, kind, from_round, to_round })));
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
