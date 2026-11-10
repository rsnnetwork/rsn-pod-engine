// ─── Admission codes: one-time, keyed-hash only, guess-proof (Part 2, Task 4, 10 Nov 2026; Review Focus 4) ────────
//
// Spec 04 ("individual invitation codes"), 11 ("invitation codes must be handled securely"), edge case "invitation code
// reused". The real service runs against a small in-memory stand-in for event_admission_codes that answers the
// service's own statements (each statement is atomic, as one Postgres statement on one row is); the real router and
// rate limiters answer the HTTP tries. The statements themselves run on Postgres in the task's probe (see the report).

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
  resolveEventOrganiserIds: jest.fn().mockResolvedValue(['host-1']),
  __esModule: true,
}));
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => ({}),
  __esModule: true,
}));
const mockFanoutSession = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: (...a: unknown[]) => mockFanoutSession(...a),
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

// ── The stand-in table ──────────────────────────────────────────────────────

interface CodeRow {
  id: string; session_id: string; code_hash: string; code_last4: string; label: string | null; group_key: string | null;
  created_by: string | null; expires_at: Date | null; redeemed_by: string | null; redeemed_at: Date | null;
  revoked_at: Date | null; created_at: Date;
}
const codes: CodeRow[] = [];
const audit: Array<{ action: string; details: string; params: unknown[] }> = [];
const allSql: Array<{ sql: string; params: unknown[] }> = [];
let seq = 0;
const EVENT = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
const OTHER_EVENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

async function fakeQuery(sql: string, params: unknown[] = []) {
  allSql.push({ sql, params });
  const flat = sql.replace(/\s+/g, ' ').trim();
  const now = new Date();
  const live = (c: CodeRow) => c.session_id === params[0] && c.code_hash === params[1];
  if (flat.startsWith('SELECT status, account_kind FROM users')) return { rows: [{ status: 'active', account_kind: 'member' }] };
  if (flat.includes('FROM sessions s LEFT JOIN pods p')) {
    return { rows: params[0] === EVENT ? [{ pod_id: 'pod-1', status: 'scheduled', visibility: 'private', admission_mode: 'restricted', pod_visibility: 'private' }] : [] };
  }
  if (flat.startsWith('SELECT pod_id FROM sessions')) return { rows: [{ pod_id: 'pod-1' }] };
  if (flat.startsWith('INSERT INTO audit_log')) { audit.push({ action: params[1] as string, details: params[3] as string, params }); return { rows: [] }; }
  if (flat.startsWith('INSERT INTO event_admission_codes')) {
    const [sessionId, hashes, last4s, label, groupKey, by, expires] = params as [string, string[], string[], string | null, string | null, string, Date | null];
    const rows: Array<{ id: string; code_hash: string }> = [];
    hashes.forEach((h, i) => {
      if (codes.some((c) => c.session_id === sessionId && c.code_hash === h)) return;
      const row: CodeRow = {
        id: `code-${++seq}`, session_id: sessionId, code_hash: h, code_last4: last4s[i], label, group_key: groupKey,
        created_by: by, expires_at: expires, redeemed_by: null, redeemed_at: null, revoked_at: null, created_at: new Date(now.getTime() + seq),
      };
      codes.push(row);
      rows.push({ id: row.id, code_hash: h });
    });
    return { rows };
  }
  if (flat.startsWith('UPDATE event_admission_codes SET redeemed_by')) {
    const c = codes.find((r) => live(r) && !r.redeemed_at && !r.revoked_at && (!r.expires_at || r.expires_at > now));
    if (!c) return { rows: [] };
    c.redeemed_by = params[2] as string; c.redeemed_at = now;
    return { rows: [{ id: c.id, group_key: c.group_key }] };
  }
  if (flat.startsWith('SELECT id, group_key, redeemed_by')) {
    const c = codes.find(live);
    return { rows: c ? [{ id: c.id, group_key: c.group_key, redeemed_by: c.redeemed_by, revoked: !!c.revoked_at, expired: !!c.expires_at && c.expires_at <= now }] : [] };
  }
  if (flat.startsWith('UPDATE event_admission_codes SET revoked_at')) {
    const c = codes.find((r) => r.id === params[0] && r.session_id === params[1] && !r.revoked_at);
    if (!c) return { rows: [] };
    c.revoked_at = now;
    return { rows: [{ redeemed_by: c.redeemed_by }] };
  }
  if (flat.startsWith('SELECT 1 FROM event_admission_codes WHERE id')) {
    return { rows: codes.filter((r) => r.id === params[0] && r.session_id === params[1]).map(() => ({ '?column?': 1 })) };
  }
  if (flat.startsWith('SELECT c.id, c.code_last4 AS last4')) {
    return {
      rows: codes.filter((c) => c.session_id === params[0]).reverse().map((c) => ({
        id: c.id, last4: c.code_last4, label: c.label, group_key: c.group_key, revoked: !!c.revoked_at, used: !!c.redeemed_at,
        expired: !!c.expires_at && c.expires_at <= now, redeemer_id: c.redeemed_by, redeemer_name: c.redeemed_by ? `Name of ${c.redeemed_by}` : null,
      })),
    };
  }
  throw new Error(`unexpected SQL in the stand-in: ${flat.slice(0, 120)}`);
}

jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => fakeQuery(sql, params),
  transaction: async (cb: (client: { query: typeof fakeQuery }) => unknown) => cb({ query: fakeQuery }),
  __esModule: true,
}));

import { UserRole } from '@rsn/shared';
import {
  ADMISSION_CODE_ALPHABET, formatAdmissionCode, generateAdmissionCodes, hashAdmissionCode, listAdmissionCodes,
  newAdmissionCode, normaliseAdmissionCode, redeemAdmissionCode, revokeAdmissionCode,
} from '../../../services/session/event-admission.service';
import admissionRoutes from '../../../routes/event-admission';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';

const HOST = { userId: 'host-1', role: UserRole.MEMBER };

beforeEach(() => {
  codes.length = 0;
  audit.length = 0;
  allSql.length = 0;
  mockEmit.mockClear();
  mockFanoutSession.mockClear();
  mockCanActAsHost.mockImplementation(async (userId: string) => ({ allowed: userId === 'host-1', effectiveRole: userId === 'host-1' ? 'event_host' : 'participant' }));
});

const plainOf = (code: string) => code.split('-').join('');

describe('generating codes', () => {
  it('500 codes are distinct, 12 symbols of the Crockford alphabet, shown XXXX-XXXX-XXXX, and none is stored', async () => {
    const { codes: made } = await generateAdmissionCodes(EVENT, HOST, { count: 500, label: 'Sponsors' });
    expect(made).toHaveLength(500);
    expect(new Set(made.map((c) => c.code)).size).toBe(500);
    for (const { code } of made) {
      expect(code).toHaveLength(14);
      expect(code[4]).toBe('-');
      expect(code[9]).toBe('-');
      for (const ch of plainOf(code)) expect(ADMISSION_CODE_ALPHABET).toContain(ch);
    }
    // No 12-symbol code string in any row, any statement's parameters, or the audit row: only keyed hashes and last fours.
    const stored = JSON.stringify({ codes, audit, params: allSql.map((s) => s.params) });
    for (const { code } of made) {
      expect(stored).not.toContain(plainOf(code));
      expect(stored).not.toContain(code);
    }
    for (const row of codes) {
      expect(row.code_hash).toHaveLength(64);
      expect(row.code_last4).toHaveLength(4);
    }
    expect(made.map((c) => plainOf(c.code).slice(-4)).sort()).toEqual(codes.map((r) => r.code_last4).sort());
    expect(audit).toEqual([expect.objectContaining({ action: 'admission.codes_generated' })]);
    expect(JSON.parse(audit[0].details)).toMatchObject({ automatic: false, after: { count: 500, label: 'Sponsors' } });
    expect(mockEmit).toHaveBeenCalledWith(expect.anything(), ['host-1'], [`session:${EVENT}:admission`, `session:${EVENT}`]);
  });

  it('a code is 60 bits from crypto.randomInt, and its hash is keyed by the secret and bound to its event', () => {
    expect(ADMISSION_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(ADMISSION_CODE_ALPHABET.length ** 12).toBe(2 ** 60);
    const code = newAdmissionCode();
    expect(hashAdmissionCode(EVENT, code)).not.toBe(hashAdmissionCode(OTHER_EVENT, code));
    expect(hashAdmissionCode(EVENT, code)).toBe(hashAdmissionCode(EVENT.toUpperCase(), code));
    const crypto = jest.requireActual('crypto') as typeof import('crypto');
    expect(hashAdmissionCode(EVENT, code)).toBe(
      crypto.createHmac('sha256', SECRET).update(`admission-code:${EVENT}:${code}`).digest('hex'),
    );
  });

  it('only the event\'s organisers make codes, between 1 and 500, with an expiry in the future', async () => {
    await expect(generateAdmissionCodes(EVENT, { userId: 'member-9', role: UserRole.MEMBER }, { count: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(generateAdmissionCodes(EVENT, HOST, { count: 0 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(generateAdmissionCodes(EVENT, HOST, { count: 501 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(generateAdmissionCodes(EVENT, HOST, { count: 1, expiresAt: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(generateAdmissionCodes(OTHER_EVENT, HOST, { count: 1 })).rejects.toMatchObject({ statusCode: 404 });
    expect(codes).toHaveLength(0);
  });
});

describe('redeeming a code', () => {
  async function oneCode(extra: { expiresAt?: string } = {}) {
    const { codes: made } = await generateAdmissionCodes(EVENT, HOST, { count: 1, groupKey: 'sponsors', ...extra });
    return made[0];
  }

  it('the first person redeems it; the same person again (another device) gets it back; anyone else is refused', async () => {
    const code = await oneCode();
    expect(await redeemAdmissionCode(EVENT, 'ana', code.code)).toEqual({ codeId: code.id, groupKey: 'sponsors' });
    expect(await redeemAdmissionCode(EVENT, 'ana', code.code)).toEqual({ codeId: code.id, groupKey: 'sponsors' });
    await expect(redeemAdmissionCode(EVENT, 'bo', code.code)).rejects.toMatchObject({
      statusCode: 409, code: 'ADMISSION_CODE_USED', message: 'This admission code has already been used.',
    });
    expect(codes[0].redeemed_by).toBe('ana');
    // One audit row for the redemption itself, none for the repeat or the refusal.
    expect(audit.filter((a) => a.action === 'admission.code_redeemed')).toHaveLength(1);
    expect(mockFanoutSession).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(expect.anything(), ['ana'], [`session:${EVENT}`, 'user:ana:sessions']);
  });

  it('case, spaces and dashes are ignored, and O, I and L read as 0, 1 and 1', async () => {
    const code = await oneCode();
    const typed = ` ${code.code.toLowerCase().split('-').join(' - ')} `;
    expect(await redeemAdmissionCode(EVENT, 'ana', typed)).toMatchObject({ codeId: code.id });
    expect(normaliseAdmissionCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normaliseAdmissionCode('O1IL-0000-0000')).toBe('0111' + '00000000');
    expect(normaliseAdmissionCode('ABCD-EFGH-JKM')).toBeNull();
    expect(normaliseAdmissionCode('ABCD-EFGH-JKMNP')).toBeNull();
    expect(normaliseAdmissionCode('ABCD-EFGH-JKMU')).toBeNull();
    expect(formatAdmissionCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('an expired code is 400 ADMISSION_CODE_EXPIRED', async () => {
    const code = await oneCode({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    codes[0].expires_at = new Date(Date.now() - 1000);
    await expect(redeemAdmissionCode(EVENT, 'ana', code.code)).rejects.toMatchObject({
      statusCode: 400, code: 'ADMISSION_CODE_EXPIRED', message: 'This admission code has expired.',
    });
    expect(codes[0].redeemed_by).toBeNull();
  });

  it('a revoked, unknown, malformed or other event\'s code is one identical 400 ADMISSION_CODE_INVALID', async () => {
    const code = await oneCode();
    await revokeAdmissionCode(EVENT, HOST, code.id);
    const invalid = { statusCode: 400, code: 'ADMISSION_CODE_INVALID', message: 'That admission code is not right.' };
    await expect(redeemAdmissionCode(EVENT, 'ana', code.code)).rejects.toMatchObject(invalid);
    await expect(redeemAdmissionCode(EVENT, 'ana', formatAdmissionCode(newAdmissionCode()))).rejects.toMatchObject(invalid);
    await expect(redeemAdmissionCode(EVENT, 'ana', 'not a code')).rejects.toMatchObject(invalid);
    // A code made for one event is not a code of another (nor of an event that does not exist, or a draft).
    const other = await oneCode();
    await expect(redeemAdmissionCode(OTHER_EVENT, 'ana', other.code)).rejects.toMatchObject(invalid);
  });

  it('two people redeeming the same code at once: exactly one wins, the other is told it was used', async () => {
    const code = await oneCode();
    const outcomes = await Promise.allSettled([
      redeemAdmissionCode(EVENT, 'ana', code.code),
      redeemAdmissionCode(EVENT, 'bo', code.code),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ statusCode: 409, code: 'ADMISSION_CODE_USED' });
    expect(['ana', 'bo']).toContain(codes[0].redeemed_by);
  });

  it('claims in one guarded UPDATE: unredeemed, unrevoked and unexpired, by the keyed hash, never the plaintext', async () => {
    const code = await oneCode();
    allSql.length = 0;
    await redeemAdmissionCode(EVENT, 'ana', code.code);
    const claim = allSql.find((s) => s.sql.includes('SET redeemed_by'))!;
    expect(claim.sql.replace(/\s+/g, ' ')).toContain(
      'WHERE session_id = $1 AND code_hash = $2 AND redeemed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) RETURNING id, group_key',
    );
    expect(claim.params).toEqual([EVENT, hashAdmissionCode(EVENT, plainOf(code.code)), 'ana']);
  });

  it('with a client it is part of the caller\'s transaction and leaves telling the screens to the caller', async () => {
    const code = await oneCode();
    const client = { query: jest.fn((sql: string, params: unknown[]) => fakeQuery(sql, params)) };
    await redeemAdmissionCode(EVENT, 'ana', code.code, client as never);
    expect(client.query).toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });
});

describe('the organisers\' list and revoke', () => {
  it('shows the last four symbols and what became of each code, never the code', async () => {
    const { codes: made } = await generateAdmissionCodes(EVENT, HOST, { count: 3 });
    await redeemAdmissionCode(EVENT, 'ana', made[0].code);
    await revokeAdmissionCode(EVENT, HOST, made[1].id);
    const list = await listAdmissionCodes(EVENT, HOST);
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(made[0].id)).toMatchObject({ status: 'used', redeemedBy: { id: 'ana', displayName: 'Name of ana' } });
    expect(byId.get(made[1].id)).toMatchObject({ status: 'revoked', redeemedBy: null });
    expect(byId.get(made[2].id)).toMatchObject({ status: 'unused', last4: plainOf(made[2].code).slice(-4) });
    expect(JSON.stringify(list)).not.toContain(plainOf(made[2].code));
    await expect(listAdmissionCodes(EVENT, { userId: 'member-9', role: UserRole.MEMBER })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('revoking a redeemed code audits its person and tells them; revoking twice changes nothing; an unknown code is 404', async () => {
    const { codes: made } = await generateAdmissionCodes(EVENT, HOST, { count: 1 });
    await redeemAdmissionCode(EVENT, 'ana', made[0].code);
    audit.length = 0;
    await revokeAdmissionCode(EVENT, HOST, made[0].id);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details)).toMatchObject({ subjectUserIds: ['ana'] });
    await revokeAdmissionCode(EVENT, HOST, made[0].id);
    expect(audit).toHaveLength(1);
    await expect(revokeAdmissionCode(EVENT, HOST, 'code-unknown')).rejects.toMatchObject({ statusCode: 404, code: 'ADMISSION_CODE_NOT_FOUND' });
  });
});

describe('POST /sessions/:id/admission/redeem: brute force (Review Focus 4)', () => {
  const app = express();
  app.use(express.json());
  app.use('/sessions', admissionRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  const as = (sub: string) => ({
    Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's' }, SECRET, { expiresIn: '1h' })}`,
  });
  const EVENTS = ['1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b', '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c', '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d'];

  it('the 11th wrong try in an hour by one person on one event is 429; another event has its own ten', async () => {
    const me = as('guesser-1');
    const ip = { 'cf-connecting-ip': '203.0.113.1' };
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post(`/sessions/${EVENTS[0]}/admission/redeem`).set(me).set(ip).send({ code: formatAdmissionCode(newAdmissionCode()) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ADMISSION_CODE_INVALID');
    }
    const eleventh = await request(app).post(`/sessions/${EVENTS[0]}/admission/redeem`).set(me).set(ip).send({ code: 'AAAA-BBBB-CCCC' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error).toEqual({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many codes tried. Please wait an hour, then try again.' });
    const otherEvent = await request(app).post(`/sessions/${EVENTS[1]}/admission/redeem`).set(me).set(ip).send({ code: 'AAAA-BBBB-CCCC' });
    expect(otherEvent.status).toBe(400);
  });

  it('a right code never counts, and thirty wrong tries from one address across people and events stop the 31st', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.2' };
    const { codes: made } = await generateAdmissionCodes(EVENT, HOST, { count: 1 });
    for (let i = 0; i < 15; i++) {
      const ok = await request(app).post(`/sessions/${EVENT}/admission/redeem`).set(as('rightful')).set(ip).send({ code: made[0].code });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ ok: true, groupKey: null });
    }
    let sent = 0;
    for (let p = 0; p < 3; p++) {
      for (let i = 0; i < 10; i++) {
        const res = await request(app).post(`/sessions/${EVENTS[p]}/admission/redeem`).set(as(`spread-${p}`)).set(ip).send({ code: 'AAAA-BBBB-CCCC' });
        expect(res.status).toBe(400);
        sent++;
      }
    }
    expect(sent).toBe(30);
    const next = await request(app).post(`/sessions/${EVENTS[3]}/admission/redeem`).set(as('spread-4')).set(ip).send({ code: 'AAAA-BBBB-CCCC' });
    expect(next.status).toBe(429);
  });

  it('an empty or over-long code, and a path that is not an event, are refused before the service', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.3' };
    expect((await request(app).post(`/sessions/${EVENT}/admission/redeem`).set(as('shape')).set(ip).send({ code: '' })).status).toBe(400);
    expect((await request(app).post(`/sessions/${EVENT}/admission/redeem`).set(as('shape')).set(ip).send({ code: 'x'.repeat(41) })).status).toBe(400);
    expect((await request(app).post('/sessions/not-an-event/admission/redeem').set(as('shape')).set(ip).send({ code: 'AAAA' })).status).toBe(400);
    expect((await request(app).post(`/sessions/${EVENT}/admission/redeem`).set(ip).send({ code: 'AAAA' })).status).toBe(401);
  });
});
