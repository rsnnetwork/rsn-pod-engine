import { utcToZonedWallTime } from '@rsn/shared';

/**
 * The first quarter hour strictly after `now`, as a datetime-local field holds it (YYYY-MM-DDTHH:MM): on `zone`'s clock
 * when given (Part 3: a new event starts on its own zone's clock), else on the browser's.
 */
export function nextQuarterHourAfter(now: Date, zone?: string): string {
  const quarter = 15 * 60 * 1000;
  const next = new Date(Math.floor(now.getTime() / quarter) * quarter + quarter);
  if (zone) return utcToZonedWallTime(next, zone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
}
