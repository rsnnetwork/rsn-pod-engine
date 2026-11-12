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
  EVENT_LIVE_STATUSES, ErrorCodes, UserRole, missingRequiredQuestions,
  type AdmissionMode, type EventAnswers, type EventGroupRules, type EventMatchingQuestion, type EventVisibility,
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
  /** The event link (migration 154): every event added gets 'rsn' and the next number, a tail when not public. */
  link_name: string | null; link_number: number | null; link_tail: string | null;
  /** Whether the call code was given while the event was not public (migration 154); addEvent sets it from the event. */
  call_code_private: boolean;
}
/** An event link the event had before (event_link_aliases). */
export interface WAlias { slug: string; session_id: string; name: string; number: number; secret: boolean; created: number }
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
  /** Part 3 Task 3: a full event's waiting list, in order (the waiting-list tests fill it; nothing else does). */
  line: [] as Array<{ session_id: string; user_id: string; status: string }>,
  /** Part 3 Task 5: an event's extra matching questions, and each person's answers (by key(sessionId, userId)). */
  questions: new Map<string, EventMatchingQuestion[]>(),
  answers: new Map<string, EventAnswers>(),
  /** The event link's counters and old links (migration 154). */
  counters: new Map<string, number>(),
  aliases: [] as WAlias[],
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
  world.memberGroups = new Map(); world.audit = []; world.sql = []; world.writes = []; world.line = [];
  world.questions = new Map(); world.answers = new Map();
  world.counters = new Map(); world.aliases = [];
}

/** eventLinkNeedsTailSql, read from the row (the world has no circles): not public, or invitation-only. */
export function needsTail(e: WEvent): boolean {
  const isPublic = e.visibility === 'public' || e.visibility === 'public_with_approval'
    || (e.visibility === null && e.pod_visibility === 'public');
  return !(isPublic && e.admission_mode !== 'restricted');
}

const TAIL_FIRST = 'abcdefghijkmnpqrstuvwxyz';
const TAIL_REST = '23456789abcdefghijkmnpqrstuvwxyz';
/** A well-formed tail, drawn here (the service draws its own). */
export function worldTail(): string {
  let t = TAIL_FIRST[crypto.randomInt(TAIL_FIRST.length)];
  while (t.length < 6) t += TAIL_REST[crypto.randomInt(TAIL_REST.length)];
  return t;
}

/** The event's link as its slug ('rsn-3', 'rsn-3-k7m2q9'), or null before it has one. */
export function slugOf(e: WEvent): string | null {
  if (!e.link_name || !e.link_number) return null;
  return e.link_tail ? `${e.link_name}-${e.link_number}-${e.link_tail}` : `${e.link_name}-${e.link_number}`;
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
    pod_id: 'pod-1', pod_name: 'Secret Pod Name', pod_visibility: 'private',
    link_name: null, link_number: null, link_tail: null, call_code_private: false, ...over,
  };
  if (!('call_code_private' in over)) e.call_code_private = needsTail(e);
  if (!('link_name' in over)) {
    const n = (world.counters.get('rsn') ?? 0) + 1;
    world.counters.set('rsn', n);
    e.link_name = 'rsn';
    e.link_number = n;
    e.link_tail = needsTail(e) ? worldTail() : null;
  }
  world.events.push(e);
  return e;
}

const userById = (id: unknown) => world.users.find((u) => u.id === id);
const userByEmail = (email: unknown) => world.users.find((u) => u.email === String(email).toLowerCase());
const eventById = (id: unknown) => world.events.find((e) => e.id === id);
/** hostIsPlatformAdminSql, read from the world's users. */
const isPlatformAdmin = (userId: unknown) => ['admin', 'super_admin'].includes(world.users.find((u) => u.id === userId)?.role ?? '');

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

/** Part 3 Task 3: the event's limit, or null. */
export function capacityOf(e: WEvent): number | null {
  const n = (e.config as { maxParticipants?: number }).maxParticipants;
  return typeof n === 'number' && n >= 1 ? n : null;
}

/** Part 3 Task 3: the places held by anyone but the host (this world has no co-hosts): rows that are not removed. */
export function placesTakenIn(sessionId: string): number {
  const e = eventById(sessionId);
  return [...world.places].filter(([k, p]) => k.startsWith(`${sessionId}:`) && p.status !== 'removed' && k !== key(sessionId, e?.host_user_id ?? '')).length;
}

/** Fix round 1: the people waiting ahead of the person (everyone waiting, when they are not on the line). */
export function waitlistAheadOf(sessionId: string, userId: string): number {
  const position = waitlistPositionOf(sessionId, userId);
  return position !== null ? position - 1 : world.line.filter((l) => l.session_id === sessionId && l.status === 'waiting').length;
}

/** Part 3 Task 3: the person's place in the event's waiting list (1 = next), or null. */
export function waitlistPositionOf(sessionId: string, userId: string): number | null {
  const waiting = world.line.filter((l) => l.session_id === sessionId && l.status === 'waiting');
  const i = waiting.findIndex((l) => l.user_id === userId);
  return i === -1 ? null : i + 1;
}

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
    registrationOpensAt: e.registration_opens_at, eventTimezone: null, isPodAdmin: false, placesHeld: 0,
    // Part 3 Task 3: an event's limit (config.maxParticipants; none in most tests), the places held by anyone but its
    // host, and the person's place in its waiting list.
    capacity: capacityOf(e), placesTaken: placesTakenIn(sessionId), waitlistPosition: waitlistPositionOf(sessionId, userId),
    waitlistAhead: waitlistAheadOf(sessionId, userId), eventStatus: e.status,
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
    // Part 3 Task 5: a required matching question unanswered refuses only a person's own first place.
    const questions = world.questions.get(sessionId) ?? [];
    if (!place && !opts.approvedRequest && e.host_user_id !== userId && !EVENT_LIVE_STATUSES.includes(e.status)
        && missingRequiredQuestions(questions, world.answers.get(placeKey) ?? {}).length > 0) {
      throw new ConflictError(ErrorCodes.EVENT_ANSWERS_REQUIRED, "Answer this event's questions first.");
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
    // A code given while the event was public opens it only while it is public (controller ruling, 12 Nov 2026).
    const opens = e && (e.call_code_private || !needsTail(e));
    return rows(opens ? [{ ...e, host_name: h?.display_name ?? null, host_avatar: null, link_needs_tail: needsTail(e) }] : []);
  }

  // ── sessions: the event link (migration 154; event-link.service.ts) ──
  if (sql.includes('FROM sessions s LEFT JOIN users h ON h.id = s.host_user_id WHERE s.id = (SELECT el_m.id FROM (')) {
    const [name, number, tail, slug] = params as [string, number, string | null, string];
    const current = world.events.find((x) => x.link_name === name && x.link_number === number
      && (x.link_tail ?? null) === (tail ?? null) && (x.link_tail !== null || !needsTail(x)));
    const alias = current ? undefined : world.aliases.find((a) => a.slug === slug
      && (a.secret || !needsTail(eventById(a.session_id) as WEvent)));
    const e = current ?? (alias ? eventById(alias.session_id) : undefined);
    const h = e ? userById(e.host_user_id) : undefined;
    return rows(e ? [{ ...e, host_name: h?.display_name ?? null, host_avatar: null, link_needs_tail: needsTail(e) }] : []);
  }
  if (sql.startsWith('SELECT s.id, s.pod_id, s.circle_id, s.link_name, s.link_number, s.link_tail,')) {
    const e = eventById(params[0]);
    return rows(e ? [{
      id: e.id, pod_id: e.pod_id, circle_id: null, link_name: e.link_name, link_number: e.link_number,
      link_tail: e.link_tail, needs_tail: needsTail(e), host_user_id: e.host_user_id,
      call_code: e.call_code, call_code_private: e.call_code_private, host_is_admin: isPlatformAdmin(e.host_user_id),
    }] : []);
  }
  if (sql.startsWith('SELECT s.link_name FROM sessions s WHERE s.pod_id = $1 AND s.link_name IS NOT NULL')) {
    const platform = params[2] === true;
    const latest = [...world.events].reverse().find((x) => x.pod_id === params[0] && x.link_name && x.id !== params[1]
      && x.publication === 'published' && !needsTail(x) && (platform || !(params[3] as string[]).includes(x.link_name)));
    return rows(latest ? [{ link_name: latest.link_name }] : []);
  }
  if (sql.startsWith('INSERT INTO event_link_counters (name, last_number) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE')) {
    const n = (world.counters.get(String(params[0])) ?? 0) + 1;
    world.counters.set(String(params[0]), n);
    return rows([{ last_number: n }]);
  }
  if (sql.startsWith('SELECT COALESCE(NOT ( ((COALESCE($2::text, s.visibility)') && sql.endsWith('AS needs_tail FROM sessions s WHERE s.id = $1')) {
    const e = eventById(params[0]);
    return rows(e ? [{ needs_tail: needsTail({ ...e, visibility: (params[1] as EventVisibility | null) ?? e.visibility }) }] : []);
  }
  if (sql.startsWith("SELECT id FROM sessions WHERE pod_id = $1 AND status::text NOT IN ('completed', 'cancelled')")) {
    return rows([...world.events].reverse().filter((x) => x.pod_id === params[0] && !['completed', 'cancelled'].includes(x.status)).map((x) => ({ id: x.id })));
  }
  if (sql === 'SELECT last_number FROM event_link_counters WHERE name = $1') {
    const n = world.counters.get(String(params[0]));
    return rows(n === undefined ? [] : [{ last_number: n }]);
  }
  if (sql.startsWith('SELECT 1 FROM sessions WHERE link_name = $1 AND link_number = $2 UNION ALL')) {
    const held = world.events.some((x) => x.link_name === params[0] && x.link_number === params[1])
      || world.aliases.some((a) => a.name === params[0] && a.number === params[1]);
    return rows(held ? [{}] : []);
  }
  if (sql.startsWith('INSERT INTO event_link_aliases (slug, session_id, name, number, secret)')) {
    const [slug, session_id, name, number, secret] = params as [string, string, string, number, boolean];
    if (world.aliases.some((a) => a.slug === slug)) return rows([], 0);
    world.aliases.push({ slug, session_id, name, number, secret, created: world.aliases.length });
    world.writes.push(`alias:${slug}`);
    return rows([], 1);
  }
  if (sql.startsWith('SELECT number FROM event_link_aliases WHERE session_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1')) {
    const own = world.aliases.filter((a) => a.session_id === params[0] && a.name === params[1]).sort((a, b) => b.created - a.created)[0];
    return rows(own ? [{ number: own.number }] : []);
  }
  if (sql === 'DELETE FROM event_link_aliases WHERE session_id = $1 AND name = $2 AND number = $3') {
    const before = world.aliases.length;
    world.aliases = world.aliases.filter((a) => !(a.session_id === params[0] && a.name === params[1] && a.number === params[2]));
    return rows([], before - world.aliases.length);
  }
  if (sql === 'DELETE FROM event_link_aliases WHERE session_id = $1 AND secret') {
    const before = world.aliases.length;
    world.aliases = world.aliases.filter((a) => !(a.session_id === params[0] && a.secret));
    return rows([], before - world.aliases.length);
  }
  if (sql === 'UPDATE sessions SET link_name = $2, link_number = $3, link_tail = $4, call_code = $5, call_code_private = $6 WHERE id = $1') {
    const e = eventById(params[0]);
    if (!e) return rows([], 0);
    if (world.events.some((x) => x.id !== e.id && x.link_name === params[1] && x.link_number === params[2])) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "idx_sessions_event_link"'), { code: '23505' });
    }
    e.link_name = String(params[1]);
    e.link_number = Number(params[2]);
    e.link_tail = (params[3] as string | null) ?? null;
    if (e.call_code !== params[4]) world.writes.push(`code:${e.id}`);
    e.call_code = (params[4] as string | null);
    e.call_code_private = params[5] === true;
    world.writes.push(`link:${e.id}`);
    return rows([], 1);
  }
  if (sql === 'UPDATE sessions SET link_tail = $2 WHERE id = $1 AND link_tail IS NOT NULL') {
    const e = eventById(params[0]);
    if (!e || !e.link_tail) return rows([], 0);
    e.link_tail = String(params[1]);
    world.writes.push(`tail:${e.id}`);
    return rows([], 1);
  }
  if (sql === 'SELECT call_code FROM sessions WHERE id = $1') {
    const e = eventById(params[0]);
    return rows(e ? [{ call_code: e.call_code }] : []);
  }
  if (sql.startsWith('UPDATE sessions s SET call_code = $2, call_code_private = COALESCE(NOT (')) {
    const e = eventById(params[0]);
    if (!e) return rows([], 0);
    if (sql.includes('AND s.call_code IS NULL') && e.call_code) return rows([], 0);
    e.call_code_private = needsTail(e);
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
      || ['pending', 'approved', 'declined'].includes(world.requests.get(key(e.id, userId)) ?? '')
      || waitlistPositionOf(e.id, userId) !== null);
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
      waiting: waitlistPositionOf(e.id, userId) !== null,
      link_name: e.link_name, link_number: e.link_number, link_tail: e.link_tail, link_needs_tail: needsTail(e),
      call_code_private: e.call_code_private,
    })));
  }

  // ── the audit trail and its tag ──
  if (sql.startsWith('INSERT INTO audit_log')) {
    world.audit.push({ action: String(params[1]), sessionId: String(params[2]) });
    return rows([], 1);
  }
  if (sql.startsWith('SELECT host_user_id AS user_id FROM sessions')) return rows([]);

  // ── Part 3 Task 5: the event's matching questions and each person's answers ──
  if (sql === 'SELECT id, key, prompt, kind, prefer, required, options FROM event_matching_questions WHERE session_id = $1 ORDER BY position, key') {
    return rows((world.questions.get(String(params[0])) ?? []).map((q) => ({ id: `${params[0]}:${q.key}`, ...q })));
  }
  if (sql === 'SELECT status FROM sessions WHERE id = $1') {
    const e = eventById(params[0]);
    return rows(e ? [{ status: e.status }] : []);
  }
  if (sql.startsWith('SELECT q.key, a.option_keys FROM event_question_answers a JOIN event_matching_questions q ON q.id = a.question_id WHERE a.session_id = $1 AND a.user_id = $2')) {
    const mine = world.answers.get(key(String(params[0]), String(params[1]))) ?? {};
    return rows(Object.entries(mine).map(([k, optionKeys]) => ({ key: k, option_keys: optionKeys })));
  }
  if (sql.startsWith('INSERT INTO event_question_answers (session_id, question_id, user_id, option_keys)')) {
    const k = key(String(params[0]), String(params[1]));
    const known = new Set((world.questions.get(String(params[0])) ?? []).map((q) => q.key));
    const mine = { ...(world.answers.get(k) ?? {}) };
    let changed = 0;
    (params[2] as string[]).forEach((qk, i) => {
      if (!known.has(qk)) return;
      const next = String((params[3] as string[])[i]).split(',');
      if ((mine[qk] ?? []).join(',') === next.join(',')) return;
      mine[qk] = next;
      changed += 1;
    });
    world.answers.set(k, mine);
    if (changed > 0) world.writes.push(`answers:${k}`);
    return rows([], changed);
  }
  if (sql.startsWith('DELETE FROM event_question_answers a USING event_matching_questions q WHERE q.id = a.question_id AND a.session_id = $1 AND a.user_id = $2 AND q.key = ANY($3::text[])')) {
    const k = key(String(params[0]), String(params[1]));
    const mine = { ...(world.answers.get(k) ?? {}) };
    let changed = 0;
    for (const qk of params[2] as string[]) if (qk in mine) { delete mine[qk]; changed += 1; }
    world.answers.set(k, mine);
    return rows([], changed);
  }

  throw new Error(`The Call link world does not know this statement: ${sql.slice(0, 160)}`);
}

/** The tokens' owner, read back from an access token (no signature check: the test made it). */
export function subjectOf(accessToken: string): string {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).sub as string;
}

export { UserRole };
