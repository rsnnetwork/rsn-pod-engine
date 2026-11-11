// Event scheduling time zone. Ali, 10 Jun: the "Scheduled At" picker is a native datetime-local input, which holds a
// wall clock and names no zone, so (1) the field must say which zone it is read on and (2) the edit form must pre-fill
// the same clock it saves on (toISOString().slice(0, 16) put UTC into the field and shifted the time on every save).
//
// Part 3 (10 Nov 2026 spec, K1) moved both from the viewer's clock to the EVENT's: the field is read on the event's
// own zone, says "Times are shown in {zone}.", and the edit form opens on the event zone's wall clock. The executed
// round trip is in server/src/__tests__/client/p3-event-time-image.test.ts.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('Event scheduling: the event zone', () => {
  const create = clientSrc('features/sessions/CreateSessionPage.tsx');
  // The edit form moved out of the event page into its own react-hook-form sheet (C7, 26 Oct 2026).
  const edit = clientSrc('features/sessions/EditEventModal.tsx');
  const field = clientSrc('features/sessions/EventZoneField.tsx');

  it('create + edit forms name the zone the date is read on (the event\'s, not the viewer\'s)', () => {
    expect(create).toContain('<EventZoneField');
    expect(edit).toContain('<EventZoneField');
    expect(field).toContain('Times are shown in {timeZoneLabel(');
    expect(`${create}${edit}`).not.toMatch(/localTimezoneLabel|Shown in your local time/);
  });

  it('the edit form pre-fills the event zone\'s wall clock, never UTC: no time shift on edit', () => {
    expect(edit).toContain('editEventValues(session, eventWallTime(session))');
    expect(edit).not.toMatch(/toISOString\(\)\.slice\(0, 16\)/);
  });
});
