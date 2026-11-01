// ─── Who can see, register for and enter an event: the matrix (real Postgres, T11, 1 Nov 2026; L17) ────────
//
// Visibility {NULL, public, public_with_approval, private} × the pod's own visibility {public,
// public_with_approval, invite_only, private} × viewer {host, pod member, invitee, circle member (a stranger
// until T13), stranger, removed participant, removed account} × action {see, list, register, enter}. Every
// answer is read through the real entry points (canViewSession, listSessions, registerParticipant,
// eventRoomAdmission) on real tables. NULL is today's rules including T2's D1/D2/D3; an explicit visibility
// follows L17. Then the request flow: ask, the bell, approve with capacity, decline, withdraw, and a removed or
// closed requester.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) plus migration
// 125 run inside it, and dropped at the end. Opt-in, because it needs a local Postgres (it refuses anything else):
//
//   ACTIVE_MEMBER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/session/event-access-matrix.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { UserRole } from '@rsn/shared';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.ACTIVE_MEMBER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

const TABLES = [
  'users', 'pods', 'pod_members', 'sessions', 'session_participants', 'session_cohosts', 'invites',
  'circles', 'circle_members', 'circle_pods', 'notifications',
];

type Vis = 'public' | 'public_with_approval' | 'private' | null;
type PodVis = 'public' | 'public_with_approval' | 'invite_only' | 'private';
type Viewer = 'host' | 'member' | 'invitee' | 'circle' | 'stranger' | 'removedParticipant' | 'removedAccount';
const VIEWERS: Viewer[] = ['host', 'member', 'invitee', 'circle', 'stranger', 'removedParticipant', 'removedAccount'];
const POD_VIS: PodVis[] = ['public', 'public_with_approval', 'invite_only', 'private'];

/** 'ok' or the refusal code registerParticipant answers. */
type Reg = 'ok' | string;
interface Expect { see: boolean; register: Reg }

/** Today's rules (NULL), T2's D1/D2/D3 included. */
function legacy(pod: PodVis, v: Viewer): Expect {
  if (v === 'host' || v === 'member') return { see: true, register: 'ok' };
  if (v === 'removedAccount') return { see: false, register: 'skip' };
  if (pod === 'public') {
    return v === 'removedParticipant' ? { see: true, register: 'REMOVED_FROM_EVENT' } : { see: true, register: 'ok' };
  }
  if (pod === 'public_with_approval') {
    if (v === 'invitee') return { see: false, register: 'ok' };
    if (v === 'removedParticipant') return { see: false, register: 'REMOVED_FROM_EVENT' };
    return { see: false, register: 'AUTH_FORBIDDEN' };
  }
  return { see: false, register: 'AUTH_FORBIDDEN' };
}

/** L17, the same in every pod. */
function explicit(vis: Exclude<Vis, null>, v: Viewer): Expect {
  if (v === 'removedAccount') return { see: false, register: 'AUTH_FORBIDDEN' };
  if (v === 'host' || v === 'member' || v === 'invitee') return { see: true, register: 'ok' };
  if (v === 'removedParticipant') return { see: vis !== 'private', register: 'REMOVED_FROM_EVENT' };
  if (vis === 'public') return { see: true, register: 'ok' };
  if (vis === 'public_with_approval') return { see: true, register: 'EVENT_NEEDS_APPROVAL' };
  return { see: false, register: 'EVENT_PRIVATE' };
}

suite('event access matrix and requests (real Postgres)', () => {
  const schema = `zz_event_access_${Date.now()}`;
  let admin: Client;
  let db: typeof import('../../../db');
  let sessions: typeof import('../../../services/session/session.service');
  let access: typeof import('../../../services/session/session-access');
  let requests: typeof import('../../../services/session/event-requests.service');
  let eventAccess: typeof import('../../../services/session/event-access');

  const run = (sql: string, params: unknown[] = []) => admin.query(sql.split('{s}').join(schema), params);

  async function person(name: string, status = 'active'): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.users (id, email, display_name, first_name, last_name, status, role)
       VALUES ($1, $2, $3, $3, 'Test', $4, 'member')`,
      [id, `${id}@rsn-e2e.invalid`, name, status],
    );
    return id;
  }

  async function pod(visibility: PodVis, director: string, members: string[]): Promise<string> {
    const id = randomUUID();
    await run(`INSERT INTO {s}.pods (id, name, created_by, visibility) VALUES ($1, $2, $3, $4)`, [id, `Pod ${visibility}`, director, visibility]);
    await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [id, director]);
    for (const m of members) await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [id, m]);
    return id;
  }

  async function event(podId: string, host: string, visibility: Vis, maxParticipants?: number): Promise<string> {
    const id = randomUUID();
    await run(
      `INSERT INTO {s}.sessions (id, pod_id, title, status, host_user_id, scheduled_at, config, visibility)
       VALUES ($1, $2, 'An event', 'scheduled', $3, NOW() + INTERVAL '2 days', $4::jsonb, $5)`,
      [id, podId, host, JSON.stringify(maxParticipants ? { maxParticipants } : {}), visibility],
    );
    return id;
  }

  const place = (sessionId: string, userId: string, status = 'registered') =>
    run(`INSERT INTO {s}.session_participants (session_id, user_id, status) VALUES ($1, $2, $3)`, [sessionId, userId, status]);

  async function invite(sessionId: string, inviter: string, inviteeId: string): Promise<void> {
    await run(
      `INSERT INTO {s}.invites (code, type, inviter_id, session_id, invitee_email, status, max_uses, expires_at)
       VALUES ($1, 'session', $2, $3, (SELECT email FROM {s}.users WHERE id = $4), 'pending', 1, NOW() + INTERVAL '7 days')`,
      [randomUUID().slice(0, 12), inviter, sessionId, inviteeId],
    );
  }

  async function registerOutcome(sessionId: string, userId: string): Promise<Reg> {
    try {
      await sessions.registerParticipant(sessionId, userId, UserRole.MEMBER);
      return 'ok';
    } catch (err) {
      return (err as { code?: string }).code ?? 'THREW';
    }
  }

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('ACTIVE_MEMBER_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // Migration 125 inside the schema (its constraint name is global, so the column check may already exist).
    const migration = fs.readFileSync(path.join(__dirname, '../../../db/migrations/125_event_visibility.sql'), 'utf8');
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(migration);
    await admin.query(`SET search_path TO public`);
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    sessions = await import('../../../services/session/session.service');
    access = await import('../../../services/session/session-access');
    requests = await import('../../../services/session/event-requests.service');
    eventAccess = await import('../../../services/session/event-access');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  const VISIBILITIES: Vis[] = [null, 'public', 'public_with_approval', 'private'];

  for (const vis of VISIBILITIES) {
    for (const podVis of POD_VIS) {
      it(`visibility ${vis ?? 'NULL'} in a ${podVis} pod: see, list, register and enter for every viewer`, async () => {
        const host = await person('Host');
        const member = await person('Member');
        const removedAccount = await person('Closed');
        const p = await pod(podVis, host, [member, removedAccount]);
        const people: Record<Viewer, string> = {
          host, member, removedAccount,
          invitee: await person('Invitee'),
          circle: await person('Circle'),
          stranger: await person('Stranger'),
          removedParticipant: await person('Kicked'),
        };
        const c = randomUUID();
        await run(`INSERT INTO {s}.circles (id, name, created_by, member_count) VALUES ($1, $3, $2, 1)`, [c, people.circle, `Circle ${c.slice(0, 8)}`]);
        await run(`INSERT INTO {s}.circle_members (circle_id, user_id) VALUES ($1, $2)`, [c, people.circle]);
        await run(`INSERT INTO {s}.circle_pods (circle_id, pod_id) VALUES ($1, $2)`, [c, p]);
        const e = await event(p, host, vis);
        await place(e, host);
        await place(e, people.removedParticipant, 'removed');
        await invite(e, host, people.invitee);
        await run(`UPDATE {s}.users SET status = 'deactivated' WHERE id = $1`, [removedAccount]);

        for (const v of VIEWERS) {
          const want = vis === null ? legacy(podVis, v) : explicit(vis, v);
          const id = people[v];
          const label = `${vis ?? 'NULL'}/${podVis}/${v}`;
          expect({ label, see: await access.canViewSession(id, e, UserRole.MEMBER) }).toEqual({ label, see: want.see });
          const listed = (await sessions.listSessions({ userId: id })).sessions.some((s) => s.id === e);
          if (v !== 'removedAccount') expect({ label, listed }).toEqual({ label, listed: want.see });
          const before = await access.eventRoomAdmission(e, id, UserRole.MEMBER);
          const enterBefore = v === 'host' ? 'admitted' : v === 'removedParticipant' ? 'removed' : 'refused';
          expect({ label, before }).toEqual({ label, before: enterBefore });
          if (want.register === 'skip') continue;
          if (v === 'host') continue;
          const outcome = await registerOutcome(e, id);
          expect({ label, outcome }).toEqual({ label, outcome: want.register });
          const after = await access.eventRoomAdmission(e, id, UserRole.MEMBER);
          const enterAfter = outcome === 'ok' ? 'admitted' : v === 'removedParticipant' ? 'removed' : 'refused';
          expect({ label, after }).toEqual({ label, after: enterAfter });
          if (vis !== null && outcome === 'ok' && v !== 'member') {
            // An explicit visibility never adds anyone to the pod (D4's rule for every path).
            const m = await run(`SELECT 1 FROM {s}.pod_members WHERE pod_id = $1 AND user_id = $2`, [p, id]);
            expect({ label, podMember: m.rows.length }).toEqual({ label, podMember: 0 });
          }
        }
      });
    }
  }

  it('the pure NULL rules answer what the real NULL paths answer', async () => {
    for (const podVis of POD_VIS) {
      const host = await person('Host');
      const member = await person('Member');
      const p = await pod(podVis, host, [member]);
      const e = await event(p, host, null);
      const viewers = [host, member, await person('Stranger')];
      for (const id of viewers) {
        const facts = (await eventAccess.readEventAccessFacts(e, id))!;
        expect(eventAccess.canSeeEvent(facts, UserRole.MEMBER)).toBe(await access.canViewSession(id, e, UserRole.MEMBER));
        const decision = eventAccess.canRegister(facts, UserRole.MEMBER);
        const real = await registerOutcome(e, id);
        expect(decision.ok ? 'ok' : decision.code).toBe(real === 'SESSION_ALREADY_REGISTERED' ? 'ok' : real);
      }
    }
  });

  it('admins see and register at every visibility', async () => {
    const host = await person('Host');
    const adminId = await person('Admin');
    const p = await pod('private', host, []);
    for (const vis of VISIBILITIES) {
      const e = await event(p, host, vis);
      expect(await access.canViewSession(adminId, e, UserRole.ADMIN)).toBe(true);
      await expect(sessions.registerParticipant(e, adminId, UserRole.ADMIN)).resolves.toBeTruthy();
    }
  });

  describe('requests to join an event that asks for approval', () => {
    it('a stranger asks once, the organisers get one bell, approval registers them and rings them, and they enter', async () => {
      const host = await person('Host');
      const director = await person('Director');
      const stranger = await person('Stranger');
      const p = await pod('private', director, []);
      await run(`INSERT INTO {s}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'host', 'active')`, [p, host]);
      const e = await event(p, host, 'public_with_approval');

      const first = await requests.requestToJoin(e, stranger, UserRole.MEMBER, 'Hello');
      expect(first.status).toBe('pending');
      const again = await requests.requestToJoin(e, stranger, UserRole.MEMBER, null);
      expect(again.id).toBe(first.id);
      const bells = await run(`SELECT user_id, type, link FROM {s}.notifications WHERE type = 'join_request' AND link = $1`, [`/sessions/${e}?requests=1`]);
      expect(bells.rows.map((r) => r.user_id).sort()).toEqual([host, director].sort());

      expect((await requests.listRequests(e, host, UserRole.MEMBER)).map((r) => r.userId)).toEqual([stranger]);
      await expect(requests.listRequests(e, stranger, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });

      const facts = (await eventAccess.readEventAccessFacts(e, stranger))!;
      expect(eventAccess.summariseEventAccess(facts, UserRole.MEMBER)).toMatchObject({ mode: 'request', myRequest: 'pending', autoRegister: false });

      const approved = await requests.approveRequest(e, stranger, director, UserRole.MEMBER);
      expect(approved.request.status).toBe('approved');
      expect(approved.isNewRegistration).toBe(true);
      expect(await access.eventRoomAdmission(e, stranger, UserRole.MEMBER)).toBe('admitted');
      const ring = await run(`SELECT 1 FROM {s}.notifications WHERE user_id = $1 AND type = 'approval'`, [stranger]);
      expect(ring.rows.length).toBe(1);
      const member = await run(`SELECT 1 FROM {s}.pod_members WHERE pod_id = $1 AND user_id = $2`, [p, stranger]);
      expect(member.rows.length).toBe(0);
      await expect(requests.approveRequest(e, stranger, director, UserRole.MEMBER)).rejects.toMatchObject({ code: 'EVENT_REQUEST_ANSWERED' });
    });

    it('fix round 1: someone approved who then unregistered registers again without asking again', async () => {
      const host = await person('Host');
      const stranger = await person('Stranger');
      const p = await pod('public', host, []);
      const e = await event(p, host, 'public_with_approval');
      await requests.requestToJoin(e, stranger, UserRole.MEMBER, null);
      await requests.approveRequest(e, stranger, host, UserRole.MEMBER);
      await sessions.unregisterParticipant(e, stranger);
      const facts = (await eventAccess.readEventAccessFacts(e, stranger))!;
      expect(eventAccess.summariseEventAccess(facts, UserRole.MEMBER)).toMatchObject({ mode: 'register', myRequest: 'approved' });
      await expect(requests.requestToJoin(e, stranger, UserRole.MEMBER, null)).rejects.toMatchObject({ code: 'EVENT_REQUEST_NOT_NEEDED' });
      expect(await registerOutcome(e, stranger)).toBe('ok');
      expect(await access.eventRoomAdmission(e, stranger, UserRole.MEMBER)).toBe('admitted');
    });

    it('a full event leaves the request pending with SESSION_FULL', async () => {
      const host = await person('Host');
      const other = await person('Other');
      const stranger = await person('Stranger');
      const p = await pod('public', host, [other]);
      const e = await event(p, host, 'public_with_approval', 2);
      await place(e, host);
      await place(e, other);
      await requests.requestToJoin(e, stranger, UserRole.MEMBER, null);
      await expect(requests.approveRequest(e, stranger, host, UserRole.MEMBER)).rejects.toMatchObject({ code: 'SESSION_FULL' });
      const row = await run(`SELECT status FROM {s}.event_join_requests WHERE session_id = $1 AND user_id = $2`, [e, stranger]);
      expect(row.rows[0].status).toBe('pending');
    });

    it('a declined request is not reopened by the requester; a withdrawn one is', async () => {
      const host = await person('Host');
      const a = await person('A');
      const b = await person('B');
      const p = await pod('public', host, []);
      const e = await event(p, host, 'public_with_approval');
      await requests.requestToJoin(e, a, UserRole.MEMBER, null);
      await requests.declineRequest(e, a, host, UserRole.MEMBER);
      await expect(requests.requestToJoin(e, a, UserRole.MEMBER, null)).rejects.toMatchObject({ code: 'EVENT_REQUEST_DECLINED' });
      await requests.requestToJoin(e, b, UserRole.MEMBER, null);
      expect(await requests.withdrawRequest(e, b)).toEqual({ withdrawn: true });
      expect((await requests.requestToJoin(e, b, UserRole.MEMBER, null)).status).toBe('pending');
    });

    it('a removed participant cannot ask, and a member or invitee is told to register instead', async () => {
      const host = await person('Host');
      const member = await person('Member');
      const kicked = await person('Kicked');
      const p = await pod('public', host, [member]);
      const e = await event(p, host, 'public_with_approval');
      await place(e, kicked, 'removed');
      await expect(requests.requestToJoin(e, kicked, UserRole.MEMBER, null)).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
      await expect(requests.requestToJoin(e, member, UserRole.MEMBER, null)).rejects.toMatchObject({ code: 'EVENT_REQUEST_NOT_NEEDED' });
    });

    it('the Requests list never shows a requester whose account is no longer active, and approving them is refused', async () => {
      const host = await person('Host');
      const gone = await person('Gone');
      const p = await pod('public', host, []);
      const e = await event(p, host, 'public_with_approval');
      await requests.requestToJoin(e, gone, UserRole.MEMBER, null);
      await run(`UPDATE {s}.users SET status = 'suspended' WHERE id = $1`, [gone]);
      expect(await requests.listRequests(e, host, UserRole.MEMBER)).toEqual([]);
      await expect(requests.approveRequest(e, gone, host, UserRole.MEMBER)).rejects.toMatchObject({ code: 'EVENT_REQUEST_ANSWERED' });
    });

    it('a private event refuses a request from a stranger with the private notice', async () => {
      const host = await person('Host');
      const stranger = await person('Stranger');
      const p = await pod('public', host, []);
      const e = await event(p, host, 'private');
      await expect(requests.requestToJoin(e, stranger, UserRole.MEMBER, null)).rejects.toMatchObject({ code: 'EVENT_PRIVATE' });
    });
  });

  it('production\'s create body (no visibility) makes a NULL event; the preview\'s makes an explicit one; an edit changes it', async () => {
    const host = await person('Host');
    const p = await pod('public', host, []);
    await run(`UPDATE {s}.pods SET status = 'active' WHERE id = $1`, [p]);
    const old = await sessions.createSession(host, {
      podId: p, title: 'Old form', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      format: 'speed_networking', config: { numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 25 },
    }, UserRole.MEMBER);
    expect(old.visibility).toBeNull();
    const dup = await sessions.createSession(host, {
      podId: p, title: 'Duplicate', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      config: { numberOfRounds: 5 },
    }, UserRole.MEMBER);
    expect(dup.visibility).toBeNull();
    const preview = await sessions.createSession(host, {
      podId: p, title: 'Preview form', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      format: 'speed_networking', visibility: 'private',
    }, UserRole.MEMBER);
    expect(preview.visibility).toBe('private');
    const edited = await sessions.updateSession(preview.id, host, { visibility: 'public' }, UserRole.MEMBER);
    expect(edited.visibility).toBe('public');
  });
});
