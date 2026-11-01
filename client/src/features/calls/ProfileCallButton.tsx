// client/src/features/calls/ProfileCallButton.tsx
// "Video call" on a connection's profile (1 Nov 2026, 30 Oct review item 4: "start a video call right away with
// a connection, without scheduling a meeting"). Shown only when the brief says the two can call (canCall: they
// are connected, neither has blocked the other, both are members), so a stranger's profile has none. It rings
// the person by id (POST /calls/user/:userId), which finds or opens their conversation. Video only: audio stays
// in the thread. The dialog asks how long (15 minutes to start with), and the "Calling…" card then waits on
// every screen. An offline person is said in the server's own sentence.
import type { PersonBrief } from '@rsn/shared';
import { CallRequestModal } from '@/features/messages/CallRequest';
import CallButton from './CallButton';
import { useCallRequest } from './useCallRequest';

export default function ProfileCallButton({ brief, userId, name }: { brief: PersonBrief; userId: string; name: string }) {
  const call = useCallRequest(brief.canCall ? { userId } : null, name);
  if (!brief.canCall) return null;
  return (
    <>
      <CallButton variant="hero" onClick={() => call.open('video')} disabled={call.ringing} />
      <CallRequestModal {...call.modal} videoOnly />
    </>
  );
}
