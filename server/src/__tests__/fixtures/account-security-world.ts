// ─── An in-memory world for the reauth, email change, close and admin-role tests (Part 3 Task 2) ────────────────────
//
// users, magic_links, refresh_tokens and audit_log, answering exactly the statements the real routes and services
// send (the auth router's sign-in link and code, the reauth and email-change services, deleteUser, the role guard, the
// admin routes). A statement this world does not know throws, so a new or changed statement fails a test instead of
// quietly reading nothing. The SQL itself runs for real on PGlite and is probed read-only on production (task report).

import crypto from 'crypto';

export interface WorldUser {
  id: string; email: string; displayName: string; role: string; status: string; accountKind: 'member' | 'event_guest';
  emailVerified: boolean;
}
export interface WorldLink {
  id: string; email: string; token_hash: string; expires_at: Date; used_at: Date | null; created_at: Date;
  purpose: string; code_hash: string | null; code_attempts: number; target_user_id: string | null;
  target_id: string | null; action: string | null;
}
export interface WorldRefresh { id: string; user_id: string; token_hash: string; revoked_at: Date | null }
export interface WorldAudit { actor_id: string | null; action: string; entity_type: string; entity_id: string | null; details: string; ip_address: string | null }

export const world = {
  users: [] as WorldUser[],
  links: [] as WorldLink[],
  refresh: [] as WorldRefresh[],
  audit: [] as WorldAudit[],
  statements: [] as string[],
  /** Runs before each statement is answered (a test that makes something happen between two statements). */
  onStatement: null as ((sql: string) => void) | null,
};

export function resetWorld(users: WorldUser[]): void {
  world.users = users.map((u) => ({ ...u }));
  world.links = [];
  world.refresh = [];
  world.audit = [];
  world.statements = [];
  world.onStatement = null;
}

const MIN = 60_000;
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const now = () => Date.now();
const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });

function userRow(u: WorldUser) {
  return {
    id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: u.status, emailVerified: u.emailVerified,
    accountKind: u.accountKind, bannerUpdatedAt: null,
  };
}

const codeRow = (l: WorldLink, ttl: number) => ({
  id: l.id, email: l.email, token_hash: l.token_hash, code_hash: l.code_hash, used_at: l.used_at,
  code_attempts: l.code_attempts, code_live: l.created_at.getTime() > now() - ttl * MIN, link_live: l.expires_at.getTime() > now(),
});

const newest = (rows: WorldLink[]) => [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(0, 1);
const emailOf = (userId: unknown) => world.users.find((u) => u.id === userId)?.email;

/** Insert a link by hand (a test that needs a row of a purpose no route here makes). */
export function addLink(partial: Partial<WorldLink> & { email: string; purpose: string }): WorldLink {
  const row: WorldLink = {
    id: crypto.randomUUID(), token_hash: crypto.randomBytes(32).toString('hex'), expires_at: new Date(now() + 60 * MIN),
    used_at: null, created_at: new Date(), code_hash: null, code_attempts: 0, target_user_id: null, target_id: null,
    action: null, ...partial,
  };
  world.links.push(row);
  return row;
}

export function answer(sqlRaw: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const sql = flat(sqlRaw);
  world.statements.push(sql);
  world.onStatement?.(sql);
  const byId = (id: unknown) => world.links.find((l) => l.id === id);

  // ── users ──
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') {
    const u = world.users.find((x) => x.id === params[0]);
    return ok(u ? [{ status: u.status, account_kind: u.accountKind }] : []);
  }
  if (sql === 'SELECT email, account_kind FROM users WHERE id = $1') {
    const u = world.users.find((x) => x.id === params[0]);
    return ok(u ? [{ email: u.email, account_kind: u.accountKind }] : []);
  }
  if (sql === 'SELECT email FROM users WHERE id = $1' || sql === 'SELECT email FROM users WHERE id = $1 FOR UPDATE') {
    const u = world.users.find((x) => x.id === params[0]);
    return ok(u ? [{ email: u.email }] : []);
  }
  if (sql === 'SELECT id FROM users WHERE email = $1 AND id <> $2 LIMIT 1') {
    return ok(world.users.filter((u) => u.email === params[0] && u.id !== params[1]).slice(0, 1).map((u) => ({ id: u.id })));
  }
  if (sql === 'SELECT id, role FROM users WHERE id = ANY($1::uuid[])') {
    const ids = params[0] as string[];
    return ok(world.users.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, role: u.role })));
  }
  if (/^SELECT id, email, display_name AS "displayName".* FROM users WHERE id = \$1$/.test(sql)) {
    const u = world.users.find((x) => x.id === params[0]);
    return ok(u ? [userRow(u)] : []);
  }
  if (/^SELECT id, email, display_name AS "displayName".* FROM users WHERE email = \$1$/.test(sql)) {
    const u = world.users.find((x) => x.email === params[0]);
    return ok(u ? [userRow(u)] : []);
  }
  if (sql === 'UPDATE users SET email = $2, email_verified = TRUE, updated_at = NOW() WHERE id = $1') {
    if (world.users.some((u) => u.email === params[1] && u.id !== params[0])) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
    }
    const u = world.users.find((x) => x.id === params[0]);
    if (u) { u.email = String(params[1]); u.emailVerified = true; }
    return ok([], u ? 1 : 0);
  }
  if (sql === 'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2') {
    const u = world.users.find((x) => x.id === params[1]);
    if (u) u.role = String(params[0]);
    return ok([], u ? 1 : 0);
  }
  if (sql === 'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2') {
    const u = world.users.find((x) => x.id === params[1]);
    if (u) u.status = String(params[0]);
    return ok([], u ? 1 : 0);
  }
  if (sql === 'UPDATE users SET role = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id'
    || sql === 'UPDATE users SET status = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id') {
    const ids = params[1] as string[];
    const hit = world.users.filter((u) => ids.includes(u.id));
    for (const u of hit) { if (sql.includes('SET role')) u.role = String(params[0]); else u.status = String(params[0]); }
    return ok(hit.map((u) => ({ id: u.id })));
  }
  if (sql === "UPDATE users SET status = 'deactivated', updated_at = NOW() WHERE id = $1") {
    const u = world.users.find((x) => x.id === params[0]);
    if (u) u.status = 'deactivated';
    return ok([], u ? 1 : 0);
  }
  if (sql === 'UPDATE users SET last_active_at = NOW() WHERE id = $1') return ok([], 1);

  // ── deleteUser's memberships (nobody here is in a pod or an event) ──
  if (/^UPDATE pod_members SET status = 'removed'/.test(sql) || /^UPDATE session_participants SET status = 'removed'/.test(sql)) return ok([], 0);
  if (/^SELECT session_id FROM session_participants WHERE user_id = \$1/.test(sql)) return ok([]);

  // ── refresh_tokens ──
  if (sql === 'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)') {
    world.refresh.push({ id: crypto.randomUUID(), user_id: String(params[0]), token_hash: String(params[1]), revoked_at: null });
    return ok([], 1);
  }
  if (sql === 'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL') {
    const mine = world.refresh.filter((r) => r.user_id === params[0] && !r.revoked_at);
    for (const r of mine) r.revoked_at = new Date();
    return ok([], mine.length);
  }
  if (sql === 'SELECT id, revoked_at FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2') {
    return ok(world.refresh.filter((r) => r.token_hash === params[0] && r.user_id === params[1]).map((r) => ({ id: r.id, revoked_at: r.revoked_at })));
  }
  if (sql === 'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1') {
    const r = world.refresh.find((x) => x.id === params[0]);
    if (r) r.revoked_at = new Date();
    return ok([], r ? 1 : 0);
  }

  // ── audit_log ──
  if (sql === 'INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)') {
    world.audit.push({
      actor_id: params[0] as string | null, action: String(params[1]), entity_type: String(params[2]),
      entity_id: params[3] as string | null, details: String(params[4]), ip_address: params[5] as string | null,
    });
    return ok([], 1);
  }
  if (sql === "INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, 'user.email_changed', 'user', $1, '{}', $2)") {
    world.audit.push({
      actor_id: String(params[0]), action: 'user.email_changed', entity_type: 'user', entity_id: String(params[0]),
      details: '{}', ip_address: params[1] as string | null,
    });
    return ok([], 1);
  }

  // ── magic_links: the sign-in link and code (identity.service sendMagicLink, verifyMagicLink, verifySignInCode) ──
  if (/^UPDATE magic_links SET used_at = NOW\(\) WHERE email = \$1 AND purpose = 'login' AND used_at IS NULL/.test(sql)) {
    for (const l of world.links) {
      if (l.email === params[0] && l.purpose === 'login' && !l.used_at && l.expires_at.getTime() > now()
        && l.expires_at.getTime() <= now() + 120 * MIN) l.used_at = new Date();
    }
    return ok([], 1);
  }
  if (sql === 'INSERT INTO magic_links (email, token_hash, expires_at, code_hash) VALUES ($1, $2, $3, $4)') {
    addLink({ email: String(params[0]), token_hash: String(params[1]), expires_at: params[2] as Date, code_hash: String(params[3]), purpose: 'login' });
    return ok([], 1);
  }
  if (sql === "SELECT id, email, expires_at, used_at FROM magic_links WHERE token_hash = $1 AND purpose = 'login'") {
    const l = world.links.find((x) => x.token_hash === params[0] && x.purpose === 'login');
    return ok(l ? [{ id: l.id, email: l.email, expires_at: l.expires_at, used_at: l.used_at }] : []);
  }
  if (sql === 'UPDATE magic_links SET used_at = NOW() WHERE id = $1') {
    const l = byId(params[0]); if (l) l.used_at = new Date();
    return ok([], l ? 1 : 0);
  }
  if (/FROM magic_links WHERE email = \$1 AND purpose = 'login' AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1$/.test(sql)) {
    return ok(newest(world.links.filter((l) => l.email === params[0] && l.purpose === 'login' && l.code_hash)).map((l) => codeRow(l, Number(params[1]))));
  }

  // ── spendSignInCode (shared by every purpose) ──
  if (/FROM magic_links WHERE id = \$1$/.test(sql) && /code_live/.test(sql)) {
    const l = byId(params[0]);
    return ok(l ? [codeRow(l, Number(params[1]))] : []);
  }
  if (sql === 'UPDATE magic_links SET code_attempts = code_attempts + 1 WHERE id = $1 AND used_at IS NULL AND code_attempts < $2 RETURNING code_attempts') {
    const l = byId(params[0]);
    if (!l || l.used_at || l.code_attempts >= Number(params[1])) return ok([]);
    l.code_attempts += 1;
    return ok([{ code_attempts: l.code_attempts }]);
  }
  if (sql === 'UPDATE magic_links SET used_at = COALESCE(used_at, NOW()), expires_at = LEAST(expires_at, NOW()) WHERE id = $1') {
    const l = byId(params[0]);
    if (l) { l.used_at = l.used_at ?? new Date(); l.expires_at = new Date(Math.min(l.expires_at.getTime(), now())); }
    return ok([], l ? 1 : 0);
  }
  if (sql === 'UPDATE magic_links SET code_attempts = code_attempts - 1 WHERE id = $1 AND used_at IS NULL') {
    const l = byId(params[0]); if (l && !l.used_at) l.code_attempts -= 1;
    return ok([], l ? 1 : 0);
  }
  if (sql === 'UPDATE magic_links SET used_at = NOW(), code_attempts = code_attempts - 1 WHERE id = $1 AND used_at IS NULL RETURNING id') {
    const l = byId(params[0]);
    if (!l || l.used_at) return ok([]);
    l.used_at = new Date(); l.code_attempts -= 1;
    return ok([{ id: l.id }]);
  }

  // ── reauth.service ──
  if (sql === "UPDATE magic_links SET used_at = NOW(), expires_at = LEAST(expires_at, NOW()) WHERE target_user_id = $1 AND purpose = 'reauth' AND action = $2 AND used_at IS NULL"
    || sql === "UPDATE magic_links SET used_at = NOW(), expires_at = LEAST(expires_at, NOW()) WHERE target_user_id = $1 AND purpose = 'email_change' AND used_at IS NULL") {
    const purpose = sql.includes("'reauth'") ? 'reauth' : 'email_change';
    const hit = world.links.filter((l) => l.target_user_id === params[0] && l.purpose === purpose && !l.used_at
      && (purpose === 'email_change' || l.action === params[1]));
    for (const l of hit) { l.used_at = new Date(); l.expires_at = new Date(Math.min(l.expires_at.getTime(), now())); }
    return ok([], hit.length);
  }
  if (sql === "INSERT INTO magic_links (email, token_hash, expires_at, code_hash, purpose, target_user_id, action) VALUES ($1, $2, NOW() + make_interval(mins => $3::int), $4, 'reauth', $5, $6)") {
    addLink({
      email: String(params[0]), token_hash: String(params[1]), expires_at: new Date(now() + Number(params[2]) * MIN),
      code_hash: String(params[3]), purpose: 'reauth', target_user_id: String(params[4]), action: String(params[5]),
    });
    return ok([], 1);
  }
  if (sql === "INSERT INTO magic_links (email, token_hash, expires_at, code_hash, purpose, target_user_id) VALUES ($1, $2, NOW() + make_interval(mins => $3::int), $4, 'email_change', $5)") {
    addLink({
      email: String(params[0]), token_hash: String(params[1]), expires_at: new Date(now() + Number(params[2]) * MIN),
      code_hash: String(params[3]), purpose: 'email_change', target_user_id: String(params[4]),
    });
    return ok([], 1);
  }
  if (/FROM magic_links WHERE target_user_id = \$1 AND purpose = 'reauth' AND action = \$3 AND code_hash IS NOT NULL AND email = \(SELECT email FROM users WHERE id = \$1\) ORDER BY created_at DESC LIMIT 1$/.test(sql)) {
    const current = emailOf(params[0]);
    return ok(newest(world.links.filter((l) => l.target_user_id === params[0] && l.purpose === 'reauth' && l.action === params[2]
      && l.code_hash && l.email === current)).map((l) => codeRow(l, Number(params[1]))));
  }
  if (/FROM magic_links WHERE target_user_id = \$1 AND purpose = 'email_change' AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1$/.test(sql)) {
    return ok(newest(world.links.filter((l) => l.target_user_id === params[0] && l.purpose === 'email_change' && l.code_hash))
      .map((l) => codeRow(l, Number(params[1]))));
  }
  if (sql === "UPDATE magic_links SET expires_at = NOW() + make_interval(mins => $2::int) WHERE id = $1 AND purpose = 'reauth' RETURNING expires_at") {
    const l = byId(params[0]);
    if (!l || l.purpose !== 'reauth') return ok([]);
    l.expires_at = new Date(now() + Number(params[1]) * MIN);
    return ok([{ expires_at: l.expires_at }]);
  }
  if (sql === "UPDATE magic_links SET expires_at = NOW() WHERE id = $1 AND purpose = 'reauth' AND target_user_id = $2 AND action = $3 AND used_at IS NOT NULL AND expires_at > NOW() AND email = (SELECT email FROM users WHERE id = $2) RETURNING id") {
    const l = byId(params[0]);
    const live = l && l.purpose === 'reauth' && l.target_user_id === params[1] && l.action === params[2] && l.used_at
      && l.expires_at.getTime() > now() && l.email === emailOf(params[1]);
    if (!live || !l) return ok([]);
    l.expires_at = new Date(now() - 1);
    return ok([{ id: l.id }]);
  }

  // ── email-change.service: every live link of the old address dies ──
  if (sql === 'UPDATE magic_links SET expires_at = LEAST(expires_at, NOW()) WHERE email = $1 AND expires_at > NOW()') {
    const hit = world.links.filter((l) => l.email === params[0] && l.expires_at.getTime() > now());
    for (const l of hit) l.expires_at = new Date(now() - 1);
    return ok([], hit.length);
  }

  throw new Error(`account-security-world: a statement this world does not know: ${sql}`);
}
