import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatEventTime } from '@rsn/shared';

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

/**
 * An EVENT's time (Part 3, K1): on the event's own clock with its zone named, "Tue 1 Dec, 14:00 CET", the same for
 * every viewer wherever they are; "No date set" when it has none. formatDateTime above stays for what is not an
 * event's time (an audit entry's moment), which reads on the viewer's own clock.
 */
export function formatEventDateTime(iso: string | null | undefined, zone: string | null | undefined): string {
  return (iso && formatEventTime(iso, zone, 'short')) || 'No date set';
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
