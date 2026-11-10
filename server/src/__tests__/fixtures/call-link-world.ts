// ─── An in-memory RSN for the Call link tests (Part 2 foundation, Task 6, 11 Nov 2026) ───────────────────
//
// Postgres is not part of the unit suite. This stand-in keeps the rows the Call link reads and writes (users,
// magic_links, the events' codes and admission lists, places, requests, groups) and answers the services' own
// statements, each atomically, as one Postgres statement on one row is. A statement it does not know fails the test,
// so nothing new slips past it unmodelled. The statements themselves run on Postgres in the task's probe.
//
// registerParticipant is modelled (modelRegister) from the real rules it calls: guestMayRegister, canRegister and
// admittedViaOf come from the real code, so the place a test sees is the place those rules give.

import crypto from 'crypto';
import {
  ErrorCodes, UserRole, type AdmissionMode, type EventGroupRules, type EventVisibility,
} from '@rsn/shared';
import { AppError, ConflictError, NotFoundError } from '../../middleware/errors';

export interface WUser {
  id: string; email: string; display_name: string; first_name: string; account_kind: 'member' | 'event_guest';
  status: string; email_verified: boolean; role: string; guest_first_session_id: string | null;
  onboarding_completed: boolean; profile_visible: boolean;
}
export interface WEvent {
  id: string; call_code: string | null; title: string; description: string | null; status: string; publication: string;
  archived_at: Date | null; registration_opens_at: Date | null; visibility: EventVisibility | null;
  admission_mode: AdmissionMode | null; host_user_id: string; scheduled_at: Date | null; config: object;
  event_format: string; pod_id: string; pod_name: string; pod_visibility: string;
}
export interface WLink {
  id: string; email: string; token_hash: string; expires_at: Date; used_at: Date | null; created_at: Date;
  purpose: string; target_id: string | null; code_hash: string | null; code_attempts: number;
}
export interface WCode {
  session_id: string; code_hash: string; group_key: string | null; redeemed_by: string | null; revoked_at: Date | null;
  expires_at: Date | null;
}

export const world = {
  users: [] as WUser[],
  events: [] as WEvent[],
  links: [] as WLink[],
  entries: [] as Array<{ session_id: string; email: string; group_key: string | null; revoked_at: Date | null }>,
  invites: [] as Array<{ session_id: string; invitee_email: string; max_uses: number; status: string; expires_at: Date | null }>,
  codes: [] as WCode[],
  places: new Map<string, { status: string; admitted_via: string | null }>(),
  requests: new Map<string, string>(),
  audience: new Set<string>(),
  rules: new Map<string, EventGroupRules>(),
  memberGroups: new Map<string, { keys: string[]; by: string }>(),
  audit: [] as Array<{ action: string; sessionId: string }>,
  sql: [] as string[],
  writes: [] as string[],
};

export const key = (sessionId: string, userId: string) => `${sessionId}:${userId}`;
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const MIN = 60_000;
let seq = 0;
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function resetWorld(): void {
  world.users = []; world.events = []; world.links = []; world.entries = []; world.invites = []; world.codes = [];
  world.places = new Map(); world.requests = new Map(); world.audience = new Set(); world.rules = new Map();
  world.memberGroups = new Map(); world.audit = []; world.sql = []; world.writes = [];
}

export function addUser(over: Partial<WUser> & { id: string; email: string }): WUser {
  const u: WUser = {
    display_name: 'Member', first_name: 'Member', account_kind: 'member', status: 'active', email_verified: true,
    role: 'member', guest_first_session_id: null, onboarding_completed: true, profile_visible: true, ...over,
  };
  world.users.push(u);
  return u;
}

export function addEvent(over: Partial<WEvent> & { id: string; call_code: string }): WEvent {
  const e: WEvent = {
    title: 'Founders breakfast', description: 'Coffee and introductions', status: 'scheduled', publication: 'published',
    archived_at: null, registration_opens_at: null, visibility: 'public', admission_mode: 'open', host_user_id: uuid(1),
    scheduled_at: new Date(Date.now() + 2 * 24 * 3600_000), config: { numberOfRounds: 3 }, event_format: 'speed_networking',
    pod_id: 'pod-1', pod_name: 'Secret Pod Name', pod_visibility: 'private', ...over,
  };
  world.events.push(e);
  return e;
}

const userById = (id: unknown) => world.users.find((u) => u.id === id);
const userByEmail = (email: unknown) => world.users.find((u) => u.email === String(email).toLowerCase());
const eventById = (id: unknown) => world.events.find((e) => e.id === id);

/** The camel-cased user getUserById / getUserByEmail answer. */
const camelUser = (u: WUser) => ({
  id: u.id, email: u.email, displayName: u.display_name, firstName: u.first_name, role: u.role, status: u.status,
  emailVerified: u.email_verified, accountKind: u.account_kind, onboardingCompleted: u.onboarding_completed,
  profileVisible: u.profile_visible,
});

const linkCodeRow = (l: WLink, ttl: number) => ({
  id: l.id, email: l.email, token_hash: l.token_hash, code_hash: l.code_hash, used_at: l.used_at, code_attempts: l.code_attempts,
  code_live: l.created_at.getTime() > Date.now() - ttl * MIN, link_live: l.expires_at.getTime() > Date.now(),
});

function personallyInvited(sessionId: string, email: string): boolean {
  return world.invites.some((i) => i.session_id === sessionId && i.invitee_email.toLowerCase() === email && i.max_uses === 1
    && (i.status === 'accepted' || (i.status === 'pending' && (!i.expires_at || i.expires_at.getTime() > Date.now()))));
}

const ACTIVE_PLACE = ['registered', 'checked_in', 'in_lobby', 'in_round'];

/** Everything the access rules read, from the world (readEventAccessFacts' answer). */
export function factsOf(sessionId: string, userId: string) {
  const e = eventById(sessionId);
  const u = userById(userId);
  if (!e || !u) return null;
  const place = world.places.get(key(sessionId, userId)) ?? null;
  const listed = world.entries.some((x) => x.session_id === sessionId && x.email === u.email && !x.revoked_at);
  const coded = world.codes.some((c) => c.session_id === sessionId && c.redeemed_by === userId && !c.revoked_at);
  const invited = personallyInvited(sessionId, u.email);
  const mode = e.admission_mode;
  const entitledVia = !mode ? null : listed ? 'allow_list' : coded ? 'code' : invited ? 'invite' : null;
  return {
    visibility: e.visibility, podId: e.pod_id, podVisibility: e.pod_visibility, isHost: e.host_user_id === userId,
    isCohost: false, isPodOrganiser: false, inAudience: world.audience.has(key(sessionId, userId)), isInvited: invited,
    participantStatus: place?.status ?? null, accountActive: u.status === 'active',
    myRequest: (world.requests.get(key(sessionId, userId)) ?? null) as 'pending' | 'approved' | 'declined' | 'withdrawn' | null,
    outsideClosedCircle: false, admissionMode: mode, entitled: entitledVia !== null,
    entitledVia: entitledVia as 'allow_list' | 'code' | 'invite' | null,
    publication: (e.publication === 'draft' ? 'draft' : 'published') as 'draft' | 'published', archived: !!e.archived_at,
    registrationOpensAt: e.registration_opens_at, viewerTimezone: null, isPodAdmin: false, placesHeld: 0,
  };
}

/** registerParticipant, modelled from the real rules it applies (passed in, so the test's own imports are used). */
export function modelRegister(rules: {
  guestMayRegister: (f: Record<string, unknown>) => boolean;
  canRegister: (f: never, role: string | undefined, o?: object) => { ok: boolean; status?: number; code?: string; message?: string };
  admittedViaOf: (f: never, role: string | undefined, o?: object) => string | null;
}) {
  return async (sessionId: string, userId: string, role: UserRole | undefined, opts: {
    groupKeys?: string[]; arrivedThroughCallLink?: boolean; approvedRequest?: boolean;
  } = {}) => {
    const facts = factsOf(sessionId, userId);
    const e = eventById(sessionId);
    const u = userById(userId);
    if (!facts || !e || !u) throw new NotFoundError('Session', sessionId, "We couldn't find that event.");
    const placeKey = key(sessionId, userId);
    const place = world.places.get(placeKey);
    if (u.account_kind === 'event_guest' && !rules.guestMayRegister({
      sessionId, guestFirstSessionId: u.guest_first_session_id, holdsPlace: !!place, admissionMode: e.admission_mode,
      admissionEntitled: facts.entitled, approvedRequest: facts.myRequest === 'approved' || !!opts.approvedRequest,
      arrivedThroughCallLink: !!opts.arrivedThroughCallLink,
    })) {
      throw new AppError(403, ErrorCodes.GUEST_MEMBERSHIP_REQUIRED, 'This event is for members.');
    }
    const decision = rules.canRegister(facts as never, role, { approvedRequest: !!opts.approvedRequest });
    if (!decision.ok) throw new AppError(decision.status!, decision.code as never, decision.message!);
    if (place?.status === 'removed') throw new AppError(403, 'REMOVED_FROM_EVENT' as never, 'You have been removed from this event by the host');
    if (place && ACTIVE_PLACE.includes(place.status)) throw new ConflictError('SESSION_ALREADY_REGISTERED', 'You are already registered for this event');
    const groupRules = world.rules.get(sessionId);
    if (groupRules && !world.memberGroups.has(placeKey) && e.host_user_id !== userId) {
      if (!opts.groupKeys?.length) throw new ConflictError(ErrorCodes.EVENT_GROUP_REQUIRED, 'Choose your group for this event first.');
      world.memberGroups.set(placeKey, { keys: opts.groupKeys, by: 'self' });
    }
    world.places.set(placeKey, { status: 'registered', admitted_via: rules.admittedViaOf(facts as never, role, opts) });
    world.writes.push(`place:${placeKey}`);
    return { isNewRegistration: !place };
  };
}

/** The answer to one statement, or a thrown error for one the world does not know. */
export function answer(raw: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const sql = flat(raw);
  world.sql.push(sql);
  const rows = (r: unknown[], rowCount = r.length) => ({ rows: r, rowCount });

  // ── users ──
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') {
    const u = userById(params[0]);
    return rows(u ? [{ status: u.status, account_kind: u.account_kind }] : []);
  }
  if (/FROM users WHERE email = \$1$/.test(sql)) {
    const u = userByEmail(params[0]);
    return rows(u ? [camelUser(u)] : []);
  }
  if (/FROM users WHERE id = \$1$/.test(sql) && sql.includes('"accountKind"')) {
    const u = userById(params[0]);
    return rows(u ? [{ ...camelUser(u), bannerUpdatedAt: null }] : []);
  }
  if (sql.startsWith('INSERT INTO users (id, email, display_name, first_name, last_name, linkedin_url, role, status, email_verified, account_kind')) {
    if (userByEmail(params[1])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    world.users.push({
      id: String(params[0]), email: String(params[1]), display_name: String(params[2]), first_name: String(params[3]),
      account_kind: 'event_guest', status: 'active', email_verified: true, role: 'member',
      guest_first_session_id: (params[6] as string | null) ?? null, onboarding_completed: false, profile_visible: false,
    });
    world.writes.push(`user:${params[1]}`);
    return rows([], 1);
  }
  if (/^INSERT INTO user_(subscriptions|entitlements)/.test(sql)) return rows([], 1);
  if (sql === 'UPDATE users SET email_verified = TRUE WHERE id = $1') {
    const u = userById(params[0]); if (u) u.email_verified = true;
    return rows([], u ? 1 : 0);
  }
  if (sql === 'UPDATE users SET last_active_at = NOW() WHERE id = $1') return rows([], 1);
  if (sql === 'SELECT account_kind FROM users WHERE id = $1') {
    const u = userById(params[0]);
    return rows(u ? [{ account_kind: u.account_kind }] : []);
  }
  if (sql === 'SELECT email, display_name, first_name, account_kind FROM users WHERE id = $1') {
    const u = userById(params[0]);
    return rows(u ? [{ email: u.email, display_name: u.display_name, first_name: u.first_name, account_kind: u.account_kind }] : []);
  }
  if (sql.startsWith('UPDATE users SET display_name = $2')) {
    const u = userById(params[0]);
    const unset = !!u && (u.display_name.trim() === ''
      || (u.account_kind === 'event_guest' && u.display_name === 'Guest' && u.first_name.trim() === ''));
    if (!u || !unset) return rows([], 0);
    u.display_name = String(params[1]);
    if (u.first_name.trim() === '') u.first_name = String(params[2]);
    world.writes.push(`name:${u.id}`);
    return rows([], 1);
  }
  if (sql.startsWith('INSERT INTO refresh_tokens')) return rows([], 1);

  // ── magic_links ──
  const linkById = (id: unknown) => world.links.find((l) => l.id === id);
  if (sql.startsWith("UPDATE magic_links SET used_at = NOW(), expires_at = LEAST(expires_at, NOW()) WHERE email = $1 AND purpose = 'event_entry' AND target_id = $2 AND used_at IS NULL")) {
    for (const l of world.links) {
      if (l.email === params[0] && l.purpose === 'event_entry' && l.target_id === params[1] && !l.used_at) {
        l.used_at = new Date(); l.expires_at = new Date(Math.min(l.expires_at.getTime(), Date.now()));
      }
    }
    return rows([], 1);
  }
  if (sql.startsWith("INSERT INTO magic_links (email, token_hash, expires_at, code_hash, purpose, target_id) VALUES ($1, $2, $3, $4, 'event_entry', $5)")) {
    world.links.push({
      id: crypto.randomUUID(), email: String(params[0]), token_hash: String(params[1]), expires_at: params[2] as Date,
      used_at: null, created_at: new Date(Date.now() + (++seq)), purpose: 'event_entry', target_id: String(params[4]),
      code_hash: String(params[3]), code_attempts: 0,
    });
    world.writes.push(`link:${params[0]}`);
    return rows([], 1);
  }
  if (/FROM magic_links WHERE email = \$1 AND purpose = 'event_entry' AND target_id = \$3 AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1$/.test(sql)) {
    const mine = world.links.filter((l) => l.email === params[0] && l.purpose === 'event_entry' && l.target_id === params[2] && l.code_hash)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return rows(mine.slice(0, 1).map((l) => linkCodeRow(l, Number(params[1]))));
  }
  if (/FROM magic_links WHERE email = \$1 AND purpose = 'login' AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1$/.test(sql)) {
    const mine = world.links.filter((l) => l.email === params[0] && l.purpose === 'login' && l.code_hash)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return rows(mine.slice(0, 1).map((l) => linkCodeRow(l, Number(params[1]))));
  }
  if (/FROM magic_links WHERE id = \$1$/.test(sql) && sql.includes('code_live')) {
    const l = linkById(params[0]);
    return rows(l ? [linkCodeRow(l, Number(params[1]))] : []);
  }
  if (sql === 'UPDATE magic_links SET code_attempts = code_attempts + 1 WHERE id = $1 AND used_at IS NULL AND code_attempts < $2 RETURNING code_attempts') {
    const l = linkById(params[0]);
    if (!l || l.used_at || l.code_attempts >= Number(params[1])) return rows([], 0);
    l.code_attempts += 1;
    return rows([{ code_attempts: l.code_attempts }]);
  }
  if (sql === 'UPDATE magic_links SET used_at = COALESCE(used_at, NOW()), expires_at = LEAST(expires_at, NOW()) WHERE id = $1') {
    const l = linkById(params[0]);
    if (l) { l.used_at = l.used_at ?? new Date(); l.expires_at = new Date(Math.min(l.expires_at.getTime(), Date.now())); }
    return rows([], l ? 1 : 0);
  }
  if (sql === 'UPDATE magic_links SET used_at = NOW(), code_attempts = code_attempts - 1 WHERE id = $1 AND used_at IS NULL RETURNING id') {
    const l = linkById(params[0]);
    if (!l || l.used_at) return rows([], 0);
    l.used_at = new Date(); l.code_attempts -= 1;
    return rows([{ id: l.id }]);
  }
  if (sql === 'UPDATE magic_links SET code_attempts = code_attempts - 1 WHERE id = $1 AND used_at IS NULL') {
    const l = linkById(params[0]);
    if (l && !l.used_at) l.code_attempts -= 1;
    return rows([], l && !l.used_at ? 1 : 0);
  }
  if (sql === 'UPDATE magic_links SET expires_at = LEAST(expires_at, NOW()) WHERE id = $1') {
    const l = linkById(params[0]);
    if (l) l.expires_at = new Date(Math.min(l.expires_at.getTime(), Date.now()));
    return rows([], l ? 1 : 0);
  }
  if (sql === "SELECT id, email, expires_at, used_at FROM magic_links WHERE token_hash = $1 AND purpose = 'event_entry' AND target_id = $2") {
    const l = world.links.find((x) => x.token_hash === params[0] && x.purpose === 'event_entry' && x.target_id === params[1]);
    return rows(l ? [{ id: l.id, email: l.email, expires_at: l.expires_at, used_at: l.used_at }] : []);
  }
  if (sql === "SELECT id, email, expires_at, used_at FROM magic_links WHERE token_hash = $1 AND purpose = 'login'") {
    const l = world.links.find((x) => x.token_hash === params[0] && x.purpose === 'login');
    return rows(l ? [{ id: l.id, email: l.email, expires_at: l.expires_at, used_at: l.used_at }] : []);
  }
  if (sql === 'UPDATE magic_links SET used_at = NOW() WHERE id = $1 AND used_at IS NULL' || sql === 'UPDATE magic_links SET used_at = NOW() WHERE id = $1') {
    const l = linkById(params[0]);
    if (l && !l.used_at) l.used_at = new Date();
    return rows([], l ? 1 : 0);
  }

  // ── sessions: the call code ──
  if (sql.includes('FROM sessions s LEFT JOIN users h ON h.id = s.host_user_id WHERE s.call_code = $1')) {
    const e = world.events.find((x) => x.call_code === params[0]);
    const h = e ? userById(e.host_user_id) : undefined;
    // Answered with every column the row has (the pod's name too), as a careless SELECT * would: the landing must
    // pick what it shows itself.
    return rows(e ? [{ ...e, host_name: h?.display_name ?? null, host_avatar: null }] : []);
  }
  if (sql === 'SELECT call_code FROM sessions WHERE id = $1') {
    const e = eventById(params[0]);
    return rows(e ? [{ call_code: e.call_code }] : []);
  }
  if (sql.startsWith('UPDATE sessions SET call_code = $2 WHERE id = $1')) {
    const e = eventById(params[0]);
    if (!e) return rows([], 0);
    if (sql.includes('AND call_code IS NULL') && e.call_code) return rows([], 0);
    if (world.events.some((x) => x.id !== e.id && x.call_code === params[1])) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "idx_sessions_call_code"'), { code: '23505' });
    }
    e.call_code = String(params[1]);
    world.writes.push(`code:${e.id}`);
    return rows([{ call_code: e.call_code }]);
  }
  if (sql === 'SELECT 1 FROM sessions WHERE id = $1') return rows(eventById(params[0]) ? [{ '?column?': 1 }] : []);
  if (sql === 'SELECT pod_id FROM sessions WHERE id = $1') {
    const e = eventById(params[0]);
    return rows(e ? [{ pod_id: e.pod_id }] : []);
  }

  // ── who may come in by email ──
  if (sql.startsWith('SELECT 1 FROM invites i WHERE i.session_id = $1 AND lower(i.invitee_email) = $2 AND i.max_uses = 1')) {
    return rows(personallyInvited(String(params[0]), String(params[1])) ? [{}] : []);
  }
  if (sql === 'SELECT 1 FROM event_admission_entries WHERE session_id = $1 AND email = $2 AND revoked_at IS NULL') {
    return rows(world.entries.some((x) => x.session_id === params[0] && x.email === params[1] && !x.revoked_at) ? [{}] : []);
  }
  if (sql.startsWith('SELECT group_key FROM event_admission_entries WHERE session_id = $1 AND email = $2 AND revoked_at IS NULL AND group_key IS NOT NULL')) {
    const x = world.entries.find((y) => y.session_id === params[0] && y.email === params[1] && !y.revoked_at && y.group_key);
    return rows(x ? [{ group_key: x.group_key }] : []);
  }
  if (sql.startsWith('SELECT redeemed_at IS NOT NULL AS used, (expires_at IS NULL OR expires_at > NOW()) AS live FROM event_admission_codes WHERE session_id = $1 AND code_hash = $2 AND revoked_at IS NULL')) {
    const c = world.codes.find((y) => y.session_id === params[0] && y.code_hash === params[1] && !y.revoked_at);
    return rows(c ? [{ used: !!c.redeemed_by, live: !c.expires_at || c.expires_at.getTime() > Date.now() }] : []);
  }
  if (sql === 'SELECT 1 FROM event_participant_groups WHERE session_id = $1 AND user_id = $2 LIMIT 1') {
    return rows(world.memberGroups.has(key(String(params[0]), String(params[1]))) ? [{}] : []);
  }

  // ── a person's events by link ──
  if (sql.startsWith('WITH mine AS (')) {
    const userId = String(params[0]);
    const mine = world.events.filter((e) => world.places.has(key(e.id, userId))
      || ['pending', 'approved', 'declined'].includes(world.requests.get(key(e.id, userId)) ?? ''));
    const ended = (e: WEvent) => ['completed', 'cancelled'].includes(e.status) || !!e.archived_at;
    const listed = mine.filter((e) => e.publication === 'published' || e.host_user_id === userId)
      .sort((a, b) => Number(ended(a)) - Number(ended(b))
        || (ended(a) ? (b.scheduled_at?.getTime() ?? 0) - (a.scheduled_at?.getTime() ?? 0)
          : (a.scheduled_at?.getTime() ?? Infinity) - (b.scheduled_at?.getTime() ?? Infinity)))
      .slice(0, Number(params[1]));
    return rows(listed.map((e) => ({
      id: e.id, call_code: e.call_code, title: e.title, scheduled_at: e.scheduled_at, status: e.status, publication: e.publication,
      archived_at: e.archived_at, registration_opens_at: e.registration_opens_at,
      place: world.places.get(key(e.id, userId))?.status ?? null, request: world.requests.get(key(e.id, userId)) ?? null,
    })));
  }

  // ── the audit trail and its tag ──
  if (sql.startsWith('INSERT INTO audit_log')) {
    world.audit.push({ action: String(params[1]), sessionId: String(params[2]) });
    return rows([], 1);
  }
  if (sql.startsWith('SELECT host_user_id AS user_id FROM sessions')) return rows([]);

  throw new Error(`The Call link world does not know this statement: ${sql.slice(0, 160)}`);
}

/** The tokens' owner, read back from an access token (no signature check: the test made it). */
export function subjectOf(accessToken: string): string {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).sub as string;
}

export { UserRole };
