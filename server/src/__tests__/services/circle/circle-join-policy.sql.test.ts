// ─── Circles: Open or Closed, asks and approvals, the invite sheet, a pod from the circle (real Postgres, T14) ───
//
// 30 Oct review, section 7: "Circle invites don't work", "Who can join a Circle: open or closed (same as Parts)",
// "Create a new Part from the Circle screen". Each rule below is read through the real services on real tables:
//   * a closed circle hides its wall, members, pods and events from people outside it, in every read;
//   * asking, cancelling, approving (under a lock, once) and declining, and reopening a circle lets everyone waiting in;
//   * an invite is the doorway: accepting one joins a closed circle and answers a pending ask;
//   * the invite sheet works for a circle, with the circle's own rule for who may invite;
//   * a pod made from the circle is attached in the same transaction, or not made at all;
//   * legacy shapes (the four open circles, a creator who is not a member, an accepted circle invite) still read.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) with migration 128 run
// inside it, and dropped at the end: no row of the database is read or written. Opt-in, because it needs a local
// Postgres (it refuses anything else):
//
//   ACTIVE_MEMBER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/circle/circle-join-policy.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';

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
// The invite bell pushes through the socket server's entry point, which is not started here.
jest.mock('../../../index', () => ({ __esModule: true, io: { to: () => ({ emit: jest.fn() }) } }));

const url = process.env.ACTIVE_MEMBER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

const TABLES = [
  'users', 'pods', 'pod_members', 'sessions', 'session_participants', 'session_cohosts', 'invites', 'notifications',
  'circles', 'circle_members', 'circle_pods', 'circle_posts', 'circle_post_reactions', 'circle_post_comments', 'circle_comment_likes',
  'dm_conversations', 'direct_messages', 'user_blocks', 'user_pokes', 'encounter_history', 'user_entitlements',
  'event_join_requests', 'matching_templates',
  // T15: a circle's page names the entities linked to it (migration 130).
  'entities', 'circle_entities',
];

const MIGRATION_128 = fs.readFileSync(path.join(__dirname, '../../../db/migrations/128_circle_join_policy.sql'), 'utf8');

suite('circles: open or closed, asks, invites and a pod from the circle (real Postgres)', () => {
  const schema = `zz_circle_join_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let circles: typeof import('../../../services/circle/circle.service');
  let joins: typeof import('../../../services/circle/circle-join.service');
  let wall: typeof import('../../../services/circle/circle-wall.service');
  let pods: typeof import('../../../services/pod/pod.service');
  let invites: typeof import('../../../services/invite/invite.service');
  let candidates: typeof import('../../../services/invite/invite-candidates.service');
  let sessions: typeof import('../../../services/session/session.service');
  let sessionAccess: typeof import('../../../services/session/session-access');

  const run = (sql: string, params: unknown[] = []) => admin.query(sql.split('{s}').join(schema), params);

  async function person(name: string, status = 'active', role = 'member'): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.users (id, email, display_name, first_name, last_name, status, role)
       VALUES ($1, $2, $3, $3, 'Test', $4, $5)`,
      [id, `${id}@rsn-e2e.invalid`, name, status, role],
    );
    return id;
  }
  const emailOf = async (id: string) => (await run(`SELECT email FROM {s}.users WHERE id = $1`, [id])).rows[0].email as string;

  /** A circle as production holds them: the creator owner (T1's backfill) unless `ownerRow` is false (the Doctors shape). */
  async function circle(creator: string, opts: { members?: string[]; policy?: 'open' | 'closed'; ownerRow?: boolean; podIds?: string[] } = {}): Promise<string> {
    const id = randomUUID();
    const members = opts.members ?? [];
    const ownerRow = opts.ownerRow ?? true;
    await run(
      `INSERT INTO {s}.circles (id, name, created_by, member_count, join_policy) VALUES ($1, $2, $3, $4, $5)`,
      [id, `Circle ${id.slice(0, 6)}`, creator, members.length + (ownerRow ? 1 : 0), opts.policy ?? 'open'],
    );
    if (ownerRow) await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, creator]);
    for (const m of members) await run(`INSERT INTO {s}.circle_members (circle_id, user_id) VALUES ($1, $2)`, [id, m]);
    for (const p of opts.podIds ?? []) await run(`INSERT INTO {s}.circle_pods (circle_id, pod_id) VALUES ($1, $2)`, [id, p]);
    return id;
  }

  async function pod(director: string, visibility = 'public', status = 'active', members: string[] = []): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.pods (id, name, created_by, visibility, status) VALUES ($1, $2, $3, $4, $5)`, [id, `Pod ${visibility} ${id.slice(0, 4)}`, director, visibility, status]);
    await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [id, director]);
    for (const m of members) await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [id, m]);
    return id;
  }

  async function event(podId: string, host: string, title: string): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.sessions (id, pod_id, title, status, host_user_id, scheduled_at, config)
       VALUES ($1, $2, $3, 'scheduled', $4, NOW() + INTERVAL '2 days', '{}'::jsonb)`,
      [id, podId, title, host],
    );
    return id;
  }

  async function post(circleId: string, author: string, content = 'hello'): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.circle_posts (id, client_id, circle_id, author_id, content, media) VALUES ($1, $2, $3, $4, $5, '[]'::jsonb)`,
      [id, randomUUID(), circleId, author, content],
    );
    return id;
  }

  async function conversation(a: string, b: string): Promise<void> {
    const [x, y] = a < b ? [a, b] : [b, a];
    const id = randomUUID();
    await run(`INSERT INTO {s}.dm_conversations (id, user_a_id, user_b_id, last_message_at) VALUES ($1, $2, $3, NOW())`, [id, x, y]);
    await run(`INSERT INTO {s}.direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, 'hi')`, [id, b]);
  }

  const memberRows = async (circleId: string) =>
    (await run(`SELECT user_id FROM {s}.circle_members WHERE circle_id = $1`, [circleId])).rows.map((r) => r.user_id as string).sort();
  const storedCount = async (circleId: string) =>
    (await run(`SELECT member_count FROM {s}.circles WHERE id = $1`, [circleId])).rows[0].member_count as number;
  const requestRows = async (circleId: string) =>
    (await run(`SELECT user_id, status, decided_by FROM {s}.circle_join_requests WHERE circle_id = $1 ORDER BY created_at`, [circleId])).rows;
  const bells = async (userId: string) =>
    (await run(`SELECT type, title, link FROM {s}.notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('ACTIVE_MEMBER_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // The code casts to the invite enums by name; a domain over each in this schema resolves them to public's types.
    for (const type of ['invite_status', 'invite_type']) {
      await admin.query(`CREATE DOMAIN ${schema}.${type} AS public.${type}`);
    }
    // Migration 128 itself, inside this schema (its own tables resolve through the search path).
    await admin.query(`SET search_path = ${schema}`);
    await admin.query(MIGRATION_128);
    await admin.query(`SET search_path = public`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    circles = await import('../../../services/circle/circle.service');
    joins = await import('../../../services/circle/circle-join.service');
    wall = await import('../../../services/circle/circle-wall.service');
    pods = await import('../../../services/pod/pod.service');
    invites = await import('../../../services/invite/invite.service');
    candidates = await import('../../../services/invite/invite-candidates.service');
    sessions = await import('../../../services/session/session.service');
    sessionAccess = await import('../../../services/session/session-access');
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
    it('a circle made before 128 reads as open, with no asks, exactly as before for a member and a stranger', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const c = await circle(owner, { members: [member] });
      const forStranger = await circles.getCircleDetail(c, stranger, 'member');
      expect(forStranger).toMatchObject({ joinPolicy: 'open', myStatus: null, canManage: false, canInvite: false, locked: false });
      expect(forStranger.members.map((m) => m.userId).sort()).toEqual([owner, member].sort());
      expect(forStranger.requestCount).toBeUndefined();
      const forOwner = await circles.getCircleDetail(c, owner, 'member');
      expect(forOwner).toMatchObject({ myStatus: 'member', canManage: true, canInvite: true, requestCount: 0, locked: false });
      const forMember = (await circles.listCircles(member, 'member')).find((x) => x.id === c)!;
      expect(forMember).toMatchObject({ isMember: true, joinPolicy: 'open', myStatus: 'member', canManage: false, canInvite: true, locked: false });
    }, 30_000);

    it('a creator who is not a member (the Doctors shape) still runs it, closed or open, and may invite', async () => {
      const creator = await person('Creator');
      const c = await circle(creator, { ownerRow: false, policy: 'closed' });
      expect(await circles.getCircleDetail(c, creator, 'member')).toMatchObject({ isMember: false, canManage: true, canInvite: true, locked: false, myStatus: null });
      await expect(invites.assertMayInviteToCircle(c, creator, false)).resolves.toMatchObject({ id: c });
      // Running it, they may join their own closed circle without asking.
      await circles.joinCircle(c, creator, { role: 'member' });
      expect(await memberRows(c)).toEqual([creator]);
    }, 30_000);

    it('an accepted circle invite still reads by its code', async () => {
      const owner = await person('Owner');
      const joiner = await person('Joiner');
      const c = await circle(owner, { members: [joiner] });
      const code = randomUUID().slice(0, 12);
      await run(
        `INSERT INTO {s}.invites (code, type, inviter_id, circle_id, invitee_email, status, max_uses, use_count, accepted_by_user_id, accepted_at)
         VALUES ($1, 'circle', $2, $3, $4, 'accepted', 1, 1, $5, NOW())`,
        [code, owner, c, await emailOf(joiner), joiner],
      );
      expect(await invites.getInviteByCode(code)).toMatchObject({ type: 'circle', circleId: c, status: 'accepted' });
    }, 30_000);
  });

  // ── A closed circle, from outside ────────────────────────────────────────────────────────────────────────

  describe('a closed circle hides its wall, members, pods and events from people outside it', () => {
    async function closedWorld() {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const p = await pod(owner, 'public');
      await event(p, owner, 'Closed circle event');
      const c = await circle(owner, { members: [member], policy: 'closed', podIds: [p] });
      const postId = await post(c, member, 'Inside words');
      return { owner, member, stranger, c, p, postId };
    }

    it('the page: locked, with no members, pods or events, but its name and counts', async () => {
      const w = await closedWorld();
      const seen = await circles.getCircleDetail(w.c, w.stranger, 'member');
      expect(seen).toMatchObject({ locked: true, joinPolicy: 'closed', canInvite: false, canManage: false, memberCount: 2, podCount: 1 });
      expect(seen.members).toEqual([]);
      expect(seen.pods).toEqual([]);
      expect(seen.upcomingEvents).toEqual([]);
      const inside = await circles.getCircleDetail(w.c, w.member, 'member');
      expect(inside.locked).toBe(false);
      expect(inside.members).toHaveLength(2);
      expect(inside.pods.map((x) => x.podId)).toEqual([w.p]);
      expect(inside.upcomingEvents.map((e) => e.title)).toEqual(['Closed circle event']);
      // A platform admin outside it runs it, so it is not locked for them.
      const platform = await person('Platform', 'active', 'admin');
      expect((await circles.getCircleDetail(w.c, platform, 'admin')).locked).toBe(false);
    }, 30_000);

    it('the wall\'s feed refuses (403), and a member reads it', async () => {
      const w = await closedWorld();
      await expect(wall.listPosts(w.c, w.stranger, {}, 'member')).rejects.toMatchObject({ statusCode: 403, code: 'CIRCLE_CLOSED' });
      expect((await wall.listPosts(w.c, w.member, {}, 'member')).posts.map((p) => p.id)).toEqual([w.postId]);
    }, 30_000);

    it('one post (the deep link) refuses (403)', async () => {
      const w = await closedWorld();
      await expect(wall.getPost(w.postId, w.stranger, 'member')).rejects.toMatchObject({ statusCode: 403 });
      expect(await wall.getPost(w.postId, w.member, 'member')).toMatchObject({ id: w.postId });
    }, 30_000);

    it('a post\'s comments refuse (403)', async () => {
      const w = await closedWorld();
      await expect(wall.listComments(w.postId, w.stranger, 'member')).rejects.toMatchObject({ statusCode: 403 });
      await expect(wall.listComments(w.postId, w.member, 'member')).resolves.toEqual([]);
    }, 30_000);

    it('sharing refuses both out of it (even for a member) and into it (for someone outside)', async () => {
      const w = await closedWorld();
      const open = await circle(w.owner, { members: [w.member, w.stranger] });
      await expect(wall.sharePost(w.postId, w.member, { circleId: open, clientId: randomUUID() }))
        .rejects.toMatchObject({ statusCode: 403 });
      const openPost = await post(open, w.owner, 'Open words');
      await expect(wall.sharePost(openPost, w.stranger, { circleId: w.c, clientId: randomUUID() }))
        .rejects.toMatchObject({ statusCode: 403 });
    }, 30_000);

    it('a share made before the circle closed no longer carries its words to people outside it', async () => {
      const w = await closedWorld();
      const open = await circle(w.owner, { members: [w.member, w.stranger] });
      await run(`UPDATE {s}.circles SET join_policy = 'open' WHERE id = $1`, [w.c]);
      const shared = await wall.sharePost(w.postId, w.member, { circleId: open, clientId: randomUUID() });
      expect(shared.sharedFrom).toMatchObject({ content: 'Inside words' });
      await run(`UPDATE {s}.circles SET join_policy = 'closed' WHERE id = $1`, [w.c]);
      expect((await wall.getPost(shared.id, w.stranger, 'member'))!.sharedFrom).toBeNull();
      expect((await wall.getPost(shared.id, w.member, 'member'))!.sharedFrom).toMatchObject({ content: 'Inside words' });
    }, 30_000);

    it('an open circle\'s wall is read by anyone signed in, as before', async () => {
      const owner = await person('Owner');
      const stranger = await person('Stranger');
      const c = await circle(owner);
      const postId = await post(c, owner);
      expect((await wall.listPosts(c, stranger, {}, 'member')).posts).toHaveLength(1);
      expect(await wall.getPost(postId, stranger, 'member')).toMatchObject({ id: postId });
      await expect(wall.listComments(postId, stranger, 'member')).resolves.toEqual([]);
    }, 30_000);
  });

  // ── Asking, approving, declining ────────────────────────────────────────────────────────────────────────

  describe('asking to join a closed circle', () => {
    it('join is refused in words; an ask waits once, rings the people who run it, and they see it', async () => {
      const owner = await person('Owner');
      const moderator = await person('Moderator');
      const asker = await person('Asker');
      const c = await circle(owner, { policy: 'closed' });
      await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, 'moderator')`, [c, moderator]);

      await expect(circles.joinCircle(c, asker, { role: 'member' })).rejects.toMatchObject({
        statusCode: 403, code: 'CIRCLE_CLOSED', message: 'This circle is closed. Ask to join and its owner will let you in.',
      });
      expect(await joins.requestToJoinCircle(c, asker, 'member')).toMatchObject({ status: 'requested', created: true });
      expect(await joins.requestToJoinCircle(c, asker, 'member')).toMatchObject({ status: 'requested', created: false });
      expect(await requestRows(c)).toEqual([{ user_id: asker, status: 'pending', decided_by: null }]);
      expect(await memberRows(c)).toEqual([owner, moderator].sort());

      for (const manager of [owner, moderator]) {
        expect(await bells(manager)).toEqual([{ type: 'join_request', title: `Asker wants to join Circle ${c.slice(0, 6)}`, link: `/circles/${c}?requests=1` }]);
      }
      expect(await bells(asker)).toEqual([]);

      expect(await circles.getCircleDetail(c, asker, 'member')).toMatchObject({ myStatus: 'requested', locked: true });
      expect((await circles.getCircleDetail(c, owner, 'member')).requestCount).toBe(1);
      expect((await joins.listJoinRequests(c, { userId: moderator, role: 'member' })).map((r) => r.userId)).toEqual([asker]);
      await expect(joins.listJoinRequests(c, { userId: asker, role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
    }, 30_000);

    it('an open circle: asking simply joins', async () => {
      const owner = await person('Owner');
      const asker = await person('Asker');
      const c = await circle(owner);
      expect(await joins.requestToJoinCircle(c, asker, 'member')).toMatchObject({ status: 'member' });
      expect(await memberRows(c)).toEqual([owner, asker].sort());
      expect(await requestRows(c)).toEqual([]);
    }, 30_000);

    it('approving joins them with the stored count moved, once, and rings "You\'re in"; a second approve is a 404', async () => {
      const owner = await person('Owner');
      const asker = await person('Asker');
      const c = await circle(owner, { policy: 'closed' });
      await joins.requestToJoinCircle(c, asker, 'member');
      const [first, second] = await Promise.allSettled([
        joins.approveJoinRequest(c, asker, { userId: owner, role: 'member' }),
        joins.approveJoinRequest(c, asker, { userId: owner, role: 'member' }),
      ]);
      expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
      const refused = (first.status === 'rejected' ? first : second) as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ statusCode: 404, message: 'This request has already been answered.' });
      expect(await memberRows(c)).toEqual([owner, asker].sort());
      expect(await storedCount(c)).toBe(2);
      expect(await requestRows(c)).toEqual([{ user_id: asker, status: 'approved', decided_by: owner }]);
      expect(await bells(asker)).toEqual([{ type: 'approval', title: `You're in Circle ${c.slice(0, 6)}`, link: `/circles/${c}` }]);
      const now = await circles.getCircleDetail(c, asker, 'member');
      expect(now).toMatchObject({ myStatus: 'member', locked: false });
      expect(now.members).toHaveLength(2);
    }, 30_000);

    it('declining leaves them out and says declined; they may ask again; cancelling withdraws an ask', async () => {
      const owner = await person('Owner');
      const asker = await person('Asker');
      const c = await circle(owner, { policy: 'closed' });
      await joins.requestToJoinCircle(c, asker, 'member');
      await joins.declineJoinRequest(c, asker, { userId: owner, role: 'member' });
      expect(await memberRows(c)).toEqual([owner]);
      expect((await circles.getCircleDetail(c, asker, 'member')).myStatus).toBe('declined');
      await expect(joins.declineJoinRequest(c, asker, { userId: owner, role: 'member' })).rejects.toMatchObject({ statusCode: 404 });
      expect(await joins.requestToJoinCircle(c, asker, 'member')).toMatchObject({ status: 'requested', created: true });
      expect(await joins.cancelJoinRequest(c, asker)).toEqual({ cancelled: true });
      expect(await joins.cancelJoinRequest(c, asker)).toEqual({ cancelled: false });
      expect((await circles.getCircleDetail(c, asker, 'member')).myStatus).toBeNull();
    }, 30_000);

    it('only the people who run it approve or decline', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const asker = await person('Asker');
      const c = await circle(owner, { members: [member], policy: 'closed' });
      await joins.requestToJoinCircle(c, asker, 'member');
      await expect(joins.approveJoinRequest(c, asker, { userId: member, role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
      await expect(joins.declineJoinRequest(c, asker, { userId: asker, role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
      const platform = await person('Platform', 'active', 'admin');
      await joins.approveJoinRequest(c, asker, { userId: platform, role: 'admin' });
      expect(await memberRows(c)).toContain(asker);
    }, 30_000);

    it('a requester whose account was closed is not shown or counted, and cannot be approved', async () => {
      const owner = await person('Owner');
      const asker = await person('Asker');
      const c = await circle(owner, { policy: 'closed' });
      await joins.requestToJoinCircle(c, asker, 'member');
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [asker]);
      expect(await joins.listJoinRequests(c, { userId: owner, role: 'member' })).toEqual([]);
      expect((await circles.getCircleDetail(c, owner, 'member')).requestCount).toBe(0);
      await expect(joins.approveJoinRequest(c, asker, { userId: owner, role: 'member' })).rejects.toMatchObject({ statusCode: 404 });
    }, 30_000);

    it('reopening the circle lets everyone waiting in, rings each of them, and leaves the members as they were', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const a = await person('A');
      const b = await person('B');
      const c = await circle(owner, { members: [member], policy: 'closed' });
      await joins.requestToJoinCircle(c, a, 'member');
      await joins.requestToJoinCircle(c, b, 'member');
      const changed = await circles.updateCircle(c, { joinPolicy: 'open' }, { userId: owner, role: 'member' });
      expect(changed.approvedUserIds.sort()).toEqual([a, b].sort());
      expect(await memberRows(c)).toEqual([owner, member, a, b].sort());
      expect(await storedCount(c)).toBe(4);
      expect((await requestRows(c)).map((r) => r.status)).toEqual(['approved', 'approved']);
      // The route rings each of them with the circle's name (routes/circles.ts); here the ringing itself.
      await joins.ringApproved(c, `Circle ${c.slice(0, 6)}`, changed.approvedUserIds);
      expect(await bells(a)).toEqual([{ type: 'approval', title: `You're in Circle ${c.slice(0, 6)}`, link: `/circles/${c}` }]);
      // Closing again changes nobody.
      expect((await circles.updateCircle(c, { joinPolicy: 'closed' }, { userId: owner, role: 'member' })).approvedUserIds).toEqual([]);
      expect(await memberRows(c)).toHaveLength(4);
    }, 30_000);

    it('an invite is the doorway: accepting one joins a closed circle and answers the pending ask', async () => {
      const owner = await person('Owner');
      const asker = await person('Asker');
      const c = await circle(owner, { policy: 'closed' });
      await joins.requestToJoinCircle(c, asker, 'member');
      await circles.joinCircle(c, asker, { invitedBy: owner });
      expect(await memberRows(c)).toEqual([owner, asker].sort());
      expect(await storedCount(c)).toBe(2);
      expect((await requestRows(c))[0]).toMatchObject({ status: 'approved' });
    }, 30_000);

    // Final fix wave S2 (2 Nov 2026): the open link a plain member made while the circle was open.
    it("a plain member's open link: it admits while the circle is open, closing withdraws it, and it admits no one after", async () => {
      const owner = await person('Owner');
      const member = await person('Plain Member');
      const first = await person('First');
      const later = await person('Later');
      const c = await circle(owner, { members: [member] });
      const link = await invites.createInvite(member, { type: 'circle', circleId: c, maxUses: 1000000 } as never, 'member');
      expect((await invites.acceptInvite(link.code, first, await emailOf(first))).registeredFor).toEqual({ circleId: c });
      const out = await circles.updateCircle(c, { joinPolicy: 'closed' }, { userId: owner, role: 'member' });
      expect(out.invitesChangedFor).toEqual([member]);
      expect((await run(`SELECT status FROM {s}.invites WHERE id = $1`, [link.id])).rows[0].status).toBe('revoked');
      await expect(invites.acceptInvite(link.code, later, await emailOf(later))).rejects.toMatchObject({ statusCode: expect.any(Number) });
      expect(await memberRows(c)).toEqual([owner, member, first].sort());
    }, 30_000);

    it("an invite whose maker no longer runs the closed circle is refused in words, even if it was never withdrawn", async () => {
      const owner = await person('Owner');
      const mod = await person('Moderator');
      const invitee = await person('Invitee');
      const c = await circle(owner, { policy: 'closed' });
      await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, 'moderator')`, [c, mod]);
      const invite = await invites.createInvite(mod, { type: 'circle', circleId: c, inviteeEmail: await emailOf(invitee) } as never, 'member');
      await run(`UPDATE {s}.circle_members SET role = 'member' WHERE circle_id = $1 AND user_id = $2`, [c, mod]);
      await expect(invites.acceptInvite(invite.code, invitee, await emailOf(invitee))).rejects.toMatchObject({
        statusCode: 403, code: 'CIRCLE_CLOSED',
        message: 'This circle is closed now, so this invite no longer lets you in. Ask to join and its owner will let you in.',
      });
      expect(await memberRows(c)).not.toContain(invitee);
    }, 30_000);

    it("closing keeps the invites of the people who run it (owner, moderator, platform admin), and the owner's open link still admits", async () => {
      const owner = await person('Owner');
      const mod = await person('Moderator');
      const platform = await person('Platform', 'active', 'admin');
      const guest = await person('Guest');
      const c = await circle(owner);
      await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, 'moderator')`, [c, mod]);
      const links = [];
      for (const maker of [owner, mod, platform]) {
        links.push(await invites.createInvite(maker, { type: 'circle', circleId: c, maxUses: 10 } as never, maker === platform ? 'admin' : 'member'));
      }
      const out = await circles.updateCircle(c, { joinPolicy: 'closed' }, { userId: owner, role: 'member' });
      expect(out.invitesChangedFor).toEqual([]);
      const statuses = (await run(`SELECT status FROM {s}.invites WHERE circle_id = $1`, [c])).rows.map((r) => r.status);
      expect(statuses).toEqual(['pending', 'pending', 'pending']);
      expect((await invites.acceptInvite(links[0].code, guest, await emailOf(guest))).registeredFor).toEqual({ circleId: c });
    }, 30_000);

    it('the people who run it may remove a member, never the owner; the count follows', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const c = await circle(owner, { members: [member] });
      await expect(joins.removeCircleMember(c, owner, { userId: owner, role: 'member' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(joins.removeCircleMember(c, owner, { userId: member, role: 'member' })).rejects.toMatchObject({ statusCode: 403 });
      await joins.removeCircleMember(c, member, { userId: owner, role: 'member' });
      expect(await memberRows(c)).toEqual([owner]);
      expect(await storedCount(c)).toBe(1);
      await expect(joins.removeCircleMember(c, member, { userId: owner, role: 'member' })).rejects.toMatchObject({ statusCode: 404 });
    }, 30_000);
  });

  // ── Invites through the sheet ───────────────────────────────────────────────────────────────────────────

  describe('the invite sheet, for a circle', () => {
    it('who may invite: an open circle, anyone in it; a closed circle, only the people who run it', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const open = await circle(owner, { members: [member] });
      const closed = await circle(owner, { members: [member], policy: 'closed' });
      await expect(invites.assertMayInviteToCircle(open, member, false)).resolves.toMatchObject({ id: open });
      await expect(invites.assertMayInviteToCircle(open, stranger, false)).rejects.toMatchObject({ statusCode: 403 });
      await expect(invites.assertMayInviteToCircle(closed, member, false)).rejects.toMatchObject({ statusCode: 403 });
      await expect(invites.assertMayInviteToCircle(closed, owner, false)).resolves.toMatchObject({ id: closed });
      await expect(invites.assertMayInviteToCircle(closed, stranger, true)).resolves.toMatchObject({ id: closed });
      await run(`UPDATE {s}.circles SET archived_at = NOW() WHERE id = $1`, [open]);
      await expect(invites.assertMayInviteToCircle(open, owner, true)).rejects.toMatchObject({ statusCode: 404 });
    }, 30_000);

    it('lists connections with where they stand; closed and blocked people are not offered', async () => {
      const owner = await person('Owner');
      const inCircle = await person('Already In');
      const free = await person('Free');
      const closedAccount = await person('Closed Account');
      const blocked = await person('Blocked');
      for (const other of [inCircle, free, closedAccount, blocked]) await conversation(owner, other);
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [closedAccount]);
      await run(`INSERT INTO {s}.user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [blocked, owner]);
      const c = await circle(owner, { members: [inCircle] });
      const page = await candidates.listInviteCandidates({ userId: owner, role: 'member' }, { circleId: c, source: 'connections', before: null, limit: 30 });
      const states = Object.fromEntries(page.items.map((i) => [i.userId, i.state]));
      expect(states).toEqual({ [inCircle]: 'member', [free]: 'available' });
    }, 30_000);

    it('a batch invites, rings the invitee, lasts a week, and accepting joins the closed circle', async () => {
      const owner = await person('Owner');
      const invitee = await person('Invitee');
      await conversation(owner, invitee);
      const c = await circle(owner, { policy: 'closed' });
      const batch = await candidates.createInvitesBatch({ userId: owner, role: 'member' }, { type: 'circle', circleId: c, inviteeUserIds: [invitee] }, { emailGapMs: 0 });
      await batch.delivery;
      expect(batch.results).toEqual([{ userId: invitee, outcome: 'invited', inviteId: expect.any(String) }]);
      expect(batch.target).toMatchObject({ circleId: c });
      const row = (await run(`SELECT code, type, circle_id, expires_at FROM {s}.invites WHERE invitee_email = $1`, [await emailOf(invitee)])).rows[0];
      expect(row).toMatchObject({ type: 'circle', circle_id: c });
      const hours = (new Date(row.expires_at).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(167);
      expect(hours).toBeLessThan(169);
      expect((await bells(invitee)).map((b) => b.type)).toEqual(['circle_invite']);
      // The same person again: already invited, never twice.
      const again = await candidates.createInvitesBatch({ userId: owner, role: 'member' }, { type: 'circle', circleId: c, inviteeUserIds: [invitee] }, { emailGapMs: 0 });
      expect(again.results[0].outcome).toBe('already_invited');
      const accepted = await invites.acceptInvite(row.code, invitee, await emailOf(invitee));
      expect(accepted.registeredFor).toEqual({ circleId: c });
      expect(await memberRows(c)).toEqual([owner, invitee].sort());
      // Now in it, they read as a member and are not offered again.
      const listed = await candidates.listInviteCandidates({ userId: owner, role: 'member' }, { circleId: c, source: 'connections', before: null, limit: 30 });
      expect(listed.items.find((i) => i.userId === invitee)?.state).toBe('member');
    }, 30_000);

    it('a member of a closed circle may not list or invite from the sheet', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const c = await circle(owner, { members: [member], policy: 'closed' });
      await expect(candidates.listInviteCandidates({ userId: member, role: 'member' }, { circleId: c, source: 'connections', before: null, limit: 30 }))
        .rejects.toMatchObject({ statusCode: 403 });
      await expect(candidates.createInvitesBatch({ userId: member, role: 'member' }, { type: 'circle', circleId: c, inviteeUserIds: [owner] }))
        .rejects.toMatchObject({ statusCode: 403 });
    }, 30_000);

    it('received invites name the circle and leave out archived circles and circles the person is already in', async () => {
      const owner = await person('Owner');
      const invitee = await person('Invitee');
      const email = await emailOf(invitee);
      const named = await circle(owner);
      const archived = await circle(owner);
      const alreadyIn = await circle(owner, { members: [invitee] });
      for (const c of [named, archived, alreadyIn]) {
        await run(`INSERT INTO {s}.invites (code, type, inviter_id, circle_id, invitee_email, status, max_uses) VALUES ($1, 'circle', $2, $3, $4, 'pending', 1)`,
          [randomUUID().slice(0, 12), owner, c, email]);
      }
      await run(`UPDATE {s}.circles SET archived_at = NOW() WHERE id = $1`, [archived]);
      const received = await invites.listReceivedInvites(email, invitee);
      expect(received.map((i) => (i as { circleId?: string }).circleId)).toEqual([named]);
      expect(received[0]).toMatchObject({ circleName: `Circle ${named.slice(0, 6)}` });
    }, 30_000);
  });

  // ── Pods on the circle's page ───────────────────────────────────────────────────────────────────────────

  describe('pods and the circle', () => {
    it('archived pods are never listed, and a private pod only to its members (admins see it)', async () => {
      const owner = await person('Owner');
      const inPrivate = await person('In Private');
      const outsider = await person('Outsider');
      const open = await pod(owner, 'public');
      const privatePod = await pod(owner, 'private', 'active', [inPrivate]);
      const archivedPod = await pod(owner, 'public', 'archived');
      const c = await circle(owner, { members: [inPrivate, outsider], podIds: [open, privatePod, archivedPod] });
      expect((await circles.getCircleDetail(c, outsider, 'member')).pods.map((p) => p.podId)).toEqual([open]);
      expect((await circles.getCircleDetail(c, inPrivate, 'member')).pods.map((p) => p.podId).sort()).toEqual([open, privatePod].sort());
      const platform = await person('Platform', 'active', 'admin');
      expect((await circles.getCircleDetail(c, platform, 'admin')).pods.map((p) => p.podId).sort()).toEqual([open, privatePod].sort());
      expect((await circles.listCircles(outsider, 'member')).find((x) => x.id === c)!.podCount).toBe(1);
    }, 30_000);

    it('a pod made from the circle is the pod, its director and the link in one transaction', async () => {
      const owner = await person('Owner');
      const c = await circle(owner);
      const made = await pods.createPod(owner, { name: 'Made here', circleId: c });
      expect((await run(`SELECT pod_id FROM {s}.circle_pods WHERE circle_id = $1`, [c])).rows.map((r) => r.pod_id)).toEqual([made.id]);
      expect((await run(`SELECT role FROM {s}.pod_members WHERE pod_id = $1`, [made.id])).rows).toEqual([{ role: 'director' }]);
    }, 30_000);

    it('a circle archived in between: nothing is left behind, no pod and no director row', async () => {
      const owner = await person('Owner');
      const c = await circle(owner);
      await run(`UPDATE {s}.circles SET archived_at = NOW() WHERE id = $1`, [c]);
      await expect(pods.createPod(owner, { name: 'Orphan?', circleId: c })).rejects.toMatchObject({ statusCode: 404 });
      expect((await run(`SELECT count(*)::int AS n FROM {s}.pods WHERE created_by = $1`, [owner])).rows[0].n).toBe(0);
      expect((await run(`SELECT count(*)::int AS n FROM {s}.pod_members WHERE user_id = $1`, [owner])).rows[0].n).toBe(0);
    }, 30_000);

    it('a pod made with no circle is made as before', async () => {
      const owner = await person('Owner');
      const made = await pods.createPod(owner, { name: 'Plain' });
      expect((await run(`SELECT count(*)::int AS n FROM {s}.circle_pods WHERE pod_id = $1`, [made.id])).rows[0].n).toBe(0);
      expect((await run(`SELECT role FROM {s}.pod_members WHERE pod_id = $1`, [made.id])).rows).toEqual([{ role: 'director' }]);
    }, 30_000);

    it('attach: a manager attaches pods they direct or host, an admin any; the picker lists exactly those, a page at a time', async () => {
      const owner = await person('Owner');
      const other = await person('Other');
      const mine = await pod(owner, 'public');
      const hosted = await pod(other, 'public');
      await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'host', 'active')`, [hosted, owner]);
      const notMine = await pod(other, 'public');
      const archivedMine = await pod(owner, 'public', 'archived');
      const c = await circle(owner);
      const listed = await joins.listAttachablePods(c, { userId: owner, role: 'member' }, { page: 1, pageSize: 1 });
      expect(listed.items).toHaveLength(1);
      expect(listed.nextPage).toBe(2);
      const all = await joins.listAttachablePods(c, { userId: owner, role: 'member' }, { page: 1, pageSize: 50 });
      expect(all.items.map((p) => p.podId).sort()).toEqual([mine, hosted].sort());
      expect(all.nextPage).toBeNull();
      expect(all.items.map((p) => p.podId)).not.toContain(archivedMine);

      await circles.attachPod(c, mine, owner, false);
      await expect(circles.attachPod(c, notMine, owner, false)).rejects.toMatchObject({ statusCode: 403 });
      const platform = await person('Platform', 'active', 'admin');
      await circles.attachPod(c, notMine, platform, true);
      const after = await joins.listAttachablePods(c, { userId: owner, role: 'member' }, { page: 1, pageSize: 50 });
      expect(after.items.map((p) => p.podId)).toEqual([hosted]);
      const searched = await joins.listAttachablePods(c, { userId: platform, role: 'admin' }, { q: hosted.slice(0, 4), page: 1, pageSize: 50 });
      expect(searched.items.map((p) => p.podId)).toContain(hosted);
      await expect(joins.listAttachablePods(c, { userId: other, role: 'member' }, { page: 1, pageSize: 50 })).rejects.toMatchObject({ statusCode: 403 });
    }, 30_000);
  });
  // ── A closed circle's own events (T14 after T13's R10m; L22) ───────────────────────────────────────────────

  describe('an event for a closed circle is hidden from people outside the circle, whatever its own visibility', () => {
    async function circleEvent(circleId: string, podId: string, host: string, visibility: string): Promise<string> {
      const id = randomUUID();
      await run(
        `INSERT INTO {s}.sessions (id, pod_id, circle_id, visibility, title, status, host_user_id, scheduled_at, config)
         VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, NOW() + INTERVAL '2 days', '{}'::jsonb)`,
        [id, podId, circleId, visibility, `Circle evening ${visibility}`, host],
      );
      return id;
    }
    const sees = (e: string, u: string, role = 'member') => sessionAccess.canViewSession(u, e, role as never);
    const lists = async (e: string, u: string) => (await sessions.listSessions({ userId: u })).sessions.some((x) => x.id === e);
    const listedToNobody = async (e: string) => (await sessions.listSessions({})).sessions.some((x) => x.id === e);
    async function registers(e: string, u: string): Promise<string> {
      try { await sessions.registerParticipant(e, u, 'member' as never); return 'ok'; } catch (err) { return (err as { code?: string }).code ?? 'THREW'; }
    }

    async function world(visibility = 'public') {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const podMember = await person('Pod Member');
      const p = await pod(owner, 'private', 'active', [podMember]);
      const c = await circle(owner, { members: [member], policy: 'closed' });
      const e = await circleEvent(c, p, owner, visibility);
      return { owner, member, stranger, podMember, p, c, e };
    }

    it('a PUBLIC event of a closed circle: a stranger neither sees, lists nor registers; the logged-out list leaves it out', async () => {
      const w = await world('public');
      expect(await sees(w.e, w.stranger)).toBe(false);
      expect(await lists(w.e, w.stranger)).toBe(false);
      expect(await listedToNobody(w.e)).toBe(false);
      expect(await registers(w.e, w.stranger)).toBe('EVENT_PRIVATE');
    }, 30_000);

    it.each(['public_with_approval', 'private'])('a %s event of a closed circle is hidden from a stranger too', async (visibility) => {
      const w = await world(visibility);
      expect(await sees(w.e, w.stranger)).toBe(false);
      expect(await lists(w.e, w.stranger)).toBe(false);
      expect(await registers(w.e, w.stranger)).toBe('EVENT_PRIVATE');
    }, 30_000);

    it('the circle\'s members see, list and register; the owner, the pod\'s own members and admins see it', async () => {
      const w = await world('public');
      expect(await sees(w.e, w.member)).toBe(true);
      expect(await lists(w.e, w.member)).toBe(true);
      expect(await registers(w.e, w.member)).toBe('ok');
      expect(await sees(w.e, w.owner)).toBe(true);
      expect(await sees(w.e, w.podMember)).toBe(true);
      expect(await lists(w.e, w.podMember)).toBe(true);
      const platform = await person('Platform', 'active', 'admin');
      expect(await sees(w.e, platform, 'admin')).toBe(true);
      expect((await circles.getCircleDetail(w.c, w.member, 'member')).upcomingEvents.map((x) => x.id)).toEqual([w.e]);
      expect((await circles.getCircleDetail(w.c, w.stranger, 'member')).upcomingEvents).toEqual([]);
    }, 30_000);

    it('someone invited, or already holding a place, keeps it', async () => {
      const w = await world('public');
      await run(`INSERT INTO {s}.invites (code, type, inviter_id, session_id, invitee_email, status, max_uses) VALUES ($1, 'session', $2, $3, $4, 'pending', 1)`,
        [randomUUID().slice(0, 12), w.owner, w.e, await emailOf(w.stranger)]);
      expect(await sees(w.e, w.stranger)).toBe(true);
      expect(await registers(w.e, w.stranger)).toBe('ok');
      expect(await lists(w.e, w.stranger)).toBe(true);
    }, 30_000);

    it('reopening the circle shows the public event to everyone again; an approved ask lets the asker see it', async () => {
      const w = await world('public');
      await joins.requestToJoinCircle(w.c, w.stranger, 'member');
      expect(await sees(w.e, w.stranger)).toBe(false);
      await joins.approveJoinRequest(w.c, w.stranger, { userId: w.owner, role: 'member' });
      expect(await sees(w.e, w.stranger)).toBe(true);
      const other = await person('Other');
      expect(await sees(w.e, other)).toBe(false);
      await circles.updateCircle(w.c, { joinPolicy: 'open' }, { userId: w.owner, role: 'member' });
      expect(await sees(w.e, other)).toBe(true);
      expect(await listedToNobody(w.e)).toBe(true);
    }, 30_000);

    it('T13\'s circle bells and audience read members only: an ask that waits is never rung', async () => {
      const w = await world('public');
      const asker = await person('Asker');
      await joins.requestToJoinCircle(w.c, asker, 'member');
      const { announceCircleEvent } = await import('../../../services/circle/circle-events.service');
      await announceCircleEvent({ sessionId: w.e, actorId: w.owner, circle: { id: w.c, name: 'x' }, previousCircleId: null });
      const rung = (await run(`SELECT user_id FROM {s}.notifications WHERE type = 'event_invite' AND link = $1`, [`/sessions/${w.e}`])).rows.map((r) => r.user_id);
      expect(rung).toEqual([w.member]);
    }, 30_000);
  });
});
