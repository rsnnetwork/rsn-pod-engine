// ─── Location on the v2 confirm, and the onboarding CSV, on a real Postgres (30 Oct review, 1.2 and 2.3) ───────
//
// What the SQL itself must do, which a stand-in database cannot show, against rows shaped like production's
// (00-production-facts.md): a member with no location (44 of 81) and one with only "USA" are refused on screen 7's
// confirm with nothing written, then accepted once they give a city and a country, which is stored exactly; an
// answer saved in edit mode is not held to it; the state reads the stored location back. The CSV has one row per
// active member, so a deactivated member is absent.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) and dropped at the
// end: no row of the database is read or written. Opt-in, because it needs a local Postgres (it refuses anything
// else); without one it is skipped:
//
//   ONBOARDING_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/onboarding/onboarding-location.sql.test.ts

import { randomUUID } from 'crypto';
import { Client } from 'pg';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.ONBOARDING_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

suite('location on the v2 confirm, and the onboarding CSV (real Postgres)', () => {
  const schema = `zz_onboarding_location_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let repo: typeof import('../../../services/onboarding/answers-v2.repo');
  let schemaV2: typeof import('../../../services/onboarding/answers-v2.schema');
  let report: typeof import('../../../services/onboarding/onboarding-report');

  const NONE = randomUUID(); // completed the earlier onboarding, no location: Claus's shape
  const USA = randomUUID(); // completed the earlier onboarding, "USA"
  const V2 = randomUUID(); // finished v2, with a location
  const GONE = randomUUID(); // deactivated

  const q = (sql: string, params: unknown[] = []) => admin.query(sql.replace(/\bS\./g, `${schema}.`), params);
  const userRow = async (id: string) => (await q(`SELECT * FROM S.users WHERE id = $1`, [id])).rows[0];

  const ANSWERS = {
    lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'], findSpecific: 'a seed lead',
    canOffer: ['offer_advice_mentoring'], selfKinds: ['self_founder_owner'],
  };
  const confirm = (id: string, profile?: Record<string, unknown>) =>
    repo.confirm(id, schemaV2.confirmSchemaV2.parse({ ...ANSWERS, ...(profile ? { profile } : {}) }));

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('ONBOARDING_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['users', 'user_intent_profiles', 'join_requests', 'onboarding_stage_events']) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const seed = (id: string, name: string, over: Record<string, unknown>) => q(
      `INSERT INTO S.users (id, email, display_name, first_name, last_name, status, onboarding_status, onboarding_version,
                            location, looking_to_meet)
       VALUES ($1, $2, $3, $3, 'Test', $4, $5, $6, $7, $8)`,
      [id, `${id}@onboarding-location.invalid`, name, over.status ?? 'active', over.onboarding_status ?? 'completed',
        over.onboarding_version ?? null, over.location ?? null, over.looking_to_meet ?? ['investors']],
    );
    await seed(NONE, 'Ana NoLocation', {});
    await seed(USA, 'Bo Usa', { location: 'USA' });
    await seed(V2, 'Cy Finished', { onboarding_version: 2, location: 'Manchester, UK', looking_to_meet: ['meet_investors'] });
    await seed(GONE, 'Dee Gone', { status: 'deactivated', location: 'Copenhagen, Denmark' });

    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    repo = await import('../../../services/onboarding/answers-v2.repo');
    schemaV2 = await import('../../../services/onboarding/answers-v2.schema');
    report = await import('../../../services/onboarding/onboarding-report');
  });

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  const REFUSED = { statusCode: 400, message: 'Please add your city and country.', details: { 'profile.location': ['Please add your city and country.'] } };

  it('a member with no location who gives none is refused, and nothing of theirs changes', async () => {
    const before = await userRow(NONE);
    await expect(confirm(NONE, { company: 'Vokt' })).rejects.toMatchObject(REFUSED);
    await expect(confirm(NONE, { location: '   ' })).rejects.toMatchObject(REFUSED);
    expect(await userRow(NONE)).toEqual(before);
  });

  it('a member with only "USA" is refused, and so is giving only a country', async () => {
    await expect(confirm(USA, { jobTitle: null })).rejects.toMatchObject(REFUSED);
    await expect(confirm(USA, { location: 'United Kingdom' })).rejects.toMatchObject(REFUSED);
    expect((await userRow(USA)).onboarding_version).toBeNull();
  });

  it('once they give a city and a country it is stored as they wrote it, tidied, and they have done v2', async () => {
    await confirm(NONE, { location: '  Copenhagen,  Denmark ' });
    expect(await userRow(NONE)).toMatchObject({ location: 'Copenhagen, Denmark', onboarding_version: 2, onboarding_status: 'completed' });
    await confirm(USA, { location: 'Omaha, NE' });
    expect((await userRow(USA)).location).toBe('Omaha, NE');
    // The state reads it back for screen 7.
    expect((await repo.getState(USA)).profile.location).toBe('Omaha, NE');
  });

  it('a blank location keeps the stored one, and an answer saved in edit mode is never held to it', async () => {
    await confirm(V2, { location: '' });
    expect((await userRow(V2)).location).toBe('Manchester, UK');
    await q(`UPDATE S.users SET location = NULL WHERE id = $1`, [V2]);
    await confirm(V2);
    expect(await userRow(V2)).toMatchObject({ location: null, onboarding_version: 2 });
  });

  it('the CSV has one row per active member, by name, and a deactivated member is not in it', async () => {
    const rows = await report.onboardingReportRows();
    expect(rows.map(r => r.Name)).toEqual(['Ana NoLocation', 'Bo Usa', 'Cy Finished']);
    expect(rows[0]).toMatchObject({
      Onboarding: 'New onboarding', Location: 'Copenhagen, Denmark', 'Who they want to meet': 'Investors',
      'Hoping to find': 'Raising funding', 'Anything specific': 'a seed lead', 'Can offer': 'Advice and mentoring',
      'Describes themselves as': 'Founder or business owner',
    });
    expect(rows.some(r => r.Name === 'Dee Gone')).toBe(false);
  });
});
