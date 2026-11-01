// client/src/features/messages/partner-seen.ts
// Whether the other person has been in the 1:1 room with me (30 Oct 2026, feedback after meetings). No React here, so
// a test can run it against a stand-in room: server/src/__tests__/client/meeting-feedback-ui.test.ts.
//
// Leaving the room after they have been in it asks how a scheduled meeting went; leaving a room nobody else came into
// goes back to the chat, as before.

import { RoomEvent, type Room } from 'livekit-client';

/** The part of a LiveKit room the watcher reads. */
export type SeenRoom = Pick<Room, 'on' | 'off' | 'remoteParticipants'>;

/**
 * Calls `onSeen` once the room has had anyone else in it: someone already there when I connect (the room lists them
 * once it has connected, with no "connected" of their own), or anyone who comes in later. Returns the function that
 * stops watching.
 */
export function watchPartnerSeen(room: SeenRoom, onSeen: () => void): () => void {
  const check = () => { if (room.remoteParticipants.size > 0) onSeen(); };
  check();
  room.on(RoomEvent.Connected, check);
  room.on(RoomEvent.ParticipantConnected, onSeen);
  return () => {
    room.off(RoomEvent.Connected, check);
    room.off(RoomEvent.ParticipantConnected, onSeen);
  };
}
