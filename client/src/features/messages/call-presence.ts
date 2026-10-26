// client/src/features/messages/call-presence.ts
// Who is in the 1:1 call with me, as the room tells it (26 Oct 2026). No React here, so a test can run the rule
// against a stand-in room: server/src/__tests__/client/meet-room-presence.test.ts.
//
// When the other person leaves, the call goes on for whoever is still in it. It used to end for both: the page swapped
// the room for a "Call ended" screen, which dropped the other connection too, and went back to the chat on a timer.
// Now the person still in the room is told who left and chooses: wait for them to come back, or leave as well.

import { RoomEvent, type RemoteParticipant, type Room } from 'livekit-client';

/** The part of a LiveKit room the watcher reads. */
export type PresenceRoom = Pick<Room, 'on' | 'off' | 'remoteParticipants'>;

/** "Stefan Avivson left the call". */
export function leftCallText(name: string | null | undefined): string {
  return `${name?.trim() || 'The other person'} left the call`;
}

/**
 * Report the other person leaving (`onChange(name)`, '' when the room has no name for them) and anyone coming back in
 * (`onChange(null)`). It never leaves the room itself. Returns the function that stops watching.
 */
export function watchPartner(room: PresenceRoom, onChange: (leftName: string | null) => void): () => void {
  const gone = (p: RemoteParticipant) => {
    // Rejoining under the same identity can land before the old connection's goodbye: then they are still here.
    for (const other of room.remoteParticipants.values()) {
      if (other.identity === p.identity) return;
    }
    onChange(p.name ?? '');
  };
  const back = () => onChange(null);
  room.on(RoomEvent.ParticipantDisconnected, gone);
  room.on(RoomEvent.ParticipantConnected, back);
  return () => {
    room.off(RoomEvent.ParticipantDisconnected, gone);
    room.off(RoomEvent.ParticipantConnected, back);
  };
}
