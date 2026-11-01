// ─── Entities: claims that wait for approval, removal, logo and banner, links to circles (real Postgres, T15) ──────
//
// 30 Oct review, section 7: "Entity members need approval. When someone says they are part of an entity, the owner
// should approve it and be able to remove members", "add options to upload a company logo and banner", "An entity
// should be linkable to one or more Circles" (L23). Each rule is read through the real services on real tables:
//   * the links that exist today (no status written) read as active, listed, counted and with their admin rights;
//   * a claim is pending: not on the entity's page, not on the person's profile or brief, not counted, never an admin;
//   * approve lists it (and fills an empty company), decline and remove take it away; a removed admin loses their
//     rights at once; nobody removes the last active admin; only a platform admin removes another admin;
//   * a closed account never shows in the people or the requests; a requester an admin blocked rings no bell there;
//   * the logo and banner: only the entity's admins (and platform admins) change them, served behind a versioned
//     address, gone with an archive;
//   * a circle's managers link an entity to it, once, and both pages list the link (a closed circle by name only).
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) with migrations 129 and
// 130 run inside it, and dropped at the end: no row of the database is read or written. Opt-in, because it needs a
// local Postgres (it refuses anything else):
//
//   ACTIVE_MEMBER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/entity/entity-members.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { solid, sizeOf } from '../../fixtures/real-pictures';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// No live socket server here: the bells are rows, and their pushes are skipped.
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  emitEntities: jest.fn(),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
}));

const url = process.env.ACTIVE_MEMBER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

const TABLES = [
  'users', 'user_blocks', 'notifications', 'entities', 'entity_members',
  'circles', 'circle_members', 'circle_join_requests', 'circle_pods', 'pods', 'pod_members', 'sessions',
  'session_participants', 'session_cohosts', 'invites', 'event_join_requests',
];
const MIGRATIONS = ['129_entity_pictures_member_status.sql', '130_circle_entities.sql']
  .map((f) => fs.readFileSync(path.join(__dirname, '../../../db/migrations', f), 'utf8'));

const dataUrl = (bytes: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${bytes.toString('base64')}`;

suite('entities: approval, removal, pictures and circles (real Postgres)', () => {
  const schema = `zz_entity_members_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let entities: typeof import('../../../services/entity/entity.service');
  let pictures: typeof import('../../../services/entity/entity-pictures.service');
  let links: typeof import('../../../services/circle/circle-entities.service');
  let circles: typeof import('../../../services/circle/circle.service');

  const run = (sql: string, params: unknown[] = []) => admin.query(sql.split('{s}').join(schema), params);

  async function person(name: string, opts: { status?: string; role?: string; company?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.users (id, email, display_name, first_name, last_name, status, role, company)
       VALUES ($1, $2, $3, $3, 'Test', $4, $5, $6)`,
      [id, `${id}@rsn-e2e.invalid`, name, opts.status ?? 'active', opts.role ?? 'member', opts.company ?? null],
    );
    return id;
  }

  /** An entity as production holds them today: links written with no status (the column's default). */
  async function legacyEntity(admins: string[], members: string[] = []): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.entities (id, name, kind, created_by) VALUES ($1, $2, 'company', $3)`,
      [id, `Acme ${id.slice(0, 8)}`, admins[0] ?? null]);
    for (const a of admins) {
      await run(`INSERT INTO {s}.entity_members (entity_id, user_id, role, is_admin) VALUES ($1, $2, 'founder', true)`, [id, a]);
    }
    for (const m of members) {
      await run(`INSERT INTO {s}.entity_members (entity_id, user_id, role, title) VALUES ($1, $2, 'employee', 'CTO')`, [id, m]);
    }
    return id;
  }
  const nameOf = async (entityId: string) =>
    (await run(`SELECT name FROM {s}.entities WHERE id = $1`, [entityId])).rows[0].name as string;
  const linkOf = async (entityId: string, userId: string) =>
    (await run(`SELECT status, role, title, is_admin, requested_role, requested_title FROM {s}.entity_members
                 WHERE entity_id = $1 AND user_id = $2`, [entityId, userId])).rows[0];
  const bells = async (userId: string) =>
    (await run(`SELECT type, title, link FROM {s}.notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
  const peopleOf = async (entityId: string, viewer: string) =>
    (await entities.getEntity(viewer, entityId, false)).people.map((p) => p.id).sort();
  const caught = (p: Promise<unknown>) => p.then(() => null, (e: { statusCode?: number; message?: string; code?: string }) => e);

  async function circle(creator: string, opts: { members?: string[]; policy?: 'open' | 'closed' } = {}): Promise<string> {
    const id = randomUUID();
    const members = opts.members ?? [];
    await run(
      `INSERT INTO {s}.circles (id, name, created_by, member_count, join_policy) VALUES ($1, $2, $3, $4, $5)`,
      [id, `Circle ${id.slice(0, 6)}`, creator, members.length + 1, opts.policy ?? 'open'],
    );
    await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, creator]);
    for (const m of members) await run(`INSERT INTO {s}.circle_members (circle_id, user_id) VALUES ($1, $2)`, [id, m]);
    return id;
  }

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('ACTIVE_MEMBER_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // Migrations 129 and 130 themselves, inside this schema (their tables resolve through the search path). The
    // copies of entities and entity_members are made from public, so on a database that has 129 already the
    // columns are there and the file changes nothing, as a second run in production would.
    await admin.query(`SET search_path = ${schema}`);
    for (const sql of MIGRATIONS) await admin.query(sql);
    await admin.query(`SET search_path = public`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    entities = await import('../../../services/entity/entity.service');
    pictures = await import('../../../services/entity/entity-pictures.service');
    links = await import('../../../services/circle/circle-entities.service');
    circles = await import('../../../services/circle/circle.service');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  // ── Legacy shapes ───────────────────────────────────────────────────────────────────────────────────────

  describe('legacy shapes', () => {
    it('links written before 129 read as active: listed, counted, on the profile, and the admin keeps their rights', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const viewer = await person('Viewer');
      const e = await legacyEntity([owner], [member]);
      expect((await linkOf(e, member)).status).toBe('active');
      const page = await entities.getEntity(viewer, e, false);
      expect(page.people.map((p) => p.id).sort()).toEqual([owner, member].sort());
      expect(page.entity.peopleCount).toBe(2);
      expect(page.myStatus).toBeNull();
      expect((await entities.listUserEntities(viewer, member)).map((x) => x.id)).toEqual([e]);
      // The admin's rights: an edit goes through, and the page says they may edit.
      await entities.updateEntity(owner, e, { about: 'We make things.' }, false);
      expect(await entities.getEntity(owner, e, false)).toMatchObject({ canEdit: true, myStatus: 'active', myRole: 'founder' });
      expect((await entities.listEntities(member)).mine).toEqual([expect.objectContaining({ id: e, myStatus: 'active', myRole: 'employee' })]);
    }, 30_000);

    it('an entity with no picture keeps the letter tile: every read answers no logo and no banner', async () => {
      const owner = await person('Owner');
      const e = await legacyEntity([owner]);
      const page = await entities.getEntity(owner, e, false);
      expect(page.entity).toMatchObject({ logoUrl: null, bannerUrl: null });
      expect((await entities.listEntities(owner)).mine[0]).toMatchObject({ id: e, logoUrl: null });
      expect((await entities.entitiesOf(owner))[0]).toMatchObject({ id: e, logoUrl: null });
      expect(await pictures.getEntityPictureBlob(e, 'logo')).toBeNull();
    }, 30_000);

    it('an entity whose only admin is no longer active still lets a platform admin answer a claim', async () => {
      const gone = await person('Gone', { status: 'deactivated' });
      const platform = await person('Platform', { role: 'admin' });
      const claimant = await person('Claimant');
      const e = await legacyEntity([gone]);
      await entities.setMyMembership(claimant, e, { role: 'employee' });
      // The platform admin is rung, since no admin of the entity can be.
      expect((await bells(platform)).map((b) => b.type)).toContain('join_request');
      expect((await entities.getEntity(platform, e, true)).requests?.map((r) => r.id)).toEqual([claimant]);
      await entities.approveMember(platform, e, claimant, true);
      expect(await peopleOf(e, claimant)).toEqual([claimant]);
    }, 30_000);
  });

  // ── Claims ──────────────────────────────────────────────────────────────────────────────────────────────

  describe('a claim waits for the entity\'s admins', () => {
    it('is pending: not on the page, not counted, not on the profile (the brief reads entitiesOf), company not filled, no admin rights', async () => {
      const owner = await person('Owner');
      const claimant = await person('Claimant', { company: null });
      const viewer = await person('Viewer');
      const e = await legacyEntity([owner]);
      const result = await entities.setMyMembership(claimant, e, { role: 'founder', title: 'CEO' });
      expect(result).toMatchObject({ joined: true, status: 'pending', companyUpdated: false, isAdmin: false, pendingChange: null });
      expect((await linkOf(e, claimant)).status).toBe('pending');
      expect(await peopleOf(e, viewer)).toEqual([owner]);
      expect((await entities.getEntity(viewer, e, false)).entity.peopleCount).toBe(1);
      expect(await entities.listUserEntities(viewer, claimant)).toEqual([]);
      expect(await entities.entitiesOf(claimant)).toEqual([]);
      expect((await run(`SELECT company FROM {s}.users WHERE id = $1`, [claimant])).rows[0].company).toBeNull();
      // Their own screens say it waits.
      expect(await entities.getEntity(claimant, e, false)).toMatchObject({ myStatus: 'pending', myRole: null, canEdit: false });
      expect((await entities.listEntities(claimant)).mine).toEqual([expect.objectContaining({ id: e, myStatus: 'pending' })]);
      expect(await entities.listUserEntities(claimant, claimant)).toEqual([expect.objectContaining({ id: e, status: 'pending' })]);
      // A pending row never carries admin rights, even with the flag set on it.
      await run(`UPDATE {s}.entity_members SET is_admin = true WHERE entity_id = $1 AND user_id = $2`, [e, claimant]);
      expect(await caught(entities.updateEntity(claimant, e, { about: 'mine now' }, false))).toMatchObject({ statusCode: 403 });
      expect((await entities.getEntity(claimant, e, false)).canEdit).toBe(false);
    }, 30_000);

    it("rings every active admin with a join_request bell in the claim's words, but not an admin who blocked them", async () => {
      const a1 = await person('Ana');
      const a2 = await person('Bea');
      const closed = await person('Cid', { status: 'deactivated' });
      const claimant = await person('Dan');
      const e = await legacyEntity([a1, a2, closed]);
      await run(`INSERT INTO {s}.user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [a2, claimant]);
      await entities.setMyMembership(claimant, e, { role: 'investor' });
      expect(await bells(a1)).toEqual([{ type: 'join_request', title: `Dan says they are an investor at ${await nameOf(e)}`, link: `/entities/${e}?requests=1` }]);
      expect(await bells(a2)).toEqual([]);
      expect(await bells(closed)).toEqual([]);
      // The admin who blocked them does not see the request either.
      expect((await entities.getEntity(a2, e, false)).requests).toEqual([]);
      expect((await entities.getEntity(a1, e, false)).requestCount).toBe(1);
    }, 30_000);

    it("shows the requests only to the people who may edit, and never a closed account's", async () => {
      const owner = await person('Owner');
      const claimant = await person('Claimant');
      const closing = await person('Closing');
      const member = await person('Member');
      const e = await legacyEntity([owner], [member]);
      await entities.setMyMembership(claimant, e, { role: 'employee', title: 'Engineer' });
      await entities.setMyMembership(closing, e, { role: 'fan' });
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [closing]);
      const forOwner = await entities.getEntity(owner, e, false);
      expect(forOwner.requests).toEqual([expect.objectContaining({ id: claimant, kind: 'join', role: 'employee', title: 'Engineer', currentRole: null })]);
      expect(forOwner.requestCount).toBe(1);
      const forMember = await entities.getEntity(member, e, false);
      expect(forMember.requests).toBeUndefined();
      expect(forMember.requestCount).toBeUndefined();
    }, 30_000);

    it('approve lists them at once, fills an empty company and rings an approval bell; a second approve is a 404', async () => {
      const owner = await person('Owner');
      const claimant = await person('Claimant', { company: '  ' });
      const e = await legacyEntity([owner]);
      await entities.setMyMembership(claimant, e, { role: 'employee' });
      const answered = await entities.approveMember(owner, e, claimant, false);
      expect(answered).toEqual({ companyUpdated: true });
      expect(await peopleOf(e, owner)).toEqual([owner, claimant].sort());
      expect((await run(`SELECT company FROM {s}.users WHERE id = $1`, [claimant])).rows[0].company).toBe(await nameOf(e));
      expect(await bells(claimant)).toEqual([{ type: 'approval', title: `You're listed at ${await nameOf(e)}`, link: `/entities/${e}` }]);
      expect(await entities.entitiesOf(claimant)).toEqual([expect.objectContaining({ id: e, role: 'employee' })]);
      expect(await caught(entities.approveMember(owner, e, claimant, false))).toMatchObject({ statusCode: 404, message: 'This request has already been answered.' });
    }, 30_000);

    it('decline leaves them off the page with no bell; they can ask again, and are pending again', async () => {
      const owner = await person('Owner');
      const claimant = await person('Claimant');
      const e = await legacyEntity([owner]);
      await entities.setMyMembership(claimant, e, { role: 'employee' });
      await entities.declineMember(owner, e, claimant, false);
      expect((await linkOf(e, claimant)).status).toBe('declined');
      expect(await bells(claimant)).toEqual([]);
      expect(await entities.getEntity(claimant, e, false)).toMatchObject({ myStatus: 'declined', myRole: null });
      expect((await entities.listEntities(claimant)).mine).toEqual([]);
      expect(await caught(entities.declineMember(owner, e, claimant, false))).toMatchObject({ statusCode: 404 });
      const again = await entities.setMyMembership(claimant, e, { role: 'advisor' });
      expect(again.status).toBe('pending');
      expect(await linkOf(e, claimant)).toMatchObject({ status: 'pending', role: 'advisor' });
    }, 30_000);

    it('only the entity\'s admins (and platform admins) answer: a member or the claimant themselves is refused', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const claimant = await person('Claimant');
      const e = await legacyEntity([owner], [member]);
      await entities.setMyMembership(claimant, e, { role: 'employee' });
      expect(await caught(entities.approveMember(member, e, claimant, false))).toMatchObject({ statusCode: 403 });
      expect(await caught(entities.approveMember(claimant, e, claimant, false))).toMatchObject({ statusCode: 403 });
      expect((await linkOf(e, claimant)).status).toBe('pending');
    }, 30_000);

    it('leaving cancels your own pending claim, and the last-person count reads active links only', async () => {
      const owner = await person('Owner');
      const claimant = await person('Claimant');
      const e = await legacyEntity([owner]);
      await entities.setMyMembership(claimant, e, { role: 'employee' });
      expect(await entities.leaveEntity(claimant, e)).toEqual({ left: true, archived: false });
      expect(await linkOf(e, claimant)).toBeUndefined();
      // A pending claim does not keep the entity alive: the last active person leaving archives it.
      const waiting = await person('Waiting');
      await entities.setMyMembership(waiting, e, { role: 'fan' });
      expect(await entities.leaveEntity(owner, e)).toEqual({ left: true, archived: true });
    }, 30_000);

    it('the last active admin leaving promotes the longest-standing ACTIVE person, never a pending one', async () => {
      const owner = await person('Owner');
      const claimant = await person('Claimant');
      const e = await legacyEntity([owner]);
      await entities.setMyMembership(claimant, e, { role: 'employee' });
      const member = await person('Member');
      await run(`INSERT INTO {s}.entity_members (entity_id, user_id, role, created_at) VALUES ($1, $2, 'member', NOW() + INTERVAL '1 minute')`, [e, member]);
      await entities.leaveEntity(owner, e);
      expect((await linkOf(e, member)).is_admin).toBe(true);
      expect((await linkOf(e, claimant)).is_admin).toBe(false);
    }, 30_000);

    it('a platform admin, or an admin of the entity, has their own claim or change applied at once', async () => {
      const owner = await person('Owner');
      const platform = await person('Platform', { role: 'admin' });
      const e = await legacyEntity([owner]);
      expect(await entities.setMyMembership(platform, e, { role: 'investor' }, true)).toMatchObject({ status: 'active', pendingChange: null });
      expect(await peopleOf(e, owner)).toEqual([owner, platform].sort());
      expect(await entities.setMyMembership(owner, e, { role: 'board_member', title: 'Chair' })).toMatchObject({ status: 'active', role: 'board_member', pendingChange: null });
      expect(await linkOf(e, owner)).toMatchObject({ role: 'board_member', title: 'Chair', is_admin: true });
    }, 30_000);
  });

  describe('a change of role or title by an active member waits for the admins', () => {
    it('keeps the listed role until approved, then applies it; decline clears it; sending the current one back clears it', async () => {
      const owner = await person('Owner');
      const member = await person('Mia', { company: null });
      const e = await legacyEntity([owner], [member]);
      const asked = await entities.setMyMembership(member, e, { role: 'founder', title: 'CEO' });
      expect(asked).toMatchObject({ status: 'active', role: 'employee', title: 'CTO', pendingChange: { role: 'founder', title: 'CEO' }, companyUpdated: false });
      expect((await entities.getEntity(owner, e, false)).people.find((p) => p.id === member)).toMatchObject({ role: 'employee', title: 'CTO' });
      expect(await entities.getEntity(member, e, false)).toMatchObject({ myStatus: 'active', myRole: 'employee', myPendingChange: { role: 'founder', title: 'CEO' } });
      expect((await entities.getEntity(owner, e, false)).requests).toEqual([
        expect.objectContaining({ id: member, kind: 'change', role: 'founder', title: 'CEO', currentRole: 'employee', currentTitle: 'CTO' }),
      ]);
      expect((await bells(owner)).map((b) => b.title)).toEqual([`Mia says they are a founder at ${await nameOf(e)}`]);
      await entities.declineMember(owner, e, member, false);
      expect(await linkOf(e, member)).toMatchObject({ status: 'active', role: 'employee', requested_role: null });
      await entities.setMyMembership(member, e, { role: 'founder', title: 'CEO' });
      await entities.approveMember(owner, e, member, false);
      expect(await linkOf(e, member)).toMatchObject({ status: 'active', role: 'founder', title: 'CEO', requested_role: null });
      await entities.setMyMembership(member, e, { role: 'advisor' });
      await entities.setMyMembership(member, e, { role: 'founder', title: 'CEO' });
      expect(await linkOf(e, member)).toMatchObject({ role: 'founder', requested_role: null });
    }, 30_000);
  });

  // ── Removal ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('removing members', () => {
    it('an admin removes a member, who leaves every list with no bell, and can ask again', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const e = await legacyEntity([owner], [member]);
      await entities.removeMember(owner, e, member, false);
      expect((await linkOf(e, member)).status).toBe('removed');
      expect(await peopleOf(e, owner)).toEqual([owner]);
      expect(await entities.entitiesOf(member)).toEqual([]);
      expect(await bells(member)).toEqual([]);
      expect(await caught(entities.removeMember(owner, e, member, false))).toMatchObject({ statusCode: 404 });
      expect((await entities.setMyMembership(member, e, { role: 'employee' })).status).toBe('pending');
    }, 30_000);

    it('a removed admin loses their rights at once; only a platform admin removes another admin', async () => {
      const a1 = await person('A1');
      const a2 = await person('A2');
      const platform = await person('Platform', { role: 'admin' });
      const e = await legacyEntity([a1, a2]);
      expect(await caught(entities.removeMember(a1, e, a2, false))).toMatchObject({ statusCode: 403 });
      await entities.removeMember(platform, e, a2, true);
      expect(await linkOf(e, a2)).toMatchObject({ status: 'removed', is_admin: false });
      expect(await caught(entities.updateEntity(a2, e, { about: 'still mine' }, false))).toMatchObject({ statusCode: 403 });
      expect((await entities.getEntity(a2, e, false)).canEdit).toBe(false);
    }, 30_000);

    it('nobody removes the last active admin, and nobody removes themselves (they leave)', async () => {
      const owner = await person('Owner');
      const platform = await person('Platform', { role: 'admin' });
      const e = await legacyEntity([owner]);
      expect(await caught(entities.removeMember(platform, e, owner, true))).toMatchObject({ statusCode: 409, code: 'ENTITY_LAST_ADMIN' });
      expect(await caught(entities.removeMember(owner, e, owner, false))).toMatchObject({ statusCode: 400 });
      expect((await linkOf(e, owner)).status).toBe('active');
    }, 30_000);

    it('a closed account never appears in the people, the count or the requests', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const e = await legacyEntity([owner], [member]);
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [member]);
      const page = await entities.getEntity(owner, e, false);
      expect(page.people.map((p) => p.id)).toEqual([owner]);
      expect(page.entity.peopleCount).toBe(1);
    }, 30_000);
  });

  // ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────

  describe('the logo and the banner', () => {
    it("an admin's logo is cut square, served at a versioned address, and shows on every read; a member is refused", async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const e = await legacyEntity([owner], [member]);
      const picture = await solid(800, 600);
      expect(await caught(pictures.saveEntityPicture(member, e, 'logo', { image: dataUrl(picture) }, false))).toMatchObject({ statusCode: 403 });
      const { url: logoUrl } = await pictures.saveEntityPicture(owner, e, 'logo', { image: dataUrl(picture) }, false);
      expect(logoUrl).toMatch(new RegExp(`/api/entities/${e}/logo\\?v=\\d+$`));
      const blob = await pictures.getEntityPictureBlob(e, 'logo');
      expect(blob?.contentType).toBe('image/jpeg');
      expect(await sizeOf(blob!.blob)).toMatchObject({ width: 600, height: 600 });
      expect((await entities.getEntity(member, e, false)).entity.logoUrl).toBe(logoUrl);
      expect((await entities.listEntities(member)).mine[0].logoUrl).toBe(logoUrl);
      expect((await entities.entitiesOf(member))[0].logoUrl).toBe(logoUrl);
      // The picture the admin chose is kept, so it can be placed again with only a crop.
      const source = await pictures.getEntityPictureSource(owner, e, 'logo', false);
      expect(source.image?.startsWith('data:image/jpeg;base64,')).toBe(true);
      const again = await pictures.saveEntityPicture(owner, e, 'logo', { crop: { x: 0.4, y: 0.5, zoom: 2 } }, false);
      expect(again.url).not.toBe(logoUrl);
      expect(await caught(pictures.getEntityPictureSource(member, e, 'logo', false))).toMatchObject({ statusCode: 403 });
    }, 30_000);

    it('a banner is cut 3:1; removing it clears it; an archived entity serves neither picture', async () => {
      const owner = await person('Owner');
      const e = await legacyEntity([owner]);
      await pictures.saveEntityPicture(owner, e, 'banner', { image: dataUrl(await solid(1500, 900)) }, false);
      expect(await sizeOf((await pictures.getEntityPictureBlob(e, 'banner'))!.blob)).toMatchObject({ width: 1500, height: 500 });
      await pictures.saveEntityPicture(owner, e, 'logo', { image: dataUrl(await solid(300, 300, undefined, 'png'), 'image/png') }, false);
      await pictures.removeEntityPicture(owner, e, 'banner', false);
      expect(await pictures.getEntityPictureBlob(e, 'banner')).toBeNull();
      expect((await entities.getEntity(owner, e, false)).entity.bannerUrl).toBeNull();
      expect(await pictures.getEntityPictureBlob(e, 'logo')).not.toBeNull();
      await entities.archiveEntity(owner, e, false);
      expect(await pictures.getEntityPictureBlob(e, 'logo')).toBeNull();
    }, 30_000);

    it('refuses a file that is not a picture in words that name the logo', async () => {
      const owner = await person('Owner');
      const e = await legacyEntity([owner]);
      expect(await caught(pictures.saveEntityPicture(owner, e, 'logo', { image: 'data:image/gif;base64,R0lGODlh' }, false)))
        .toMatchObject({ statusCode: 400, message: 'Choose a JPG, PNG or WebP picture for the logo.' });
      expect(await caught(pictures.saveEntityPicture(owner, e, 'logo', { crop: { x: 0.5, y: 0.5, zoom: 1 } }, false)))
        .toMatchObject({ statusCode: 400, message: 'Choose a picture first.' });
    }, 30_000);
  });

  // ── Circles ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('links to circles', () => {
    // Production's client reads GET /circles/:id (CircleDetailPage on origin/main): every field it had is still there.
    it("production's circle page keeps every field it read, with entities added beside them", async () => {
      const manager = await person('Manager');
      const c = await circle(manager);
      const detail = await circles.getCircleDetail(c, manager, 'member');
      for (const key of ['id', 'name', 'description', 'parentCircleId', 'memberCount', 'isMember', 'createdAt', 'podCount',
        'members', 'pods', 'upcomingEvents', 'children']) {
        expect(detail).toHaveProperty(key);
      }
      expect(detail.entities).toEqual([]);
    }, 30_000);

    it("a circle's manager links an entity once; both pages list it; a member of the circle is refused", async () => {
      const manager = await person('Manager');
      const member = await person('Member');
      const owner = await person('Owner');
      const c = await circle(manager, { members: [member] });
      const e = await legacyEntity([owner]);
      expect(await caught(links.linkEntity(c, e, { userId: member, role: 'member' }))).toMatchObject({ statusCode: 403 });
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      expect((await run(`SELECT count(*)::int AS n FROM {s}.circle_entities WHERE circle_id = $1`, [c])).rows[0].n).toBe(1);
      const detail = await circles.getCircleDetail(c, member, 'member');
      expect(detail.entities).toEqual([{ id: e, name: await nameOf(e), kind: 'company', logoUrl: null }]);
      expect((await entities.getEntity(owner, e, false)).circles).toEqual([
        { id: c, name: expect.any(String), memberCount: 2, joinPolicy: 'open' },
      ]);
    }, 30_000);

    it('a closed circle shows on the entity page by name only to someone outside it, and in full to its members', async () => {
      const manager = await person('Manager');
      const owner = await person('Owner');
      const c = await circle(manager, { policy: 'closed' });
      const e = await legacyEntity([owner]);
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      expect((await entities.getEntity(owner, e, false)).circles).toEqual([expect.objectContaining({ id: c, memberCount: null, joinPolicy: 'closed' })]);
      expect((await entities.getEntity(manager, e, false)).circles).toEqual([expect.objectContaining({ id: c, memberCount: 1 })]);
      // Its own page, locked to an outsider, names no entities either.
      expect((await circles.getCircleDetail(c, owner, 'member')).entities).toEqual([]);
    }, 30_000);

    it('an archived entity or circle is a 404 to link, and is left off both pages', async () => {
      const manager = await person('Manager');
      const owner = await person('Owner');
      const c = await circle(manager);
      const e = await legacyEntity([owner]);
      const gone = await legacyEntity([owner]);
      await run(`UPDATE {s}.entities SET archived_at = NOW() WHERE id = $1`, [gone]);
      expect(await caught(links.linkEntity(c, gone, { userId: manager, role: 'member' }))).toMatchObject({ statusCode: 404 });
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      await run(`UPDATE {s}.circles SET archived_at = NOW() WHERE id = $1`, [c]);
      expect((await entities.getEntity(owner, e, false)).circles).toEqual([]);
      expect(await caught(links.linkEntity(c, e, { userId: manager, role: 'member' }))).toMatchObject({ statusCode: 404 });
    }, 30_000);

    it('unlinking an archived entity is a 404, and unlinking what is not linked answers unlinked false (review M5)', async () => {
      const manager = await person('Manager');
      const owner = await person('Owner');
      const c = await circle(manager);
      const e = await legacyEntity([owner]);
      expect(await links.unlinkEntity(c, e, { userId: manager, role: 'member' })).toEqual({ unlinked: false });
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      await run(`UPDATE {s}.entities SET archived_at = NOW() WHERE id = $1`, [e]);
      expect(await caught(links.unlinkEntity(c, e, { userId: owner, role: 'member' }))).toMatchObject({ statusCode: 404 });
    }, 30_000);

    it('the picture source is read without the lock, for its admins only, and is none before any picture (review M3, M4)', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const e = await legacyEntity([owner], [member]);
      expect(await pictures.getEntityPictureSource(owner, e, 'banner', false)).toEqual({ image: null, crop: null });
      expect(await caught(pictures.getEntityPictureSource(member, e, 'banner', false))).toMatchObject({ statusCode: 403 });
      // Held by another write's row lock, the source still reads at once.
      const holder = new Client({ connectionString: url });
      await holder.connect();
      try {
        await holder.query(`SET search_path = ${schema}`);
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM entities WHERE id = $1 FOR UPDATE', [e]);
        const read = pictures.getEntityPictureSource(owner, e, 'banner', false);
        expect(await Promise.race([read.then(() => 'read'), new Promise((r) => setTimeout(() => r('waited'), 2000))])).toBe('read');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    }, 30_000);

    it('a manager or the entity\'s own admin unlinks it; anyone else is refused', async () => {
      const manager = await person('Manager');
      const owner = await person('Owner');
      const stranger = await person('Stranger');
      const c = await circle(manager);
      const e = await legacyEntity([owner]);
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      expect(await caught(links.unlinkEntity(c, e, { userId: stranger, role: 'member' }))).toMatchObject({ statusCode: 403 });
      await links.unlinkEntity(c, e, { userId: owner, role: 'member' });
      expect((await circles.getCircleDetail(c, manager, 'member')).entities).toEqual([]);
      await links.linkEntity(c, e, { userId: manager, role: 'member' });
      await links.unlinkEntity(c, e, { userId: manager, role: 'member' });
      expect((await entities.getEntity(owner, e, false)).circles).toEqual([]);
    }, 30_000);
  });
});
