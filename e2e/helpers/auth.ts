import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';

// Load server's .env (for DATABASE_URL)
dotenvConfig({ path: path.resolve(__dirname, '../../server/.env') });

const JWT_SECRET = process.env.JWT_SECRET || process.env.E2E_JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET env var required (set via Render env or E2E_JWT_SECRET)');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Create a test user directly in DB and return JWT tokens.
 * Marks the user with email prefix `e2etest-` so we can clean up later.
 */
export async function createTestUser(suffix: string, role: 'member' | 'admin' | 'super_admin' = 'member'): Promise<TestUser> {
  const id = uuid();
  const email = `e2etest-${suffix}-${Date.now()}@example.com`;
  const displayName = `E2E Test ${suffix}`;
  const firstName = 'E2E';
  const lastName = `Test ${suffix}`;

  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed, email_verified, company, job_title, industry, reasons_to_connect)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, true, true, true, 'TestCo', 'Test Engineer', 'Tech', ARRAY['Testing']::text[])`,
    [id, email, displayName, firstName, lastName, role]
  );

  const sessionId = uuid();
  const accessToken = jwt.sign(
    { sub: id, email, role, displayName, sessionId },
    JWT_SECRET!,
    { expiresIn: '1h' }
  );
  const refreshToken = jwt.sign(
    { sub: id, sessionId, type: 'refresh' },
    JWT_SECRET!,
    { expiresIn: '1d' }
  );

  return { id, email, displayName, accessToken, refreshToken };
}

/**
 * Cleanup all e2e test users (and cascading data).
 */
export async function cleanupTestData(): Promise<{ users: number; sessions: number; matches: number }> {
  // Find test users
  const u = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'e2etest-%@example.com'`
  );
  const userIds = u.rows.map(r => r.id);
  if (userIds.length === 0) return { users: 0, sessions: 0, matches: 0 };

  // Find sessions hosted by test users
  const s = await pool.query<{ id: string }>(
    `SELECT id FROM sessions WHERE host_user_id = ANY($1)`,
    [userIds]
  );
  const sessionIds = s.rows.map(r => r.id);

  let matchCount = 0;
  if (sessionIds.length > 0) {
    const m = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM matches WHERE session_id = ANY($1)`,
      [sessionIds]
    );
    matchCount = parseInt(m.rows[0].c, 10);

    // Delete invites tied to these sessions (no cascade)
    await pool.query(`DELETE FROM invites WHERE session_id = ANY($1)`, [sessionIds]);
    // Delete encounter_history rows tied to these sessions (no cascade)
    await pool.query(`DELETE FROM encounter_history WHERE last_session_id = ANY($1)`, [sessionIds]);
    // Sessions cascade matches → ratings → session_participants
    await pool.query(`DELETE FROM sessions WHERE id = ANY($1)`, [sessionIds]);
  }

  // Delete pods owned by test users
  await pool.query(`DELETE FROM pods WHERE created_by = ANY($1)`, [userIds]);

  // Delete encounter_history involving these users (in case any survive)
  await pool.query(
    `DELETE FROM encounter_history WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`,
    [userIds]
  );

  // Delete audit_log entries for these users (FK has no CASCADE)
  await pool.query(`DELETE FROM audit_log WHERE actor_id = ANY($1)`, [userIds]);

  // Delete refresh_tokens for these users (if FK has no CASCADE)
  await pool.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [userIds]).catch(() => {});

  // Delete notifications, etc.
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [userIds]).catch(() => {});

  // Delete users (cascades matches via FK, ratings via match cascade, session_participants)
  const del = await pool.query(`DELETE FROM users WHERE id = ANY($1) RETURNING id`, [userIds]);

  return { users: del.rows.length, sessions: sessionIds.length, matches: matchCount };
}

export async function closePool() {
  await pool.end();
}

export { pool };
