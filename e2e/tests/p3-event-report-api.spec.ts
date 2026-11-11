import { test, expect } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createSession } from '../helpers/api';
import { cleanup, idsOf, teardown } from '../helpers/live-ui';

// Part 3 Task 4 (11 Nov 2026), spec 03 "Reporting": the organisers' event report and its CSV, through the API on
// production (dark: no production screen reads it yet; the card and page come on the preview in Task 9).
//
// A throwaway host creates an event in their pod. Two throwaway members register: A, whose display name is
// =SUM(1,2) (a cell a spreadsheet would run as a formula), and B. The host takes the event live and ends it straight
// away through F7's end route (POST /sessions/:id/host/end) without anyone joining. The host's report says 2
// registered, 2 no-shows, 0 meetings, in the event's own zone; A, a participant, is refused (403, in words); the
// attendance CSV starts with a UTF-8 BOM, its header names the zone, and A's name cell starts with '= (written as text);
// a CSV without a part is refused; and the event's history (GET /sessions/:id/audit) shows the download as
// report.downloaded. Throwaway accounts only (%rsn-e2e.invalid), deleted by id at the end with their pod and event.

const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const RUN = `zp3t4${Date.now().toString(36)}`;
let host: TestUser | undefined, memberA: TestUser | undefined, memberB: TestUser | undefined;
let podId: string | undefined;
let eventId: string | undefined;

interface Answer { status: number; json: any; text: string; bytes: Buffer; headers: Headers }

/**
 * A call whose answer the test reads whatever its status: its raw bytes, and as JSON when it is JSON. The bytes are
 * read as they came: fetch's res.text() decodes UTF-8 the WHATWG way, which drops a leading byte-order mark, so a CSV's
 * BOM can only be seen in the bytes.
 */
async function call(user: TestUser | null, method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a CSV */ }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

/** A throwaway account on the reserved test domain, named for this run (or as given). */
async function throwaway(label: string, displayName?: string): Promise<TestUser> {
  const u = await createTestUser(`p3t4${label}`);
  const name = displayName ?? `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $4 WHERE id = $1`,
    [u.id, `${u.id}@rsn-e2e.invalid`, name, `${RUN} ${label}`]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

test.beforeAll(async () => {
  host = await throwaway('Host');
  memberA = await throwaway('A', '=SUM(1,2)');
  memberB = await throwaway('B');
  // An active pod the host directs (only an active pod takes a new event), with both members in it.
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility, status, pod_type) VALUES ($1, $2, 'private', 'active', 'speed_networking') RETURNING id`,
    [`${RUN} pod`, host.id]);
  podId = pod.rows[0].id;
  await pool.query(
    `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active'), ($1, $3, 'member', 'active'), ($1, $4, 'member', 'active')`,
    [podId, host.id, memberA.id, memberB.id]);
});

test.afterAll(async () => {
  await teardown(() => cleanup(pool, { ids: idsOf(host, memberA, memberB), podId }));
});

test('the host reads an event\'s report and downloads its attendance CSV; a participant is refused; the download is in the history', async () => {
  test.setTimeout(180_000);
  const h = host!;
  const a = memberA!;
  const b = memberB!;

  // The host creates the event; both members register.
  const event = await createSession(h, podId!, `${RUN} report evening`, new Date(Date.now() + 60_000));
  eventId = event.id;
  for (const m of [a, b]) {
    const reg = await call(m, 'POST', `/sessions/${eventId}/register`);
    expect(reg.status, JSON.stringify(reg.json)).toBeLessThan(300);
  }

  // Live, then ended at once through F7's end route, nobody having joined.
  const started = await call(h, 'POST', `/sessions/${eventId}/host/start`);
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  const ended = await call(h, 'POST', `/sessions/${eventId}/host/end`);
  expect(ended.status, JSON.stringify(ended.json)).toBe(200);
  await expect.poll(async () => (await pool.query<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [eventId])).rows[0].status,
    { timeout: 30_000 }).toBe('completed');

  // The host's report: two places, nobody came, no meetings, the event's zone carried.
  const report = await call(h, 'GET', `/sessions/${eventId}/report`);
  expect(report.status, JSON.stringify(report.json)).toBe(200);
  const data = report.json.data;
  expect(data.event).toMatchObject({ id: eventId, status: 'completed' });
  expect(typeof data.event.timezone).toBe('string');
  expect(data.summary).toMatchObject({ registered: 2, attended: 0, noShows: 2, meetings: 0, mutualMatches: 0 });
  const people = data.people.filter((p: any) => p.role === 'participant');
  expect(people.map((p: any) => p.userId).sort()).toEqual([a.id, b.id].sort());
  expect(people.every((p: any) => p.outcome === 'no_show')).toBe(true);
  // The host sees the emails (9 Sep rule), and nothing names a score or a note.
  expect(people.find((p: any) => p.userId === a.id).email).toBe(a.email);
  expect(report.text).not.toMatch(/quality_score|qualityScore|"feedback"|"meetAgain"/);

  // A participant is refused, in words.
  const refused = await call(a, 'GET', `/sessions/${eventId}/report`);
  expect(refused.status).toBe(403);
  expect(refused.json.error.message).toBe('Only the people running this event can see its report.');

  // A CSV needs a part.
  const noPart = await call(h, 'GET', `/sessions/${eventId}/report?format=csv`);
  expect(noPart.status).toBe(400);

  // The attendance CSV: a BOM, the zone in the header, A's would-be formula written as text.
  const file = await call(h, 'GET', `/sessions/${eventId}/report?format=csv&section=attendance`);
  expect(file.status).toBe(200);
  expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="rsn-event-\d{4}-\d{2}-\d{2}-attendance\.csv"$/);
  expect(file.headers.get('cache-control')).toBe('no-store');
  // The file starts with the UTF-8 byte-order mark EF BB BF (so Excel reads non-ASCII names right); the rest is read
  // without it.
  expect([...file.bytes.subarray(0, 3)], 'the CSV starts with the UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
  const lines = file.bytes.subarray(3).toString('utf8').split('\r\n');
  expect(lines[0]).toBe([
    'Name', 'Email', 'Account', 'Role', 'Groups', `Registered at (${data.event.timezone})`, 'How admitted',
    `Joined at (${data.event.timezone})`, `Left at (${data.event.timezone})`, 'Outcome', 'Missed a meeting',
    'Rounds completed', 'People met', 'Ratings given', 'Ratings expected', 'Mutual matches',
  ].join(','));
  const rowA = lines.find((l) => l.includes(a.email));
  expect(rowA, 'A has a row').toBeTruthy();
  // The name holds a comma, so the cell is quoted: "'=SUM(1,2)".
  expect(rowA!.startsWith(`"'=SUM(1,2)",${a.email},`)).toBe(true);
  expect(rowA).toContain('Did not come');

  // The organisers' history shows who took the file out.
  await expect.poll(async () => {
    const audit = await call(h, 'GET', `/sessions/${eventId}/audit`);
    return (audit.json?.data?.entries ?? []).map((e: any) => e.action);
  }, { timeout: 15_000 }).toContain('report.downloaded');
  const stored = await pool.query<{ details: any }>(
    `SELECT details FROM audit_log WHERE entity_type = 'session' AND entity_id = $1 AND action = 'report.downloaded'`, [eventId]);
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0].details.after).toEqual({ section: 'attendance', rows: data.people.length });
});
