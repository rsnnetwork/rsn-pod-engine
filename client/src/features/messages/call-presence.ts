// client/src/features/messages/call-presence.ts
// Who is in the 1:1 call with me, as the room tells it (26 Oct 2026). No React here, so a test can run the rule
// against a stand-in room: server/src/__tests__/client/meet-room-presence.test.ts.
//
// When the other person leaves, the call goes on for whoever is still in it. It used to end for both: the page swapped
// the room for a "Call ended" screen, which dropped the other connection too, and went back to the chat on a timer.
// Now the person still in the room is told who left and chooses: wait for them to come back, or leave as well.
//
// A leave is only said once it has lasted, because the room also reports one when nobody left:
//   - my own full reconnect: livekit-client unwinds everyone in the room (a "disconnected" for each, while the room
//     still reads as connected), only then says it is reconnecting, and puts them back once it has reconnected;
//   - their reconnect, or a rejoin from another tab: their old connection's goodbye, then the new one's hello.
// So a leave waits LEAVE_GRACE_MS. My own reconnect cancels the wait, and once I am back in the room the wait starts
// again only if they are not there. Anyone coming back in clears the notice.

import { ConnectionState, RoomEvent, type RemoteParticipant, type Room } from 'livekit-client';

/** The part of a LiveKit room the watcher reads. */
export type PresenceRoom = Pick<Room, 'on' | 'off' | 'remoteParticipants' | 'state'>;

/** How long the other person has to be gone before "left the call" shows: long enough for a reconnect to land. */
export const LEAVE_GRACE_MS = 5_000;

/** "Stefan Avivson left the call". */
export function leftCallText(name: string | null | undefined): string {
  return `${name?.trim() || 'The other person'} left the call`;
}

/**
 * Report the other person leaving (`onChange(name)`, '' when the room has no name for them) once they have been gone
 * for `graceMs`, and anyone coming back in (`onChange(null)`). It never leaves the room itself. Returns the function
 * that stops watching.
 */
export function watchPartner(
  room: PresenceRoom,
  onChange: (leftName: string | null) => void,
  graceMs: number = LEAVE_GRACE_MS,
): () => void {
  // The other person as the room last named them, and the wait before saying they left.
  let partner: { identity: string; name: string } | null = null;
  let wait: ReturnType<typeof setTimeout> | null = null;

  const stopWaiting = () => {
    if (wait !== null) clearTimeout(wait);
    wait = null;
  };
  // The room's list is keyed by identity, and livekit-client takes a person off it before it says they left.
  const inRoom = (identity: string) => room.remoteParticipants.has(identity);
  const sayIfStillGone = () => {
    wait = null;
    if (!partner || room.state !== ConnectionState.Connected || inRoom(partner.identity)) return;
    onChange(partner.name);
  };
  const waitThenSay = () => {
    stopWaiting();
    wait = setTimeout(sayIfStillGone, graceMs);
  };

  const gone = (p: RemoteParticipant) => {
    partner = { identity: p.identity, name: p.name ?? '' };
    // While my own room is reconnecting, nothing it says about the others is news: Reconnected decides.
    if (room.state !== ConnectionState.Connected) return;
    waitThenSay();
  };
  const back = (p: RemoteParticipant) => {
    partner = { identity: p.identity, name: p.name ?? '' };
    stopWaiting();
    onChange(null);
  };
  // My own connection dropped: a leave heard just now was my room unwinding, not them going.
  const reconnecting = () => stopWaiting();
  // Back in the room: the list is whole again before the buffered hellos arrive, so it already says who is here.
  const reconnected = () => {
    if (partner && !inRoom(partner.identity)) waitThenSay();
  };

  room.on(RoomEvent.ParticipantDisconnected, gone);
  room.on(RoomEvent.ParticipantConnected, back);
  room.on(RoomEvent.Reconnecting, reconnecting);
  room.on(RoomEvent.SignalReconnecting, reconnecting);
  room.on(RoomEvent.Reconnected, reconnected);
  return () => {
    stopWaiting();
    room.off(RoomEvent.ParticipantDisconnected, gone);
    room.off(RoomEvent.ParticipantConnected, back);
    room.off(RoomEvent.Reconnecting, reconnecting);
    room.off(RoomEvent.SignalReconnecting, reconnecting);
    room.off(RoomEvent.Reconnected, reconnected);
  };
}
