// ─── The calendar entry for an event says REASON (21 Oct 2026) ───────────────
//
// The client's 19 Oct feedback: "Call it REASON everywhere". The entry a member's calendar
// gets for an event they registered for is "REASON event — {title}", and when the host has
// no name on file the organizer is REASON.

jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));

import { query } from '../../../db';
import { buildSessionCalendarEvent } from '../../../services/calendar/calendar.service';

const SESSION = { title: 'Founders Evening', scheduled_at: '2026-11-05T17:00:00.000Z', host_user_id: 'u-host', config: {} };

/** The database holds one event, and a host row when there is one. */
function theEventIsHostedBy(host: { display_name: string | null; email: string } | undefined) {
  (query as jest.Mock).mockImplementation((sql: string) => {
    if (/FROM sessions WHERE id/.test(sql)) return Promise.resolve({ rows: [SESSION] });
    if (/FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: host ? [host] : [] });
    return Promise.resolve({ rows: [] });
  });
}

describe('buildSessionCalendarEvent', () => {
  it('describes the event as "REASON event — {title}"', async () => {
    theEventIsHostedBy({ display_name: 'Stefan', email: 'stefan@example.com' });
    const event = await buildSessionCalendarEvent('s-1');
    expect(event?.description).toBe('REASON event — Founders Evening');
    expect(event?.title).toBe('Founders Evening');
  });

  it('names the host as the organizer when the host has a name', async () => {
    theEventIsHostedBy({ display_name: 'Stefan', email: 'stefan@example.com' });
    expect((await buildSessionCalendarEvent('s-1'))?.organizerName).toBe('Stefan');
  });

  it.each([
    ['the host has no name on file', { display_name: null, email: 'stefan@example.com' }],
    ['the host row is gone', undefined],
  ])('names REASON as the organizer when %s', async (_why, host) => {
    theEventIsHostedBy(host);
    expect((await buildSessionCalendarEvent('s-1'))?.organizerName).toBe('REASON');
  });
});
