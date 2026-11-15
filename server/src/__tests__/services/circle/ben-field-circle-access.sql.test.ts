// ─── Ben field test, 13 Nov 2026: circles keep their restrictions, and a new circle is asked for (real Postgres) ───
//
// "Creating a Circle requires a request and approval." "Each Circle has its own admission policy: open, request to
// join, or invitation only. Private Circles must enforce their restrictions. Ben was briefly able to join an area that
// should have been controlled." Each rule is read through the real services on real tables:
//   * a new circle is closed from its first moment unless its maker chooses otherwise (on 13 Nov it was open for the
//     minute before its maker closed it, and Ben joined in that minute);
//   * invite only: nobody can ask, nobody can join by themselves, an invitation from someone who runs it lets a person
//     in, and outsiders see it locked;
//   * a pod in a closed or invite-only circle is not a side door: joining it, or asking to, needs the circle;
//   * a circle's event lives in one of the circle's own pods;
//   * asking for a circle: limits, the admins' bell, approval makes the circle with the asker as owner and their
//     choice of policy, once; decline tells them why; a member withdraws only their own waiting ask.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) with migrations 128 and
// 157 run inside it, and dropped at the end. Opt-in, because it needs a local Postgres (it refuses anything else):
//
//   ACTIVE_MEMBER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/circle/ben-field-circle-access.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  emitEntities: jest.fn(),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
}));
jest.mock('../../../index', () => ({ __esModule: true, io: { to: () => ({ emit: jest.fn() }) } }));
const mockSendGenericEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  ...jest.requireActual('../../../services/email/email.service'),
  sendGenericEmail: (...a: unknown[]) => mockSendGenericEmail(...a),
}));

const url = process.env.ACTIVE_MEMBER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

const TABLES = [
  'users', 'pods', 'pod_members', 'sessions', 'session_participants', 'session_cohosts', 'invites', 'notifications',
  'circles', 'circle_members', 'circle_pods', 'circle_posts', 'circle_post_reactions', 'circle_post_comments', 'circle_comment_likes',
  'circle_removals', 'audit_log', 'email_config', 'user_blocks', 'matching_templates', 'entities', 'circle_entities',
  'event_join_requests', 'event_admission_entries', 'event_admission_codes', 'event_waitlist', 'event_link_aliases',
  'event_link_counters', 'event_groups', 'event_participant_groups', 'event_matching_questions', 'event_question_answers',
  'event_matching_rules', 'user_entitlements', 'dm_conversations', 'direct_messages', 'user_pokes', 'encounter_history',
];
const MIGRATIONS = ['128_circle_join_policy.sql', '157_circle_requests_and_invite_only.sql']
  .map((f) => fs.readFileSync(path.join(__dirname, '../../../db/migrations', f), 'utf8'));

suite('Ben field test: circle access and circle requests (real Postgres)', () => {
  const schema = `zz_ben_circles_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let circles: typeof import('../../../services/circle/circle.service');
  let joins: typeof import('../../../services/circle/circle-join.service');
  let requests: typeof import('../../../services/circle/circle-request.service');
  let pods: typeof import('../../../services/pod/pod.service');
  let invites: typeof import('../../../services/invite/invite.service');
  let sessions: typeof import('../../../services/session/session.service');

  const run = (sql: string, params: unknown[] = []) => admin.query(sql.split('{s}').join(schema), params);

  async function person(name: string, opts: { role?: string; status?: string; kind?: string } = {}): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.users (id, email, display_name, first_name, last_name, status, role, account_kind)
       VALUES ($1, $2, $3, $3, 'Test', $4, $5, $6)`,
      [id, `${id}@rsn-e2e.invalid`, name, opts.status ?? 'active', opts.role ?? 'member', opts.kind ?? 'member'],
    );
    return id;
  }
  const emailOf = async (id: string) => (await run(`SELECT email FROM {s}.users WHERE id = $1`, [id])).rows[0].email as string;

  async function pod(director: string, visibility = 'public'): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.pods (id, name, created_by, visibility, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, `Pod ${id.slice(0, 6)}`, director, visibility]);
    await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [id, director]);
    return id;
  }
  const attach = (circleId: string, podId: string) =>
    run(`INSERT INTO {s}.circle_pods (circle_id, pod_id) VALUES ($1, $2)`, [circleId, podId]);
  const policyOf = async (circleId: string) =>
    (await run(`SELECT join_policy FROM {s}.circles WHERE id = $1`, [circleId])).rows[0].join_policy as string;
  const isMember = async (circleId: string, userId: string) =>
    (await run(`SELECT 1 FROM {s}.circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, userId])).rows.length > 0;
  const bells = async (userId: string) =>
    (await run(`SELECT type, title, body, link FROM {s}.notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
  const accessOf = async (circleId: string, viewer: string) =>
    (await circles.getCircleDetail(circleId, viewer, 'member' as never))!;

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('ACTIVE_MEMBER_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const type of ['invite_status', 'invite_type']) await admin.query(`CREATE DOMAIN ${schema}.${type} AS public.${type}`);
    await admin.query(`SET search_path = ${schema}`);
    for (const sql of MIGRATIONS) await admin.query(sql);
    await admin.query(`SET search_path = public`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    circles = await import('../../../services/circle/circle.service');
    joins = await import('../../../services/circle/circle-join.service');
    requests = await import('../../../services/circle/circle-request.service');
    pods = await import('../../../services/pod/pod.service');
    invites = await import('../../../services/invite/invite.service');
    sessions = await import('../../../services/session/session.service');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  // ── A new circle is never open by accident ─────────────────────────────────────────────────────────────────

  describe('a new circle', () => {
    it('made with no choice is closed from its first moment: a stranger cannot join, and asking waits', async () => {
      const platform = await person('Platform Admin', { role: 'admin' });
      const stranger = await person('Stranger');
      const { id } = await circles.createCircle(platform, { name: `Triibe ${randomUUID().slice(0, 6)}` });
      expect(await policyOf(id)).toBe('closed');
      await expect(circles.joinCircle(id, stranger)).rejects.toMatchObject({ statusCode: 403, code: 'CIRCLE_CLOSED' });
      expect(await joins.requestToJoinCircle(id, stranger)).toMatchObject({ status: 'requested' });
      expect(await isMember(id, stranger)).toBe(false);
    });

    it('keeps the policy its maker chose, written with the row', async () => {
      const platform = await person('Platform Admin', { role: 'admin' });
      const open = await circles.createCircle(platform, { name: `Open ${randomUUID().slice(0, 6)}`, joinPolicy: 'open' });
      const invite = await circles.createCircle(platform, { name: `Invite ${randomUUID().slice(0, 6)}`, joinPolicy: 'invite_only' });
      expect(await policyOf(open.id)).toBe('open');
      expect(await policyOf(invite.id)).toBe('invite_only');
    });

    it('the column default is closed too, for any insert that names no policy', async () => {
      const maker = await person('Maker');
      const r = await run(`INSERT INTO {s}.circles (name, created_by) VALUES ($1, $2) RETURNING join_policy`,
        [`Raw ${randomUUID().slice(0, 6)}`, maker]);
      expect(r.rows[0].join_policy).toBe('closed');
    });
  });

  // ── Invite only ────────────────────────────────────────────────────────────────────────────────────────────

  describe('an invite-only circle', () => {
    async function inviteOnly() {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const { id } = await circles.createCircle(owner, { name: `Invite ${randomUUID().slice(0, 6)}`, joinPolicy: 'invite_only' });
      await circles.joinCircle(id, member, { invitedBy: owner });
      return { id, owner, member, stranger };
    }

    it('nobody can ask: the ask is refused in words and no ask is stored', async () => {
      const { id, stranger } = await inviteOnly();
      await expect(joins.requestToJoinCircle(id, stranger)).rejects.toMatchObject({
        statusCode: 403, code: 'CIRCLE_CLOSED', message: circles.CIRCLE_INVITE_ONLY_JOIN,
      });
      expect((await run(`SELECT 1 FROM {s}.circle_join_requests WHERE circle_id = $1`, [id])).rows).toHaveLength(0);
    });

    it('nobody can join by themselves', async () => {
      const { id, stranger } = await inviteOnly();
      await expect(circles.joinCircle(id, stranger)).rejects.toMatchObject({
        statusCode: 403, message: circles.CIRCLE_INVITE_ONLY_JOIN,
      });
      expect(await isMember(id, stranger)).toBe(false);
    });

    it('an invitation from its owner lets a person in; a plain member may not invite', async () => {
      const { id, owner, member, stranger } = await inviteOnly();
      await expect(invites.assertMayInviteToCircle(id, member, false)).rejects.toMatchObject({ statusCode: 403 });
      const inv = await invites.createInvite(owner, { type: 'circle', circleId: id, inviteeEmail: await emailOf(stranger) } as never, 'member');
      expect((await invites.acceptInvite(inv.code, stranger, await emailOf(stranger))).registeredFor).toEqual({ circleId: id });
      expect(await isMember(id, stranger)).toBe(true);
    });

    it('outsiders see it locked: no members, pods or events; its members see it whole', async () => {
      const { id, member, stranger } = await inviteOnly();
      const outside = await accessOf(id, stranger);
      expect(outside).toMatchObject({ joinPolicy: 'invite_only', locked: true, canInvite: false });
      const inside = await accessOf(id, member);
      expect(inside).toMatchObject({ joinPolicy: 'invite_only', locked: false });
    });

    it('switching a closed circle to invite only withdraws a plain member\'s invites and keeps the asks waiting', async () => {
      const owner = await person('Owner');
      const plain = await person('Plain');
      const asker = await person('Asker');
      const { id } = await circles.createCircle(owner, { name: `Switch ${randomUUID().slice(0, 6)}`, joinPolicy: 'open' });
      await circles.joinCircle(id, plain);
      const link = await invites.createInvite(plain, { type: 'circle', circleId: id, maxUses: 10 } as never, 'member');
      await circles.updateCircle(id, { joinPolicy: 'closed' }, { userId: owner });
      await joins.requestToJoinCircle(id, asker);
      await circles.updateCircle(id, { joinPolicy: 'invite_only' }, { userId: owner });
      expect((await run(`SELECT status FROM {s}.invites WHERE id = $1`, [link.id])).rows[0].status).toBe('revoked');
      expect((await run(`SELECT status FROM {s}.circle_join_requests WHERE circle_id = $1`, [id])).rows[0].status).toBe('pending');
    });
  });

  // ── The pod side door ──────────────────────────────────────────────────────────────────────────────────────

  describe('a pod in a closed or invite-only circle', () => {
    async function closedWithPod(policy: 'closed' | 'invite_only' = 'closed', visibility = 'public') {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const { id } = await circles.createCircle(owner, { name: `Circle ${randomUUID().slice(0, 6)}`, joinPolicy: policy });
      await circles.joinCircle(id, member, { invitedBy: owner });
      const p = await pod(owner, visibility);
      await attach(id, p);
      return { id, owner, member, stranger, p };
    }
    const podMember = async (podId: string, userId: string) =>
      (await run(`SELECT status FROM {s}.pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, userId])).rows[0]?.status ?? null;

    it('a stranger cannot join its public pod, and is told to join the circle first', async () => {
      const { stranger, p } = await closedWithPod();
      await expect(pods.joinPod(p, stranger)).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/Ask to join .* first/) });
      await expect(pods.requestToJoin(p, stranger)).rejects.toMatchObject({ statusCode: 403 });
      expect(await podMember(p, stranger)).toBeNull();
    });

    it('a stranger cannot ask to join its approval pod either, so its organisers are never asked', async () => {
      const { owner, stranger, p } = await closedWithPod('closed', 'public_with_approval');
      await expect(pods.requestToJoin(p, stranger)).rejects.toMatchObject({ statusCode: 403 });
      expect(await podMember(p, stranger)).toBeNull();
      expect((await bells(owner)).filter((b) => b.type === 'join_request')).toHaveLength(0);
    });

    it('an invite-only circle says so', async () => {
      const { stranger, p } = await closedWithPod('invite_only');
      await expect(pods.joinPod(p, stranger)).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/by invitation only/) });
    });

    it('a member of the circle joins its public pod as before', async () => {
      const { member, p } = await closedWithPod();
      await pods.joinPod(p, member);
      expect(await podMember(p, member)).toBe('active');
    });

    it('an open circle\'s pod is unchanged: anyone joins its public pod', async () => {
      const owner = await person('Owner');
      const stranger = await person('Stranger');
      const { id } = await circles.createCircle(owner, { name: `Open ${randomUUID().slice(0, 6)}`, joinPolicy: 'open' });
      const p = await pod(owner);
      await attach(id, p);
      await pods.joinPod(p, stranger);
      expect(await podMember(p, stranger)).toBe('active');
    });

    it('a platform admin still joins', async () => {
      const { p } = await closedWithPod();
      const platform = await person('Platform Admin', { role: 'admin' });
      await pods.joinPod(p, platform, 'admin' as never);
      expect(await podMember(p, platform)).toBe('active');
    });
  });

  // ── A circle's event lives in one of its pods ──────────────────────────────────────────────────────────────

  describe('scheduling an event for a circle', () => {
    it('refuses a pod that is not one of the circle\'s, in words, and accepts one that is', async () => {
      const owner = await person('Owner');
      const { id } = await circles.createCircle(owner, { name: `Events ${randomUUID().slice(0, 6)}` });
      const inside = await pod(owner);
      const outside = await pod(owner);
      await attach(id, inside);
      await expect(sessions.createSession(owner, { podId: outside, title: 'Outside', circleId: id } as never, 'member' as never))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Choose one of .*'s pods/) });
      const made = await sessions.createSession(owner, { podId: inside, title: 'Inside', circleId: id } as never, 'member' as never);
      expect(made).toMatchObject({ podId: inside });
    });
  });

  // ── Asking for a new circle ────────────────────────────────────────────────────────────────────────────────

  describe('asking for a new circle', () => {
    const ask = (name: string, joinPolicy?: 'open' | 'closed' | 'invite_only') =>
      ({ name, purpose: 'The TRIIBE founder community, about 100 people.', description: 'Founders helping founders.', joinPolicy });

    it('a member asks: the ask waits, every active admin is rung once, and no circle exists yet', async () => {
      const asker = await person('Ben');
      const platform = await person('Platform Admin', { role: 'admin' });
      const name = `TRIIBE ${randomUUID().slice(0, 6)}`;
      const made = await requests.requestCircle(asker, ask(name, 'invite_only'));
      expect(made).toMatchObject({ name, status: 'pending', joinPolicy: 'invite_only', circleId: null });
      expect((await bells(platform)).filter((b) => b.type === 'circle_request')).toEqual([
        expect.objectContaining({ link: '/admin/circle-requests', body: expect.stringContaining(name) }),
      ]);
      expect((await run(`SELECT 1 FROM {s}.circles WHERE name = $1`, [name])).rows).toHaveLength(0);
      expect(await requests.listOwnRequests(asker)).toEqual([expect.objectContaining({ id: made.id })]);
    });

    it('refuses a guest account, a name a circle has, a second ask with the same name, and more than three waiting', async () => {
      const guest = await person('Guest', { kind: 'event_guest' });
      await expect(requests.requestCircle(guest, ask('Guest circle'))).rejects.toMatchObject({ statusCode: 403 });

      const platform = await person('Platform Admin', { role: 'admin' });
      const taken = `Taken ${randomUUID().slice(0, 6)}`;
      await circles.createCircle(platform, { name: taken });
      const asker = await person('Asker');
      await expect(requests.requestCircle(asker, ask(taken.toUpperCase()))).rejects.toMatchObject({ statusCode: 409 });

      await requests.requestCircle(asker, ask('One'));
      await expect(requests.requestCircle(asker, ask('one'))).rejects.toMatchObject({ statusCode: 409, message: requests.SAME_NAME_WAITING });
      await requests.requestCircle(asker, ask('Two'));
      await requests.requestCircle(asker, ask('Three'));
      await expect(requests.requestCircle(asker, ask('Four'))).rejects.toMatchObject({ statusCode: 409, message: requests.TOO_MANY_WAITING });
    });

    it('approval makes the circle once, with the asker as its owner and the policy they chose', async () => {
      const asker = await person('Ben');
      const platform = await person('Platform Admin', { role: 'admin' });
      const name = `TRIIBE ${randomUUID().slice(0, 6)}`;
      const made = await requests.requestCircle(asker, ask(name, 'invite_only'));
      expect((await requests.listPendingForReview()).some((r) => r.id === made.id && r.requester.userId === asker)).toBe(true);

      const { circleId } = await requests.approveRequest(platform, made.id);
      expect(await policyOf(circleId)).toBe('invite_only');
      const owners = (await run(`SELECT user_id, role FROM {s}.circle_members WHERE circle_id = $1`, [circleId])).rows;
      expect(owners).toEqual([{ user_id: asker, role: 'owner' }]);
      expect((await run(`SELECT status, circle_id, decided_by FROM {s}.circle_creation_requests WHERE id = $1`, [made.id])).rows[0])
        .toEqual({ status: 'approved', circle_id: circleId, decided_by: platform });
      expect((await bells(asker)).filter((b) => b.type === 'circle_request_answered')).toEqual([
        expect.objectContaining({ link: `/circles/${circleId}`, title: 'Your circle is live' }),
      ]);
      expect(mockSendGenericEmail).toHaveBeenCalledWith(await emailOf(asker), 'Ben', expect.objectContaining({ subject: 'Your circle is live' }));
      expect((await run(`SELECT action FROM {s}.audit_log WHERE entity_id = $1`, [made.id])).rows).toEqual([{ action: 'circle_request_approved' }]);

      await expect(requests.approveRequest(platform, made.id)).rejects.toMatchObject({ statusCode: 409, message: requests.ALREADY_ANSWERED });
      await expect(requests.declineRequest(platform, made.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await run(`SELECT count(*)::int AS n FROM {s}.circles WHERE name = $1`, [name])).rows[0].n).toBe(1);
    });

    it('an admin may rename on approval; a name taken since is refused in words and nothing is made', async () => {
      const asker = await person('Asker');
      const platform = await person('Platform Admin', { role: 'admin' });
      const name = `Clash ${randomUUID().slice(0, 6)}`;
      const made = await requests.requestCircle(asker, ask(name));
      await circles.createCircle(platform, { name });
      await expect(requests.approveRequest(platform, made.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await run(`SELECT status FROM {s}.circle_creation_requests WHERE id = $1`, [made.id])).rows[0].status).toBe('pending');
      const { circleId } = await requests.approveRequest(platform, made.id, { name: `${name} Founders` });
      expect((await run(`SELECT name, join_policy FROM {s}.circles WHERE id = $1`, [circleId])).rows[0])
        .toEqual({ name: `${name} Founders`, join_policy: 'closed' });
    });

    it('a decline tells the member why, and makes nothing', async () => {
      const asker = await person('Asker');
      const platform = await person('Platform Admin', { role: 'admin' });
      const made = await requests.requestCircle(asker, ask(`Nope ${randomUUID().slice(0, 6)}`));
      await requests.declineRequest(platform, made.id, { reason: 'Please join Founders instead.' });
      expect((await requests.listOwnRequests(asker))[0]).toMatchObject({ status: 'declined', declineReason: 'Please join Founders instead.' });
      expect((await bells(asker)).at(-1)).toMatchObject({ type: 'circle_request_answered', body: expect.stringContaining('Please join Founders instead.') });
    });

    it('a member withdraws only their own waiting ask; an answered one stays answered', async () => {
      const asker = await person('Asker');
      const other = await person('Other');
      const platform = await person('Platform Admin', { role: 'admin' });
      const made = await requests.requestCircle(asker, ask(`Mine ${randomUUID().slice(0, 6)}`));
      await expect(requests.cancelOwnRequest(other, made.id)).rejects.toMatchObject({ statusCode: 404 });
      await requests.cancelOwnRequest(asker, made.id);
      await expect(requests.cancelOwnRequest(asker, made.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(requests.approveRequest(platform, made.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('cannot approve for an account that has since been closed', async () => {
      const asker = await person('Asker');
      const platform = await person('Platform Admin', { role: 'admin' });
      const made = await requests.requestCircle(asker, ask(`Gone ${randomUUID().slice(0, 6)}`));
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [asker]);
      await expect(requests.approveRequest(platform, made.id)).rejects.toMatchObject({ statusCode: 409, message: requests.REQUESTER_GONE });
      expect((await requests.listPendingForReview()).some((r) => r.id === made.id)).toBe(false);
    });
  });
});
