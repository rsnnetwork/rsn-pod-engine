// ─── The meeting calendar file says REASON (21 Oct 2026) ─────────────────────
//
// The client's 19 Oct feedback: "Call it REASON everywhere". The "Add to calendar" file for a
// confirmed meeting is named reason-meeting.ics, and the entry it creates is a "REASON meeting".
//
// These go through express with the real router; only the sign-in check, the meeting lookup,
// the database and the config are stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network' },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'u-a', email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockScheduling = jest.fn();
jest.mock('../../services/dm/meeting-windows.service', () => ({
  getScheduling: (...a: unknown[]) => mockScheduling(...a),
  __esModule: true,
}));
jest.mock('../../services/dm/meeting-call.service', () => ({ __esModule: true }));
jest.mock('../../services/presence/presence.service', () => ({ areActive: jest.fn(), __esModule: true }));
// The two people, and (26 Oct 2026) the meeting's own row: the SEQUENCE its invite is at and who booked it.
const mockMeetingRow = jest.fn();
const mockQuery = jest.fn((sql: string, params?: unknown[]) => {
  if (/FROM meetings WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: mockMeetingRow(params?.[0]) });
  return Promise.resolve({
    rows: [
      { id: 'u-a', display_name: 'Ana', email: 'ana@example.com' },
      { id: 'u-b', display_name: 'Bo', email: 'bo@example.com' },
    ],
  });
});
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  __esModule: true,
}));

import meetingRoutes from '../../routes/meeting';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', meetingRoutes);
app.use(errorHandler);

/** The calendar file as a calendar app reads it: folded lines joined back together. */
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');

describe('GET /dm/conversations/:id/meeting.ics', () => {
  beforeEach(() => {
    mockScheduling.mockReset().mockResolvedValue({
      partnerId: 'u-b',
      confirmed: { startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, type: 'video', meetingId: null },
    });
    mockMeetingRow.mockReset().mockReturnValue([]);
  });

  // 26 Oct 2026: the in-app file was built with no UID, so it got a random one, and accepting the
  // emailed invite and then pressing "Add to calendar" left two entries in the same calendar. It now
  // carries the meeting's own identity, the SEQUENCE its invite is at, and the organizer the invite named.
  it('carries the meeting\'s own calendar identity and SEQUENCE, as the emails do, so adding it never makes a second entry', async () => {
    mockScheduling.mockResolvedValue({
      partnerId: 'u-b',
      confirmed: { startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, type: 'video', meetingId: 'mtg-1' },
    });
    mockMeetingRow.mockReturnValue([{ calendar_sequence: 2, confirmed_by: 'u-b' }]);

    const res = await request(app).get('/dm/conversations/c-1/meeting.ics');

    const ics = unfold(res.text);
    expect(ics).toContain('\r\nUID:meeting-mtg-1@rsn.network\r\n');
    expect(ics).toContain('\r\nSEQUENCE:2\r\n');
    expect(ics).toContain('\r\nORGANIZER;CN=Bo:mailto:bo@example.com\r\n');
    expect(mockMeetingRow).toHaveBeenCalledWith('mtg-1');
  });

  it('a meeting the old server booked without a row still downloads, as before', async () => {
    const res = await request(app).get('/dm/conversations/c-1/meeting.ics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('\r\nSEQUENCE:0\r\n');
    expect(res.text).not.toContain('UID:meeting-');
    expect(mockMeetingRow).not.toHaveBeenCalled();
  });

  it('is downloaded as reason-meeting.ics', async () => {
    const res = await request(app).get('/dm/conversations/c-1/meeting.ics');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="reason-meeting.ics"');
    expect(res.headers['content-type']).toMatch(/^text\/calendar/);
  });

  it('creates a "REASON meeting" that says it is a call on REASON with the other person', async () => {
    const res = await request(app).get('/dm/conversations/c-1/meeting.ics');
    const ics = unfold(res.text);
    expect(ics).toContain('SUMMARY:REASON meeting');
    expect(ics).toContain('DESCRIPTION:A 1:1 video call on REASON with Bo. Join: https://app.rsn.network/meet/c-1?scheduled=1&kind=video');
  });

  it('says an audio call is an audio call', async () => {
    mockScheduling.mockResolvedValue({
      partnerId: 'u-b',
      confirmed: { startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, type: 'audio' },
    });
    const res = await request(app).get('/dm/conversations/c-1/meeting.ics');
    expect(unfold(res.text)).toContain('DESCRIPTION:A 1:1 audio call on REASON with Bo.');
  });

  it('writes RSN nowhere a person reads, only in the program identifier of the file', async () => {
    const res = await request(app).get('/dm/conversations/c-1/meeting.ics');
    const people = unfold(res.text).split('\r\n').filter((line) => !line.startsWith('PRODID:')).join('\r\n');
    expect(people).not.toMatch(/\bRSN\b/);
  });
});
