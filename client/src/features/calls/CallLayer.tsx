// client/src/features/calls/CallLayer.tsx
// Calls above every route (1 Nov 2026): the ring listener, the banner for a call ringing me, and the card for a
// call I rang. Mounted once in App.tsx for a signed-in member, so the profile (outside the app's shell) and the
// call room ring too.
import IncomingCallBanner from '@/components/ui/IncomingCallBanner';
import OutgoingCallCard from './OutgoingCallCard';
import { useCallSignals } from './useCallSignals';

export default function CallLayer() {
  useCallSignals();
  return (
    <>
      <IncomingCallBanner />
      <OutgoingCallCard />
    </>
  );
}
