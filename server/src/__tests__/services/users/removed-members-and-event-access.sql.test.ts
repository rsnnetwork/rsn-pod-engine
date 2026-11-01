// ─── Removed members vanish, and who sees and joins a pod's events (real Postgres, T2, 1 Nov 2026) ─────────────
//
// 30 Oct review: "Removing users doesn't work. Users that were removed still show up." Removing changes the account's
// status only; every list reached through a membership table kept the person. Each surface below is read through the
// real service on real tables, once with an active member and once after an admin removed, suspended or banned them:
// they are gone from the list, its count agrees with the list, their old words read "Former member", and a message
// to them is refused in words.
//
// The event access holes found on the way (audit 04): D1 an invite-only pod's events were listed to people who could
// not open them; D2 anyone with the id registered for an approval pod's event and so entered its live room; D3 the
// circle page named every attached pod's events, private ones included. Everything else about access stays as it was,
// shown by the matrix at the end.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) and dropped at the end:
// no row of the database is read or written. Opt-in, because it needs a local Postgres (it refuses anything else):
//
//   ACTIVE_MEMBER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/users/removed-members-and-event-access.sql.test.ts

import { randomUUID } from 'crypto';
import { Client } from 'pg';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.ACTIVE_MEMBER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

const TABLES = [
  'users', 'pods', 'pod_members', 'pod_posts', 'pod_post_reactions', 'pod_post_comments', 'pod_comment_likes',
  'sessions', 'session_participants', 'session_cohosts', 'invites',
  'circles', 'circle_members', 'circle_pods', 'circle_posts', 'circle_post_reactions', 'circle_post_comments', 'circle_comment_likes',
  'dm_conversations', 'direct_messages', 'dm_message_reactions', 'user_blocks', 'encounter_history', 'ratings',
];

suite('removed members vanish, and who sees and joins a pod\'s events (real Postgres)', () => {
  const schema = `zz_active_member_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let pods: typeof import('../../../services/pod/pod.service');
  let circles: typeof import('../../../services/circle/circle.service');
  let wall: typeof import('../../../services/circle/circle-wall.service');
  let podWall: typeof import('../../../services/pod/pod-wall.service');
  let sessions: typeof import('../../../services/session/session.service');
  let access: typeof import('../../../services/session/session-access');
  let dm: typeof import('../../../services/dm/dm.service');
  let identity: typeof import('../../../services/identity/identity.service');

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

  const setStatus = (id: string, status: string) => run(`UPDATE {s}.users SET status = $2 WHERE id = $1`, [id, status]);

  async function pod(visibility: string, director: string, members: string[] = []): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.pods (id, name, created_by, visibility) VALUES ($1, $2, $3, $4)`, [id, `Pod ${visibility}`, director, visibility]);
    await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [id, director]);
    for (const m of members) {
      await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [id, m]);
    }
    return id;
  }

  async function event(podId: string, host: string, title = 'An event'): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.sessions (id, pod_id, title, status, host_user_id, scheduled_at, config)
       VALUES ($1, $2, $3, 'scheduled', $4, NOW() + INTERVAL '2 days', '{}'::jsonb)`,
      [id, podId, title, host],
    );
    return id;
  }

  const register = (sessionId: string, userId: string, status = 'registered') =>
    run(`INSERT INTO {s}.session_participants (session_id, user_id, status) VALUES ($1, $2, $3)`, [sessionId, userId, status]);

  async function circle(members: string[], podIds: string[] = []): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.circles (id, name, created_by, member_count) VALUES ($1, $2, $3, $4)`, [id, `Circle ${id.slice(0, 6)}`, members[0], members.length]);
    for (const m of members) await run(`INSERT INTO {s}.circle_members (circle_id, user_id) VALUES ($1, $2)`, [id, m]);
    for (const p of podIds) await run(`INSERT INTO {s}.circle_pods (circle_id, pod_id) VALUES ($1, $2)`, [id, p]);
    return id;
  }

  async function invite(sessionId: string, inviter: string, email: string, status = 'pending', expiresIn = '7 days', declined = false): Promise<void> {
    await run(
      `INSERT INTO {s}.invites (code, type, inviter_id, session_id, invitee_email, status, max_uses, expires_at, declined_at)
       VALUES ($1, 'session', $2, $3, $4, $5, 1, NOW() + $6::interval, CASE WHEN $7 THEN NOW() END)`,
      [randomUUID().slice(0, 12), inviter, sessionId, email, status, expiresIn, declined],
    );
  }

  const emailOf = async (id: string) => (await run(`SELECT email FROM {s}.users WHERE id = $1`, [id])).rows[0].email as string;

  async function conversation(a: string, b: string, text: string): Promise<string> {
    const [x, y] = a < b ? [a, b] : [b, a];
    const id = randomUUID();
    await run(`INSERT INTO {s}.dm_conversations (id, user_a_id, user_b_id, last_message_at) VALUES ($1, $2, $3, NOW())`, [id, x, y]);
    await run(`INSERT INTO {s}.direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, $3)`, [id, b, text]);
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
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    pods = await import('../../../services/pod/pod.service');
    circles = await import('../../../services/circle/circle.service');
    wall = await import('../../../services/circle/circle-wall.service');
    podWall = await import('../../../services/pod/pod-wall.service');
    sessions = await import('../../../services/session/session.service');
    access = await import('../../../services/session/session-access');
    dm = await import('../../../services/dm/dm.service');
    identity = await import('../../../services/identity/identity.service');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  // ── Removed members vanish ─────────────────────────────────────────────────────────────────────────────────

  describe.each(['deactivated', 'suspended', 'banned'])('a member whose account is %s', (status) => {
    it('is gone from the pod\'s member list, and every count of the pod agrees with the list', async () => {
      const director = await person('Director');
      const stays = await person('Stays');
      const goes = await person('Goes');
      const p = await pod('private', director, [stays, goes]);
      expect((await pods.getPodMembers(p)).map((m) => m.userId).sort()).toEqual([director, stays, goes].sort());

      await setStatus(goes, status);
      const listed = (await pods.getPodMembers(p)).map((m) => m.userId);
      expect(listed.sort()).toEqual([director, stays].sort());
      expect((await pods.getPodById(p)).memberCount).toBe(listed.length);
      expect((await pods.listPods({ userId: director })).pods.find((x) => x.id === p)).toMatchObject({ memberCount: listed.length });
      expect((await pods.getMemberStatusCounts(p)).active).toBe(listed.length);
    }, 30_000);

    it('does not take a place in a full pod', async () => {
      const director = await person('Director');
      const goes = await person('Goes');
      const joiner = await person('Joiner');
      const p = await pod('public', director, [goes]);
      await run(`UPDATE {s}.pods SET max_members = 2 WHERE id = $1`, [p]);
      await setStatus(goes, status);
      await expect(pods.addMember(p, joiner)).resolves.toMatchObject({ userId: joiner, status: 'active' });
    }, 30_000);

    it('is gone from the circle\'s members and its member counts, and their wall posts read "Former member"', async () => {
      const stays = await person('Stays');
      const goes = await person('Goes');
      const c = await circle([stays, goes]);
      await run(
        `INSERT INTO {s}.circle_posts (client_id, circle_id, author_id, content, media) VALUES ($1, $2, $3, 'Hello circle', '[]'::jsonb)`,
        [randomUUID(), c, goes],
      );
      await setStatus(goes, status);

      const detail = await circles.getCircleDetail(c, stays);
      expect(detail.members.map((m) => m.userId)).toEqual([stays]);
      expect(detail.memberCount).toBe(1);
      expect((await circles.listCircles(stays)).find((x) => x.id === c)).toMatchObject({ memberCount: 1 });

      const feed = await wall.listPosts(c, stays);
      expect(feed.posts).toHaveLength(1);
      expect(feed.posts[0]).toMatchObject({ content: 'Hello circle', authorName: 'Former member', authorAvatarUrl: null, authorClosed: true });
    }, 30_000);

    it('reads "Former member" on a pod wall', async () => {
      const director = await person('Director');
      const goes = await person('Goes');
      const p = await pod('private', director, [goes]);
      await run(
        `INSERT INTO {s}.pod_posts (client_id, pod_id, author_id, content, media) VALUES ($1, $2, $3, 'Hello pod', '[]'::jsonb)`,
        [randomUUID(), p, goes],
      );
      await setStatus(goes, status);
      const feed = await podWall.listPosts(p, { userId: director, role: 'member' });
      expect(feed.posts[0]).toMatchObject({ content: 'Hello pod', authorName: 'Former member', authorAvatarUrl: null, authorClosed: true });
    }, 30_000);

    it('is gone from an event\'s participants, and the event\'s counts agree with the list', async () => {
      const host = await person('Host');
      const stays = await person('Stays');
      const goes = await person('Goes');
      const p = await pod('private', host, [stays, goes]);
      const e = await event(p, host);
      for (const id of [host, stays, goes]) await register(e, id);
      await setStatus(goes, status);

      const listed = (await sessions.getSessionParticipants(e)).map((x) => x.userId);
      expect(listed.sort()).toEqual([host, stays].sort());
      expect(await sessions.getParticipantCount(e)).toBe(2);
      const counts = await sessions.getParticipantStatusCounts(e);
      expect(counts.registered).toBe(2);
      expect(counts.total).toBe(2);
    }, 30_000);

    it('stays in the inbox as "Former member" with their old messages, and cannot be written to', async () => {
      const me = await person('Me');
      const goes = await person('Goes');
      const conv = await conversation(me, goes, 'An old message');
      await setStatus(goes, status);

      const inbox = await dm.listConversations(me);
      expect(inbox.total).toBe(1);
      expect(inbox.conversations[0]).toMatchObject({
        conversationId: conv, otherUserId: goes, otherDisplayName: 'Former member', otherAvatarUrl: null,
        otherJobTitle: null, otherCompany: null, otherBio: null, otherIsFormerMember: true, lastMessage: 'An old message',
      });
      const thread = await dm.listMessages(conv, me);
      expect(thread.messages.map((m) => m.content)).toEqual(['An old message']);

      expect(await dm.canMessage(me, goes)).toEqual({ allowed: false, reason: 'former_member' });
      await expect(dm.sendMessage(me, goes, 'Are you there?')).rejects.toMatchObject({
        statusCode: 403, message: 'This person is no longer a member of REASON, so they cannot get messages.',
      });
    }, 30_000);

    it('cannot be messaged even by an admin', async () => {
      const boss = await person('Admin', 'active', 'admin');
      const goes = await person('Goes', status);
      expect(await dm.canMessage(boss, goes)).toEqual({ allowed: false, reason: 'former_member' });
    }, 30_000);
  });

  it('an active member in the inbox is not marked a former member', async () => {
    const me = await person('Me');
    const friend = await person('Friend');
    await conversation(me, friend, 'Hi');
    expect((await dm.listConversations(me)).conversations[0]).toMatchObject({ otherDisplayName: 'Friend', otherIsFormerMember: false });
  }, 30_000);

  it('the admin users list counts every status, with the same search, and filters by the status it is asked for', async () => {
    const tag = `zq${Date.now()}`;
    const ids = {
      active: await person(`${tag} A`),
      suspended: await person(`${tag} S`, 'suspended'),
      deactivated: await person(`${tag} D`, 'deactivated'),
      banned: await person(`${tag} B`, 'banned'),
    };
    const all = await identity.getUsers({ search: tag, withStatusCounts: true });
    expect(all.total).toBe(4);
    expect(all.statusCounts).toEqual({ active: 1, suspended: 1, deactivated: 1, banned: 1 });
    for (const [status, id] of Object.entries(ids)) {
      const tab = await identity.getUsers({ search: tag, status: status as 'active', withStatusCounts: true });
      expect(tab.users.map((u) => u.id)).toEqual([id]);
      expect(tab.total).toBe(1);
      expect(tab.statusCounts).toEqual({ active: 1, suspended: 1, deactivated: 1, banned: 1 });
    }
  }, 30_000);

  // ── D1, D2, D3 and the matrix: who sees and joins a pod's events ──────────────────────────────────────────

  /** A director, the pod's member, a stranger, and an admin; one pod of the visibility and one upcoming event in it. */
  async function podWithEvent(visibility: string) {
    const director = await person('Director');
    const member = await person('Member');
    const stranger = await person('Stranger');
    const boss = await person('Admin', 'active', 'admin');
    const p = await pod(visibility, director, [member]);
    const e = await event(p, director, `Event of a ${visibility} pod`);
    return { director, member, stranger, boss, p, e };
  }

  const listedTo = async (userId: string, e: string, isAdmin = false) =>
    (await sessions.listSessions({ userId, isAdmin, pageSize: 100 })).sessions.some((s) => s.id === e);

  // Listing and opening agree for everyone: an event is listed exactly to the people who may open it.
  describe.each<[string, { stranger: boolean }]>([
    ['public', { stranger: true }],
    ['public_with_approval', { stranger: false }],
    ['invite_only', { stranger: false }],
    ['private', { stranger: false }],
  ])('an event of a %s pod', (visibility, expected) => {
    it('is listed exactly to the people who may open it (D1)', async () => {
      const { director, member, stranger, boss, e } = await podWithEvent(visibility);
      for (const [who, isAdmin, sees] of [
        [director, false, true], [member, false, true], [stranger, false, expected.stranger], [boss, true, true],
      ] as const) {
        expect(await listedTo(who, e, isAdmin)).toBe(sees);
        expect(await access.canViewSession(who, e, isAdmin ? 'admin' : 'member')).toBe(sees);
      }
    }, 30_000);

    it('is named on a circle page exactly to the people who may open it (D3)', async () => {
      const { director, member, stranger, boss, p, e } = await podWithEvent(visibility);
      const c = await circle([director, member, stranger], [p]);
      const named = async (who: string, role: string) => (await circles.getCircleDetail(c, who, role)).upcomingEvents.some((x) => x.id === e);
      expect(await named(director, 'member')).toBe(true);
      expect(await named(member, 'member')).toBe(true);
      expect(await named(stranger, 'member')).toBe(expected.stranger);
      expect(await named(boss, 'admin')).toBe(true);
    }, 30_000);
  });

  it('an invite-only pod\'s event is listed to a non-member who is registered for it or co-hosts it (they may open it)', async () => {
    const { director, stranger, e } = await podWithEvent('invite_only');
    expect(await listedTo(stranger, e)).toBe(false);
    await register(e, stranger);
    expect(await listedTo(stranger, e)).toBe(true);
    const cohost = await person('Cohost');
    await run(`INSERT INTO {s}.session_cohosts (session_id, user_id, granted_by) VALUES ($1, $2, $3)`, [e, cohost, director]);
    expect(await listedTo(cohost, e)).toBe(true);
  }, 30_000);

  describe('an event of a pod that asks for approval (D2)', () => {
    it('refuses a non-member without an invite, in words, and leaves no row', async () => {
      const { stranger, e } = await podWithEvent('public_with_approval');
      await expect(sessions.registerParticipant(e, stranger, 'member' as never)).rejects.toMatchObject({
        statusCode: 403, code: 'AUTH_FORBIDDEN',
        message: 'This event is for the pod\'s members. Ask to join the pod first, or ask the host for an invite.',
      });
      expect((await run(`SELECT 1 FROM {s}.session_participants WHERE session_id = $1 AND user_id = $2`, [e, stranger])).rows).toHaveLength(0);
      expect(await access.eventRoomAdmission(e, stranger, 'member')).toBe('refused');
    }, 30_000);

    it('still takes the pod\'s approved members, the host, a co-host, an admin and invitees', async () => {
      const { director, member, boss, e } = await podWithEvent('public_with_approval');
      await expect(sessions.registerParticipant(e, member, 'member' as never)).resolves.toMatchObject({ status: 'registered' });
      await expect(sessions.registerParticipant(e, director, 'member' as never)).resolves.toMatchObject({ status: 'registered' });
      await expect(sessions.registerParticipant(e, boss, 'admin' as never)).resolves.toMatchObject({ status: 'registered' });

      const cohost = await person('Cohost');
      await run(`INSERT INTO {s}.session_cohosts (session_id, user_id, granted_by) VALUES ($1, $2, $3)`, [e, cohost, director]);
      await expect(sessions.registerParticipant(e, cohost, 'member' as never)).resolves.toMatchObject({ status: 'registered' });

      const invited = await person('Invited');
      await invite(e, director, (await emailOf(invited)).toUpperCase());
      await expect(sessions.registerParticipant(e, invited, 'member' as never)).resolves.toMatchObject({ status: 'registered' });

      // A shared link (no address on it): the invite accept registers them first and records who used it after.
      const viaLink = await person('Via a link');
      await expect(sessions.registerParticipant(e, viaLink, undefined, { viaInvite: true })).resolves.toMatchObject({ status: 'registered' });
      await run(
        `INSERT INTO {s}.invites (code, type, inviter_id, session_id, status, max_uses, use_count, accepted_by_user_id)
         VALUES ($1, 'session', $2, $3, 'pending', 10, 1, $4)`,
        [randomUUID().slice(0, 12), director, e, viaLink],
      );

      for (const id of [member, director, cohost, invited, viaLink]) {
        expect(await access.eventRoomAdmission(e, id, 'member')).toBe('admitted');
      }
      expect(await access.eventRoomAdmission(e, boss, 'admin')).toBe('admitted');
    }, 30_000);

    it('a withdrawn, declined or expired invite does not count', async () => {
      const { director, e } = await podWithEvent('public_with_approval');
      const revoked = await person('Withdrawn');
      await invite(e, director, await emailOf(revoked), 'revoked');
      const declined = await person('Declined');
      await invite(e, director, await emailOf(declined), 'revoked', '7 days', true);
      const expired = await person('Expired');
      await invite(e, director, await emailOf(expired), 'pending', '-1 day');
      for (const id of [revoked, declined, expired]) {
        await expect(sessions.registerParticipant(e, id, 'member' as never)).rejects.toMatchObject({ statusCode: 403 });
      }
    }, 30_000);

    it('keeps a non-member who already holds a place out of the live room', async () => {
      const { stranger, e } = await podWithEvent('public_with_approval');
      await register(e, stranger);
      expect(await access.eventRoomAdmission(e, stranger, 'member')).toBe('refused');
    }, 30_000);
  });

  describe('everything else about registering stays as it was', () => {
    it('a public pod\'s event takes a stranger and makes them a pod member', async () => {
      const { stranger, p, e } = await podWithEvent('public');
      await expect(sessions.registerParticipant(e, stranger, 'member' as never)).resolves.toMatchObject({ status: 'registered' });
      expect((await run(`SELECT status FROM {s}.pod_members WHERE pod_id = $1 AND user_id = $2`, [p, stranger])).rows[0]).toEqual({ status: 'active' });
      expect(await access.eventRoomAdmission(e, stranger, 'member')).toBe('admitted');
    }, 30_000);

    it.each(['invite_only', 'private'])('a %s pod\'s event refuses a stranger with the same words as before', async (visibility) => {
      const { stranger, e } = await podWithEvent(visibility);
      await expect(sessions.registerParticipant(e, stranger, 'member' as never)).rejects.toMatchObject({
        statusCode: 403, message: 'You must be a pod member to register for sessions in a private pod',
      });
    }, 30_000);

    it.each(['public', 'public_with_approval', 'invite_only', 'private'])('a %s pod\'s event takes its members and admins', async (visibility) => {
      const { member, boss, e } = await podWithEvent(visibility);
      await expect(sessions.registerParticipant(e, member, 'member' as never)).resolves.toMatchObject({ status: 'registered' });
      await expect(sessions.registerParticipant(e, boss, 'admin' as never)).resolves.toMatchObject({ status: 'registered' });
    }, 30_000);

    it.each(['public', 'invite_only', 'private'])('a registered non-member of a %s pod\'s event is still let into its live room', async (visibility) => {
      const { stranger, e } = await podWithEvent(visibility);
      await register(e, stranger);
      expect(await access.eventRoomAdmission(e, stranger, 'member')).toBe('admitted');
    }, 30_000);
  });
});
