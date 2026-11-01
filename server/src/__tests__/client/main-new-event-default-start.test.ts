// ─── The new event form starts on the next quarter hour after now ────────────
// (2 Nov 2026)
//
// Production's default start rounded the minutes up but dropped the seconds, so at 23:30:15 it offered 23:30, a start
// already behind the clock; and from :46 to :59 it rolled into the next hour by setMinutes(60) and then added another
// hour, so 10:50 offered 12:00. The rule is now one pure helper: the first quarter hour strictly after now.

import { loadClientModule } from './load-client-module';

const { nextQuarterHourAfter } = loadClientModule('features/sessions/default-start.ts', {}) as {
  nextQuarterHourAfter: (now: Date) => string;
};

describe('the new event form default start', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);

  it('10:50 offers 11:00, not 12:00', () => {
    expect(nextQuarterHourAfter(at(2026, 11, 2, 10, 50))).toBe('2026-11-02T11:00');
  });
  it('10:30:15 offers 10:45, not the 10:30 that has begun', () => {
    expect(nextQuarterHourAfter(at(2026, 11, 2, 10, 30, 15))).toBe('2026-11-02T10:45');
  });
  it('10:00:00 on the dot offers 10:15, after now', () => {
    expect(nextQuarterHourAfter(at(2026, 11, 2, 10, 0))).toBe('2026-11-02T10:15');
  });
  it('23:50 rolls to 00:00 of the next day', () => {
    expect(nextQuarterHourAfter(at(2026, 11, 2, 23, 50))).toBe('2026-11-03T00:00');
  });
  it('23:59:59 rolls to 00:00 of the next day', () => {
    expect(nextQuarterHourAfter(at(2026, 11, 2, 23, 59, 59, 999))).toBe('2026-11-03T00:00');
  });
  it('the last day of the month and year rolls over too', () => {
    expect(nextQuarterHourAfter(at(2026, 12, 31, 23, 46))).toBe('2027-01-01T00:00');
  });
});

describe('the new event form uses it', () => {
  it('getDefaultScheduledAt hands the clock to the helper', () => {
    const src = require('./load-client-module').readClientSource('features/sessions/CreateSessionPage.tsx') as string;
    expect(src).toContain("import { nextQuarterHourAfter } from './default-start'");
    expect(src).toMatch(/function getDefaultScheduledAt\(\): string \{\s*return nextQuarterHourAfter\(new Date\(\)\);\s*\}/);
  });
});
