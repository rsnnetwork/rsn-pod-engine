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
//
// Someone who leaves on purpose says so (1 Nov 2026). The room's own leave reaches the other person through the LiveKit
// server, which takes a person off the list at once only if their goodbye reached it; otherwise it keeps them until
// their connection times out (about 21 s on a local server, so 26 s with the grace). On LiveKit Cloud the person still
// in the room was not told within 30 s. So leaveCall first says goodbye in the room itself, on the call's reliable
// data channel, then disconnects and waits for that before the page moves on; the other side says who left the moment
// the goodbye arrives. A drop (a crash, a lost network) still shows once the server takes them off, after the grace.
// So do the leaves that never pass through leaveCall: closing or refreshing the tab (a goodbye there would flash
// "left the call" on every refresh), the browser's Back, a link out of the room, or answering another call from it.
// Those still send LiveKit's own leave as the room unmounts, so the other person is told after the grace.

import { ConnectionState, RoomEvent, type LocalParticipant, type RemoteParticipant, type Room } from 'livekit-client';

/** The part of a LiveKit room the watcher reads. */
export type PresenceRoom = Pick<Room, 'on' | 'off' | 'remoteParticipants' | 'state'>;

/** The part of a LiveKit room leaveCall uses. */
export type DepartingRoom = Pick<Room, 'state' | 'disconnect' | 'remoteParticipants' | 'on' | 'off'> & {
  localParticipant: Pick<LocalParticipant, 'publishData'>;
};

/** The data topic a goodbye is sent on. */
export const GOODBYE_TOPIC = 'reason:left-call';
/** The longest a leave waits on its own connection, the goodbye and the disconnect before the page moves on anyway. */
export const DEPART_MS = 3_000;
/**
 * The longest a leave waits for my own room to finish connecting before it can say goodbye (fix round 2, 2 Nov 2026).
 * The other room lists me as soon as the server announces my join, which on LiveKit Cloud is a second or more before
 * my own room reads Connected; a leave pressed in between said no goodbye, and the other person waited on the
 * server's leave instead, past 30 s on Cloud.
 */
export const CONNECT_MS = 1_500;
/**
 * The longest the goodbye itself is waited on, inside DEPART_MS, so the disconnect always runs and is waited for: a
 * goodbye can stall (livekit-client waits for the publisher to connect, which a person with camera and mic denied
 * may never have done). A second, not half of one (fix round 2): livekit-client opens the data channel only when it
 * is first used, and on LiveKit Cloud that renegotiation is a round trip or two away.
 */
export const GOODBYE_MS = 1_000;
const GOODBYE = new TextEncoder().encode('left');

/** `work`, or nothing once `ms` have passed, whichever is first; never rejects. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([work.catch(() => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the room reads Connected (at once if it already does), or after `ms`; stops listening either way. */
async function connectedWithin(room: DepartingRoom, ms: number): Promise<void> {
  if (room.state === ConnectionState.Connected) return;
  let onState: ((state: ConnectionState) => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    onState = (state) => { if (state === ConnectionState.Connected) resolve(); };
    room.on(RoomEvent.ConnectionStateChanged, onState);
  });
  try {
    await within(connected, ms);
  } finally {
    if (onState) room.off(RoomEvent.ConnectionStateChanged, onState);
  }
}

/**
 * Leave the room on purpose. When someone else is in it (so they may have seen me come in), say goodbye: first let my
 * own room finish connecting, for at most CONNECT_MS, then wait at most GOODBYE_MS on the goodbye itself. Then
 * disconnect. A room with nobody else in it has no one to tell. Resolves once the disconnect has finished, or after
 * `timeoutMs` altogether, whichever is first; never rejects.
 */
export async function leaveCall(room: DepartingRoom, timeoutMs: number = DEPART_MS): Promise<void> {
  const depart = async () => {
    if (room.remoteParticipants.size > 0) {
      await connectedWithin(room, CONNECT_MS);
      // A goodbye that cannot be sent is the drop case: the server's own leave, or its timeout, still tells them.
      if (room.state === ConnectionState.Connected) {
        await within(room.localParticipant.publishData(GOODBYE, { reliable: true, topic: GOODBYE_TOPIC }), GOODBYE_MS);
      }
    }
    await room.disconnect();
  };
  // A disconnect that throws has still ended this side of the call; the page moves on either way.
  await within(depart(), timeoutMs);
}

/** How long the other person has to be gone before "left the call" shows: long enough for a reconnect to land. */
export const LEAVE_GRACE_MS = 5_000;

/** "Stefan Avivson left the call". */
export function leftCallText(name: string | null | undefined): string {
  return `${name?.trim() || 'The other person'} left the call`;
}

/**
 * Report the other person leaving (`onChange(name)`, '' when the room has no name for them) once they have been gone
 * for `graceMs`, or at once when they said goodbye (leaveCall), and anyone coming back in (`onChange(null)`). It never
 * leaves the room itself. Returns the function that stops watching.
 */
export function watchPartner(
  room: PresenceRoom,
  onChange: (leftName: string | null) => void,
  graceMs: number = LEAVE_GRACE_MS,
): () => void {
  // The other person as the room last named them, and the wait before saying they left.
  let partner: { identity: string; name: string } | null = null;
  let wait: ReturnType<typeof setTimeout> | null = null;
  // Whose goodbye has been said: the server taking that person off the list afterwards is not news.
  let announced: string | null = null;

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
    if (announced === p.identity) return;
    // While my own room is reconnecting, nothing it says about the others is news: Reconnected decides.
    if (room.state !== ConnectionState.Connected) return;
    waitThenSay();
  };
  const back = (p: RemoteParticipant) => {
    partner = { identity: p.identity, name: p.name ?? '' };
    announced = null;
    stopWaiting();
    onChange(null);
  };
  // My own connection dropped: a leave heard just now was my room unwinding, not them going.
  const reconnecting = () => stopWaiting();
  // Back in the room: the list is whole again before the buffered hellos arrive, so it already says who is here.
  const reconnected = () => {
    if (partner && partner.identity !== announced && !inRoom(partner.identity)) waitThenSay();
  };
  // The one other person the room lists, if it lists exactly one.
  const onlyOther = (): RemoteParticipant | undefined =>
    room.remoteParticipants.size === 1 ? room.remoteParticipants.values().next().value : undefined;
  // They pressed leave: said at once, with no grace, even while the room still lists them. livekit-client names the
  // sender from the identity the server stamps on the packet; without it, in a 1:1 room it can only be the other one.
  const saidGoodbye = (_payload: Uint8Array, sender?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (topic !== GOODBYE_TOPIC) return;
    const p = sender ?? onlyOther();
    if (!p) return;
    partner = { identity: p.identity, name: p.name ?? '' };
    announced = p.identity;
    stopWaiting();
    onChange(partner.name);
  };

  room.on(RoomEvent.ParticipantDisconnected, gone);
  room.on(RoomEvent.ParticipantConnected, back);
  room.on(RoomEvent.Reconnecting, reconnecting);
  room.on(RoomEvent.SignalReconnecting, reconnecting);
  room.on(RoomEvent.Reconnected, reconnected);
  room.on(RoomEvent.DataReceived, saidGoodbye);
  return () => {
    stopWaiting();
    room.off(RoomEvent.ParticipantDisconnected, gone);
    room.off(RoomEvent.ParticipantConnected, back);
    room.off(RoomEvent.Reconnecting, reconnecting);
    room.off(RoomEvent.SignalReconnecting, reconnecting);
    room.off(RoomEvent.Reconnected, reconnected);
    room.off(RoomEvent.DataReceived, saidGoodbye);
  };
}
