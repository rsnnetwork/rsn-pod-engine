// ─── A join request is stored under the lower-case email (21 Oct 2026) ───────
//
// The sign-in gate (identity.service.ts isEmailApproved) trims and lower-cases the address it
// is asked about and compares it EXACTLY with join_requests.email, as does every other table
// that holds an email (users and invites are written lower case). The request form stored the
// address as typed, so someone who wrote "Jane.Doe@Example.com" was approved and then turned
// away at sign-in with "Registration requires an approved join request": the gate looked for
// "jane.doe@example.com" and never found the row. The request is now stored trimmed and lower
// case, before the check for a pending request and before the insert.
//
// These go through express with the real router and services; only the database and the emails
// are stand-ins. The stand-in compares emails exactly, as the column's `=` does.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestConfirmationEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestAdminReviewEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/onboarding/providers/registry', () => ({
  resolveEnrichProvider: () => 'none',
  runProvider: jest.fn(),
  resultFromOutcome: jest.fn(),
  statusFromResult: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/onboarding/enrichment.service', () => ({
  applyMatchVerification: jest.fn(),
  normalizeLinkedinUrl: jest.fn(),
  __esModule: true,
}));
jest.mock('../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

// ── The stand-in database ────────────────────────────────────────────────────

interface JoinRow {
  id: string; full_name: string; email: string; linkedin_url: string; reason: string; status: string;
  sign_in_origin: string | null; created_at: Date; updated_at: Date;
}
let joinRows: JoinRow[];

const answer = (rows: unknown[]) => Promise.resolve({ rows, rowCount: rows.length });

function database(sql: string, params: unknown[] = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (/^SELECT id FROM join_requests WHERE email = \$1 AND status = 'pending'/.test(text)) {
    return answer(joinRows.filter((r) => r.email === params[0] && r.status === 'pending'));
  }
  if (/^SELECT id FROM join_requests WHERE email = \$1 AND status = 'approved'/.test(text)) {
    return answer(joinRows.filter((r) => r.email === params[0] && r.status === 'approved'));
  }
  if (/^INSERT INTO join_requests/.test(text)) {
    const now = new Date('2026-10-21T10:00:00Z');
    const row: JoinRow = {
      id: `jr-${joinRows.length + 1}`, full_name: String(params[0]), email: String(params[1]), linkedin_url: String(params[2]),
      reason: String(params[3]), status: 'pending', sign_in_origin: null, created_at: now, updated_at: now,
    };
    joinRows.push(row);
    return answer([row]);
  }
  return answer([]); // no members, no invites, no admins, nothing else
}
const mockQuery = jest.fn();

jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) }),
  __esModule: true,
}));

import joinRequestRoutes from '../../routes/join-requests';
import { createJoinRequest } from '../../services/join-request/join-request.service';
import { sendMagicLink } from '../../services/identity/identity.service';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { sendMagicLinkEmail, sendJoinRequestConfirmationEmail } from '../../services/email/email.service';

const app = express();
app.use(express.json());
app.use('/join-requests', joinRequestRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const TYPED = 'Jane.Doe@Example.com';
const STORED = 'jane.doe@example.com';
const BODY = { fullName: 'Jane Doe', email: TYPED, linkedinUrl: 'https://www.linkedin.com/in/jane-doe', reason: 'I run a studio' };

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const submit = (body: object = BODY) => request(app).post('/join-requests').send(body);
const callsTo = (pattern: RegExp) => mockQuery.mock.calls.filter((c) => pattern.test(String(c[0])));

beforeEach(() => {
  joinRows = [];
  mockQuery.mockReset().mockImplementation(database);
  (sendMagicLinkEmail as jest.Mock).mockClear();
  (sendJoinRequestConfirmationEmail as jest.Mock).mockClear();
});

describe('POST /join-requests: the email is stored lower case', () => {
  it(`"${TYPED}" is stored, and answered, as "${STORED}"`, async () => {
    const res = await submit();

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe(STORED);
    expect(joinRows.map((r) => r.email)).toEqual([STORED]);
  });

  it('the check for a pending request and the insert both use that form', async () => {
    await submit();

    expect(callsTo(/FROM join_requests WHERE email = \$1 AND status = 'pending'/)[0][1]).toEqual([STORED]);
    expect((callsTo(/INSERT INTO join_requests/)[0][1] as unknown[])[1]).toBe(STORED);
  });

  it('the same person in other capitals is one pending request: the second is refused', async () => {
    expect((await submit()).status).toBe(201);

    const again = await submit({ ...BODY, email: 'JANE.DOE@EXAMPLE.COM' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('You already have a pending request.');
    expect(joinRows).toHaveLength(1);
  });

  it('the confirmation email goes to the address as stored', async () => {
    await submit();
    await flush();

    expect(sendJoinRequestConfirmationEmail).toHaveBeenCalledWith(STORED, 'Jane Doe');
  });

  it('an address already in lower case is stored exactly as before', async () => {
    const res = await submit({ ...BODY, email: STORED });

    expect(res.status).toBe(201);
    expect(joinRows.map((r) => r.email)).toEqual([STORED]);
  });

  it('createJoinRequest trims the address too, for a caller that does not go through the form', async () => {
    const created = await createJoinRequest({ ...BODY, email: `  ${TYPED}  ` });

    expect(created.email).toBe(STORED);
    expect(joinRows.map((r) => r.email)).toEqual([STORED]);
    expect(callsTo(/FROM join_requests WHERE email = \$1 AND status = 'pending'/)[0][1]).toEqual([STORED]);
  });
});

describe('the sign-in gate finds the request however the email was typed', () => {
  it(`once "${TYPED}" is approved, Jane can ask for a sign-in link`, async () => {
    await submit();
    joinRows[0].status = 'approved'; // what an admin's Approve does

    await expect(sendMagicLink(TYPED)).resolves.toEqual({ sent: true });
    expect(sendMagicLinkEmail).toHaveBeenCalledWith(STORED, expect.stringContaining('/auth/verify?token='));
  });

  it('and is still turned away while the request is only pending', async () => {
    await submit();

    await expect(sendMagicLink(TYPED)).rejects.toMatchObject({ statusCode: 403, code: 'REGISTRATION_BLOCKED' });
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });
});
