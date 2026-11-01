// ─── The sign-in code's statements on a real Postgres (1 Nov 2026) ──────────────────────────────────
//
// routes/sign-in-code.test.ts proves the rules against an in-memory table that answers the service's own
// statements. This runs the real sendMagicLink and verifySignInCode on a real Postgres, so the SQL itself is
// what is tested: the 15-minute window in the database's own clock, the one statement that reserves a try
// (so tries sent all at once still compare at most five codes), the lock that pulls the link's expiry to now,
// and a right code sent twice at once giving one session. Only the email sender and the logger are stand-ins.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) plus migration
// 131's own file, and dropped at the end: no row of the database is read or written.
//
// Opt-in, because it needs a Postgres to connect to (a local one: it refuses anything else); without one it
// is skipped:
//
//   SIGN_IN_CODE_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/identity/sign-in-code.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';

jest.mock('../../../services/email/email.service', () => ({ __esModule: true, sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.SIGN_IN_CODE_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

suite('the sign-in code on a real Postgres', () => {
  const schema = `zz_sign_in_code_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let identity: typeof import('../../../services/identity/identity.service');
  let email: { sendMagicLinkEmail: jest.Mock };

  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const codeOf = (err: unknown) => (err as { code?: string }).code;

  /** A member of this schema, and the code and token of the sign-in email they just asked for. */
  async function member(): Promise<{ address: string; code: string; token: string }> {
    const address = `${randomUUID()}@sign-in-code.invalid`;
    await admin.query(
      `INSERT INTO ${schema}.users (id, email, display_name, first_name, last_name, status, email_verified) VALUES ($1, $2, 'Ana', 'Ana', 'Test', 'active', TRUE)`,
      [randomUUID(), address],
    );
    email.sendMagicLinkEmail.mockClear();
    await identity.sendMagicLink(address, 'https://app.rsn.network');
    const [, link, code] = email.sendMagicLinkEmail.mock.calls[0] as [string, string, string];
    return { address, code, token: new URL(link).searchParams.get('token') ?? '' };
  }
  const linkOf = async (address: string) =>
    (await admin.query(`SELECT used_at, expires_at, code_attempts, code_hash, expires_at <= NOW() AS dead FROM ${schema}.magic_links WHERE email = $1`, [address])).rows[0];
  const sessions = async () => (await admin.query(`SELECT count(*)::int AS n FROM ${schema}.refresh_tokens`)).rows[0].n as number;

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('SIGN_IN_CODE_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['users', 'magic_links', 'refresh_tokens']) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // Migration 131 exactly as it ships (it is idempotent, so a database that already has it is fine too).
    const migration = fs.readFileSync(path.join(__dirname, '../../../db/migrations/131_magic_link_sign_in_code.sql'), 'utf8');
    await admin.query(`SET search_path TO ${schema}; ${migration}; SET search_path TO public;`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    identity = await import('../../../services/identity/identity.service');
    email = (await import('../../../services/email/email.service')) as unknown as { sendMagicLinkEmail: jest.Mock };
  });

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  it('the right code signs in and spends the link; the stored hash is not the code', async () => {
    const { address, code, token } = await member();
    const before = await linkOf(address);
    expect(before.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(before.code_attempts).toBe(0);
    const tokens = await identity.verifySignInCode(address, code);
    expect(tokens.accessToken).toBeTruthy();
    const after = await linkOf(address);
    expect(after.used_at).not.toBeNull();
    expect(after.code_attempts).toBe(0);
    await db.query(`UPDATE magic_links SET used_at = NOW() - INTERVAL '3 minutes' WHERE email = $1`, [address]);
    await expect(identity.verifyMagicLink(token)).rejects.toMatchObject({ code: 'AUTH_MAGIC_LINK_USED' });
  }, 30_000);

  it('eight wrong codes sent at once compare at most five, kill the link, and the right code then fails', async () => {
    const { address, code, token } = await member();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => identity.verifySignInCode(address, wrong(code))));
    const codes = results.map((r) => (r.status === 'rejected' ? codeOf(r.reason) : 'signed-in'));
    expect(codes).not.toContain('signed-in');
    expect(codes.filter((c) => c === 'AUTH_SIGN_IN_CODE_WRONG').length).toBe(4);
    expect(codes.filter((c) => c === 'AUTH_SIGN_IN_LOCKED').length).toBe(4);
    const row = await linkOf(address);
    expect(row.code_attempts).toBe(5);
    expect(row.used_at).not.toBeNull();
    expect(row.dead).toBe(true);
    await expect(identity.verifySignInCode(address, code)).rejects.toMatchObject({ code: 'AUTH_SIGN_IN_LOCKED' });
    await expect(identity.verifyMagicLink(token)).rejects.toMatchObject({ code: 'AUTH_MAGIC_LINK_EXPIRED' });
  }, 30_000);

  it('the right code sent twice at once gives one session', async () => {
    const { address, code } = await member();
    const before = await sessions();
    const results = await Promise.allSettled([identity.verifySignInCode(address, code), identity.verifySignInCode(address, code)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(codeOf(refused.reason)).toBe('AUTH_MAGIC_LINK_USED');
    expect(await sessions()).toBe(before + 1);
  }, 30_000);

  it('the 15 minutes are counted in the database clock: at 14 the code works, at 16 it is expired', async () => {
    const early = await member();
    await admin.query(`UPDATE ${schema}.magic_links SET created_at = NOW() - INTERVAL '14 minutes' WHERE email = $1`, [early.address]);
    await expect(identity.verifySignInCode(early.address, early.code)).resolves.toHaveProperty('accessToken');

    const late = await member();
    await admin.query(`UPDATE ${schema}.magic_links SET created_at = NOW() - INTERVAL '16 minutes' WHERE email = $1`, [late.address]);
    await expect(identity.verifySignInCode(late.address, late.code)).rejects.toMatchObject({ code: 'AUTH_SIGN_IN_CODE_EXPIRED' });
    expect((await linkOf(late.address)).code_attempts).toBe(0);
    await expect(identity.verifyMagicLink(late.token)).resolves.toHaveProperty('accessToken');
  }, 30_000);
});
