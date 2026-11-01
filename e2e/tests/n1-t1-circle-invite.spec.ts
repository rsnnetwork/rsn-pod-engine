import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { cleanup, idsOf, SERVER } from '../helpers/live-ui';

// CIRCLE INVITES RING THE BELL, AND THE PEOPLE WHO RUN A CIRCLE MAY INVITE (30 Oct programme, T1, server only).
//
// The admin creates a circle and is its owner. The admin invites a member: the member's notifications carry a
// circle_invite row (until migration 118, 'circle_invite' was not an allowed notification type, so the bell
// insert failed and was swallowed), the member accepts through the bell's own link and is listed with the right
// count. A second platform admin who is not in the circle invites too. API level: this task has no screen.
//
// Runs against production or a local stack: every account is a throwaway ending @rsn-e2e.invalid, the circle is
// the spec's own, and teardown deletes exactly those rows by id.

const SECRET = process.env.E2E_JWT_SECRET || process.env.JWT_SECRET;

interface Person { id: string; email: string; token: string }

async function makePerson(label: string, role: 'member' | 'admin'): Promise<Person> {
  const id = uuid();
  const email = `n1t1-${label}-${Date.now()}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, 'N1T1', $4, 'active', $5, true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Copenhagen, Denmark')`,
    [id, email, `N1T1 ${label}`, label, role],
  );
  const token = jwt.sign({ sub: id, email, role, displayName: `N1T1 ${label}`, sessionId: uuid() }, SECRET!, { expiresIn: '1h' });
  return { id, email, token };
}

async function api(who: Person, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let admin: Person;       // creates the circle
let otherAdmin: Person;  // a platform admin who is not in it
let member: Person;      // invited by the admin, accepts
let guest: Person;       // invited by the other admin
let circleId = '';

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  admin = await makePerson('admin', 'admin');
  otherAdmin = await makePerson('otheradmin', 'admin');
  member = await makePerson('member', 'member');
  guest = await makePerson('guest', 'member');
});

test.afterAll(async () => {
  const ids = idsOf(admin, otherAdmin, member, guest);
  if (circleId) {
    await pool.query(`DELETE FROM invites WHERE circle_id = $1`, [circleId]).catch(() => {});
    await pool.query(`DELETE FROM circle_members WHERE circle_id = $1`, [circleId]).catch(() => {});
    await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  }
  if (ids.length) await pool.query(`DELETE FROM invites WHERE inviter_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
});

const membersOf = async (who: Person) => {
  const res = await api(who, 'GET', `/circles/${circleId}`);
  expect(res.status, `circle detail: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json.data as { memberCount: number; members: Array<{ userId: string; role: string }> };
};

test('the admin creates a circle, invites a member, the member has a circle_invite bell, accepts and is listed', async () => {
  test.setTimeout(120_000);

  const created = await api(admin, 'POST', '/circles', { name: `N1T1 Circle ${Date.now()}`, description: 'throwaway' });
  expect(created.status, `create circle: ${JSON.stringify(created.json)}`).toBe(201);
  circleId = created.json.data.id;

  // The creator is the circle's owner, and the count says so.
  const first = await membersOf(admin);
  expect(first.members.map((m) => [m.userId, m.role])).toEqual([[admin.id, 'owner']]);
  expect(first.memberCount).toBe(1);

  // The admin invites the member by id (the way a list pick arrives).
  const invited = await api(admin, 'POST', '/invites', { type: 'circle', circleId, inviteeUserId: member.id });
  expect(invited.status, `circle invite: ${JSON.stringify(invited.json)}`).toBe(201);
  expect(invited.json.data.circleId).toBe(circleId);

  // The member's notifications include the circle_invite row, and it leads to the invite.
  const bell = await api(member, 'GET', '/notifications');
  expect(bell.status).toBe(200);
  const row = (bell.json.data.notifications as Array<{ type: string; link: string; title: string }>).find((n) => n.type === 'circle_invite');
  expect(row, `no circle_invite row in ${JSON.stringify(bell.json.data.notifications)}`).toBeTruthy();
  expect(row!.link).toBe(`/invite/${invited.json.data.code}`);
  expect(row!.title).toMatch(/invited you to N1T1 Circle/);

  // The member accepts through the bell's own call and lands on the circle.
  const accepted = await api(member, 'POST', `/invites/${invited.json.data.code}/accept`);
  expect(accepted.status, `accept: ${JSON.stringify(accepted.json)}`).toBe(200);
  expect(accepted.json.data.registeredFor.circleId).toBe(circleId);
  expect(accepted.json.data.redirectTo).toBe(`/circles/${circleId}`);

  // The member is listed as a member, and the count follows the rows.
  const after = await membersOf(member);
  expect(after.members.map((m) => [m.userId, m.role]).sort()).toEqual([[admin.id, 'owner'], [member.id, 'member']].sort());
  expect(after.memberCount).toBe(2);
});

test('a platform admin who is not in the circle may invite to it; a member who is not in it may not', async () => {
  test.setTimeout(120_000);
  expect(circleId, 'the first test makes the circle').toBeTruthy();

  const byAdmin = await api(otherAdmin, 'POST', '/invites', { type: 'circle', circleId, inviteeUserId: guest.id });
  expect(byAdmin.status, `platform admin invite: ${JSON.stringify(byAdmin.json)}`).toBe(201);
  const bell = await api(guest, 'GET', '/notifications');
  expect((bell.json.data.notifications as Array<{ type: string }>).some((n) => n.type === 'circle_invite')).toBe(true);

  const refused = await api(guest, 'POST', '/invites', { type: 'circle', circleId });
  expect(refused.status).toBe(403);
});
