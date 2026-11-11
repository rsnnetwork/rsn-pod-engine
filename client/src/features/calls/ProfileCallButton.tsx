// client/src/features/calls/ProfileCallButton.tsx
// "Video call" on a connection's profile (1 Nov 2026, 30 Oct review item 4: "start a video call right away with
// a connection, without scheduling a meeting"). Shown only when the brief says the two can call (canCall: they
// are connected, neither has blocked the other, both are members), so a stranger's profile has none. It rings
// the person by id (POST /calls/user/:userId), which finds or opens their conversation. Video only: audio stays
// in the thread. The dialog asks how long (15 minutes to start with), and the "Calling…" card then waits on
// every screen.
//
// 11 Nov 2026 (Shirley Palmer's RSN 07): it follows the person's presence the way the thread does (usePresence), so the
// profile and the thread never disagree. Never disabled for presence; away adds a note under it; a press while they are
// offline opens the offline sheet, whose Find a time and Send a message open the conversation (with the scheduler for
// the first).
import { useNavigate } from 'react-router-dom';
import type { PersonBrief } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { CallRequestModal } from '@/features/messages/CallRequest';
import CallButton from './CallButton';
import OfflineCallSheet from './OfflineCallSheet';
import { useCallRequest } from './useCallRequest';
import { useMemberPresence } from './usePresence';
import { awayNote, callHint } from './presence-words';
import { writeToPath } from '@/features/messages/compose-intent';

export default function ProfileCallButton({ brief, userId, name }: { brief: PersonBrief; userId: string; name: string }) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const navigate = useNavigate();
  const presence = useMemberPresence(me, userId, !!brief.canCall);
  const call = useCallRequest(brief.canCall ? { userId } : null, name, {
    state: presence.data,
    refresh: () => presence.refetch().then((r) => r.data),
  });
  if (!brief.canCall) return null;
  const toConversation = (schedule: boolean) => {
    call.closeOffline();
    navigate(schedule ? `/messages/new/${encodeURIComponent(userId)}?schedule=1` : writeToPath(userId));
  };
  return (
    <>
      <CallButton
        variant="hero"
        onClick={() => call.open('video')}
        disabled={call.ringing}
        title={callHint(presence.data, name)}
        note={presence.data === 'away' ? awayNote(name) : undefined}
      />
      <CallRequestModal {...call.modal} videoOnly />
      <OfflineCallSheet
        {...call.offline}
        name={name}
        onFindATime={() => toConversation(true)}
        onSendMessage={() => toConversation(false)}
      />
    </>
  );
}
