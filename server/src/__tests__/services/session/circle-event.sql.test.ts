// ─── An event for a whole circle (real Postgres, T13, 1 Nov 2026; L20, L21) ─────────────────────────────
//
// A circle event still lives in its pod (sessions.pod_id) and names its circle (sessions.circle_id, migration 127).
// The circle's ACTIVE members are its audience on top of the pod's (event-access.ts's eventAudienceSql): they see
// it, register without joining the pod and are registered on opening it. Only a circle's managers (its creator,
// owner and moderators) and platform admins may name a circle, and the pod rule still holds. On create, each active
// member but the creator gets one event_invite bell; nobody gets an email. Every answer is read through the real
// entry points (createSession, updateSession, canViewSession, listSessions, registerParticipant, readEventAccessFacts,
// eventRoomAdmission, getCircleDetail) on real tables.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) plus migrations 125
// and 127 run inside it, and dropped at the end. Opt-in, because it needs a local Postgres (it refuses anything else):
//
//   ACTIVE_MEMBER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/session/circle-event.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { UserRole } from '@rsn/shared';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockEmail = jest.fn();
jest.mock('../../../services/email/email.service', () => new Proxy({}, {
  get: (_t, name) => (name === '__esModule' ? true : (...args: unknown[]) => { mockEmail(name, ...args); return Promise.resolve(); }),
}));

const url = process.env.ACTIVE_MEMBER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

const TABLES = [
  'users', 'pods', 'pod_members', 'sessions', 'session_participants', 'session_cohosts', 'invites',
  'circles', 'circle_members', 'circle_pods', 'notifications', 'matching_templates',
  // T14: a circle read asks the viewer's latest ask to join (migration 128).
  'circle_join_requests',
];

suite('an event for a whole circle (real Postgres)', () => {
  const schema = `zz_circle_event_${Date.now()}`;
  let admin: Client;
  let db: typeof import('../../../db');
  let sessions: typeof import('../../../services/session/session.service');
  let access: typeof import('../../../services/session/session-access');
  let eventAccess: typeof import('../../../services/session/event-access');
  let circles: typeof import('../../../services/circle/circle.service');

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

  async function pod(director: string, visibility = 'private', members: string[] = []): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.pods (id, name, created_by, visibility, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, `Pod ${id.slice(0, 6)}`, director, visibility]);
    await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [id, director]);
    for (const m of members) await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [id, m]);
    return id;
  }

  /** A circle made by `creator`, who holds an owner row unless `ownerRow` is false (the Doctors shape before 118). */
  async function circle(creator: string, members: Array<[string, string?]>, opts: { ownerRow?: boolean; archived?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.circles (id, name, created_by, member_count, archived_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, `Founders ${id.slice(0, 6)}`, creator, members.length, opts.archived ? new Date() : null],
    );
    if (opts.ownerRow !== false) await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, creator]);
    for (const [m, role] of members) {
      await run(`INSERT INTO {s}.circle_members (circle_id, user_id, role) VALUES ($1, $2, $3)`, [id, m, role ?? 'member']);
    }
    return id;
  }

  const circleName = async (id: string) => (await run(`SELECT name FROM {s}.circles WHERE id = $1`, [id])).rows[0].name as string;

  const body = (podId: string, extra: Record<string, unknown> = {}) => ({
    podId, title: 'Founders evening', scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    format: 'speed_networking' as const, config: { numberOfRounds: 3, roundDurationSeconds: 480, maxParticipants: 30 },
    ...extra,
  });

  async function outcome<T>(work: () => Promise<T>): Promise<'ok' | string> {
    try {
      await work();
      return 'ok';
    } catch (err) {
      return (err as { code?: string }).code ?? 'THREW';
    }
  }

  const sees = (sessionId: string, userId: string) => access.canViewSession(userId, sessionId, UserRole.MEMBER);
  const lists = async (sessionId: string, userId: string) =>
    (await sessions.listSessions({ userId })).sessions.some((s) => s.id === sessionId);
  const register = (sessionId: string, userId: string) => outcome(() => sessions.registerParticipant(sessionId, userId, UserRole.MEMBER));
  const inPod = async (podId: string, userId: string) =>
    (await run(`SELECT 1 FROM {s}.pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, userId])).rows.length > 0;
  const bells = async (sessionId: string) =>
    (await run(`SELECT user_id, type, title, link FROM {s}.notifications WHERE link = $1 ORDER BY user_id`, [`/sessions/${sessionId}`])).rows;
  const summary = async (sessionId: string, userId: string) => {
    const facts = await eventAccess.readEventAccessFacts(sessionId, userId);
    return facts ? eventAccess.summariseEventAccess(facts, UserRole.MEMBER) : null;
  };

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('ACTIVE_MEMBER_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await admin.query(`SET search_path TO ${schema}`);
    for (const file of ['125_event_visibility.sql', '127_circle_events.sql']) {
      await admin.query(fs.readFileSync(path.join(__dirname, '../../../db/migrations', file), 'utf8'));
    }
    await admin.query(`SET search_path TO public`);
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    sessions = await import('../../../services/session/session.service');
    access = await import('../../../services/session/session-access');
    eventAccess = await import('../../../services/session/event-access');
    circles = await import('../../../services/circle/circle.service');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  beforeEach(() => mockEmail.mockClear());

  describe('who may schedule one', () => {
    it('the circle\'s owner, in a pod they run: the event names the circle, is private by default, and the host holds a place', async () => {
      const owner = await person('Owner');
      const c = await circle(owner, []);
      const p = await pod(owner);
      const created = await sessions.createSession(owner, body(p, { circleId: c }), UserRole.MEMBER);
      expect(created).toMatchObject({ podId: p, circleId: c, visibility: 'private' });
      const row = (await run(`SELECT circle_id, visibility FROM {s}.sessions WHERE id = $1`, [created.id])).rows[0];
      expect(row).toEqual({ circle_id: c, visibility: 'private' });
      const host = (await run(`SELECT status FROM {s}.session_participants WHERE session_id = $1 AND user_id = $2`, [created.id, owner])).rows;
      expect(host).toEqual([{ status: 'registered' }]);
    });

    it('a visibility the manager chose wins over the default', async () => {
      const owner = await person('Owner');
      const c = await circle(owner, []);
      const p = await pod(owner);
      const created = await sessions.createSession(owner, body(p, { circleId: c, visibility: 'public' }), UserRole.MEMBER);
      expect(created).toMatchObject({ circleId: c, visibility: 'public' });
    });

    it('a moderator schedules; a platform admin schedules in any pod and any circle', async () => {
      const owner = await person('Owner');
      const mod = await person('Moderator');
      const adminUser = await person('Admin', 'active', 'admin');
      const c = await circle(owner, [[mod, 'moderator']]);
      const p = await pod(mod);
      expect(await outcome(() => sessions.createSession(mod, body(p, { circleId: c }), UserRole.MEMBER))).toBe('ok');
      expect(await outcome(() => sessions.createSession(adminUser, body(p, { circleId: c }), UserRole.ADMIN))).toBe('ok');
    });

    it('the Doctors shape: a creator with no member row in their circle still schedules for it', async () => {
      const creator = await person('Creator');
      const c = await circle(creator, [], { ownerRow: false });
      const p = await pod(creator);
      expect(await outcome(() => sessions.createSession(creator, body(p, { circleId: c }), UserRole.MEMBER))).toBe('ok');
    });

    it('a plain member who runs the pod is refused 403 in a sentence, and nothing is created', async () => {
      const owner = await person('Owner');
      const plain = await person('Plain');
      const c = await circle(owner, [[plain]]);
      const p = await pod(plain);
      let refusal: { statusCode?: number; code?: string; message?: string } = {};
      try {
        await sessions.createSession(plain, body(p, { circleId: c }), UserRole.MEMBER);
      } catch (err) {
        refusal = err as typeof refusal;
      }
      expect(refusal).toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
      expect(refusal.message).toBe(`Only the people who run ${await circleName(c)} can schedule an event for it.`);
      expect((await run(`SELECT count(*)::int AS n FROM {s}.sessions WHERE pod_id = $1`, [p])).rows[0].n).toBe(0);
    });

    it('an archived or unknown circle answers 404', async () => {
      const owner = await person('Owner');
      const archived = await circle(owner, [], { archived: true });
      const p = await pod(owner);
      expect(await outcome(() => sessions.createSession(owner, body(p, { circleId: archived }), UserRole.MEMBER))).toBe('CIRCLE_NOT_FOUND');
      expect(await outcome(() => sessions.createSession(owner, body(p, { circleId: randomUUID() }), UserRole.MEMBER))).toBe('CIRCLE_NOT_FOUND');
    });

    it('the pod is still required: a manager who does not run the pod is refused by the pod rule', async () => {
      const owner = await person('Owner');
      const other = await person('Director');
      const c = await circle(owner, []);
      const p = await pod(other);
      expect(await outcome(() => sessions.createSession(owner, body(p, { circleId: c }), UserRole.MEMBER))).toBe('AUTH_FORBIDDEN');
    });

    it('production\'s body (no circleId) makes a NULL-circle, NULL-visibility event exactly as before, and rings nobody', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      await circle(owner, [[member]]);
      const p = await pod(owner);
      const created = await sessions.createSession(owner, body(p), UserRole.MEMBER);
      expect(created).toMatchObject({ circleId: null, visibility: null });
      expect(await bells(created.id)).toEqual([]);
    });
  });

  describe('the bells', () => {
    it('one event_invite to each active member but the creator, "New event in {circle}", linking the event; no email', async () => {
      const owner = await person('Owner');
      const a = await person('Ana');
      const b = await person('Ben');
      const closed = await person('Closed');
      const c = await circle(owner, [[a], [b], [closed]]);
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [closed]);
      const p = await pod(owner);
      const created = await sessions.createSession(owner, body(p, { circleId: c }), UserRole.MEMBER);
      const title = `New event in ${await circleName(c)}`;
      const link = `/sessions/${created.id}`;
      expect(await bells(created.id)).toEqual(
        [a, b].sort().map((user_id) => ({ user_id, type: 'event_invite', title, link })),
      );
      expect(mockEmail).not.toHaveBeenCalled();
    });
  });

  describe('the audience', () => {
    async function circleEvent() {
      const owner = await person('Owner');
      const member = await person('Member');
      const stranger = await person('Stranger');
      const c = await circle(owner, [[member]]);
      const p = await pod(owner);
      const created = await sessions.createSession(owner, body(p, { circleId: c }), UserRole.MEMBER);
      return { owner, member, stranger, c, p, e: created.id };
    }

    it('a circle member who is not in the pod sees it, lists it, is registered on opening it, enters and is never added to the pod', async () => {
      const { member, p, e } = await circleEvent();
      expect(await sees(e, member)).toBe(true);
      expect(await lists(e, member)).toBe(true);
      expect(await summary(e, member)).toMatchObject({ visibility: 'private', mode: 'register', autoRegister: true });
      expect(await register(e, member)).toBe('ok');
      expect(await access.eventRoomAdmission(e, member, UserRole.MEMBER)).toBe('admitted');
      expect(await inPod(p, member)).toBe(false);
    });

    it('someone outside the circle does not see or list it, and hears the private refusal', async () => {
      const { stranger, e } = await circleEvent();
      expect(await sees(e, stranger)).toBe(false);
      expect(await lists(e, stranger)).toBe(false);
      expect(await summary(e, stranger)).toMatchObject({ mode: 'private', autoRegister: false });
      expect(await register(e, stranger)).toBe('EVENT_PRIVATE');
    });

    it('someone who joins the circle later sees it at once', async () => {
      const { c, stranger, e } = await circleEvent();
      await circles.joinCircle(c, stranger);
      expect(await sees(e, stranger)).toBe(true);
      expect(await lists(e, stranger)).toBe(true);
      expect(await register(e, stranger)).toBe('ok');
    });

    it('leaving the circle keeps a registration; a member who left without one no longer sees it', async () => {
      const owner = await person('Owner');
      const stayer = await person('Registered');
      const leaver = await person('Leaver');
      const c = await circle(owner, [[stayer], [leaver]]);
      const p = await pod(owner);
      const e = (await sessions.createSession(owner, body(p, { circleId: c }), UserRole.MEMBER)).id;
      expect(await register(e, stayer)).toBe('ok');
      await circles.leaveCircle(c, stayer);
      await circles.leaveCircle(c, leaver);
      expect(await sees(e, stayer)).toBe(true);
      expect(await lists(e, stayer)).toBe(true);
      expect(await access.eventRoomAdmission(e, stayer, UserRole.MEMBER)).toBe('admitted');
      expect(await sees(e, leaver)).toBe(false);
      expect(await lists(e, leaver)).toBe(false);
      expect(await register(e, leaver)).toBe('EVENT_PRIVATE');
    });

    it('a deactivated circle member gets no bell, does not see it through the circle and cannot register', async () => {
      const owner = await person('Owner');
      const closed = await person('Closed');
      const c = await circle(owner, [[closed]]);
      await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [closed]);
      const p = await pod(owner);
      const e = (await sessions.createSession(owner, body(p, { circleId: c }), UserRole.MEMBER)).id;
      expect((await bells(e)).map((r) => r.user_id)).not.toContain(closed);
      expect(await sees(e, closed)).toBe(false);
      const facts = await eventAccess.readEventAccessFacts(e, closed);
      expect(facts?.inAudience).toBe(false);
      expect(await register(e, closed)).toBe('AUTH_FORBIDDEN');
    });

    it('an event with no circle in a pod attached to the circle is not widened to the circle (T11\'s answers hold)', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const c = await circle(owner, [[member]]);
      const p = await pod(owner);
      await run(`INSERT INTO {s}.circle_pods (circle_id, pod_id) VALUES ($1, $2)`, [c, p]);
      for (const visibility of [undefined, 'private'] as const) {
        const e = (await sessions.createSession(owner, body(p, visibility ? { visibility } : {}), UserRole.MEMBER)).id;
        expect(await sees(e, member)).toBe(false);
        expect(await lists(e, member)).toBe(false);
        expect(await register(e, member)).toBe(visibility ? 'EVENT_PRIVATE' : 'AUTH_FORBIDDEN');
      }
    });
  });

  describe('editing the circle (PUT)', () => {
    it('the host who manages the circle names it on an event: it turns private, the members are rung and see it; clearing it takes it away', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const c = await circle(owner, [[member]]);
      const p = await pod(owner);
      const e = (await sessions.createSession(owner, body(p), UserRole.MEMBER)).id;
      expect(await sees(e, member)).toBe(false);
      const named = await sessions.updateSession(e, owner, { circleId: c }, UserRole.MEMBER);
      expect(named).toMatchObject({ circleId: c, visibility: 'private' });
      expect((await bells(e)).map((r) => r.user_id)).toEqual([member]);
      expect(await sees(e, member)).toBe(true);
      const cleared = await sessions.updateSession(e, owner, { circleId: null }, UserRole.MEMBER);
      expect(cleared).toMatchObject({ circleId: null, visibility: 'private' });
      expect(await sees(e, member)).toBe(false);
    });

    it('a host who does not manage the circle may neither name it nor clear it', async () => {
      const owner = await person('Owner');
      const plain = await person('Plain');
      const c = await circle(owner, [[plain]]);
      const p = await pod(plain);
      const e = (await sessions.createSession(plain, body(p), UserRole.MEMBER)).id;
      expect(await outcome(() => sessions.updateSession(e, plain, { circleId: c }, UserRole.MEMBER))).toBe('AUTH_FORBIDDEN');
      const ownersPod = await pod(owner, 'private', [plain]);
      const theirs = (await sessions.createSession(owner, body(ownersPod, { circleId: c }), UserRole.MEMBER)).id;
      await run(`UPDATE {s}.sessions SET host_user_id = $2 WHERE id = $1`, [theirs, plain]);
      expect(await outcome(() => sessions.updateSession(theirs, plain, { circleId: null }, UserRole.MEMBER))).toBe('AUTH_FORBIDDEN');
    });
  });

  describe('the circle page', () => {
    it('lists the circle\'s own events and its pods\' events each viewer may open, with the fields production reads', async () => {
      const owner = await person('Owner');
      const member = await person('Member');
      const podMember = await person('Pod member');
      const adminUser = await person('Admin', 'active', 'admin');
      const c = await circle(owner, [[member], [podMember]]);
      const elsewhere = await pod(owner);
      const attachedPrivate = await pod(owner, 'private', [podMember]);
      const attachedPublic = await pod(owner, 'public');
      await run(`INSERT INTO {s}.circle_pods (circle_id, pod_id) VALUES ($1, $2), ($1, $3)`, [c, attachedPrivate, attachedPublic]);
      const forCircle = (await sessions.createSession(owner, body(elsewhere, { circleId: c, title: 'For the circle' }), UserRole.MEMBER)).id;
      const privatePodEvent = (await sessions.createSession(owner, body(attachedPrivate, { title: 'Private pod' }), UserRole.MEMBER)).id;
      const publicPodEvent = (await sessions.createSession(owner, body(attachedPublic, { title: 'Public pod' }), UserRole.MEMBER)).id;
      const otherCircle = await circle(owner, []);
      const notHere = (await sessions.createSession(owner, body(elsewhere, { circleId: otherCircle, title: 'Another circle' }), UserRole.MEMBER)).id;

      const ids = async (viewer: string, role = 'member') =>
        (await circles.getCircleDetail(c, viewer, role)).upcomingEvents.map((x) => x.id).sort();
      expect(await ids(member)).toEqual([forCircle, publicPodEvent].sort());
      expect(await ids(podMember)).toEqual([forCircle, privatePodEvent, publicPodEvent].sort());
      expect(await ids(await person('Stranger'))).toEqual([publicPodEvent]);
      expect(await ids(adminUser, 'admin')).toEqual([forCircle, privatePodEvent, publicPodEvent].sort());
      expect(await ids(member)).not.toContain(notHere);

      const detail = await circles.getCircleDetail(c, member, 'member');
      const event = detail.upcomingEvents.find((x) => x.id === forCircle)!;
      expect(Object.keys(event)).toEqual(expect.arrayContaining(['id', 'title', 'scheduledAt', 'podId']));
      expect(event).toMatchObject({ title: 'For the circle', podId: elsewhere, forCircle: true });
      expect(detail.upcomingEvents.find((x) => x.id === publicPodEvent)).toMatchObject({ forCircle: false });
      for (const key of ['id', 'name', 'description', 'memberCount', 'isMember', 'members', 'pods', 'upcomingEvents', 'children']) {
        expect(detail).toHaveProperty(key);
      }
    });

    it('says who may schedule: the creator, an owner or moderator, and admins; never a plain member', async () => {
      const creator = await person('Creator');
      const mod = await person('Moderator');
      const plain = await person('Plain');
      const adminUser = await person('Admin', 'active', 'admin');
      const c = await circle(creator, [[mod, 'moderator'], [plain]], { ownerRow: false });
      expect((await circles.getCircleDetail(c, creator, 'member')).canManage).toBe(true);
      expect((await circles.getCircleDetail(c, mod, 'member')).canManage).toBe(true);
      expect((await circles.getCircleDetail(c, adminUser, 'admin')).canManage).toBe(true);
      expect((await circles.getCircleDetail(c, plain, 'member')).canManage).toBe(false);
    });
  });
});
