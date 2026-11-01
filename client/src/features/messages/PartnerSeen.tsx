// client/src/features/messages/PartnerSeen.tsx
// Tells the 1:1 room once the other person has been in it (30 Oct 2026, feedback after meetings; the rule is in
// partner-seen.ts). Renders nothing.
import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { watchPartnerSeen } from './partner-seen';

export default function PartnerSeen({ onSeen }: { onSeen: () => void }) {
  const room = useRoomContext();
  useEffect(() => watchPartnerSeen(room, onSeen), [room, onSeen]);
  return null;
}
