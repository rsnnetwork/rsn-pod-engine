// client/src/features/calls/CallLayer.tsx
// Calls above every route (1 Nov 2026): the ring listener, the banner for a call ringing me, and the card for a
// call I rang. Mounted once in App.tsx for a signed-in member, so the profile (outside the app's shell) and the
// call room ring too.
import { useEffect } from 'react';
import IncomingCallBanner from '@/components/ui/IncomingCallBanner';
import { useCallStore } from '@/stores/callStore';
import OutgoingCallCard from './OutgoingCallCard';
import { useCallSignals } from './useCallSignals';

export default function CallLayer() {
  useCallSignals();
  // Signing out unmounts the layer: nothing of this member's calls stays for whoever signs in next in this tab.
  useEffect(() => () => {
    useCallStore.getState().setIncoming(null);
    useCallStore.getState().setOutgoing(null);
  }, []);
  return (
    <>
      <IncomingCallBanner />
      <OutgoingCallCard />
    </>
  );
}
