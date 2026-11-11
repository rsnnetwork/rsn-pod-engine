import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { SERVER, cleanup, idsOf, teardown } from '../helpers/live-ui';

// THE EVENT LINK (Stefan, 11 Nov 2026): /events/<name>-<n>, and /events/<name>-<n>-<tail> for an event that is not public.
// Over the production API (the screens are on the preview: p3-event-links-ui.spec.ts).
//
// A throwaway host in a throwaway public pod creates two public events under a link name of this run's own
// (p3el-<run>): they get <name>-1 and <name>-2, and each opens by its link. A private event under the same name gets
// <name>-3 with a random tail: its link without the tail is the same 404 as an unknown code, with it the event opens.
// The first event's call link (/call/<code>) still opens it and names its event link. Renaming the second event gives it
// the next number under the new name, and its old link still leads to it. Turning the first event private adds a tail,
// and its guessable link stops at once. A reserved name is refused in words, on the form's check and on create.
// Everything is deleted by id at the end; the two counters this run made are deleted by their exact names.

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);
const NAME = `p3el-${RUN}`;
const RENAMED = `p3el-${RUN}-b`;
const NOT_FOUND = { success: false, error: { code: 'SESSION_NOT_FOUND', message: "We couldn't find that event." } };
const TAIL = /^[a-km-np-z][2-9a-km-np-z]{5}$/;

interface Person { id: string; email: string; token: string }

async function makeHost(): Promise<Person> {
  const id = uuid();
  const email = `p3el-host-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, 'P3EL Host', 'Host', 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email],
  );
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: 'P3EL Host', sessionId: uuid() }, SECRET, { expiresIn: '1h' });
  return { id, email, token };
}

async function call(method: string, p: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let host: Person | undefined;
let podId = '';

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the host').toBeTruthy();
  host = await makeHost();
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'public', 'active', 'speed_networking')`,
    [podId, `P3EL pod ${RUN}`, host.id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);
});

test.afterAll(async () => {
  await teardown(
    () => cleanup(pool, { ids: idsOf(host), podId }),
    () => pool.query(`DELETE FROM event_link_counters WHERE name = ANY($1::text[])`, [[NAME, RENAMED]]),
  );
});

test('event links: numbered per name, a tail for a private event, old links and the call link still lead in', async () => {
  test.setTimeout(180_000);
  const h = host!;
  const scheduledAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  const create = (title: string, extra: object) => call('POST', '/sessions', { token: h.token, body: { podId, title, scheduledAt, ...extra } });
  const cardOf = async (id: string) => {
    const r = await call('GET', `/sessions/${id}/call-link`, { token: h.token });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.data as { code: string; eventLink: { name: string; number: number; slug: string; path: string; url: string; private: boolean } };
  };

  // The form's check: the default name, the next number, and a reserved word refused in words.
  const check = await call('GET', `/sessions/event-link-name?podId=${podId}&name=${encodeURIComponent(NAME)}&visibility=public`, { token: h.token });
  expect(check.status, JSON.stringify(check.json)).toBe(200);
  expect(check.json.data).toMatchObject({ name: NAME, problem: null, nextNumber: 1, private: false });
  expect(check.json.data.preview).toMatch(new RegExp(`/events/${NAME}-1$`));
  const reserved = await call('GET', `/sessions/event-link-name?podId=${podId}&name=admin`, { token: h.token });
  expect(reserved.json.data).toMatchObject({ problem: 'That name is kept for REASON itself. Choose another.', nextNumber: null });
  const refusedCreate = await create(`P3EL refused ${RUN}`, { linkName: 'admin', visibility: 'public' });
  expect(refusedCreate.status).toBe(400);
  expect(refusedCreate.json.error.details.linkName).toEqual(['That name is kept for REASON itself. Choose another.']);

  // A public event under the run's name: <name>-1, opened by anyone at its link.
  const first = await create(`P3EL first ${RUN}`, { linkName: NAME.toUpperCase(), visibility: 'public' });
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  expect(first.json.data.linkName).toBe(NAME);
  const firstId: string = first.json.data.id;
  const firstCard = await cardOf(firstId);
  expect(firstCard.eventLink).toMatchObject({ name: NAME, number: 1, slug: `${NAME}-1`, path: `/events/${NAME}-1`, private: false });
  const opened = await call('GET', `/call-links/${NAME}-1`);
  expect(opened.status, JSON.stringify(opened.json)).toBe(200);
  expect(opened.json.data).toMatchObject({ title: `P3EL first ${RUN}`, code: `${NAME}-1`, link: { slug: `${NAME}-1`, path: `/events/${NAME}-1` } });
  expect(JSON.stringify(opened.json)).not.toContain(firstCard.code);

  // A second event under the same name gets the next number.
  const second = await create(`P3EL second ${RUN}`, { linkName: NAME, visibility: 'public' });
  expect(second.status, JSON.stringify(second.json)).toBe(201);
  const secondId: string = second.json.data.id;
  expect((await cardOf(secondId)).eventLink).toMatchObject({ slug: `${NAME}-2`, number: 2 });
  expect((await call('GET', `/call-links/${NAME}-2`)).json.data.title).toBe(`P3EL second ${RUN}`);

  // A private event: a tail; without it, the same 404 as an unknown code.
  const third = await create(`P3EL private ${RUN}`, { linkName: NAME, visibility: 'private' });
  expect(third.status, JSON.stringify(third.json)).toBe(201);
  const thirdCard = await cardOf(third.json.data.id);
  expect(thirdCard.eventLink.private).toBe(true);
  expect(thirdCard.eventLink.number).toBe(3);
  const tail = thirdCard.eventLink.slug.split('-').pop()!;
  expect(tail).toMatch(TAIL);
  expect(thirdCard.eventLink.slug).toBe(`${NAME}-3-${tail}`);
  const unknownCode = await call('GET', '/call-links/zzzzzzzzzz');
  expect(unknownCode).toEqual({ status: 404, json: NOT_FOUND });
  expect(await call('GET', `/call-links/${NAME}-3`)).toEqual(unknownCode);
  expect(await call('GET', `/call-links/${NAME}-3-${tail === 'abcdef' ? 'abcdeg' : 'abcdef'}`)).toEqual(unknownCode);
  expect((await call('GET', `/call-links/${NAME}-3-${tail}`)).json.data.title).toBe(`P3EL private ${RUN}`);

  // The old call link still opens the first event, and names its event link for the address bar.
  const byCode = await call('GET', `/call-links/${firstCard.code}`);
  expect(byCode.status).toBe(200);
  expect(byCode.json.data).toMatchObject({ code: firstCard.code, link: { slug: `${NAME}-1` } });

  // Renaming the second event: the next number under the new name; its old link still leads to it.
  const renamed = await call('PUT', `/sessions/${secondId}`, { token: h.token, body: { linkName: RENAMED } });
  expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
  expect(renamed.json.data.linkName).toBe(RENAMED);
  expect((await cardOf(secondId)).eventLink.slug).toBe(`${RENAMED}-1`);
  const old = await call('GET', `/call-links/${NAME}-2`);
  expect(old.status).toBe(200);
  expect(old.json.data.link).toEqual({ slug: `${RENAMED}-1`, path: `/events/${RENAMED}-1` });

  // Turning the first event private: a tail is added, and its guessable link stops at once.
  const madePrivate = await call('PUT', `/sessions/${firstId}`, { token: h.token, body: { visibility: 'private' } });
  expect(madePrivate.status, JSON.stringify(madePrivate.json)).toBe(200);
  expect(await call('GET', `/call-links/${NAME}-1`)).toEqual(unknownCode);
  const nowPrivate = await cardOf(firstId);
  expect(nowPrivate.eventLink).toMatchObject({ number: 1, private: true });
  expect(nowPrivate.eventLink.slug).toMatch(new RegExp(`^${NAME}-1-[a-km-np-z][2-9a-km-np-z]{5}$`));
  expect((await call('GET', `/call-links/${nowPrivate.eventLink.slug}`)).status).toBe(200);

  // Nobody but the host reads the card or renames.
  const strangerToken = jwt.sign({ sub: uuid(), email: `nobody-${RUN}@rsn-e2e.invalid`, role: 'member', displayName: 'N', sessionId: uuid() }, SECRET, { expiresIn: '10m' });
  expect((await call('PUT', `/sessions/${firstId}`, { token: strangerToken, body: { linkName: 'stolen' } })).status).not.toBe(200);
  expect((await call('GET', `/sessions/${firstId}/call-link`, { token: strangerToken })).status).not.toBe(200);
  expect((await cardOf(firstId)).eventLink.name).toBe(NAME);
});
