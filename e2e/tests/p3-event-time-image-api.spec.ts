import { test, expect } from '@playwright/test';
import zlib from 'zlib';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, idsOf, teardown } from '../helpers/live-ui';

// Part 3 Task 1 (11 Nov 2026), spec 03 "event setup: imagery, time zone": an event's own zone and image, through the API
// on production (dark: production's screens send no zone and show no image yet).
//
// A throwaway host whose own zone is Karachi creates an event for Copenhagen (timezone 'Europe/Copenhagen') at
// 2026-12-01T13:00Z: the event reads back with that zone. The host puts a 1200 by 400 PNG on it: the answer is the
// image's address (?v=), which anyone opens without signing in (the cut picture, a JPEG, never sniffed). A throwaway
// member whose own zone is New York registers. The host moves the event a day (EVENT_COMMS is on in production): within
// 10 seconds the member's bell says "<title> has moved to ..." with 14:00 and CET, Copenhagen's clock, not New York's
// 08:00. The host takes the image away: its address answers 404. Throwaway accounts only (%rsn-e2e.invalid), deleted by
// id at the end with their pod and event.

const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const RUN = `zp3t1${Date.now().toString(36)}`;
const TITLE = `${RUN} Copenhagen evening`;
let host: TestUser | undefined, member: TestUser | undefined;
let podId: string | undefined;
let eventId: string | undefined;

/** A call whose answer the test reads whatever its status. */
async function call(user: TestUser | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function throwaway(label: string, timezone: string): Promise<TestUser> {
  const u = await createTestUser(`p3t1${label}`);
  const name = `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3, timezone = $4 WHERE id = $1`,
    [u.id, `${u.id}@rsn-e2e.invalid`, name, timezone]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

// ── A real PNG of one colour, built here (no image library in the e2e package) ──────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.beforeAll(async () => {
  host = await throwaway('Host', 'Asia/Karachi');
  member = await throwaway('Member', 'America/New_York');
  // A private, active speed-networking pod the host directs and the member belongs to, so the member registers
  // without an invite (the NULL-visibility rule) and holds a place the move notice reaches.
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility, status, pod_type) VALUES ($1, $2, 'private', 'active', 'speed_networking') RETURNING id`,
    [`${RUN} pod`, host.id]);
  podId = pod.rows[0].id;
  await pool.query(
    `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active'), ($1, $3, 'member', 'active')`,
    [podId, host.id, member.id]);
});

test.afterAll(async () => {
  await teardown(() => cleanup(pool, { ids: idsOf(host, member), podId }));
});

test('an event keeps its own zone and image: the bell reads Copenhagen\'s clock, the image opens without signing in', async () => {
  test.setTimeout(120_000);

  // The host (Karachi) creates a Copenhagen event: the zone sent wins over the host's own.
  const created = await call(host!, 'POST', '/sessions', {
    podId, title: TITLE, scheduledAt: '2026-12-01T13:00:00.000Z', timezone: 'Europe/Copenhagen',
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50 },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  eventId = created.json.data.id as string;
  expect(created.json.data).toMatchObject({ timezone: 'Europe/Copenhagen', imageUrl: null });
  const read = await call(host!, 'GET', `/sessions/${eventId}`);
  expect(read.status).toBe(200);
  expect(read.json.data.timezone).toBe('Europe/Copenhagen');

  // An invented zone is refused in a sentence.
  const invented = await call(host!, 'PUT', `/sessions/${eventId}`, { timezone: 'Mars/Base' });
  expect(invented.status).toBe(400);
  expect(invented.json.error.message).toBe("Choose the event's time zone from the list.");

  // The host puts a 1200 by 400 picture on it; the answer is its address, which anyone opens.
  const png = solidPng(1200, 400, [30, 30, 220]);
  const put = await call(host!, 'PUT', `/sessions/${eventId}/image`, { image: `data:image/png;base64,${png.toString('base64')}` });
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  const imageUrl = put.json.data.imageUrl as string;
  expect(imageUrl).toMatch(new RegExp(`/api/sessions/${eventId}/image\\?v=\\d+$`));
  const image = await fetch(imageUrl);
  expect(image.status).toBe(200);
  // The picture everyone sees is cut on the server (3:1, on white) and kept as a JPEG, whatever was sent.
  expect(image.headers.get('content-type')).toBe('image/jpeg');
  expect(image.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
  expect((await call(host!, 'GET', `/sessions/${eventId}`)).json.data.imageUrl).toBe(imageUrl);

  // The member (New York) registers.
  const registered = await call(member!, 'POST', `/sessions/${eventId}/register`);
  expect(registered.status, JSON.stringify(registered.json)).toBe(201);

  // The host moves it a day: the member's bell names Copenhagen's 14:00 CET, not New York's 08:00.
  const moved = await call(host!, 'PUT', `/sessions/${eventId}`, { scheduledAt: '2026-12-02T13:00:00.000Z' });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  await expect.poll(async () => {
    const bell = await call(member!, 'GET', '/notifications');
    const titles = (bell.json?.data?.notifications ?? [])
      .filter((n: { type: string; title: string }) => n.type === 'event_rescheduled' && n.title.startsWith(`${TITLE} has moved to`))
      .map((n: { title: string }) => n.title);
    return titles;
  }, { timeout: 10_000 }).toEqual([`${TITLE} has moved to Wednesday 2 December, 14:00 (CET)`]);

  // The host takes the image away: its address answers 404, and the event reads no image.
  const removed = await call(host!, 'DELETE', `/sessions/${eventId}/image`);
  expect(removed.status).toBe(200);
  expect(removed.json.data).toEqual({ imageUrl: null });
  expect((await fetch(imageUrl)).status).toBe(404);
  expect((await call(host!, 'GET', `/sessions/${eventId}`)).json.data.imageUrl).toBeNull();
});
