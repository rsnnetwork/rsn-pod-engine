// ─── One place says how long an event lasts (26 Oct 2026, H2b item 12) ───────────────────────────────────
//
// The invite email's calendar entry, the reminder's, and the calendar feed each worked an event's length out with the
// same two calls on the session row (eventDurationMinutes(resolveEventFormat({ format, config }), config)), written
// three times. It is one helper now, read from the row as the row stores it (the format column, which an older event
// may lack, and the config, which may still be the stored JSON string).

import { eventDurationOf } from '../../../services/session/event-duration';

describe('eventDurationOf', () => {
  it('a video meeting lasts what its config says', () => {
    expect(eventDurationOf({ event_format: 'video_meeting', config: { durationMinutes: 45 } })).toBe(45);
  });

  it('a speed-networking event lasts its rounds (the shared estimate), format column or not', () => {
    const config = { numberOfRounds: 3, roundDurationSeconds: 300 };
    const withColumn = eventDurationOf({ event_format: 'speed_networking', config });
    const withoutColumn = eventDurationOf({ event_format: null, config });
    expect(withColumn).toBe(withoutColumn);
    expect(withColumn).toBeGreaterThanOrEqual(15);
  });

  it('reads a config still stored as JSON text', () => {
    expect(eventDurationOf({ event_format: 'video_meeting', config: JSON.stringify({ durationMinutes: 30 }) })).toBe(30);
  });
});

describe('the three callers use it, and the two-call expression is written nowhere else', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

  it.each([
    'services/invite/invite.service.ts',
    'routes/invites.ts',
    'services/calendar/calendar.service.ts',
  ])('%s', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/eventDurationOf\(/);
    expect(src).not.toMatch(/eventDurationMinutes\(resolveEventFormat\(/);
  });
});

describe('a config the row holds as text that is not an object (review M9)', () => {
  it('falls back to the format\'s defaults instead of throwing after the invite row exists', () => {
    const defaults = eventDurationOf({ event_format: 'speed_networking', config: {} });
    expect(eventDurationOf({ event_format: 'speed_networking', config: '{not json' })).toBe(defaults);
    expect(eventDurationOf({ event_format: 'speed_networking', config: 'null' })).toBe(defaults);
    expect(eventDurationOf({ event_format: 'speed_networking', config: null })).toBe(defaults);
  });
});
