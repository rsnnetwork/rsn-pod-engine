// ─── Admin join-request email-action — architectural pins ──────────────────
//
// Pins for the email-based approve/reject feature. The admin gets an email
// with two signed-token URLs; clicking either lands on a peek page that
// confirms the action, and a POST finalises it. Tokens are tied to (admin,
// request, action), single-use, 24h, hashed at rest.
//
// These are static text pins over the source — they confirm the
// architectural contract the runtime depends on, not full behaviour.
// Behavioural tests live alongside the service.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..');
const SERVER = join(REPO, 'server', 'src');
const CLIENT = join(REPO, 'client', 'src');

const MIGRATION = join(SERVER, 'db', 'migrations', '058_join_request_action_tokens.sql');
const SERVICE = join(SERVER, 'services', 'join-request', 'admin-action-tokens.service.ts');
const ROUTES = join(SERVER, 'routes', 'admin-actions.ts');
const INDEX = join(SERVER, 'index.ts');
const EMAIL_SVC = join(SERVER, 'services', 'email', 'email.service.ts');
const JR_SVC = join(SERVER, 'services', 'join-request', 'join-request.service.ts');
const CLIENT_PAGE = join(CLIENT, 'features', 'admin', 'AdminJoinRequestActionPage.tsx');
const APP = join(CLIENT, 'App.tsx');

describe('Admin email-action — architectural pins', () => {
  test('migration 055 exists and adds the four canonical columns + index', () => {
    expect(existsSync(MIGRATION)).toBe(true);
    const sql = readFileSync(MIGRATION, 'utf8');
    // additive ALTERs, all safe
    expect(sql).toMatch(/ALTER\s+TABLE\s+magic_links/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?purpose/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?target_user_id/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?target_id/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?action/i);
    // existing rows default to login so login keeps working
    expect(sql).toMatch(/DEFAULT\s+'login'/i);
    // index for the non-login lookup path
    expect(sql).toMatch(/CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+magic_links/i);
  });

  test('service file exists with the three canonical exports', () => {
    expect(existsSync(SERVICE)).toBe(true);
    const src = readFileSync(SERVICE, 'utf8');
    expect(src).toMatch(/export\s+async\s+function\s+issueReviewTokens/);
    expect(src).toMatch(/export\s+async\s+function\s+peekActionToken/);
    expect(src).toMatch(/export\s+async\s+function\s+confirmActionToken/);
  });

  test('service hashes tokens with SHA-256, stores hash not plaintext', () => {
    const src = readFileSync(SERVICE, 'utf8');
    expect(src).toMatch(/crypto\.createHash\(['"]sha256['"]\)/);
    // 32 bytes literal, OR a constant whose value is 32
    expect(src).toMatch(/randomBytes\(\s*32|TOKEN_BYTES\s*=\s*32/);
    // never store raw token in DB
    expect(src).toMatch(/token_hash/);
  });

  test('confirmActionToken uses atomic where status pending (race-safe)', () => {
    const src = readFileSync(SERVICE, 'utf8');
    // The atomic check-and-set on the join_requests row.
    expect(src).toMatch(/UPDATE[\s\S]+?join_requests[\s\S]+?WHERE[\s\S]+?status\s*=\s*'pending'/i);
  });

  test('email template function added to email.service.ts', () => {
    const src = readFileSync(EMAIL_SVC, 'utf8');
    expect(src).toMatch(/export\s+async\s+function\s+sendJoinRequestAdminReviewEmail/);
    // dual-button HTML with both action URLs
    expect(src).toMatch(/approveUrl/);
    expect(src).toMatch(/rejectUrl/);
  });

  test('createJoinRequest fans out the new admin email to all admins', () => {
    const src = readFileSync(JR_SVC, 'utf8');
    expect(src).toMatch(/sendJoinRequestAdminReviewEmail/);
    // Reuses the existing role IN ('admin','super_admin') admin lookup
    expect(src).toMatch(/role\s+IN\s*\(\s*'admin'\s*,\s*'super_admin'\s*\)/);
  });

  test('routes file exposes peek (GET) and confirm (POST) endpoints, both rate-limited', () => {
    expect(existsSync(ROUTES)).toBe(true);
    const src = readFileSync(ROUTES, 'utf8');
    // Peek endpoint
    expect(src).toMatch(/router\.get\(\s*['"]\/[:\w]*token/);
    // Confirm endpoint
    expect(src).toMatch(/router\.post\(\s*['"][^'"]*confirm/);
    // Rate-limited (any limiter import or middleware)
    expect(src).toMatch(/rateLimit|Limiter|limiter/i);
  });

  test('routes mounted in server/src/index.ts under /api/admin/join-request-action', () => {
    const src = readFileSync(INDEX, 'utf8');
    expect(src).toMatch(/admin-actions/);
    expect(src).toMatch(/['"]\/api\/admin\/join-request-action['"]/);
  });

  test('peek endpoint never mutates state (read-only against the token row)', () => {
    const src = readFileSync(ROUTES, 'utf8');
    // The GET handler must call peekActionToken but NOT confirmActionToken.
    const getHandlerMatch = src.match(/router\.get\([\s\S]+?\}\s*\)\s*;/);
    expect(getHandlerMatch).toBeTruthy();
    if (getHandlerMatch) {
      expect(getHandlerMatch[0]).toMatch(/peekActionToken/);
      expect(getHandlerMatch[0]).not.toMatch(/confirmActionToken/);
    }
  });

  test('client action page exists with four documented states', () => {
    expect(existsSync(CLIENT_PAGE)).toBe(true);
    const src = readFileSync(CLIENT_PAGE, 'utf8');
    // The four shapes the design calls out
    expect(src).toMatch(/['"]loading['"]|isLoading|kind:\s*['"]checking['"]/);
    expect(src).toMatch(/['"]ready['"]|kind:\s*['"]ready['"]/);
    expect(src).toMatch(/already_processed|alreadyProcessed|already_actioned/);
    expect(src).toMatch(/expired/);
  });

  test('client route /admin/jr/:token wired in App.tsx', () => {
    const src = readFileSync(APP, 'utf8');
    expect(src).toMatch(/['"]\/admin\/jr\/:token['"]/);
    expect(src).toMatch(/AdminJoinRequestActionPage/);
  });
});
