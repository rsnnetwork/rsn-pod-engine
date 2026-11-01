// ─── The entity admin lock on a real Postgres (26 Oct 2026, H2b item 10) ────────────────────────────────────
//
// lockEntity used to join the actor's membership into the statement that takes the entity's row lock
// (FOR UPDATE OF e). A statement queued behind another transaction's lock re-reads the locked row once the lock
// is granted, but the joined membership comes from the snapshot the statement started with: an admin action
// queued behind the actor's own demotion read is_admin = true and went through. The lock is now its own statement
// and the membership is read in the next, with a fresh snapshot.
//
// Two real connections play it out: one holds the entity's lock and demotes the actor; the other, queued behind
// it, must read the demotion (403), not the flag from before the queue. Opt-in, because it needs a Postgres with the
// schema (the scratch database): ENTITY_SQL_TEST_DB=postgresql://... ; without it the suite is skipped.

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

jest.mock('../../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: jest.fn().mockResolvedValue(false), __esModule: true }));

import { lockForAdmin } from '../../../services/entity/entity.service';

const url = process.env.ENTITY_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

suite('an admin action queued behind the actor\'s own demotion', () => {
  let holder: Client;
  let queued: Client;
  const user = randomUUID();
  const entity = randomUUID();

  beforeAll(async () => {
    holder = new Client({ connectionString: url });
    queued = new Client({ connectionString: url });
    await holder.connect();
    await queued.connect();
    // The columns the e2e helper fills for a throwaway account (every NOT NULL one without a default).
    await holder.query(
      `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                          onboarding_status, email_verified, company, job_title, industry, interests)
       VALUES ($1, $2, 'Lock Race Test', 'Lock', 'Race', 'active', 'member', true, true, 'completed', true, 'TestCo', 'Test Account',
               'Tech', ARRAY['Testing']::text[])`,
      [user, `lock-race-${user}@rsn-e2e.invalid`],
    );
    await holder.query(`INSERT INTO entities (id, name, kind, created_by) VALUES ($1, 'Lock Race Ltd', 'company', $2)`, [entity, user]);
    await holder.query(`INSERT INTO entity_members (entity_id, user_id, role, is_admin) VALUES ($1, $2, 'founder', true)`, [entity, user]);
  });

  afterAll(async () => {
    try {
      await holder.query('ROLLBACK').catch(() => undefined);
      await queued.query('ROLLBACK').catch(() => undefined);
      await holder.query('DELETE FROM entities WHERE id = $1', [entity]);
      await holder.query('DELETE FROM users WHERE id = $1', [user]);
    } finally {
      await holder.end();
      await queued.end();
    }
  });

  it('is refused (403): the lock is granted first, then the membership is read as it stands', async () => {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM entities WHERE id = $1 FOR UPDATE', [entity]);

    await queued.query('BEGIN');
    const answer = lockForAdmin(queued as unknown as PoolClient, entity, user, false)
      .then(() => 'allowed', (err: { statusCode?: number }) => err.statusCode ?? 'threw');
    // Let the queued statement reach the lock and wait on it.
    await new Promise((r) => setTimeout(r, 300));

    await holder.query('UPDATE entity_members SET is_admin = false WHERE entity_id = $1 AND user_id = $2', [entity, user]);
    await holder.query('COMMIT');

    expect(await answer).toBe(403);
    await queued.query('ROLLBACK');
  });

  it('goes through while the actor is still an admin', async () => {
    await holder.query('UPDATE entity_members SET is_admin = true WHERE entity_id = $1 AND user_id = $2', [entity, user]);
    await queued.query('BEGIN');
    await expect(lockForAdmin(queued as unknown as PoolClient, entity, user, false)).resolves.toBeUndefined();
    await queued.query('ROLLBACK');
  });
});
