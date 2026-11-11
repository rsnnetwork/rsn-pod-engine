// The meeting picker's calendar line and busy shading (Shirley pilot S8, D7). Nothing here while the server has
// calendar free/busy off. With it on:
//   - no calendar connected: one quiet, dismissible line offering to connect (remembered per member on this device),
//     never a modal and never a step: booking goes on exactly as before;
//   - connected: the member's OWN busy times shade the cells they overlap (striped, "Busy"), which stay selectable;
//   - a calendar that could not be read, or must be connected again: a quiet note, and the picker works as before.
// The busy read runs only while the picker is open (this hook lives in MeetingScheduler).

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { CalendarProvider } from '@rsn/shared';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import CalendarConsentSheet from './CalendarConsentSheet';
import {
  PICKER_HINT, PICKER_LEGEND, PICKER_RECONNECT, PICKER_UNAVAILABLE, PROVIDER_LABEL, busyRange, busySlotKeys,
  hintDismissedKey, returnPathFrom,
} from './calendar-words';
import { useCalendarBusy, useCalendarConnections, useCalendarSwitch } from './useCalendar';

const HOUR_MS = 3_600_000;

export function useSchedulerBusy(visible: readonly string[], zone: string, now: number) {
  const { on, providers } = useCalendarSwitch();
  const connections = useCalendarConnections(on);
  const active = (connections.data ?? []).filter((c) => c.status === 'active');
  const hour = Math.floor(now / HOUR_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the range moves once an hour, not every minute
  const range = useMemo(() => busyRange(now), [hour]);
  const busy = useCalendarBusy(on && active.length > 0, range, zone);
  const busyKeys = useMemo(() => busySlotKeys(visible, busy.data?.busy ?? []), [visible, busy.data]);
  return { on, providers, connections, busy, busyKeys };
}

export type SchedulerBusy = ReturnType<typeof useSchedulerBusy>;

const LINE = 'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 text-[11px]';
const LINK = 'inline-flex min-h-[44px] items-center px-1 font-semibold underline underline-offset-2';

export default function SchedulerCalendarLine({ state }: { state: SchedulerBusy }) {
  const { pathname, search } = useLocation();
  const me = useAuthStore((s) => s.user?.id);
  const [consentFor, setConsentFor] = useState<CalendarProvider | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return !!me && localStorage.getItem(hintDismissedKey(me)) === '1'; } catch { return false; }
  });
  if (!state.on || state.connections.isPending) return null;

  // Back to this conversation with the picker open again.
  const returnTo = returnPathFrom(pathname, search, { schedule: '1' });
  const sheet = <CalendarConsentSheet provider={consentFor} returnTo={returnTo} onClose={() => setConsentFor(null)} />;
  const connections = state.connections.data ?? [];
  const reconnect = connections.find((c) => c.status === 'needs_reconnect' && state.providers.includes(c.provider))
    ?? state.busy.data?.errors.find((e) => e.code === 'reconnect');

  if (connections.length === 0 || state.connections.isError) {
    if (dismissed || state.connections.isError || state.providers.length === 0) return null;
    const dismiss = () => {
      setDismissed(true);
      try { if (me) localStorage.setItem(hintDismissedKey(me), '1'); } catch { /* private mode: dismissed for this visit only */ }
    };
    return (
      <div className={`${LINE} border-gray-200 bg-white text-gray-600`} data-testid="scheduler-calendar-hint">
        <span className="min-w-0 flex-1 basis-40">{PICKER_HINT}</span>
        {state.providers.map((p) => (
          <button key={p} type="button" className={`${LINK} text-reason-ink`} onClick={() => setConsentFor(p)}>
            {p === 'google' ? 'Google' : 'Outlook'}
          </button>
        ))}
        <button type="button" onClick={dismiss} aria-label="Hide this suggestion" className="grid h-11 w-11 place-items-center rounded-full text-gray-500 hover:bg-gray-100">
          <X className="h-4 w-4" aria-hidden />
        </button>
        {sheet}
      </div>
    );
  }

  if (reconnect) {
    return (
      <div className={`${LINE} border-amber-200 bg-amber-50 text-amber-800`} role="status" data-testid="scheduler-calendar-reconnect">
        <span className="min-w-0 flex-1 basis-40">{PICKER_RECONNECT}</span>
        <button type="button" className={LINK} onClick={() => setConsentFor(reconnect.provider)}>
          Connect {PROVIDER_LABEL[reconnect.provider]} again
        </button>
        {sheet}
      </div>
    );
  }

  const unreadable = state.busy.isError || (state.busy.data?.errors.length ?? 0) > 0;
  if (unreadable) {
    return <p className="text-[11px] text-gray-500" role="status" data-testid="scheduler-calendar-unavailable">{PICKER_UNAVAILABLE}</p>;
  }
  if (state.busyKeys.size > 0) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-gray-600" data-testid="scheduler-calendar-legend">
        <span aria-hidden className="inline-block h-3 w-4 rounded-sm border border-gray-300 rsn-busy-stripes" />
        {PICKER_LEGEND}
      </p>
    );
  }
  return null;
}
