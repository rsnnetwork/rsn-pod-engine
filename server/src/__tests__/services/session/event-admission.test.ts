// ─── Admission per event: the mode and the allowed emails (Part 2, Task 4, 10 Nov 2026) ───────────────────────
//
// Spec 02 (invitation only), 04 ("allowed email list ... the link alone does not grant permission"), 11, edge cases
// "duplicate email" and "external paid guest list out of date". The real service and router run against a small
// in-memory stand-in for sessions and event_admission_entries that answers the service's own statements; the
// statements themselves run on Postgres in the task's probe (see the report). Also: registerParticipant records what
// gave a place (admitted_via) on an event with a mode, and writes nothing new on one without.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const SECRET = 'test-jwt-secret';
jest.mock('../../../config', () => ({
  default: { jwtSecret: 'test-jwt-secret', env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 100000 },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockCanActAsHost = jest.fn();
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: (...a: unknown[]) => mockCanActAsHost(...a),
  __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: jest.fn().mockResolvedValue(['host-1', 'cohost-1']),
  __esModule: true,
}));
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => ({}),
  __esModule: true,
}));
const mockFanoutSession = jest.fn().mockResolvedValue(undefined);
const mockFanoutLists = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: (...a: unknown[]) => mockFanoutSession(...a),
  fanoutSessionListEntities: (...a: unknown[]) => mockFanoutLists(...a),
  __esModule: true,
}));
jest.mock('../../../services/orchestration/state/session-state', () => ({ activeSessions: new Map(), __esModule: true }));

// ── The stand-in tables ─────────────────────────────────────────────────────

const EVENT = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
interface EventState { status: string; visibility: string | null; admission_mode: string | null; pod_visibility: string | null }
let event: EventState;
interface Entry { id: string; session_id: string; email: string; group_key: string | null; source: string; added_by: string | null; revoked_at: Date | null; revoked_by: string | null }
const entries: Entry[] = [];
const users = new Map<string, string>([['ana@x.io', 'user-ana'], ['bo@x.io', 'user-bo']]);
const audit: Array<{ action: string; details: Record<string, unknown> }> = [];
const allSql: string[] = [];
let seq = 0;

async function fakeQuery(sql: string, params: unknown[] = []) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  allSql.push(flat);
  if (flat.startsWith('SELECT status, account_kind FROM users')) return { rows: [{ status: 'active', account_kind: 'member' }] };
  // The audit trail's tag goes to the host and co-hosts (emitEventAuditChanged).
  if (flat.startsWith('SELECT host_user_id AS user_id FROM sessions')) return { rows: [{ user_id: 'host-1' }] };
  if (flat.includes('FROM sessions s LEFT JOIN pods p ON p.id = s.pod_id WHERE s.id = $1')) {
    return { rows: params[0] === EVENT ? [{ pod_id: 'pod-1', ...event }] : [] };
  }
  if (flat.startsWith('UPDATE sessions SET admission_mode')) {
    event.admission_mode = params[1] as string | null;
    event.visibility = event.visibility ?? (params[2] as string | null);
    return { rows: [] };
  }
  if (flat.startsWith('INSERT INTO audit_log')) {
    audit.push({ action: params[1] as string, details: JSON.parse(params[3] as string) });
    return { rows: [] };
  }
  if (flat.startsWith('UPDATE event_admission_entries SET revoked_at = NULL')) {
    const [sid, emails, source, by, group] = params as [string, string[], string, string, string | null];
    const rows = entries.filter((e) => e.session_id === sid && emails.includes(e.email) && e.revoked_at);
    for (const e of rows) Object.assign(e, { revoked_at: null, revoked_by: null, source, added_by: by, group_key: group ?? e.group_key });
    return { rows: rows.map((e) => ({ email: e.email })) };
  }
  if (flat.startsWith('INSERT INTO event_admission_entries')) {
    const [sid, emails, group, source, by] = params as [string, string[], string | null, string, string];
    const rows: Array<{ email: string }> = [];
    for (const email of emails) {
      if (entries.some((e) => e.session_id === sid && e.email === email)) continue;
      entries.push({ id: `entry-${++seq}`, session_id: sid, email, group_key: group, source, added_by: by, revoked_at: null, revoked_by: null });
      rows.push({ email });
    }
    return { rows };
  }
  if (flat.startsWith('SELECT id FROM users WHERE lower(email) = ANY')) {
    return { rows: (params[0] as string[]).filter((e) => users.has(e)).map((e) => ({ id: users.get(e) })) };
  }
  if (flat.startsWith('UPDATE event_admission_entries SET revoked_at = NOW()')) {
    const e = entries.find((r) => r.id === params[0] && r.session_id === params[1] && !r.revoked_at);
    if (!e) return { rows: [] };
    e.revoked_at = new Date(); e.revoked_by = params[2] as string;
    return { rows: [{ email: e.email }] };
  }
  if (flat.startsWith('SELECT 1 FROM event_admission_entries WHERE id')) {
    return { rows: entries.filter((r) => r.id === params[0] && r.session_id === params[1]).map(() => ({})) };
  }
  if (flat.startsWith('SELECT e.id, e.email, e.group_key')) {
    const [sid, q, cursor, limit] = params as [string, string | null, string | null, number];
    const rows = entries
      .filter((e) => e.session_id === sid && (!q || e.email.includes(q)) && (!cursor || e.email > cursor))
      .sort((a, b) => (a.email < b.email ? -1 : 1))
      .slice(0, limit)
      .map((e) => ({ id: e.id, email: e.email, group_key: e.group_key, revoked: !!e.revoked_at, registered: e.email === 'ana@x.io', display_name: users.has(e.email) ? 'Someone' : null }));
    return { rows };
  }
  if (flat.startsWith('SELECT (SELECT COUNT(*)::int FROM event_admission_entries')) {
    return { rows: [{ listed: entries.filter((e) => !e.revoked_at).length, registered: 1, codes_unused: 2, codes_used: 0 }] };
  }
  throw new Error(`unexpected SQL in the stand-in: ${flat.slice(0, 140)}`);
}

jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => fakeQuery(sql, params),
  transaction: async (cb: (client: { query: typeof fakeQuery }) => unknown) => cb({ query: fakeQuery }),
  __esModule: true,
}));

import { UserRole } from '@rsn/shared';
import {
  ADMISSION_LIVE_REFUSAL, addAdmissionEmails, listAdmissionEntries, revokeAdmissionEmail, setAdmissionMode,
} from '../../../services/session/event-admission.service';
import admissionRoutes, { ADMISSION_BODY_MAX_BYTES } from '../../../routes/event-admission';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';
import { registerParticipant } from '../../../services/session/session.service';

const HOST = { userId: 'host-1', role: UserRole.MEMBER };
const STRANGER = { userId: 'member-9', role: UserRole.MEMBER };

beforeEach(() => {
  event = { status: 'scheduled', visibility: null, admission_mode: null, pod_visibility: 'invite_only' };
  entries.length = 0;
  audit.length = 0;
  allSql.length = 0;
  mockEmit.mockClear();
  mockFanoutSession.mockClear();
  mockFanoutLists.mockClear();
  mockCanActAsHost.mockImplementation(async (userId: string) => ({ allowed: userId === 'host-1', effectiveRole: 'event_host' }));
});

describe('setAdmissionMode', () => {
  it('on an event that follows its pod, sets the mode and the pod\'s default visibility in the same write (D3)', async () => {
    await setAdmissionMode(EVENT, HOST, 'restricted');
    expect(event).toMatchObject({ admission_mode: 'restricted', visibility: 'private' });
    expect(audit).toEqual([{ action: 'admission.mode_changed', details: expect.objectContaining({
      automatic: false, before: { mode: null, visibility: null }, after: { mode: 'restricted', visibility: 'private' },
    }) }]);
    expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT, [`session:${EVENT}:admission`]);
    expect(mockFanoutLists).toHaveBeenCalledWith('pod-1', EVENT);
    expect(mockEmit).toHaveBeenCalledWith(expect.anything(), ['host-1', 'cohost-1'], [`session:${EVENT}:admission`, `session:${EVENT}`]);
  });

  it('keeps an explicit visibility, and clearing the mode keeps it too', async () => {
    event.visibility = 'public';
    await setAdmissionMode(EVENT, HOST, 'approval');
    expect(event).toMatchObject({ admission_mode: 'approval', visibility: 'public' });
    expect(mockFanoutLists).not.toHaveBeenCalled();
    await setAdmissionMode(EVENT, HOST, null);
    expect(event).toMatchObject({ admission_mode: null, visibility: 'public' });
  });

  it('a public pod\'s event gets public, an approval pod\'s public_with_approval', async () => {
    event.pod_visibility = 'public';
    await setAdmissionMode(EVENT, HOST, 'open');
    expect(event.visibility).toBe('public');
    event = { status: 'scheduled', visibility: null, admission_mode: null, pod_visibility: 'public_with_approval' };
    await setAdmissionMode(EVENT, HOST, 'open');
    expect(event.visibility).toBe('public_with_approval');
  });

  it('setting the mode it already has writes and tells nothing', async () => {
    event.admission_mode = 'open';
    event.visibility = 'public';
    await setAdmissionMode(EVENT, HOST, 'open');
    expect(allSql.some((s) => s.startsWith('UPDATE sessions'))).toBe(false);
    expect(audit).toHaveLength(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it.each(['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'])('is refused while live (%s)', async (status) => {
    event.status = status;
    await expect(setAdmissionMode(EVENT, HOST, 'restricted')).rejects.toMatchObject({
      statusCode: 409, code: 'SESSION_IN_PROGRESS', message: "Admission can't change while the event is live.",
    });
    expect(ADMISSION_LIVE_REFUSAL).toBe("Admission can't change while the event is live.");
    expect(event.admission_mode).toBeNull();
  });

  it('is the organisers\' only: 403 for anyone else, 404 for no event, and the event row is locked for the write', async () => {
    await expect(setAdmissionMode(EVENT, STRANGER, 'open')).rejects.toMatchObject({ statusCode: 403 });
    await expect(setAdmissionMode('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', HOST, 'open')).rejects.toMatchObject({ statusCode: 404 });
    expect(event.admission_mode).toBeNull();
    await setAdmissionMode(EVENT, HOST, 'open');
    expect(allSql.some((s) => s.endsWith('WHERE s.id = $1 FOR UPDATE OF s'))).toBe(true);
    expect(mockCanActAsHost).toHaveBeenCalledWith('host-1', UserRole.MEMBER, EVENT);
  });
});

describe('addAdmissionEmails', () => {
  it('trims, lower-cases and counts each address once; adds, leaves a listed one, restores a revoked one', async () => {
    await addAdmissionEmails(EVENT, HOST, { emails: ['ana@x.io', 'kept@x.io', 'gone@x.io'], source: 'paste' });
    const gone = entries.find((e) => e.email === 'gone@x.io')!;
    await revokeAdmissionEmail(EVENT, HOST, gone.id);
    audit.length = 0;
    const result = await addAdmissionEmails(EVENT, HOST, {
      emails: [' NEW@x.io ', 'new@x.io', 'kept@X.io', 'Gone@x.io', 'not an address', ''], source: 'paste', groupKey: 'vip',
    });
    expect(result).toEqual({ added: 1, alreadyListed: 1, restored: 1, invalid: ['not an address'] });
    expect(entries.find((e) => e.email === 'gone@x.io')).toMatchObject({ revoked_at: null, group_key: 'vip' });
    expect(entries.find((e) => e.email === 'new@x.io')).toMatchObject({ group_key: 'vip', source: 'paste', added_by: 'host-1' });
    expect(audit).toEqual([{ action: 'admission.emails_added', details: expect.objectContaining({
      after: { added: 1, restored: 1, alreadyListed: 1, source: 'paste', groupKey: 'vip' },
    }) }]);
    expect(JSON.stringify(audit)).not.toContain('new@x.io');
  });

  it('imports a CSV with a duplicate: added 2, and tells the members whose address was added', async () => {
    const csv = 'name,email,ticket\nAna,ana@x.io,VIP\nBo,bo@x.io,GA\nAna again,ANA@x.io,VIP\nCy,nope,GA\n';
    const result = await addAdmissionEmails(EVENT, HOST, { csv, source: 'csv' });
    expect(result).toEqual({ added: 2, alreadyListed: 0, restored: 0, invalid: ['Row 5'] });
    expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT, [`session:${EVENT}:admission`]);
    for (const id of ['user-ana', 'user-bo']) {
      expect(mockEmit).toHaveBeenCalledWith(expect.anything(), [id], [`session:${EVENT}`, `user:${id}:sessions`]);
    }
  });

  it('refuses more than 2,000 distinct addresses at a time, and writes nothing', async () => {
    const lines = ['email'];
    for (let i = 0; i < 2001; i++) lines.push(`p${i}@example.com`);
    await expect(addAdmissionEmails(EVENT, HOST, { csv: lines.join('\n'), source: 'csv' })).rejects.toMatchObject({
      statusCode: 400, message: 'Import at most 2,000 addresses at a time.',
    });
    expect(entries).toHaveLength(0);
    // 2,000 is fine, and repeats of them do not count against it.
    const two = Array.from({ length: 2000 }, (_, i) => `p${i}@example.com`);
    expect((await addAdmissionEmails(EVENT, HOST, { emails: [...two, ...two], source: 'paste' })).added).toBe(2000);
  });

  it('keeps at most 50 examples of what could not be an address', async () => {
    const bad = Array.from({ length: 80 }, (_, i) => `bad ${i}`);
    expect((await addAdmissionEmails(EVENT, HOST, { emails: bad, source: 'paste' })).invalid).toHaveLength(50);
  });

  it('is the organisers\' only', async () => {
    await expect(addAdmissionEmails(EVENT, STRANGER, { emails: ['a@x.io'], source: 'paste' })).rejects.toMatchObject({ statusCode: 403 });
    expect(entries).toHaveLength(0);
  });
});

describe('revokeAdmissionEmail and the list', () => {
  it('revokes once (audited with its person, who is told), a second revoke changes nothing, an unknown entry is 404', async () => {
    await addAdmissionEmails(EVENT, HOST, { emails: ['ana@x.io'], source: 'organiser' });
    const ana = entries[0];
    audit.length = 0;
    mockEmit.mockClear();
    await revokeAdmissionEmail(EVENT, HOST, ana.id);
    expect(ana.revoked_at).not.toBeNull();
    expect(audit).toEqual([{ action: 'admission.email_revoked', details: expect.objectContaining({ subjectUserIds: ['user-ana'] }) }]);
    expect(mockEmit).toHaveBeenCalledWith(expect.anything(), ['user-ana'], [`session:${EVENT}`, 'user:user-ana:sessions']);
    await revokeAdmissionEmail(EVENT, HOST, ana.id);
    expect(audit).toHaveLength(1);
    await expect(revokeAdmissionEmail(EVENT, HOST, 'entry-x')).rejects.toMatchObject({ statusCode: 404, code: 'ADMISSION_ENTRY_NOT_FOUND' });
  });

  it('lists by address with status, searches, and pages by cursor', async () => {
    await addAdmissionEmails(EVENT, HOST, { emails: ['cy@x.io', 'ana@x.io', 'bo@x.io'], source: 'paste' });
    await revokeAdmissionEmail(EVENT, HOST, entries.find((e) => e.email === 'cy@x.io')!.id);
    const first = await listAdmissionEntries(EVENT, HOST, { limit: 2 });
    expect(first.entries.map((e) => [e.email, e.status])).toEqual([['ana@x.io', 'registered'], ['bo@x.io', 'listed']]);
    expect(first.nextCursor).toBe('bo@x.io');
    const second = await listAdmissionEntries(EVENT, HOST, { limit: 2, cursor: first.nextCursor! });
    expect(second).toEqual({ entries: [expect.objectContaining({ email: 'cy@x.io', status: 'revoked', displayName: null })], nextCursor: null });
    expect((await listAdmissionEntries(EVENT, HOST, { q: ' BO' })).entries.map((e) => e.email)).toEqual(['bo@x.io']);
    await expect(listAdmissionEntries(EVENT, STRANGER)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the routes', () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/sessions', admissionRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  const as = (sub: string) => ({
    Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's' }, SECRET, { expiresIn: '1h' })}`,
  });

  it('GET and PUT /:id/admission answer the mode, what decides a place and the counts', async () => {
    const before = await request(app).get(`/sessions/${EVENT}/admission`).set(as('host-1'));
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ mode: null, effective: 'pod_rules', counts: { listed: 0, registered: 1, codesUnused: 2, codesUsed: 0 } });
    const put = await request(app).put(`/sessions/${EVENT}/admission`).set(as('host-1')).send({ mode: 'restricted' });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ mode: 'restricted', effective: 'restricted' });
    expect((await request(app).put(`/sessions/${EVENT}/admission`).set(as('host-1')).send({ mode: 'everyone' })).status).toBe(400);
    expect((await request(app).get(`/sessions/${EVENT}/admission`).set(as('member-9'))).status).toBe(403);
  });

  it('POST /:id/admission/emails over 300 KB is 413, before the service', async () => {
    const big = 'email\n' + 'x'.repeat(ADMISSION_BODY_MAX_BYTES);
    const res = await request(app).post(`/sessions/${EVENT}/admission/emails`).set(as('host-1')).send({ csv: big, source: 'csv' });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: 'That list is too big. Import at most 300 KB at a time.' });
    expect(allSql.some((s) => s.includes('event_admission_entries'))).toBe(false);
  });

  it('POST /:id/admission/emails with 2,001 rows is 400 in the organiser\'s words', async () => {
    const lines = ['email'];
    for (let i = 0; i < 2001; i++) lines.push(`p${i}@ex.io`);
    const res = await request(app).post(`/sessions/${EVENT}/admission/emails`).set(as('host-1')).send({ csv: lines.join('\n'), source: 'csv' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Import at most 2,000 addresses at a time.');
  });

  it('POST /:id/admission/emails answers the counts; a body with neither emails nor csv, or a bad group, is 400', async () => {
    const ok = await request(app).post(`/sessions/${EVENT}/admission/emails`).set(as('host-1'))
      .send({ csv: 'email\na@x.io\nb@x.io\na@x.io\n', source: 'csv', groupKey: 'sponsors' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ added: 2, alreadyListed: 0, restored: 0, invalid: [] });
    expect((await request(app).post(`/sessions/${EVENT}/admission/emails`).set(as('host-1')).send({ source: 'paste' })).status).toBe(400);
    expect((await request(app).post(`/sessions/${EVENT}/admission/emails`).set(as('host-1')).send({ emails: ['a@x.io'], source: 'paste', groupKey: 'Not A Key' })).status).toBe(400);
  });

  it('DELETE /:id/admission/emails/:entryId revokes; a path that is not an id is 400', async () => {
    await addAdmissionEmails(EVENT, HOST, { emails: ['ana@x.io'], source: 'paste' });
    // The stand-in's ids are not uuids; the route's own check refuses them before the service.
    expect((await request(app).delete(`/sessions/${EVENT}/admission/emails/${entries[0].id}`).set(as('host-1'))).status).toBe(400);
    const res = await request(app).delete(`/sessions/${EVENT}/admission/emails/7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b`).set(as('host-1'));
    expect(res.status).toBe(404);
  });
});

// ─── registerParticipant records what gave the place (admitted_via) ──────────────────────────────────────

describe('registerParticipant and admitted_via', () => {
  const ME = 'user-ana';
  /** A transaction client answering registerParticipant's reads for an event with `visibility` and `mode`. */
  function registerWorld(visibility: string | null, mode: string | null, facts: Record<string, unknown>) {
    const sql: Array<{ text: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn(async (text: string, params: unknown[] = []) => {
        const flat = text.replace(/\s+/g, ' ').trim();
        sql.push({ text: flat, params });
        if (flat.includes('FROM sessions WHERE id = $1') && flat.startsWith('SELECT id, pod_id')) {
          return { rows: [{ id: EVENT, podId: 'pod-1', hostUserId: 'host-1', status: 'scheduled', config: {}, visibility }] };
        }
        if (flat.includes('AS outside_closed_circle')) {
          return { rows: [{ visibility, pod_id: 'pod-1', pod_visibility: 'private', is_host: false, is_cohost: false, is_pod_organiser: false,
            in_audience: false, is_invited: false, participant_status: null, account_active: true, my_request: null,
            outside_closed_circle: false, admission_mode: mode, ...facts }] };
        }
        if (flat.startsWith('SELECT visibility FROM pods')) return { rows: [{ visibility: 'private' }] };
        if (flat.startsWith('SELECT role FROM pod_members')) return { rows: [{ role: 'member' }] };
        if (flat.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '1' }] };
        if (flat.startsWith('SELECT id, status, left_at FROM session_participants')) return { rows: [] };
        if (flat.startsWith('INSERT INTO session_participants')) return { rows: [{ id: 'sp-1', sessionId: EVENT, userId: ME, status: 'registered' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    return { client, sql };
  }

  async function register(visibility: string | null, mode: string | null, facts: Record<string, unknown> = {}, options = {}) {
    const world = registerWorld(visibility, mode, facts);
    const db = jest.requireMock('../../../db') as { transaction: unknown };
    const original = db.transaction;
    db.transaction = async (cb: (c: typeof world.client) => unknown) => cb(world.client);
    try {
      await registerParticipant(EVENT, ME, UserRole.MEMBER, options);
    } finally {
      db.transaction = original;
    }
    return world.sql;
  }

  it('records allow_list for a listed person on an invitation-only event, keeping the first answer', async () => {
    const sql = await register('private', 'restricted', { admission_listed: true });
    const write = sql.find((s) => s.text.startsWith('UPDATE session_participants SET admitted_via'))!;
    expect(write.text).toBe('UPDATE session_participants SET admitted_via = $3 WHERE session_id = $1 AND user_id = $2 AND admitted_via IS NULL');
    expect(write.params).toEqual([EVENT, ME, 'allow_list']);
  });

  it('records code, invite, approval and open as each applies', async () => {
    const via = async (mode: string, facts: Record<string, unknown>, options = {}) =>
      (await register('public', mode, facts, options)).find((s) => s.text.includes('SET admitted_via'))?.params[2];
    expect(await via('restricted', { admission_code_held: true })).toBe('code');
    expect(await via('restricted', { is_invited: true })).toBe('invite');
    expect(await via('approval', {}, { approvedRequest: true })).toBe('approval');
    expect(await via('open', {})).toBe('open');
  });

  it('refuses an unlisted person on an invitation-only event before any write', async () => {
    const world = registerWorld('private', 'restricted', {});
    const db = jest.requireMock('../../../db') as { transaction: unknown };
    const original = db.transaction;
    db.transaction = async (cb: (c: typeof world.client) => unknown) => cb(world.client);
    try {
      await expect(registerParticipant(EVENT, ME, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403, code: 'EVENT_ADMISSION_REQUIRED' });
    } finally {
      db.transaction = original;
    }
    expect(world.sql.some((s) => /^(INSERT|UPDATE)/.test(s.text))).toBe(false);
  });

  it('writes no admitted_via on an event without a mode, NULL visibility or explicit (dark on production)', async () => {
    for (const visibility of [null, 'public']) {
      const sql = await register(visibility, null, { in_audience: true });
      expect(sql.some((s) => s.text.includes('admitted_via'))).toBe(false);
      expect(sql.some((s) => s.text.startsWith('INSERT INTO session_participants'))).toBe(true);
    }
  });
});
