// Settings → Calendars (Shirley pilot S8, D7). Draws nothing while the server has calendar free/busy off.
// One row per provider the server offers (and any calendar still connected through a provider it no longer offers):
// not connected → Connect (consent sheet first); connected → the account, Disconnect (asks first); needs
// reconnecting → why, Connect again and Disconnect. Loading, failure and empty states each say so.

import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { CalendarConnection, CalendarProvider } from '@rsn/shared';
import { useLocation } from 'react-router-dom';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import CalendarConsentSheet from './CalendarConsentSheet';
import {
  CARD_INTRO, CARD_TITLE, CONNECT_LABEL, DISCONNECT_TITLE, MICROSOFT_REMOVE_HINT, NEEDS_RECONNECT, PROVIDER_LABEL,
  disconnectBody, returnPathFrom,
} from './calendar-words';
import { calendarErrorMessage, useCalendarConnections, useCalendarSwitch, useDisconnectCalendar } from './useCalendar';

export default function CalendarsCard() {
  const { on, providers } = useCalendarSwitch();
  if (!on) return null;
  return <CalendarsCardBody providers={providers} />;
}

function CalendarsCardBody({ providers }: { providers: CalendarProvider[] }) {
  const { pathname, search } = useLocation();
  const { addToast } = useToastStore();
  const connections = useCalendarConnections(true);
  const disconnect = useDisconnectCalendar();
  const [consentFor, setConsentFor] = useState<CalendarProvider | null>(null);
  const [confirming, setConfirming] = useState<CalendarProvider | null>(null);

  const byProvider = new Map((connections.data ?? []).map((c) => [c.provider, c] as const));
  const rows = [...new Set<CalendarProvider>([...providers, ...byProvider.keys()])];

  const confirmDisconnect = () => {
    if (!confirming) return;
    const provider = confirming;
    disconnect.mutate(provider, {
      onSuccess: (result) => {
        setConfirming(null);
        if (provider === 'microsoft' && !result.revokedAtProvider) addToast(MICROSOFT_REMOVE_HINT, 'success', { duration: 8000 });
        else addToast(`${PROVIDER_LABEL[provider]} disconnected.`, 'success');
      },
      onError: (err) => addToast(calendarErrorMessage(err, 'We could not disconnect that calendar. Please try again.'), 'error'),
    });
  };

  return (
    <Card className="animate-fade-in-up" data-testid="calendars-card">
      <div className="mb-2 flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-rsn-red" />
        <h2 className="font-semibold text-[#1a1a2e]">{CARD_TITLE}</h2>
      </div>
      <p className="mb-3 text-xs text-gray-500">{CARD_INTRO}</p>

      {connections.isPending ? (
        <div className="space-y-3 py-2" aria-hidden>
          <span className="sr-only" role="status">Loading your calendars</span>
          {providers.map((p) => <Skeleton key={p} className="h-11 w-full" />)}
        </div>
      ) : connections.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-2" role="alert">
          <p className="text-sm text-gray-600">We couldn&apos;t load your calendars.</p>
          <Button variant="secondary" onClick={() => void connections.refetch()}>Try again</Button>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              connection={byProvider.get(provider) ?? null}
              offered={providers.includes(provider)}
              busy={disconnect.isPending && disconnect.variables === provider}
              onConnect={() => setConsentFor(provider)}
              onDisconnect={() => setConfirming(provider)}
            />
          ))}
        </ul>
      )}

      <CalendarConsentSheet provider={consentFor} returnTo={returnPathFrom(pathname, search)} onClose={() => setConsentFor(null)} />
      <ConfirmDialog
        open={confirming !== null}
        title={DISCONNECT_TITLE}
        body={confirming ? disconnectBody(confirming) : ''}
        confirmLabel="Disconnect"
        tone="danger"
        busy={disconnect.isPending}
        busyLabel="Disconnecting…"
        onConfirm={confirmDisconnect}
        onCancel={() => setConfirming(null)}
      />
    </Card>
  );
}

function ProviderRow({ provider, connection, offered, busy, onConnect, onDisconnect }: {
  provider: CalendarProvider;
  connection: CalendarConnection | null;
  offered: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const reconnect = connection?.status === 'needs_reconnect';
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3" data-testid={`calendar-row-${provider}`}>
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium text-gray-800">{PROVIDER_LABEL[provider]}</p>
        {connection ? (
          <p className={`text-xs [overflow-wrap:anywhere] ${reconnect ? 'text-amber-700' : 'text-gray-500'}`}>
            {reconnect ? NEEDS_RECONNECT : `Connected${connection.accountEmail ? ` as ${connection.accountEmail}` : ''}. We check your main calendar.`}
          </p>
        ) : (
          <p className="text-xs text-gray-400">Not connected</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {offered && (!connection || reconnect) && (
          <Button size="md" variant={reconnect ? 'primary' : 'outline'} onClick={onConnect}>
            {reconnect ? 'Connect again' : CONNECT_LABEL[provider]}
          </Button>
        )}
        {connection && (
          <Button size="md" variant="ghost" onClick={onDisconnect} isLoading={busy} className="text-red-600">
            Disconnect
          </Button>
        )}
      </div>
    </li>
  );
}
