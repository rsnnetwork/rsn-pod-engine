// ─── An event's time in the event's own zone, the shared formatter (10 Nov spec, Part 3 Task 1; K1) ─────────────
//
// One module writes every event time on every surface: in the event's zone, 24-hour, British order, and always with
// the zone's name. A zone Intl refuses reads as UTC and never throws. The organiser's wall clock converts to an
// instant across both 2026 European summer-time changes (29 Mar gap, 25 Oct overlap).

import {
  FALLBACK_TIME_ZONE, canonicalTimeZone, eventZone, formatEventTime, relativeEventTime, timeZoneLabel,
  utcToZonedWallTime, zonedWallTimeToUtc,
} from '@rsn/shared';
import { canonicalTimeZone as onboardingCanonical } from '../../services/onboarding/time-zone';

const CPH = 'Europe/Copenhagen';
const AT = '2026-11-17T13:00:00Z';

describe('formatEventTime', () => {
  it('writes the long form in the event zone, named', () => {
    expect(formatEventTime(AT, CPH)).toBe('Tuesday 17 November, 14:00 (CET)');
    expect(formatEventTime(new Date(AT), CPH, 'long')).toBe('Tuesday 17 November, 14:00 (CET)');
  });

  it('writes the short, day and clock forms', () => {
    expect(formatEventTime(AT, CPH, 'short')).toBe('Tue 17 Nov, 14:00 CET');
    expect(formatEventTime(AT, CPH, 'day')).toBe('Tue 17 Nov 2026');
    expect(formatEventTime(AT, CPH, 'clock')).toBe('14:00 CET');
  });

  it('drops the zone name only when asked', () => {
    expect(formatEventTime(AT, CPH, 'long', { withZone: false })).toBe('Tuesday 17 November, 14:00');
    expect(formatEventTime(AT, CPH, 'short', { withZone: false })).toBe('Tue 17 Nov, 14:00');
    expect(formatEventTime(AT, CPH, 'clock', { withZone: false })).toBe('14:00');
  });

  it('names summer time as summer time', () => {
    expect(formatEventTime('2026-06-17T12:00:00Z', CPH)).toBe('Wednesday 17 June, 14:00 (CEST)');
  });

  it('prints Karachi as GMT+5 and its own calendar day', () => {
    expect(formatEventTime(AT, 'Asia/Karachi')).toBe('Tuesday 17 November, 18:00 (GMT+5)');
    expect(formatEventTime('2026-11-17T20:00:00Z', 'Asia/Karachi', 'day')).toBe('Wed 18 Nov 2026');
  });

  it.each(['Not/AZone', '', null, undefined, '+05:45'])('a zone Intl refuses (%p) reads as UTC and never throws', (zone) => {
    expect(() => formatEventTime(AT, zone)).not.toThrow();
    expect(formatEventTime(AT, zone)).toBe('Tuesday 17 November, 13:00 (UTC)');
  });

  it('formats a date that is not one as empty, never throwing', () => {
    expect(formatEventTime('not a date', CPH)).toBe('');
    expect(formatEventTime(new Date(NaN), CPH, 'short')).toBe('');
  });
});

describe('canonicalTimeZone and eventZone', () => {
  it('accepts real zones, including those Node does not list', () => {
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('Asia/Kolkata')).not.toBeNull();
    expect(canonicalTimeZone('Europe/Copenhagen')).toBe('Europe/Copenhagen');
    expect(canonicalTimeZone('europe/berlin')).toBe('Europe/Berlin');
  });

  it('refuses offsets, blanks and invented zones', () => {
    expect(canonicalTimeZone('+05:45')).toBeNull();
    expect(canonicalTimeZone('')).toBeNull();
    expect(canonicalTimeZone(null)).toBeNull();
    expect(canonicalTimeZone('Mars/Base')).toBeNull();
    expect(canonicalTimeZone('garbage')).toBeNull();
  });

  it('is the same function onboarding uses', () => {
    expect(onboardingCanonical).toBe(canonicalTimeZone);
  });

  it('falls back to UTC', () => {
    expect(FALLBACK_TIME_ZONE).toBe('UTC');
    expect(eventZone('Mars/Base')).toBe('UTC');
    expect(eventZone(null)).toBe('UTC');
    expect(eventZone(CPH)).toBe(CPH);
  });
});

describe('zonedWallTimeToUtc and utcToZonedWallTime', () => {
  it('reads an ordinary wall time in the zone', () => {
    expect(zonedWallTimeToUtc('2026-11-17T14:00', CPH)).toBe('2026-11-17T13:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-11-17T14:00', 'Asia/Karachi')).toBe('2026-11-17T09:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-11-17T14:00', 'UTC')).toBe('2026-11-17T14:00:00.000Z');
  });

  it('reads a skipped time (29 Mar gap) with the offset before the change', () => {
    expect(zonedWallTimeToUtc('2026-03-29T02:30', CPH)).toBe('2026-03-29T01:30:00.000Z');
  });

  it('reads a doubled time (25 Oct overlap) as the earlier one', () => {
    expect(zonedWallTimeToUtc('2026-10-25T02:30', CPH)).toBe('2026-10-25T00:30:00.000Z');
  });

  it('refuses a malformed time or zone', () => {
    expect(zonedWallTimeToUtc('2026-02-30T10:00', CPH)).toBeNull();
    expect(zonedWallTimeToUtc('17/11/2026 14:00', CPH)).toBeNull();
    expect(zonedWallTimeToUtc('2026-11-17T25:00', CPH)).toBeNull();
    expect(zonedWallTimeToUtc('2026-11-17T14:00', 'Mars/Base')).toBeNull();
  });

  it('round-trips', () => {
    expect(utcToZonedWallTime('2026-11-17T13:00:00.000Z', CPH)).toBe('2026-11-17T14:00');
    expect(zonedWallTimeToUtc(utcToZonedWallTime(AT, CPH), CPH)).toBe('2026-11-17T13:00:00.000Z');
    expect(utcToZonedWallTime('2026-11-17T20:00:00Z', 'Asia/Karachi')).toBe('2026-11-18T01:00');
  });

  it('answers empty for a date that is not one', () => {
    expect(utcToZonedWallTime('nope', CPH)).toBe('');
  });
});

describe('relativeEventTime', () => {
  // 23:30 in Copenhagen on 16 Nov (22:30 UTC).
  const lateEvening = new Date('2026-11-16T22:30:00.000Z');

  it('judges tomorrow in the event zone, and names it', () => {
    expect(relativeEventTime('2026-11-17T08:00:00.000Z', lateEvening, CPH)).toBe('tomorrow at 09:00 (CET)');
  });

  it('counts minutes and hours close to the start', () => {
    expect(relativeEventTime(new Date(lateEvening.getTime() + 12 * 60_000), lateEvening, CPH)).toBe('in 12 minutes');
    expect(relativeEventTime(new Date(lateEvening.getTime() + 60_000), lateEvening, CPH)).toBe('in 1 minute');
    expect(relativeEventTime(new Date(lateEvening.getTime() + 60 * 60_000), lateEvening, CPH)).toBe('in 1 hour');
    expect(relativeEventTime(new Date(lateEvening.getTime() + 3 * 3_600_000), lateEvening, CPH)).toBe('in 3 hours');
    expect(relativeEventTime(new Date(lateEvening.getTime() - 60_000), lateEvening, CPH)).toBe('now');
  });

  it('says today in the event zone', () => {
    const noon = new Date('2026-11-17T11:00:00.000Z'); // 12:00 in Copenhagen
    expect(relativeEventTime('2026-11-17T17:00:00.000Z', noon, CPH)).toBe('today at 18:00 (CET)');
  });

  it('takes the day from the event zone: 20:00 UTC is already the next day in Karachi', () => {
    const at = new Date('2026-11-16T10:00:00.000Z'); // 15:00 Karachi
    expect(relativeEventTime('2026-11-16T20:00:00.000Z', at, 'Asia/Karachi')).toBe('tomorrow at 01:00 (GMT+5)');
  });

  it('writes the long form further out, and UTC for a zone Intl refuses', () => {
    expect(relativeEventTime(AT, new Date('2026-11-10T12:00:00Z'), CPH)).toBe('Tuesday 17 November, 14:00 (CET)');
    expect(relativeEventTime('2026-11-17T08:00:00.000Z', lateEvening, 'Not/AZone')).toBe('tomorrow at 08:00 (UTC)');
  });
});

describe('timeZoneLabel', () => {
  it('names the zone with its short name and offset', () => {
    expect(timeZoneLabel(CPH, new Date(AT))).toBe('Europe/Copenhagen (CET, GMT+1)');
    expect(timeZoneLabel(CPH, new Date('2026-06-17T12:00:00Z'))).toBe('Europe/Copenhagen (CEST, GMT+2)');
    expect(timeZoneLabel('Asia/Karachi', new Date(AT))).toBe('Asia/Karachi (GMT+5)');
    expect(timeZoneLabel('Asia/Kathmandu', new Date(AT))).toBe('Asia/Kathmandu (GMT+5:45)');
  });
});
