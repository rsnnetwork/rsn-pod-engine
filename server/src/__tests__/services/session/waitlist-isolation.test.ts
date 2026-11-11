// ─── Nobody waiting reaches an attendee surface (10 Nov 2026 spec, Part 3 Task 3; Review Focus #2) ──────────────────
//
// The waiting list is its own table (event_waitlist), never a participant status, so every participant query
// (matching, the live room, the fan-out of an event's changes, reminders, direct messages) is blind to it by
// construction. This holds that construction: none of those files reads event_waitlist. A waiting person is told about
// a cancellation or a new time (event-lifecycle.service.ts, event-notices.ts), never reminded, matched, admitted or
// offered a DM; the live door refuses them as a newcomer (event-waitlist.test.ts).

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../../..');

function filesUnder(rel: string): string[] {
  const dir = path.join(SRC, rel);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path.relative(SRC, full));
    return /\.ts$/.test(entry.name) ? [path.relative(SRC, full).split(path.sep).join('/')] : [];
  });
}

const ATTENDEE_SURFACES = [
  ...filesUnder('services/matching'),
  ...filesUnder('services/orchestration'),
  'realtime/fanout.ts',
  'services/session/event-reminder.worker.ts',
  'services/dm/dm.service.ts',
];

describe('the waiting list is invisible to every attendee surface', () => {
  it('finds the files it guards, so a moved folder cannot pass by finding nothing', () => {
    expect(ATTENDEE_SURFACES.length).toBeGreaterThan(30);
    for (const known of [
      'services/matching/matching.engine.ts', 'services/orchestration/event-room-entry.ts',
      'services/orchestration/handlers/participant-flow.ts', 'realtime/fanout.ts',
    ]) expect(ATTENDEE_SURFACES).toContain(known);
  });

  it('no matching, live-room, fan-out, reminder or DM file reads event_waitlist', () => {
    const readers = ATTENDEE_SURFACES.filter((rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').includes('event_waitlist'));
    expect(readers).toEqual([]);
  });

  it('the live room reaches the waiting list only to move it on after a removal or a co-host, never to read it', () => {
    const hostActions = fs.readFileSync(path.join(SRC, 'services/orchestration/handlers/host-actions.ts'), 'utf8');
    const uses = hostActions.split('\n').filter((line) => line.includes('event-waitlist.service'));
    expect(uses).toHaveLength(2);
    for (const line of uses) expect(line).toMatch(/afterPlaceFreed\((data\.sessionId|sessionId), '(removed|cohost)'\)/);
  });

  it('participant rows are never written with a waiting status: no waitlisted participant_status exists', () => {
    const service = fs.readFileSync(path.join(SRC, 'services/session/event-waitlist.service.ts'), 'utf8');
    expect(service).not.toMatch(/session_participants[^;]*'waitlisted'/);
    const migration = fs.readFileSync(path.join(SRC, 'db/migrations/145_event_waitlist.sql'), 'utf8');
    expect(migration).not.toMatch(/participant_status/);
  });
});
