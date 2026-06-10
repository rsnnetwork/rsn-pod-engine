// Event scheduling timezone (Ali, 10 Jun). The "Scheduled At" picker is a native
// datetime-local input = always LOCAL time. Two things must hold:
//   1. the field LABELS the viewer's local timezone (it was silent → ambiguous).
//   2. the EDIT form pre-fills LOCAL time, not UTC. Using
//      `new Date(iso).toISOString().slice(0,16)` put UTC into the local input,
//      so opening + saving an event shifted its time by the viewer's offset.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('Event scheduling — local timezone', () => {
  const utils = clientSrc('lib/utils.ts');
  const create = clientSrc('features/sessions/CreateSessionPage.tsx');
  const detail = clientSrc('features/sessions/SessionDetailPage.tsx');

  it('utils export the local datetime + timezone-label helpers', () => {
    expect(utils).toMatch(/export function toLocalDatetimeInput\(/);
    expect(utils).toMatch(/export function localTimezoneLabel\(/);
    // toLocalDatetimeInput uses LOCAL getters, never toISOString.
    expect(utils).toMatch(/date\.getHours\(\)/);
    const fnStart = utils.indexOf('export function toLocalDatetimeInput');
    const fn = utils.slice(fnStart, utils.indexOf('\n}', fnStart));
    expect(fn).not.toMatch(/toISOString/);
  });

  it('create + edit forms label the local timezone', () => {
    expect(create).toMatch(/localTimezoneLabel\(\)/);
    expect(detail).toMatch(/localTimezoneLabel\(\)/);
  });

  it('the edit form pre-fills LOCAL time (not UTC) — no time-shift on edit', () => {
    expect(detail).toMatch(/setEditScheduledAt\(session\?\.scheduledAt \? toLocalDatetimeInput\(session\.scheduledAt\) : ''\)/);
    expect(detail).not.toMatch(/setEditScheduledAt\([^)]*toISOString\(\)\.slice\(0, 16\)/);
  });
});
