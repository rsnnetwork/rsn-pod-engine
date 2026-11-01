// client/src/features/messages/partner-seen.ts
// Whether the other person has been in the 1:1 room with me (30 Oct 2026, feedback after meetings). No React here, so
// a test can run it against a stand-in room: server/src/__tests__/client/meeting-feedback-ui.test.ts.
//
// Leaving the room after they have been in it asks how a scheduled meeting went; leaving a room nobody else came into
// goes back to the chat, as before.
//
// 1 Nov 2026 (fix round 2): the room's list of people is what counts, not one event. livekit-client sends
// ParticipantConnected only while the room reads as connected, holds it back while the room resumes its connection,
// and drops what it held back once the signal is back (Room.ts: emitWhenConnected; SignalResumed empties
// bufferedEvents). The person is still listed, and their tile still draws from the track and connection events, so
// the list is read on each of those too, and once more as the person leaves (partnerInRoom).

import { RoomEvent, type Room } from 'livekit-client';

/** The part of a LiveKit room the watcher reads. */
export type SeenRoom = Pick<Room, 'on' | 'off' | 'remoteParticipants'>;

/** The room events after which someone else may newly be listed in the room. */
const LISTED_AFTER = [
  RoomEvent.Connected,
  RoomEvent.Reconnected,
  RoomEvent.ConnectionStateChanged,
  RoomEvent.ParticipantActive,
  RoomEvent.TrackPublished,
  RoomEvent.TrackSubscribed,
] as const;

/** Someone else is in the room right now. */
export function partnerInRoom(room: Pick<Room, 'remoteParticipants'>): boolean {
  return room.remoteParticipants.size > 0;
}

/**
 * Calls `onSeen` once the room has had anyone else in it: someone already there when I connect (the room lists them
 * once it has connected, with no "connected" of their own), anyone who comes in later, and anyone the room lists
 * without announcing them. Returns the function that stops watching.
 */
export function watchPartnerSeen(room: SeenRoom, onSeen: () => void): () => void {
  const check = () => { if (partnerInRoom(room)) onSeen(); };
  check();
  for (const event of LISTED_AFTER) room.on(event, check);
  room.on(RoomEvent.ParticipantConnected, onSeen);
  return () => {
    for (const event of LISTED_AFTER) room.off(event, check);
    room.off(RoomEvent.ParticipantConnected, onSeen);
  };
}
