// ─── Every path that writes a notification tells the member's bell (26 Oct 2026, H2b item 6) ────────────────
//
// A notification row is a mutation like any other: the member's screens learn of it through the entity tag
// user:<id>:notifications (E.userNotifications), which the bell's queries declare, so they can stop polling. Several
// paths inserted rows and emitted nothing, or only the older 'notification:new' socket event: the member's bell
// filled in on the next poll or reload. This pins that every file inserting into notifications also emits the tag;
// the behaviour of the paths this round changed is tested beside them.

import * as fs from 'fs';
import * as path from 'path';

const SERVICES = path.join(__dirname, '../../services');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const inserting = walk(SERVICES).filter((file) => /INSERT INTO notifications/.test(fs.readFileSync(file, 'utf8')));

describe('every service file that inserts a notification', () => {
  it('exists in a known number (a new path lands here and is checked below)', () => {
    expect(inserting.length).toBeGreaterThanOrEqual(13);
  });

  it.each(inserting.map((f) => [path.relative(SERVICES, f).replace(/\\/g, '/'), f]))('%s emits the member\'s notifications tag', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/E\.userNotifications\(/);
  });
});
