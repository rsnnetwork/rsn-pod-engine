// 26 May (Stefan) — self-registration now sends a "you're registered"
// confirmation email with a calendar (.ics) invite, mirroring the emailed-invite
// path. Before this, a self-signup got NO email at all.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

jest.mock('../../db', () => ({ query: jest.fn() }));
import { query } from '../../db';
import {
  computeSessionDurationMinutes,
  buildSessionCalendarEvent,
} from '../../services/calendar/calendar.service';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Self-registration confirmation + calendar (26 May, Stefan)', () => {
  describe('computeSessionDurationMinutes', () => {
    it('= rounds×(round+rating) + (rounds−1)×transition + closing, ceil to minutes', () => {
      // 3×60 + 3×30 + 2×30 + 120 = 450s → 8 min
      expect(computeSessionDurationMinutes({
        numberOfRounds: 3, roundDurationSeconds: 60, ratingWindowSeconds: 30,
        transitionDurationSeconds: 30, closingLobbyDurationSeconds: 120,
      })).toBe(8);
    });
    it('falls back to sane defaults for a sparse config', () => {
      expect(computeSessionDurationMinutes({})).toBeGreaterThan(0);
    });
  });

  describe('buildSessionCalendarEvent', () => {
    beforeEach(() => (query as jest.Mock).mockReset());

    it('returns event data (title/start/organizer/duration) for a scheduled session', async () => {
      const when = new Date('2026-06-01T10:00:00.000Z');
      (query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ title: 'My Event', scheduled_at: when.toISOString(), host_user_id: 'h1', config: { numberOfRounds: 3, roundDurationSeconds: 60 } }] })
        .mockResolvedValueOnce({ rows: [{ display_name: 'Hosty', email: 'host@x.com' }] });
      const ev = await buildSessionCalendarEvent('s1');
      expect(ev).toBeDefined();
      expect(ev!.title).toBe('My Event');
      expect(ev!.startTime.getTime()).toBe(when.getTime());
      expect(ev!.organizerEmail).toBe('host@x.com');
      expect(ev!.sessionId).toBe('s1');
      expect(ev!.durationMinutes).toBeGreaterThan(0);
    });

    it('returns undefined when the session has no scheduled time (nothing to calendar)', async () => {
      (query as jest.Mock).mockResolvedValueOnce({ rows: [{ title: 'X', scheduled_at: null, host_user_id: 'h', config: {} }] });
      expect(await buildSessionCalendarEvent('s1')).toBeUndefined();
    });

    it('returns undefined when the session does not exist', async () => {
      (query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      expect(await buildSessionCalendarEvent('nope')).toBeUndefined();
    });
  });

  describe('wiring', () => {
    it('email.service exposes sendSessionRegistrationConfirmationEmail and attaches the .ics', () => {
      const src = readServer('services/email/email.service.ts');
      const i = src.indexOf('export async function sendSessionRegistrationConfirmationEmail');
      expect(i).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport async function ', i + 1);
      const fn = src.slice(i, next > -1 ? next : src.length);
      expect(fn).toMatch(/generateIcsContent/);
      expect(fn).toMatch(/filename: 'event\.ics'/);
    });

    it('POST /sessions/:id/register sends the confirmation with a calendar event (fire-and-forget)', () => {
      const src = readServer('routes/sessions.ts');
      // first occurrence of the route string is the POST handler (DELETE is later)
      const i = src.indexOf("'/:id/register'");
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 2200);
      expect(block).toMatch(/sendSessionRegistrationConfirmationEmail/);
      expect(block).toMatch(/buildSessionCalendarEvent/);
    });
  });
});
