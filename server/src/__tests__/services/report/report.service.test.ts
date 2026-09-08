// ─── User reports (report → admin moderation queue) ─────────────────────────
//
// 8 Sep 2026 (Ali): a report filed from a chat carries the conversation so
// admins can review the messages behind it — but only if the reporter is
// actually in that conversation (no spoofing another chat's id).

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { submitReport } from '../../../services/report/report.service';

const REPORTER = 'u-reporter';
const REPORTED = 'u-reported';
const CONV = 'conv-1';

function insertRow() {
  return { rows: [{
    id: 'rep-1', reporter_id: REPORTER, reported_id: REPORTED, reason: 'spam',
    description: null, status: 'open', resolved_by: null, resolved_at: null,
    resolution_notes: null, created_at: new Date(),
  }] };
}

beforeEach(() => mockQuery.mockReset());

it('rejects a self-report', async () => {
  await expect(submitReport(REPORTER, REPORTER, 'spam')).rejects.toMatchObject({ statusCode: 400 });
});

it('stores the conversation when the reporter is part of it', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: REPORTED }] });
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: CONV }] });
    if (/INSERT INTO user_reports/.test(sql)) return Promise.resolve(insertRow());
    return Promise.resolve({ rows: [] });
  });
  await submitReport(REPORTER, REPORTED, 'spam', 'bad', CONV);
  const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_reports/.test(c[0] as string))!;
  expect(String(insert[0])).toMatch(/conversation_id/);
  expect((insert[1] as unknown[])[5]).toBe(CONV); // conversation stored
});

it('drops a conversation id the reporter does NOT belong to (no spoofing)', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: REPORTED }] });
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [] }); // not a participant
    if (/INSERT INTO user_reports/.test(sql)) return Promise.resolve(insertRow());
    return Promise.resolve({ rows: [] });
  });
  await submitReport(REPORTER, REPORTED, 'spam', undefined, 'someone-elses-conv');
  const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_reports/.test(c[0] as string))!;
  expect((insert[1] as unknown[])[5]).toBeNull();
});

it('stores null conversation when reported from a profile (no conversation id)', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: REPORTED }] });
    if (/INSERT INTO user_reports/.test(sql)) return Promise.resolve(insertRow());
    return Promise.resolve({ rows: [] });
  });
  await submitReport(REPORTER, REPORTED, 'spam');
  const convLookup = mockQuery.mock.calls.find(c => /FROM dm_conversations WHERE id/.test(c[0] as string));
  expect(convLookup).toBeUndefined(); // no conversation lookup at all
  const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_reports/.test(c[0] as string))!;
  expect((insert[1] as unknown[])[5]).toBeNull();
});
