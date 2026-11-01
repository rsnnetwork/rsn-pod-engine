// client/src/features/messages/PartnerSeen.tsx
// Tells the 1:1 room once the other person has been in it (30 Oct 2026, feedback after meetings; the rule is in
// partner-seen.ts), and lets the leave ask the room, as the person leaves, whether anyone else is in it now (1 Nov
// 2026, fix round 2: the leave buttons sit outside the LiveKit room). Renders nothing.
import { useEffect, type MutableRefObject } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { partnerInRoom, watchPartnerSeen } from './partner-seen';

export default function PartnerSeen({ onSeen, probe }: { onSeen: () => void; probe: MutableRefObject<() => boolean> }) {
  const room = useRoomContext();
  useEffect(() => watchPartnerSeen(room, onSeen), [room, onSeen]);
  useEffect(() => {
    probe.current = () => partnerInRoom(room);
    return () => { probe.current = () => false; };
  }, [room, probe]);
  return null;
}
