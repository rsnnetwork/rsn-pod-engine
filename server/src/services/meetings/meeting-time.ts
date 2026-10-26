// ─── A meeting's time, as one person reads it (26 Oct 2026) ──────────────────
//
// Bells and emails are written for one reader, so they say the time in that reader's own zone and
// name the zone. 25 Oct 2026 was the day Europe left summer time: Stefan picked 13:00 in Copenhagen,
// 12:00 UTC, and a bare "12:00" read as the wrong hour. A zone REASON does not know (none on file, or
// one Intl refuses) reads as UTC, and says UTC.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface MeetingTime {
  /** "Sun 25 Oct, 13:00" */
  short: string;
  /** "Sunday 25 October, 13:00" */
  long: string;
  /** "CET", "CEST", "GMT+5", "UTC" */
  zone: string;
}

function partsIn(at: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(at);
}

export function meetingTime(at: Date, timeZone?: string | null): MeetingTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = partsIn(at, timeZone || 'UTC');
  } catch {
    parts = partsIn(at, 'UTC');
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  // en-GB writes "Sept"; our own month names keep every month to three letters. Its numeric date
  // pattern pads the day ("05"), so the day is read as a number.
  const month = Number(part('month')) - 1;
  const day = Number(part('day'));
  const weekday = part('weekday');
  const time = `${part('hour')}:${part('minute')}`;
  return {
    short: `${weekday.slice(0, 3)} ${day} ${MONTHS_SHORT[month]}, ${time}`,
    long: `${weekday} ${day} ${MONTHS_LONG[month]}, ${time}`,
    zone: part('timeZoneName'),
  };
}
