/** The first quarter hour strictly after `now`, as a datetime-local field holds it (local time, YYYY-MM-DDTHH:MM). */
export function nextQuarterHourAfter(now: Date): string {
  const quarter = 15 * 60 * 1000;
  const next = new Date(Math.floor(now.getTime() / quarter) * quarter + quarter);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
}
