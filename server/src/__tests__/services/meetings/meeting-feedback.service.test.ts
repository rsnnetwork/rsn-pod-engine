// ─── Feedback after a meeting: the rules, with a stand-in database (30 Oct 2026, item 5c) ────────────
//
// Who may answer, in what order the refusals are checked, what is written (the partner as target, the source,
// each problem once, blank text as none), the CSV's cells, and production's client. The SQL itself runs on a real
// Postgres in meeting-feedback.sql.test.ts (opt-in); this file runs everywhere.

import * as fs from 'fs';
import * as path from 'path';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockAdminFanout = jest.fn();
jest.mock('../../../realtime/fanout', () => ({ __esModule: true, fanoutAdminEntities: (s: string) => mockAdminFanout(s) }));

import { E } from '../../../realtime/entities';
import {
  announceFeedbackToAdmins, csvCell, submitMeetingFeedback, isAdminFeedbackCursor,
} from '../../../services/meetings/meeting-feedback.service';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const M = 'dddddddd-0000-4000-8000-000000000004';
const NOW = new Date('2026-11-05T12:00:00Z');
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

const target = (extra: Record<string, unknown> = {}) => ({
  id: M, user_a_id: A, user_b_id: B, start_at: new Date('2026-11-05T11:30:00Z'), status: 'scheduled',
  author_active: true, blocked: false, ...extra,
});
const savedRow = { id: 'o-1', worth_continuing: 'maybe', problems: ['other', 'audio'], problem_text: 'Echo', created_at: new Date('2026-11-05T12:00:00Z') };

beforeEach(() => {
  mockQuery.mockReset();
  mockAdminFanout.mockReset().mockResolvedValue(undefined);
});

describe('submitMeetingFeedback', () => {
  it('writes the answer with the other person as its target, the meeting, its source, each problem once and the text trimmed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [target()] }).mockResolvedValueOnce({ rows: [savedRow] });
    const saved = await submitMeetingFeedback(B, M, { worthContinuing: 'maybe', problems: ['other', 'audio', 'other'], problemText: '  Echo ' }, NOW);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(flat(sql)).toMatch(/^INSERT INTO meeting_outcomes \(user_id, target_user_id, worth_continuing, meeting_id, source, problems, problem_text\)/);
    expect(flat(sql)).toContain('ON CONFLICT (user_id, meeting_id) WHERE meeting_id IS NOT NULL DO UPDATE');
    // An edit leaves outcome_keys (the profile sheet's chips) as they are.
    expect(flat(sql)).not.toMatch(/outcome_keys = /);
    expect(params).toEqual([B, A, 'maybe', M, 'meeting', ['audio', 'other'], 'Echo']);
    expect(saved).toEqual({ id: 'o-1', meetingId: M, worthContinuing: 'maybe', problems: ['audio', 'other'], problemText: 'Echo', createdAt: '2026-11-05T12:00:00.000Z' });
  });

  // T9 (migration 124): an answered call is a meetings row with source 'instant'; its feedback says so.
  it('an answer about an answered call is stored with source instant; a booked meeting\'s with source meeting', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [target({ source: 'instant' })] }).mockResolvedValueOnce({ rows: [savedRow] });
    await submitMeetingFeedback(B, M, { worthContinuing: 'yes' }, NOW);
    expect(flat(mockQuery.mock.calls[0][0])).toMatch(/SELECT m\.id, m\.user_a_id, m\.user_b_id, m\.start_at, m\.status, m\.source,/);
    expect(mockQuery.mock.calls[1][1][4]).toBe('instant');
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [target({ source: 'scheduled' })] }).mockResolvedValueOnce({ rows: [savedRow] });
    await submitMeetingFeedback(B, M, { worthContinuing: 'yes' }, NOW);
    expect(mockQuery.mock.calls[1][1][4]).toBe('meeting');
  });

  it('blank text is stored as no text, and no problems as an empty list', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [target()] }).mockResolvedValueOnce({ rows: [{ ...savedRow, problems: [], problem_text: null }] });
    await submitMeetingFeedback(A, M, { worthContinuing: 'yes', problemText: '   ' }, NOW);
    expect(mockQuery.mock.calls[1][1]).toEqual([A, B, 'yes', M, 'meeting', [], null]);
  });

  it('reads the author\'s status fresh with the meeting, and whether a block stands between the two', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [target()] }).mockResolvedValueOnce({ rows: [savedRow] });
    await submitMeetingFeedback(A, M, { worthContinuing: 'yes' }, NOW);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toContain("(author.status = 'active') AS author_active");
    expect(flat(sql)).toContain('FROM user_blocks ub');
    expect(params).toEqual([M, A]);
  });

  it.each([
    ['an unknown meeting', null, C, 404, "We couldn't find that meeting."],
    ['someone who is not one of the two', target(), C, 403, 'Only the two people in this meeting can say how it went.'],
    ['a participant whose account is closed', target({ author_active: false }), A, 403, 'Your account is closed, so you cannot leave feedback.'],
    ['a pair a block stands between', target({ blocked: true }), A, 404, "We couldn't find that meeting."],
    ['a cancelled meeting', target({ status: 'cancelled' }), A, 409, 'This meeting was cancelled, so there is nothing to say about it yet.'],
    ['a meeting that has not started', target({ start_at: new Date('2026-11-05T12:00:01Z') }), A, 409, 'You can say how it went once the meeting has started.'],
  ])('refuses %s and writes nothing', async (_label, found, who, status, message) => {
    mockQuery.mockResolvedValueOnce({ rows: found ? [found] : [] });
    await expect(submitMeetingFeedback(who, M, { worthContinuing: 'yes' }, NOW)).rejects.toMatchObject({ statusCode: status, message });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('takes an answer from the very minute the meeting starts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [target({ start_at: NOW })] }).mockResolvedValueOnce({ rows: [savedRow] });
    await expect(submitMeetingFeedback(A, M, { worthContinuing: 'no' }, NOW)).resolves.toMatchObject({ id: 'o-1' });
  });
});

describe('the admin list', () => {
  it('tells every admin through admin:meeting-feedback, and never throws when that fails', async () => {
    await announceFeedbackToAdmins();
    expect(`admin:${mockAdminFanout.mock.calls[0][0]}`).toBe(E.adminMeetingFeedback);
    expect(E.adminMeetingFeedback).toBe('admin:meeting-feedback');
    mockAdminFanout.mockRejectedValueOnce(new Error('socket down'));
    await expect(announceFeedbackToAdmins()).resolves.toBeUndefined();
  });

  it('takes only a page edge it wrote: a time to the microsecond and an id', () => {
    expect(isAdminFeedbackCursor('2026-11-01T10:00:00.123456Z~5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e')).toBe(true);
    expect(isAdminFeedbackCursor('2026-11-01T10:00:00.123Z~5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e')).toBe(false);
    expect(isAdminFeedbackCursor("2026-11-01T10:00:00.123456Z~x' OR 1=1")).toBe(false);
  });

  it('writes a cell a spreadsheet would run as a formula as text, and quotes commas, quotes and line breaks', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@me')).toBe("'@me");
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('2026-11-01T10:00:00.000Z')).toBe('2026-11-01T10:00:00.000Z');
  });
});

describe('production\'s client', () => {
  const client = path.join(__dirname, '../../../../../client/src');

  it('its meeting room leaves the way it always did: it never calls the feedback route', () => {
    const meetPage = fs.readFileSync(path.join(client, 'features/messages/MeetPage.tsx'), 'utf8');
    expect(meetPage).not.toMatch(/\/feedback/);
  });
});
