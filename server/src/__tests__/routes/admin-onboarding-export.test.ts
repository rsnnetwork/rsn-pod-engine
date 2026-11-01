// ─── GET /admin/onboarding/export.csv (30 Oct review, 2.3; L4, D12, D13) ─────
//
// "Onboarding answers should be saved and visible in the admin report." The report is a CSV an admin can open in a
// sheet: one row per active member with every answer as its label, never a key. Members' own words leave REASON in
// this file, so each download is written to audit_log. A read, so no entity tags. Through the real router: the
// authenticate and requireRole middleware run; the database is a stand-in that answers by the SQL it is sent.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));
const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../middleware/audit', () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a), __esModule: true }));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: (...a: unknown[]) => mockFanout(...a),
  fanoutUserEntity: (...a: unknown[]) => mockFanout(...a),
  __esModule: true,
}));

import { query as dbQuery } from '../../db';
import adminRoutes from '../../routes/admin';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/admin', adminRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (role: string, sub = 'admin-1') =>
  jwt.sign({ sub, email: `${sub}@e.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '15m' });

const member = (over: Record<string, unknown>) => ({
  display_name: 'Ana Baker', email: 'ana@e.com', onboarding_status: 'completed', last_onboarded_at: null,
  onboarding_version: null, location: null, timezone: null, onboarding_intent: null,
  looking_to_meet: null, meet_other: null, hoping_to_find: null, find_other: null, find_specific: null,
  can_offer: null, offer_other: null, self_kinds: null, self_other: null,
  ...over,
});

let rows: Record<string, unknown>[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  (dbQuery as jest.Mock).mockImplementation((sql: string) => {
    if (/SELECT\s+status\s+FROM\s+users/i.test(sql)) return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
    if (/u\.find_specific/.test(sql)) return Promise.resolve({ rows, rowCount: rows.length });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

const download = (role = 'admin', sub?: string) =>
  request(app).get('/admin/onboarding/export.csv').set('Authorization', `Bearer ${token(role, sub)}`);

/** The CSV as rows of cells (no cell in these fixtures holds a line break). */
const parse = (csv: string): string[][] => csv.trim().split('\n').map((line) => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { cells.push(cell); cell = ''; } else cell += ch;
  }
  cells.push(cell);
  return cells;
});

describe('who may download it', () => {
  it('401 signed out, 403 for a member or a host, 200 for an admin and a super admin', async () => {
    expect((await request(app).get('/admin/onboarding/export.csv')).status).toBe(401);
    expect((await download('member', 'm-1')).status).toBe(403);
    expect((await download('host', 'h-1')).status).toBe(403);
    expect((await download('admin', 'a-1')).status).toBe(200);
    expect((await download('super_admin', 'sa-1')).status).toBe(200);
    // Only the two admins' downloads were logged.
    expect(mockAudit).toHaveBeenCalledTimes(2);
  });
});

describe('the report', () => {
  it('one row per active member, every answer as its label, own words and the specific wish beside them', async () => {
    rows = [
      member({
        display_name: 'Ana Baker', email: 'ana@e.com', onboarding_version: 2,
        last_onboarded_at: new Date('2026-10-30T09:00:00.000Z'), location: 'Copenhagen, Denmark', timezone: 'Europe/Copenhagen',
        looking_to_meet: ['investors', 'meet_investors', 'meet_other'], meet_other: 'bakers in Vienna',
        hoping_to_find: ['find_funding', 'find_cofounder'], find_specific: 'a seed lead, ideally "warm"',
        can_offer: ['offer_advice_mentoring'], self_kinds: ['self_founder_owner', 'self_other'], self_other: 'Pastry chef',
      }),
      member({ display_name: 'Claus Earlier', email: 'c@e.com', looking_to_meet: ['investors'], location: 'Nepal' }),
      member({ display_name: 'Dee New', email: 'd@e.com', onboarding_status: 'update_required' }),
    ];
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="reason-onboarding-answers-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');

    const [header, ana, claus, dee] = parse(res.text);
    expect(header).toEqual([
      'Name', 'Email', 'Onboarding', 'Status', 'Last onboarded', 'Location', 'Time zone',
      'Who they want to meet', 'Meet (own words)', 'Hoping to find', 'Find (own words)', 'Anything specific',
      'Can offer', 'Offer (own words)', 'Describes themselves as', 'Self (own words)',
    ]);
    expect(ana).toEqual([
      'Ana Baker', 'ana@e.com', 'New onboarding', 'completed', '2026-10-30T09:00:00.000Z', 'Copenhagen, Denmark', 'Europe/Copenhagen',
      'Investors; Something else', 'bakers in Vienna', 'Raising funding; A cofounder', '', 'a seed lead, ideally "warm"',
      'Advice and mentoring', '', 'Founder or business owner; Something else', 'Pastry chef',
    ]);
    expect(claus.slice(0, 8)).toEqual(['Claus Earlier', 'c@e.com', 'Earlier onboarding', 'completed', '', 'Nepal', '', '']);
    expect(dee.slice(2, 4)).toEqual(['Not done', 'update_required']);
  });

  it('reads only active members, by name, at most 1000', async () => {
    await download();
    const call = (dbQuery as jest.Mock).mock.calls.find(c => /u\.find_specific/.test(c[0] as string))!;
    expect(call[0]).toMatch(/WHERE u\.status = 'active'/);
    expect(call[0]).toMatch(/ORDER BY lower\(COALESCE\(u\.display_name, u\.email\)\), u\.id/);
    expect(call[0]).toMatch(/LIMIT \$1/);
    expect(call[1]).toEqual([1000]);
  });

  it('a cell a spreadsheet would run as a formula is written as text', async () => {
    rows = [member({ display_name: '=HYPERLINK("x")', self_kinds: ['self_other'], self_other: '+1 and -1', location: '@home, Denmark' })];
    const [, row] = parse((await download()).text);
    expect(row[0]).toBe('\'=HYPERLINK("x")');
    expect(row[5]).toBe('\'@home, Denmark');
    expect(row[15]).toBe('\'+1 and -1');
  });

  it('with no members it is the header row alone', async () => {
    const res = await download();
    expect(parse(res.text)).toHaveLength(1);
  });

  it('each download is written to audit_log with who took it and how many rows, and tells no screen', async () => {
    rows = [member({}), member({ email: 'b@e.com' })];
    await download('admin', 'admin-7');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-7', action: 'admin.onboarding_csv_download', entityType: 'user', entityId: null, details: { rows: 2 },
    }));
    expect(mockFanout).not.toHaveBeenCalled();
  });
});
