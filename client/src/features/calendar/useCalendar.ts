// client/src/features/calendar/useCalendar.ts
// Calendar free/busy (Shirley pilot S8, D7): the server's switch, the member's connections, their busy times, and the
// connect and disconnect actions. Every calendar control reads useCalendarSwitch first and draws nothing while the
// server has calendar free/busy off (GET /api/public/config), so with CALENDAR_SYNC=off no calendar UI appears at all.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarBusy, CalendarConnection, CalendarDisconnectResult, CalendarProvider, PublicConfig } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { invalidateEntities } from '@/realtime/invalidate-entities';
import { useAuthStore } from '@/stores/authStore';
import { errorMessage } from '@/features/reason/errors';

/** The server's own switches. Fixed for the life of a deploy, so read once a page load and kept for ten minutes. */
export function usePublicConfig() {
  // realtime: skip — the server's switches change only with a deploy (CALENDAR_SYNC), never by anyone's action
  return useQuery<PublicConfig>({
    queryKey: ['public-config'],
    queryFn: () => api.get('/public/config').then((r) => r.data.data),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

/** Whether calendar free/busy is on, and which providers can be connected. Off while unknown or unreadable. */
export function useCalendarSwitch(): { on: boolean; providers: CalendarProvider[] } {
  const { data } = usePublicConfig();
  const on = data?.calendar?.enabled === true;
  return { on, providers: on ? data!.calendar.providers : [] };
}

export function useCalendarConnections(on: boolean) {
  const me = useAuthStore((s) => s.user?.id);
  return useQuery<CalendarConnection[]>({
    queryKey: ['calendar-connections', me],
    queryFn: () => api.get('/calendar/connections').then((r) => r.data.data),
    enabled: on && !!me,
    meta: { entities: me ? [E.userCalendars(me)] : [] },
  });
}

/** The member's OWN busy times in the range (never anyone else's). Read only while the picker is open and connected. */
export function useCalendarBusy(on: boolean, range: { from: string; to: string }, zone: string) {
  const me = useAuthStore((s) => s.user?.id);
  return useQuery<CalendarBusy>({
    queryKey: ['calendar-busy', me, range.from, range.to, zone],
    queryFn: () => api.get('/calendar/busy', { params: { from: range.from, to: range.to, tz: zone } }).then((r) => r.data.data),
    enabled: on && !!me,
    staleTime: 4 * 60 * 1000,
    retry: 1,
    meta: { entities: me ? [E.userCalendars(me)] : [] },
  });
}

/** Leave for the provider's consent screen. `returnTo` is the app path to come back to (this page). */
export function useConnectCalendar() {
  return useMutation({
    mutationFn: async ({ provider, returnTo }: { provider: CalendarProvider; returnTo: string }) => {
      const res = await api.post(`/calendar/connect/${provider}`, { returnTo });
      return res.data.data.url as string;
    },
    // A full-page navigation, never a popup: iOS Safari and in-app browsers block popups, and the provider sends the
    // browser back to the page it left.
    onSuccess: (url) => { window.location.assign(url); },
  });
}

export function useFinishCalendar() {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id);
  return useMutation({
    mutationFn: async ({ provider, ticket }: { provider: CalendarProvider; ticket: string }) =>
      (await api.post(`/calendar/connections/${provider}/finish`, { ticket })).data.data as CalendarConnection,
    // This tab reads again at once; the server's user:<id>:calendars tells the member's other tabs and devices.
    onSuccess: () => { if (me) void invalidateEntities(qc, [E.userCalendars(me)]); },
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id);
  return useMutation({
    mutationFn: async (provider: CalendarProvider) =>
      (await api.delete(`/calendar/connections/${provider}`)).data.data as CalendarDisconnectResult,
    onSuccess: () => { if (me) void invalidateEntities(qc, [E.userCalendars(me)]); },
  });
}

/** A calendar request's failure in a member's words: the server's own calendar sentence when it sent one. */
export function calendarErrorMessage(err: unknown, fallback: string): string {
  const response = (err as { response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown } } } })?.response;
  const data = response?.data?.error;
  if (typeof data?.code === 'string' && data.code.startsWith('CALENDAR_') && typeof data.message === 'string') return data.message;
  // A 404 here means calendar free/busy was just switched off, not a missing person (errorMessage's 404 sentence).
  if (response?.status === 404) return fallback;
  return errorMessage(err, fallback);
}
