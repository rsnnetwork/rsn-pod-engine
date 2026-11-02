// ─── The ring, wherever the member is in the app (1 Nov 2026, 30 Oct review item 4) ─────────────────
//
// Mounted once, above every route (CallLayer in App.tsx), so a call rung from a profile, a thread or anywhere
// else rings the other person on whatever screen they are on, and enters the room for the caller when it is
// answered, from whatever screen the caller is on. These listeners used to live in the open thread
// (MessagesPage), so a call started anywhere else never entered the room.
// What each call:* event does in this tab is in call-signals.ts: the banner, the room for the tab that rang (and only
// that tab: finding F3, 2 Nov 2026), "{Name} can't take the call right now.", and the banner closing.
// After a refresh, a reconnect, or any change to a call (user:<id>:calls), GET /dm/call/requests/incoming and
// /outgoing say what is ringing now. A read only brings a call back or takes one away when it began after this
// device learned of that call, so a read already on its way when a call rang cannot hide the call again. A call of
// mine read this way was rung in another tab or on another device, unless this tab remembers ringing it.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { useCallStore } from '@/stores/callStore';
import { fetchIncomingCall, fetchOutgoingCall } from './call-api';
import { fromLive, reconcile, type RingingCall } from './call-ring';
import { callSignalHandlers } from './call-signals';
import { wasPlacedHere } from './placed-here';

const callKeys = {
  incoming: (me: string) => ['calls', 'incoming', me] as const,
  outgoing: (me: string) => ['calls', 'outgoing', me] as const,
};

export function useCallSignals(): void {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const addToast = useToastStore((s) => s.addToast);

  // The live socket events, for every screen.
  useEffect(() => {
    const socket = getSocket();
    const { onRequest, onAccepted, onDeclined, onCancelled } =
      callSignalHandlers({ store: useCallStore.getState, navigate, toast: (m) => addToast(m, 'info') });
    socket.on('call:request', onRequest);
    socket.on('call:accepted', onAccepted);
    socket.on('call:declined', onDeclined);
    socket.on('call:cancelled', onCancelled);
    return () => {
      socket.off('call:request', onRequest);
      socket.off('call:accepted', onAccepted);
      socket.off('call:declined', onDeclined);
      socket.off('call:cancelled', onCancelled);
    };
  }, [navigate, addToast]);

  // What rings now, read when the app opens and again whenever a call of mine changes.
  const incoming = useQuery({
    queryKey: callKeys.incoming(me ?? ''),
    queryFn: async () => { const askedAt = Date.now(); return { askedAt, call: await fetchIncomingCall() }; },
    enabled: !!me,
    staleTime: 0,
    refetchOnWindowFocus: false,
    meta: { entities: me ? [E.userCalls(me)] : [] },
  });
  const outgoing = useQuery({
    queryKey: callKeys.outgoing(me ?? ''),
    queryFn: async () => { const askedAt = Date.now(); return { askedAt, call: await fetchOutgoingCall() }; },
    enabled: !!me,
    staleTime: 0,
    refetchOnWindowFocus: false,
    meta: { entities: me ? [E.userCalls(me)] : [] },
  });

  useEffect(() => {
    if (!incoming.data) return;
    const { askedAt, call } = incoming.data;
    const next = reconcile(useCallStore.getState().incoming, call ? fromLive(call, 'incoming', askedAt) : null, askedAt);
    if (next !== undefined) useCallStore.getState().setIncoming(next);
  }, [incoming.data]);
  useEffect(() => {
    if (!outgoing.data) return;
    const { askedAt, call } = outgoing.data;
    const next = reconcile(useCallStore.getState().outgoing, call ? fromLive(call, 'outgoing', askedAt, wasPlacedHere(call.id)) : null, askedAt);
    if (next !== undefined) useCallStore.getState().setOutgoing(next);
  }, [outgoing.data]);

  // A call nobody answers lapses on its own, on both sides.
  const ringingIn = useCallStore((s) => s.incoming);
  const ringingOut = useCallStore((s) => s.outgoing);
  useEffect(() => {
    const timers = [ringingIn, ringingOut].filter((c): c is RingingCall => !!c).map((c) =>
      setTimeout(() => useCallStore.getState().end(c.requestId), Math.max(0, c.expiresAt - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [ringingIn, ringingOut]);
}
