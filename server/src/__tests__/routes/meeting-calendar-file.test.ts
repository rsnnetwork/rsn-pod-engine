// ─── A meeting's own calendar file (1 Nov 2026, T7, 30 Oct review 5b) ────────
//
// The "Meeting confirmed" card in a thread downloaded the conversation's CURRENT meeting: the only file route read
// the conversation, not a meeting. So a card for an earlier meeting, once the pair had booked another, gave the
// other meeting's time. GET /api/meetings/:id/calendar.ics is the meeting's own file, for its two people only, with
// the same content the conversation's file has (production's client keeps GET /dm/conversations/:id/meeting.ics).
//
// Both routers run for real, with the real file builder and the real meetings service; the sign-in check, the
// database, the scheduler read and the config are stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
let mockViewer = 'aaaaaaaa-0000-4000-8000-000000000001';
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: mockViewer, email: 'x@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockScheduling = jest.fn();
jest.mock('../../services/dm/meeting-windows.service', () => ({
  getScheduling: (...a: unknown[]) => mockScheduling(...a),
  meetingJoinPath: (conversationId: string, type: string | null) => `/meet/${conversationId}?scheduled=1&kind=${type ?? 'video'}`,
  __esModule: true,
}));
jest.mock('../../services/dm/meeting-call.service', () => ({ __esModule: true }));
jest.mock('../../services/presence/presence.service', () => ({ presenceOf: jest.fn(), presenceState: jest.fn(), __esModule: true }));
jest.mock('../../services/dm/dm.service', () => ({ __esModule: true }));
jest.mock('../../services/email/email.service', () => ({ __esModule: true }));
jest.mock('../../index', () => ({ __esModule: true, io: null }));

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const STRANGER = 'eeeeeeee-0000-4000-8000-000000000005';
const CONV = 'cccccccc-0000-4000-8000-000000000003';
const EARLIER = 'dddddddd-0000-4000-8000-000000000004';
const LATER = 'ffffffff-0000-4000-8000-000000000006';

/** The meetings rows: the pair's earlier meeting (moved once, to 18:00) and the later one they booked since. */
const ROWS: Record<string, Record<string, unknown>> = {
  [EARLIER]: {
    id: EARLIER, conversation_id: CONV, user_a_id: A, user_b_id: B,
    start_at: new Date('2026-11-05T18:00:00Z'), duration_min: 30, kind: 'audio', status: 'scheduled',
    context: null, joined_a_at: null, joined_b_at: null, calendar_sequence: 1, confirmed_by: B,
  },
  [LATER]: {
    id: LATER, conversation_id: CONV, user_a_id: A, user_b_id: B,
    start_at: new Date('2026-11-12T09:00:00Z'), duration_min: 45, kind: 'video', status: 'scheduled',
    context: null, joined_a_at: null, joined_b_at: null, calendar_sequence: 0, confirmed_by: A,
  },
};
const PEOPLE = [
  { id: A, display_name: 'Ana', email: 'ana@example.com' },
  { id: B, display_name: 'Bo', email: 'bo@example.com' },
];

const mockQuery = jest.fn((sql: string, params: unknown[] = []) => {
  const flat = sql.replace(/\s+/g, ' ');
  if (/FROM meetings m JOIN users p/.test(flat)) {
    // The viewer's meetings, the other person joined: none for someone who is not one of the two.
    const [viewer, id] = params as [string, string];
    const found = ROWS[id];
    if (!found || (found.user_a_id !== viewer && found.user_b_id !== viewer)) return Promise.resolve({ rows: [] });
    const partner = PEOPLE.find((p) => p.id === (found.user_a_id === viewer ? found.user_b_id : found.user_a_id))!;
    return Promise.resolve({
      rows: [{ ...found, partner_id: partner.id, partner_name: partner.display_name, partner_avatar_url: null, partner_status: 'active' }],
    });
  }
  if (/FROM meetings WHERE id = \$1/.test(flat)) {
    const found = ROWS[params[0] as string];
    return Promise.resolve({ rows: found ? [{ calendar_sequence: found.calendar_sequence, confirmed_by: found.confirmed_by }] : [] });
  }
  if (/FROM users WHERE id = ANY/.test(flat)) return Promise.resolve({ rows: PEOPLE });
  return Promise.resolve({ rows: [] });
});
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: jest.fn(),
  __esModule: true,
}));

import meetingRoutes from '../../routes/meeting';
import meetingsRoutes from '../../routes/meetings';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', meetingRoutes);
app.use('/meetings', meetingsRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

/** The file as a calendar reads it: folded lines joined back, and the time it was written left out. */
const lines = (ics: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter((l) => !l.startsWith('DTSTAMP:'));

/** The conversation's current meeting, as the scheduler reads it. */
const current = (id: string) => {
  const r = ROWS[id];
  return {
    partnerId: B,
    confirmed: {
      startAt: (r.start_at as Date).toISOString(), durationMin: r.duration_min, type: r.kind, meetingId: id,
    },
  };
};

beforeEach(() => {
  mockViewer = A;
  mockQuery.mockClear();
  ROWS[EARLIER].status = 'scheduled';
  // The pair has booked a later meeting since: it is the conversation's meeting now.
  mockScheduling.mockReset().mockResolvedValue(current(LATER));
});

describe('GET /meetings/:id/calendar.ics', () => {
  it('is the meeting\'s own file: its identity, its SEQUENCE, its time (as moved), its kind and both people', async () => {
    const res = await request(app).get(`/meetings/${EARLIER}/calendar.ics`);

    expect(res.status).toBe(200);
    expect(lines(res.text)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//RSN//Pod Engine//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:meeting-${EARLIER}@rsn.network`,
      'DTSTART:20261105T180000Z',
      'DTEND:20261105T183000Z',
      'SUMMARY:REASON meeting',
      `DESCRIPTION:A 1:1 audio call on REASON with Bo. Join: https://app.rsn.network/meet/${CONV}?scheduled=1&kind=audio`,
      'ORGANIZER;CN=Bo:mailto:bo@example.com',
      'ATTENDEE;CN=Ana;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com',
      'ATTENDEE;CN=Bo;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.com',
      'SEQUENCE:1',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Event starting in 15 minutes',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
    // The conversation's current meeting was not what it read.
    expect(mockScheduling).not.toHaveBeenCalled();
  });

  it('answers the same headers as the conversation\'s file: a calendar invite saved as reason-meeting.ics', async () => {
    const res = await request(app).get(`/meetings/${EARLIER}/calendar.ics`);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8; method=REQUEST');
    expect(res.headers['content-disposition']).toBe('attachment; filename="reason-meeting.ics"');
  });

  it('has the same content as the conversation\'s file for the same meeting', async () => {
    mockScheduling.mockResolvedValue(current(LATER));
    const own = await request(app).get(`/meetings/${LATER}/calendar.ics`);
    const conversations = await request(app).get(`/dm/conversations/${CONV}/meeting.ics`);
    expect(own.status).toBe(200);
    expect(conversations.status).toBe(200);
    expect(lines(own.text)).toEqual(lines(conversations.text));
  });

  it('the other person gets the same meeting, written for them', async () => {
    mockViewer = B;
    const res = await request(app).get(`/meetings/${EARLIER}/calendar.ics`);
    expect(res.status).toBe(200);
    expect(lines(res.text)).toContain(`DESCRIPTION:A 1:1 audio call on REASON with Ana. Join: https://app.rsn.network/meet/${CONV}?scheduled=1&kind=audio`);
    expect(lines(res.text)).toContain(`UID:meeting-${EARLIER}@rsn.network`);
  });

  it('is a 404 in words for anyone who is not one of the two (a block reads the same), with nothing in it', async () => {
    mockViewer = STRANGER;
    const res = await request(app).get(`/meetings/${EARLIER}/calendar.ics`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("We couldn't find that meeting.");
    expect(res.text).not.toContain('BEGIN:VCALENDAR');
  });

  it('a cancelled meeting has no file to add: a 404 that says so', async () => {
    ROWS[EARLIER].status = 'cancelled';
    const res = await request(app).get(`/meetings/${EARLIER}/calendar.ics`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('This meeting was cancelled, so there is nothing to add to a calendar.');
  });

  it('refuses an id that is not one with a 400, before reading anything', async () => {
    const res = await request(app).get('/meetings/undefined/calendar.ics');
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// Production's client (origin/main) still downloads GET /dm/conversations/:id/meeting.ics from the meeting page, the
// thread card and the scheduler. Its file is the conversation's current meeting, exactly as before.
describe('production\'s GET /dm/conversations/:id/meeting.ics', () => {
  it('answers the same headers and the same file as before', async () => {
    const res = await request(app).get(`/dm/conversations/${CONV}/meeting.ics`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8; method=REQUEST');
    expect(res.headers['content-disposition']).toBe('attachment; filename="reason-meeting.ics"');
    expect(lines(res.text)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//RSN//Pod Engine//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:meeting-${LATER}@rsn.network`,
      'DTSTART:20261112T090000Z',
      'DTEND:20261112T094500Z',
      'SUMMARY:REASON meeting',
      `DESCRIPTION:A 1:1 video call on REASON with Bo. Join: https://app.rsn.network/meet/${CONV}?scheduled=1&kind=video`,
      'ORGANIZER;CN=Ana:mailto:ana@example.com',
      'ATTENDEE;CN=Ana;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com',
      'ATTENDEE;CN=Bo;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.com',
      'SEQUENCE:0',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Event starting in 15 minutes',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
  });

  it('a conversation with no meeting standing is still a 404', async () => {
    mockScheduling.mockResolvedValue({ partnerId: B, confirmed: null });
    const res = await request(app).get(`/dm/conversations/${CONV}/meeting.ics`);
    expect(res.status).toBe(404);
  });
});
