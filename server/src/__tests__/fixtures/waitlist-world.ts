// ─── An in-memory RSN for the waiting-list tests (10 Nov 2026 spec, Part 3 Task 3) ─────────────────────────
//
// Postgres is not part of the unit suite. This stand-in keeps the rows the waiting list, the registration and the paths
// that give or free a place read and write (users, events, places, co-hosts, the line, requests, invites, allowed
// emails, bells, audit rows) and answers the services' own statements, each as Postgres would for these rows. A
// statement it does not know fails the test, so nothing new slips past it unmodelled. A transaction and a savepoint
// are snapshots of the rows, put back when they are rolled back. The statements themselves run on Postgres (PGlite) in
// the task's t3-pglite.mjs, and read-only on production in its probe.

export interface WwUser {
  id: string; email: string; display_name: string; status: string; role: string; account_kind: 'member' | 'event_guest';
  guest_first_session_id: string | null; email_verified: boolean;
}
export interface WwEvent {
  id: string; title: string; status: string; publication: 'draft' | 'published'; visibility: string | null;
  admission_mode: 'open' | 'approval' | 'restricted' | null; host_user_id: string; pod_id: string; pod_visibility: string;
  config: { maxParticipants?: number } & Record<string, unknown>; scheduled_at: Date | null; timezone: string;
  call_code: string | null;
}
export interface WwPlace { session_id: string; user_id: string; status: string; left_at: Date | null; admitted_via: string | null }
export interface WwLine {
  id: string; session_id: string; user_id: string; status: string; joined_via: string; group_keys: string[];
  lapsed_reason: string | null; queued_at: number; decided_by: string | null;
  /** Fix round 3: the invite that queued them (invite accept), or none. */
  invite_id?: string | null;
}
export interface WwInvite {
  id: string; code: string; session_id: string; invitee_email: string | null; status: string; max_uses: number; use_count: number;
  inviter_id: string; created_at: Date; accepted_by_user_id?: string | null; expires_at?: Date | null;
}

interface Rows {
  users: WwUser[]; events: WwEvent[]; places: WwPlace[]; cohosts: Array<{ session_id: string; user_id: string }>;
  line: WwLine[]; requests: Array<{ id: string; session_id: string; user_id: string; status: string }>;
  invites: WwInvite[]; entries: Array<{ session_id: string; email: string; revoked_at: Date | null }>;
  podMembers: Array<{ pod_id: string; user_id: string; role: string }>;
  bells: Array<{ id: string; user_id: string; type: string; title: string; body: string; link: string }>;
  audit: Array<{ action: string; session_id: string; details: { subjectUserIds?: string[]; reason?: string | null; automatic?: boolean } }>;
}

export const world = {
  rows: emptyRows(),
  sql: [] as string[],
  clock: 0,
  /** Events whose capacity lock another instance holds (the try-lock answers false). */
  lockHeldBy: new Set<string>(),
};

function emptyRows(): Rows {
  return {
    users: [], events: [], places: [], cohosts: [], line: [], requests: [], invites: [], entries: [], podMembers: [],
    bells: [], audit: [],
  };
}

export function resetWaitlistWorld(): void {
  world.rows = emptyRows();
  world.sql = [];
  world.clock = 0;
  world.lockHeldBy = new Set();
  savepoints.clear();
}

let seq = 0;
export const wid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nextId = (): string => `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function addUser(over: Partial<WwUser> & { id: string }): WwUser {
  const u: WwUser = {
    email: `${over.id.slice(-4)}@rsn-e2e.invalid`, display_name: `Person ${over.id.slice(-2)}`, status: 'active', role: 'member',
    account_kind: 'member', guest_first_session_id: null, email_verified: true, ...over,
  };
  world.rows.users.push(u);
  return u;
}

export function addEvent(over: Partial<WwEvent> & { id: string; host_user_id: string }): WwEvent {
  const e: WwEvent = {
    title: 'Founders breakfast', status: 'scheduled', publication: 'published', visibility: 'public', admission_mode: 'open',
    pod_id: 'pod-1', pod_visibility: 'public', config: { maxParticipants: 2 },
    scheduled_at: new Date(Date.now() + 3 * 3600_000), timezone: 'Europe/Copenhagen', call_code: 'k7m2x9q4ra', ...over,
  };
  world.rows.events.push(e);
  // createSession registers the host as a participant: a row, never a place counted against capacity.
  world.rows.places.push({ session_id: e.id, user_id: e.host_user_id, status: 'registered', left_at: null, admitted_via: null });
  return e;
}

export function addPlace(sessionId: string, userId: string, status = 'registered'): void {
  world.rows.places.push({ session_id: sessionId, user_id: userId, status, left_at: status === 'removed' ? new Date(0) : null, admitted_via: null });
}

export const placeOf = (sessionId: string, userId: string): WwPlace | undefined =>
  world.rows.places.find((p) => p.session_id === sessionId && p.user_id === userId);
export const lineOf = (sessionId: string, userId: string): WwLine | undefined =>
  world.rows.line.find((l) => l.session_id === sessionId && l.user_id === userId);

const userById = (id: unknown) => world.rows.users.find((u) => u.id === id);
const eventById = (id: unknown) => world.rows.events.find((e) => e.id === id);
const active = (id: unknown) => userById(id)?.status === 'active';
const isCohost = (sessionId: unknown, userId: unknown) => world.rows.cohosts.some((c) => c.session_id === sessionId && c.user_id === userId);
const organiser = (e: WwEvent, userId: unknown) => e.host_user_id === userId || isCohost(e.id, userId);

/** capacityTakenSql: rows not removed, of an active account, the host and co-hosts left out. */
export function placesTaken(sessionId: string): number {
  const e = eventById(sessionId)!;
  return world.rows.places.filter((p) => p.session_id === sessionId && p.status !== 'removed' && !organiser(e, p.user_id) && active(p.user_id)).length;
}

const capacityOf = (e: WwEvent): number | null => {
  const n = e.config?.maxParticipants;
  return typeof n === 'number' && n >= 1 ? Math.floor(n) : null;
};

/** waitlistPositionSql: 1 + the active people waiting ahead (queued_at, id), or null when not waiting. */
export function positionOf(sessionId: string, userId: string): number | null {
  const mine = world.rows.line.find((l) => l.session_id === sessionId && l.user_id === userId && l.status === 'waiting');
  if (!mine) return null;
  const ahead = world.rows.line.filter((l) => l.session_id === sessionId && l.status === 'waiting' && active(l.user_id)
    && (l.queued_at < mine.queued_at || (l.queued_at === mine.queued_at && l.id < mine.id)));
  return 1 + ahead.length;
}

/** waitlistAheadSql: the active people waiting before this person (everyone waiting, when they are not). */
export function aheadOf(sessionId: string, userId: string): number {
  const mine = positionOf(sessionId, userId);
  if (mine !== null) return mine - 1;
  return world.rows.line.filter((l) => l.session_id === sessionId && l.status === 'waiting' && active(l.user_id)).length;
}

const listed = (e: WwEvent, u: WwUser) => world.rows.entries.some((x) => x.session_id === e.id && x.email === u.email && !x.revoked_at)
  && u.email_verified;
const personallyInvited = (e: WwEvent, u: WwUser) => world.rows.invites.some((i) => i.session_id === e.id
  && i.invitee_email?.toLowerCase() === u.email && i.max_uses <= 1 && ['accepted', 'pending'].includes(i.status));
const invited = (e: WwEvent, u: WwUser) => world.rows.invites.some((i) => i.session_id === e.id
  && i.invitee_email?.toLowerCase() === u.email && ['accepted', 'pending'].includes(i.status));
const inAudience = (e: WwEvent, userId: string) => world.rows.podMembers.some((m) => m.pod_id === e.pod_id && m.user_id === userId);

/** readEventAccessFacts' one row, as the SQL computes it. */
function factsRow(e: WwEvent, userId: string) {
  const u = userById(userId);
  const place = placeOf(e.id, userId);
  const request = world.rows.requests.find((r) => r.session_id === e.id && r.user_id === userId);
  const mode = e.admission_mode;
  return {
    visibility: e.visibility, pod_id: e.pod_id, pod_visibility: e.pod_visibility, is_host: e.host_user_id === userId,
    is_cohost: isCohost(e.id, userId),
    is_pod_organiser: world.rows.podMembers.some((m) => m.pod_id === e.pod_id && m.user_id === userId && ['director', 'host'].includes(m.role)),
    in_audience: inAudience(e, userId), is_invited: !!u && invited(e, u), participant_status: place?.status ?? null,
    account_active: !!u && u.status === 'active', my_request: request?.status ?? null, outside_closed_circle: false,
    publication: e.publication, archived: false, registration_opens_at: null, event_timezone: e.timezone, is_pod_admin: false,
    places_held: world.rows.places.filter((p) => p.session_id === e.id && p.status !== 'removed' && !organiser(e, p.user_id)).length,
    admission_mode: mode,
    admission_listed: !!mode && !!u && listed(e, u),
    admission_code_held: false,
    admission_personal_invite: !!mode && !!u && personallyInvited(e, u),
    capacity: capacityOf(e), places_taken: placesTaken(e.id), waitlist_position: positionOf(e.id, userId),
    waitlist_ahead: aheadOf(e.id, userId), event_status: e.status,
  };
}

function sessionRow(e: WwEvent, userId?: unknown) {
  return {
    id: e.id, podId: e.pod_id, title: e.title, description: null, scheduledAt: e.scheduled_at, startedAt: null, endedAt: null,
    status: e.status, currentRound: 0, config: e.config, hostUserId: e.host_user_id, lobbyRoomId: null, hostVisibilityMode: null,
    format: 'speed_networking', visibility: e.visibility, circleId: null, publication: e.publication, publishedAt: null,
    registrationOpensAt: null, archivedAt: null, cancelledAt: null, cancelReason: null, timezone: e.timezone,
    hasImage: false, imageUpdatedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    ...(userId !== undefined ? { accountActive: userById(userId) ? active(userId) : null, hasEventGroups: false } : {}),
  };
}

const participantRow = (p: WwPlace) => ({ id: `sp-${p.user_id}`, sessionId: p.session_id, userId: p.user_id, status: p.status });

// ── Transactions and savepoints: snapshots of the rows ──
const savepoints = new Map<string, Rows>();
const snapshot = (): Rows => JSON.parse(JSON.stringify(world.rows), (k, v) => (k === 'left_at' || k === 'revoked_at' || k === 'scheduled_at' || k === 'created_at') && typeof v === 'string' ? new Date(v) : v);

export async function inTransaction<T>(cb: (client: { query: typeof run }) => Promise<T>): Promise<T> {
  const saved = snapshot();
  try {
    return await cb({ query: run });
  } catch (err) {
    world.rows = saved;
    throw err;
  }
}

export async function run(raw: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
  return answer(raw, params);
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export function answer(raw: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const sql = flat(raw);
  world.sql.push(sql);
  const [a, b] = params;
  const rows = (r: unknown[], rowCount = r.length) => ({ rows: r, rowCount });

  // ── savepoints ──
  let m = /^SAVEPOINT (\w+)$/.exec(sql);
  if (m) { savepoints.set(m[1], snapshot()); return rows([]); }
  m = /^ROLLBACK TO SAVEPOINT (\w+)$/.exec(sql);
  if (m) { world.rows = savepoints.get(m[1])!; savepoints.set(m[1], snapshot()); return rows([]); }
  if (/^RELEASE SAVEPOINT \w+$/.test(sql)) return rows([]);
  if (/^SELECT pg_advisory_xact_lock\(hashtext\('event-capacity:' \|\| \$1::text\)\)$/.test(sql)) return rows([{}]);
  // Fix round 2: the stalled-line move-on only tries the lock; a test holds it (lockHeldBy) to play another instance.
  if (/^SELECT pg_try_advisory_xact_lock\(hashtext\('event-capacity:' \|\| \$1::text\)\) AS got$/.test(sql)) {
    return rows([{ got: !world.lockHeldBy.has(String(a)) }]);
  }

  // ── users ──
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') {
    const u = userById(a);
    return rows(u ? [{ status: u.status, account_kind: u.account_kind }] : []);
  }
  if (sql.startsWith('SELECT u.guest_first_session_id, EXISTS (SELECT 1 FROM session_participants sp')) {
    const u = userById(b);
    const e = eventById(a);
    return rows(u ? [{
      guest_first_session_id: u.guest_first_session_id, holds_place: !!placeOf(String(a), String(b)), admission_mode: e?.admission_mode ?? null,
      admission_entitled: !!e?.admission_mode && (listed(e, u) || personallyInvited(e, u)),
      approved_request: world.rows.requests.some((r) => r.session_id === a && r.user_id === b && r.status === 'approved'),
      on_waitlist: positionOf(String(a), String(b)) !== null,
    }] : []);
  }
  if (sql === "SELECT u.status = 'active' AS active FROM users u WHERE u.id = $1") return rows([{ active: active(a) }]);
  if (sql === 'SELECT id, email, account_kind FROM users WHERE id = ANY($1::uuid[])') {
    return rows(world.rows.users.filter((u) => (a as string[]).includes(u.id)).map((u) => ({ id: u.id, email: u.email, account_kind: u.account_kind })));
  }

  // ── the event ──
  if (/FROM sessions WHERE id = \$1$/.test(sql) && sql.includes('pod_id AS "podId"')) {
    const e = eventById(a);
    return rows(e ? [sessionRow(e, sql.includes('"accountActive"') ? b : undefined)] : []);
  }
  if (sql.startsWith('SELECT s.visibility, s.pod_id, p.visibility::text AS pod_visibility')) {
    const e = eventById(a);
    return rows(e ? [factsRow(e, String(b))] : []);
  }
  if (sql === 'SELECT visibility FROM pods WHERE id = $1') {
    const e = world.rows.events.find((x) => x.pod_id === a);
    return rows(e ? [{ visibility: e.pod_visibility }] : []);
  }
  if (sql === "SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'") {
    return rows(world.rows.podMembers.filter((x) => x.pod_id === a && x.user_id === b));
  }
  // Shirley pilot S2 fix round 2: whether an organiser removed them from the public pod (the world holds active members
  // only, so never).
  if (sql === 'SELECT removal_kind FROM pod_members WHERE pod_id = $1 AND user_id = $2') return rows([]);
  if (sql === 'SELECT key, label, description FROM event_groups WHERE session_id = $1 ORDER BY position, key') return rows([]);
  // Part 3 Task 5: no event in this world asks matching questions (the waiting list reads the one table and stops).
  if (sql === 'SELECT id, key, prompt, kind, prefer, required, options FROM event_matching_questions WHERE session_id = $1 ORDER BY position, key') return rows([]);
  if (/^SELECT \(SELECT COUNT\(\*\)::int FROM session_participants ct .* AS taken, .* AS capacity, .* AS ahead, .* AS runs FROM sessions s WHERE s\.id = \$1$/.test(sql)) {
    const e = eventById(a)!;
    return rows([{ taken: placesTaken(e.id), capacity: capacityOf(e), ahead: aheadOf(e.id, String(b)), runs: organiser(e, b) }]);
  }
  if (/^SELECT s\.status::text AS status, s\.publication, .* AS capacity, .* AS taken FROM sessions s WHERE s\.id = \$1$/.test(sql)) {
    const e = eventById(a);
    return rows(e ? [{ status: e.status, publication: e.publication, capacity: capacityOf(e), taken: placesTaken(e.id) }] : []);
  }
  if (sql === 'SELECT title, status::text AS status, scheduled_at, timezone, call_code, pod_id FROM sessions WHERE id = $1') {
    const e = eventById(a);
    return rows(e ? [{ title: e.title, status: e.status, scheduled_at: e.scheduled_at, timezone: e.timezone, call_code: e.call_code, pod_id: e.pod_id }] : []);
  }
  if (/^SELECT \(SELECT 1 \+ \(SELECT COUNT\(\*\)::int FROM event_waitlist wl_a .* AS position FROM sessions s WHERE s\.id = \$1$/.test(sql)) {
    return rows([{ position: positionOf(String(a), String(b)) }]);
  }
  if (sql.startsWith('SELECT host_user_id AS user_id FROM sessions')) return rows([]);
  if (sql === 'SELECT status FROM sessions WHERE id = $1') {
    const e = eventById(a);
    return rows(e ? [{ status: e.status }] : []);
  }
  if (sql === 'SELECT pod_id AS "podId" FROM sessions WHERE id = $1') return rows([{ podId: eventById(a)?.pod_id }]);
  if (sql === 'SELECT visibility FROM sessions WHERE id = $1') return rows([{ visibility: eventById(a)?.visibility ?? null }]);
  if (sql === 'SELECT pod_id FROM sessions WHERE id = $1') return rows([{ pod_id: eventById(a)?.pod_id ?? null }]);
  if (sql.startsWith('SELECT s.title, COALESCE(NULLIF(u.first_name')) {
    return rows([{ title: eventById(a)?.title ?? 'your event', name: userById(b)?.display_name ?? 'Someone' }]);
  }

  // ── places ──
  if (sql === 'SELECT id, status, left_at FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const p = placeOf(String(a), String(b));
    return rows(p ? [{ id: `sp-${p.user_id}`, status: p.status, left_at: p.left_at }] : []);
  }
  if (sql === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const p = placeOf(String(a), String(b));
    return rows(p ? [{ status: p.status }] : []);
  }
  if (/^SELECT session_participants\.id, .* FROM session_participants WHERE session_id = \$1 AND user_id = \$2$/.test(sql)) {
    const p = placeOf(String(a), String(b));
    return rows(p ? [participantRow(p)] : []);
  }
  if (sql.startsWith("UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE")) {
    const p = placeOf(String(a), String(b));
    const invitedAt = params[2] as Date | null;
    if (!p || (p.status === 'removed' && !(invitedAt && (!p.left_at || p.left_at < invitedAt)))) return rows([]);
    p.status = 'registered';
    p.left_at = null;
    return rows([participantRow(p)]);
  }
  if (sql.startsWith('INSERT INTO session_participants (session_id, user_id, status, acting_as_host)')) {
    if (placeOf(String(a), String(b))) return rows([], 0);
    const p: WwPlace = { session_id: String(a), user_id: String(b), status: 'registered', left_at: null, admitted_via: null };
    world.rows.places.push(p);
    return rows([participantRow(p)]);
  }
  if (sql.startsWith('INSERT INTO session_participants (session_id, user_id, status) VALUES')) {
    throw new Error('The defensive insert of the invite accept ran: it would give a place the line is for');
  }
  if (sql.startsWith('UPDATE session_participants SET admitted_via = $3')) {
    const p = placeOf(String(a), String(b));
    if (p && !p.admitted_via) p.admitted_via = String(params[2]);
    return rows([], p ? 1 : 0);
  }
  if (sql.startsWith("UPDATE invites SET status = 'accepted', accepted_by_user_id = COALESCE(accepted_by_user_id, $1)")) return rows([]);
  if (sql === "DELETE FROM session_participants WHERE session_id = $1 AND user_id = $2 AND status != 'removed'") {
    const before = world.rows.places.length;
    world.rows.places = world.rows.places.filter((p) => !(p.session_id === a && p.user_id === b && p.status !== 'removed'));
    return rows([], before - world.rows.places.length);
  }

  // ── the line ──
  if (sql.startsWith('INSERT INTO event_waitlist (session_id, user_id, joined_via, group_keys, invite_id)')) {
    const existing = lineOf(String(a), String(b));
    if (existing) {
      if (!['left', 'lapsed', 'promoted'].includes(existing.status)) return rows([], 0);
      Object.assign(existing, {
        status: 'waiting', joined_via: String(params[2]), group_keys: params[3] as string[], lapsed_reason: null,
        queued_at: ++world.clock, decided_by: null, invite_id: (params[4] as string | null) ?? null,
      });
      return rows([{ id: existing.id }]);
    }
    const line: WwLine = {
      id: nextId(), session_id: String(a), user_id: String(b), status: 'waiting', joined_via: String(params[2]),
      group_keys: (params[3] as string[]) ?? [], lapsed_reason: null, queued_at: ++world.clock, decided_by: null,
      invite_id: (params[4] as string | null) ?? null,
    };
    world.rows.line.push(line);
    return rows([{ id: line.id }]);
  }
  if (sql === 'SELECT status FROM event_waitlist WHERE session_id = $1 AND user_id = $2') {
    const l = lineOf(String(a), String(b));
    return rows(l ? [{ status: l.status }] : []);
  }
  m = /^UPDATE event_waitlist SET status = '(left|removed)', decided_at = NOW\(\), decided_by = \$(2|3), updated_at = NOW\(\) WHERE session_id = \$1 AND user_id = \$2 AND status = 'waiting'$/.exec(sql);
  if (m) {
    const l = lineOf(String(a), String(b));
    if (!l || l.status !== 'waiting') return rows([], 0);
    l.status = m[1];
    l.decided_by = String(m[2] === '2' ? b : params[2]);
    return rows([], 1);
  }
  if (sql.startsWith("UPDATE event_waitlist SET status = 'promoted', decided_at = NOW(), updated_at = NOW() WHERE session_id = $1 AND user_id = $2 AND status = 'waiting'")) {
    const l = lineOf(String(a), String(b));
    if (!l || l.status !== 'waiting') return rows([], 0);
    l.status = 'promoted';
    return rows([], 1);
  }
  if (sql.startsWith("UPDATE event_waitlist SET status = 'promoted', decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'waiting'")) {
    const l = world.rows.line.find((x) => x.id === a && x.status === 'waiting');
    if (l) l.status = 'promoted';
    return rows([], l ? 1 : 0);
  }
  if (sql.startsWith("UPDATE event_waitlist SET status = 'lapsed', lapsed_reason = $2")) {
    const l = world.rows.line.find((x) => x.id === a && x.status === 'waiting');
    if (l) { l.status = 'lapsed'; l.lapsed_reason = String(b); }
    return rows([], l ? 1 : 0);
  }
  const lineEntry = (l: WwLine) => ({
    id: l.id, user_id: l.user_id, joined_via: l.joined_via, group_keys: l.group_keys, invite_id: l.invite_id ?? null,
    role: userById(l.user_id)?.role ?? null,
  });
  const waiting = (sessionId: unknown) => world.rows.line.filter((l) => l.session_id === sessionId && l.status === 'waiting')
    .sort((x, y) => x.queued_at - y.queued_at || x.id.localeCompare(y.id));
  if (sql.startsWith('SELECT w.id, w.user_id, w.joined_via, w.group_keys, w.invite_id, u.role FROM event_waitlist w JOIN users u ON u.id = w.user_id WHERE w.session_id = $1 AND w.user_id = $2')) {
    const l = waiting(a).find((x) => x.user_id === b);
    return rows(l ? [lineEntry(l)] : []);
  }
  if (sql.startsWith('SELECT w.id, w.user_id, w.joined_via, w.group_keys, w.invite_id, u.role FROM event_waitlist w JOIN users u ON u.id = w.user_id WHERE w.session_id = $1 AND w.status = \'waiting\' ORDER BY w.queued_at, w.id LIMIT 1')) {
    const l = waiting(a)[0];
    return rows(l ? [lineEntry(l)] : []);
  }
  if (sql === "SELECT user_id FROM event_waitlist WHERE session_id = $1 AND status = 'waiting' LIMIT $2") {
    return rows(waiting(a).map((l) => ({ user_id: l.user_id })));
  }
  if (sql.startsWith('SELECT w.user_id, u.display_name, u.avatar_url, w.queued_at, w.joined_via, u.account_kind, ROW_NUMBER()')) {
    return rows(waiting(a).filter((l) => active(l.user_id)).map((l, i) => {
      const u = userById(l.user_id)!;
      return {
        user_id: l.user_id, display_name: u.display_name, avatar_url: null, queued_at: new Date(l.queued_at * 1000),
        joined_via: l.joined_via, account_kind: u.account_kind, position: i + 1,
      };
    }));
  }

  // ── the say-so a promotion re-reads (fix round 1): the person's invites to the event and their request ──
  if (sql.startsWith('SELECT i.status::text AS status, (i.expires_at IS NOT NULL AND i.expires_at <= NOW()) AS past, s.admission_mode FROM invites i JOIN sessions s ON s.id = $1 WHERE i.id = $2')) {
    const i = world.rows.invites.find((x) => x.id === b && x.session_id === a);
    return rows(i ? [{ status: i.status, past: !!i.expires_at && i.expires_at.getTime() <= Date.now(), admission_mode: eventById(a)?.admission_mode ?? null }] : []);
  }
  if (sql.startsWith('SELECT i.status::text AS status, (i.expires_at IS NOT NULL AND i.expires_at <= NOW()) AS past FROM invites i')) {
    const u = userById(b);
    return rows(world.rows.invites.filter((i) => i.session_id === a
      && (i.accepted_by_user_id === b || (!!u && i.invitee_email?.toLowerCase() === u.email)))
      .map((i) => ({ status: i.status, past: !!i.expires_at && i.expires_at.getTime() <= Date.now() })));
  }
  if (sql === 'SELECT status FROM event_join_requests WHERE session_id = $1 AND user_id = $2') {
    const r = world.rows.requests.find((x) => x.session_id === a && x.user_id === b);
    return rows(r ? [{ status: r.status }] : []);
  }
  if (sql.startsWith('INSERT INTO pod_members (pod_id, user_id, role, status)')) {
    if (!world.rows.podMembers.some((m) => m.pod_id === a && m.user_id === b)) world.rows.podMembers.push({ pod_id: String(a), user_id: String(b), role: 'member' });
    return rows([], 1);
  }
  if (sql.startsWith('SELECT DISTINCT sp.session_id FROM session_participants sp JOIN sessions s ON s.id = sp.session_id JOIN users u ON u.id = sp.user_id')) {
    const ids = params[0] as string[];
    const live = (sid: string) => !['completed', 'cancelled'].includes(eventById(sid)?.status ?? 'completed');
    return rows([...new Set(world.rows.places.filter((x) => ids.includes(x.user_id) && active(x.user_id) && x.status !== 'removed' && live(x.session_id))
      .map((x) => x.session_id))].map((session_id) => ({ session_id })));
  }

  // ── requests to join ──
  if (/FROM event_join_requests r WHERE r\.session_id = \$1 AND r\.user_id = \$2 FOR UPDATE$/.test(sql)) {
    const r = world.rows.requests.find((x) => x.session_id === a && x.user_id === b);
    return rows(r ? [{ id: r.id, sessionId: r.session_id, userId: r.user_id, status: r.status, message: null, createdAt: new Date(0), decidedAt: null }] : []);
  }
  if (sql.startsWith("UPDATE event_join_requests r SET status = 'approved'")) {
    const r = world.rows.requests.find((x) => x.session_id === a && x.user_id === b)!;
    r.status = 'approved';
    return rows([{ id: r.id, sessionId: r.session_id, userId: r.user_id, status: r.status, message: null, createdAt: new Date(0), decidedAt: new Date() }]);
  }

  // ── invites ──
  if (/FROM invites WHERE code = \$1 FOR UPDATE$/.test(sql)) {
    const i = world.rows.invites.find((x) => x.code === a);
    return rows(i ? [{
      id: i.id, code: i.code, type: 'session', inviterId: i.inviter_id, inviteeEmail: i.invitee_email, podId: null, sessionId: i.session_id,
      circleId: null, status: i.status, maxUses: i.max_uses, useCount: i.use_count, expiresAt: null, acceptedByUserId: null,
      acceptedAt: null, createdAt: i.created_at, updatedAt: i.created_at,
    }] : []);
  }
  if (sql.startsWith('UPDATE invites SET use_count = use_count + 1')) {
    const i = world.rows.invites.find((x) => x.id === b)!;
    i.use_count += 1;
    i.status = 'accepted';
    i.accepted_by_user_id = i.accepted_by_user_id ?? String(a);
    return rows([{ id: i.id, code: i.code, status: i.status, useCount: i.use_count, sessionId: i.session_id }]);
  }
  if (sql.startsWith('UPDATE notifications SET is_read = TRUE')) return rows([]);

  // ── bells and the audit trail ──
  if (sql.startsWith('INSERT INTO notifications (user_id, type, title, body, link)')) {
    // ringEventBells: unnest(users, titles), type $3, body $4, link $5. The request flow's ring: unnest(users), $2..$5.
    const perPersonTitles = Array.isArray(params[1]);
    const users = params[0] as string[];
    const made = users.map((userId, i) => {
      const bell = perPersonTitles
        ? { id: nextId(), user_id: userId, type: String(params[2]), title: (params[1] as string[])[i], body: String(params[3]), link: String(params[4]) }
        : { id: nextId(), user_id: userId, type: String(params[1]), title: String(params[2]), body: String(params[3]), link: String(params[4]) };
      world.rows.bells.push(bell);
      return { id: bell.id, user_id: userId, title: bell.title, created_at: new Date() };
    });
    return rows(made);
  }
  if (sql.startsWith('INSERT INTO audit_log')) {
    world.rows.audit.push({ action: String(params[1]), session_id: String(params[2]), details: JSON.parse(String(params[3])) });
    return rows([], 1);
  }

  // ── the live room's door (eventRoomAdmission) ──
  if (sql.startsWith('SELECT s.host_user_id = $2 AS is_host,') && sql.includes('LEFT JOIN session_participants p')) {
    const e = eventById(a);
    if (!e) return rows([]);
    return rows([{
      is_host: e.host_user_id === b, is_cohost: isCohost(e.id, b), participant_status: placeOf(e.id, String(b))?.status ?? null,
      account_closed: !active(b), publication: e.publication, admission_holds: true,
    }]);
  }

  throw new Error(`The waiting-list world does not know this statement: ${sql.slice(0, 200)}`);
}
