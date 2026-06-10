import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const tz = date.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() || '';
  return `${day}, ${time} hrs ${tz}`;
}

export const LOCAL_TIME_LABEL = '(your local time)';

/** Format a Date (or ISO string) as the LOCAL `YYYY-MM-DDTHH:MM` value a native
 *  `datetime-local` input expects. NEVER use `.toISOString().slice(0,16)` for
 *  this — that yields UTC, which the input then renders/saves as if it were
 *  local, shifting the time by the viewer's offset (Ali, 10 Jun — edit-event
 *  bug). getHours()/getMinutes() are local, so this round-trips correctly. */
export function toLocalDatetimeInput(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The viewer's local timezone for display, e.g. "Asia/Karachi (GMT+5)".
 *  A datetime-local input is always in local time but shows no zone — label it. */
export function localTimezoneLabel(): string {
  const offsetMin = -new Date().getTimezoneOffset(); // +300 for GMT+5
  const sign = offsetMin >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(offsetMin) / 60);
  const m = Math.abs(offsetMin) % 60;
  const gmt = `GMT${sign}${h}${m ? `:${m.toString().padStart(2, '0')}` : ''}`;
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
  return zone ? `${zone} (${gmt})` : gmt;
}

export function getInitials(name: string): string {
  return name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

export function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export function isAdmin(role?: string): boolean {
  return role === 'admin' || role === 'super_admin';
}
