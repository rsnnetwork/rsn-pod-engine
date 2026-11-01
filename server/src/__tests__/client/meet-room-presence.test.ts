// server/src/__tests__/client/meet-room-presence.test.ts
// The 1:1 call room (MeetPage), 26 Oct 2026. Three faults:
//   - One person leaving ended the call for BOTH: the watcher swapped the room for a "Call ended" screen (which drops
//     the other person's connection) and sent them back to the chat 3.5 s later. The 25 Oct spec's Script B asks to
//     "leave and rejoin without ending the other person's meeting".
//   - The room's token was minted when the page LOADED. Opened early, the countdown waited, then entered on a token
//     minted outside the meeting window, so attendance was never stamped and calls never unlocked.
//   - (fix round 1) The member's OWN full reconnect told them "{partner} left the call": livekit-client unwinds every
//     participant (delete, then a "disconnected" event) before it says it is reconnecting.
// call-presence.ts holds the watcher's rule and has no React in it, so this runs it against a stand-in room built on
// Node's EventEmitter that orders things as livekit-client 2.17's Room does (the local stack has no LiveKit server).
// MeetPage's wiring is read from source; the real room, with two browsers, is meeting-call.spec.ts test 9, on the preview.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionState, RoomEvent } from 'livekit-client';
import {
  DEPART_MS, GOODBYE_MS, GOODBYE_TOPIC, LEAVE_GRACE_MS, leaveCall, leftCallText, watchPartner, type DepartingRoom, type PresenceRoom,
} from '../../../../client/src/features/messages/call-presence';

interface Person { identity: string; name?: string }

/**
 * A stand-in for LiveKit's Room, in its order of events:
 *   - handleParticipantDisconnected takes the person off remoteParticipants, THEN emits ParticipantDisconnected;
 *   - handleRestarting (a full reconnect) does that for everyone while the room still reads Connected, THEN sets
 *     Reconnecting and emits Reconnecting;
 *   - handleSignalRestarted puts the people still there back on the list, sets Connected, emits Reconnected, and only
 *     then emits the ParticipantConnected events it buffered while reconnecting (emitWhenConnected).
 */
class StubRoom extends EventEmitter {
  remoteParticipants = new Map<string, Person>();
  state: ConnectionState = ConnectionState.Connected;
  disconnect = jest.fn();
  private buffered: Person[] = [];
  join(p: Person) {
    this.remoteParticipants.set(p.identity, p);
    if (this.state === ConnectionState.Connected) this.emit(RoomEvent.ParticipantConnected, p);
    else this.buffered.push(p);
  }
  leave(p: Person) {
    this.remoteParticipants.delete(p.identity);
    this.emit(RoomEvent.ParticipantDisconnected, p);
  }
  restart() {
    for (const p of [...this.remoteParticipants.values()]) this.leave(p);
    this.state = ConnectionState.Reconnecting;
    this.emit(RoomEvent.Reconnecting);
  }
  reconnected(stillThere: Person[]) {
    this.buffered = [];
    for (const p of stillThere) this.join(p);
    this.state = ConnectionState.Connected;
    this.emit(RoomEvent.Reconnected);
    const hellos = this.buffered;
    this.buffered = [];
    for (const p of hellos) this.emit(RoomEvent.ParticipantConnected, p);
  }
  asRoom(): PresenceRoom { return this as unknown as PresenceRoom; }
}

const stefan: Person = { identity: 'u-stefan', name: 'Stefan Avivson' };
const LEFT = 'Stefan Avivson';

function watched() {
  const room = new StubRoom();
  const seen: Array<string | null> = [];
  const stop = watchPartner(room.asRoom(), (name) => seen.push(name));
  return { room, seen, stop };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('when the other person leaves, the room stays open for whoever is still in it', () => {
  it('says who left once they have been gone a few seconds, and never leaves the room itself', () => {
    const { room, seen } = watched();
    room.join(stefan);
    room.leave(stefan);
    expect(LEAVE_GRACE_MS).toBeGreaterThanOrEqual(3_000);
    expect(LEAVE_GRACE_MS).toBeLessThanOrEqual(10_000);
    jest.advanceTimersByTime(LEAVE_GRACE_MS - 1);
    expect(seen).toEqual([null]);
    jest.advanceTimersByTime(1);
    expect(seen).toEqual([null, LEFT]);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it('clears the notice when they come back in', () => {
    const { room, seen } = watched();
    room.join(stefan);
    room.leave(stefan);
    jest.advanceTimersByTime(LEAVE_GRACE_MS);
    room.join(stefan);
    expect(seen).toEqual([null, LEFT, null]);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it('their reconnect (a goodbye, then the new connection\'s hello) is not a leave', () => {
    const { room, seen } = watched();
    room.join(stefan);
    room.leave(stefan);
    jest.advanceTimersByTime(LEAVE_GRACE_MS / 2);
    room.join(stefan);
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 4);
    expect(seen).not.toContain(LEFT);
  });

  it('my OWN full reconnect is not their leave: the room unwinds everyone, reconnects, and puts them back', () => {
    const { room, seen } = watched();
    room.join(stefan);
    room.restart();
    // The reconnect takes longer than the grace: still nothing said while it runs.
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 3);
    room.reconnected([stefan]);
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 3);
    expect(seen).not.toContain(LEFT);
    expect(seen[seen.length - 1]).toBeNull();
  });

  it('if they really left while I was reconnecting, it says so once I am back and they still are not', () => {
    const { room, seen } = watched();
    room.join(stefan);
    room.restart();
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 3);
    room.reconnected([]);
    jest.advanceTimersByTime(LEAVE_GRACE_MS - 1);
    expect(seen).not.toContain(LEFT);
    jest.advanceTimersByTime(1);
    expect(seen[seen.length - 1]).toBe(LEFT);
  });

  it('stops listening, and drops a notice still waiting, when the room is left', () => {
    const { room, seen, stop } = watched();
    const events = [
      RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantConnected,
      RoomEvent.Reconnecting, RoomEvent.SignalReconnecting, RoomEvent.Reconnected,
    ];
    for (const e of events) expect(room.listenerCount(e)).toBe(1);
    room.join(stefan);
    room.leave(stefan);
    stop();
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 2);
    expect(seen).toEqual([null]);
    for (const e of events) expect(room.listenerCount(e)).toBe(0);
  });

  it('someone the room has no name for still raises the notice (as "", never as null, which means "nobody left")', () => {
    const { room, seen } = watched();
    room.join({ identity: 'u-nameless' });
    room.leave({ identity: 'u-nameless' });
    jest.advanceTimersByTime(LEAVE_GRACE_MS);
    expect(seen).toEqual([null, '']);
    expect(leftCallText(seen[1])).toBe('The other person left the call');
  });

  it('the words: "{name} left the call", and a name it does not have is "The other person"', () => {
    expect(leftCallText('Stefan Avivson')).toBe('Stefan Avivson left the call');
    expect(leftCallText('')).toBe('The other person left the call');
    expect(leftCallText(null)).toBe('The other person left the call');
  });
});

// Leave fix (1 Nov 2026). On LiveKit Cloud the person still in the room was not told within 30 s that the other had
// pressed Leave. A local LiveKit server shows why that can happen: when a leave's goodbye does not reach the server
// (the page crashed, the network went, the tab closed straight after the press), the server keeps the person listed
// until their connection times out, about 21 s, and the grace makes that 26 s. So someone who leaves on purpose now
// says so in the room itself, over the call's data channel, and the person still there is told at once; a drop is
// still caught by the server taking them off the list, after the grace.
const goodbye = new TextEncoder().encode('left');
function sayGoodbye(room: StubRoom, from: Person, topic: string = GOODBYE_TOPIC) {
  room.emit(RoomEvent.DataReceived, goodbye, from, undefined, topic);
}

describe('someone who leaves on purpose is announced at once', () => {
  it('says who left the moment their goodbye arrives, while the room still lists them', () => {
    const { room, seen } = watched();
    room.join(stefan);
    sayGoodbye(room, stefan);
    expect(seen).toEqual([null, LEFT]);
    expect(room.remoteParticipants.has(stefan.identity)).toBe(true);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it('the server taking them off afterwards is not news: a Wait stays a Wait', () => {
    const { room, seen } = watched();
    room.join(stefan);
    sayGoodbye(room, stefan);
    room.leave(stefan);
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 3);
    expect(seen).toEqual([null, LEFT]);
  });

  it('their coming back in after the goodbye clears the notice, and a later real leave is said again', () => {
    const { room, seen } = watched();
    room.join(stefan);
    sayGoodbye(room, stefan);
    room.leave(stefan);
    room.join(stefan);
    expect(seen).toEqual([null, LEFT, null]);
    room.leave(stefan);
    jest.advanceTimersByTime(LEAVE_GRACE_MS);
    expect(seen).toEqual([null, LEFT, null, LEFT]);
  });

  it('a data message on any other topic, or one with no sender, is not a goodbye', () => {
    const { room, seen } = watched();
    room.join(stefan);
    sayGoodbye(room, stefan, 'lk-chat-topic');
    room.emit(RoomEvent.DataReceived, goodbye, undefined, undefined, GOODBYE_TOPIC);
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 2);
    expect(seen).toEqual([null]);
  });

  // Fix round 1 (review Minor 2): my own reconnect after their goodbye unwinds them and comes back without them;
  // that is the leave already said, so it is not said a second time (a Wait stays a Wait).
  it('my own reconnect after their goodbye does not say it again once I am back and they are not', () => {
    const { room, seen } = watched();
    room.join(stefan);
    sayGoodbye(room, stefan);
    room.restart();
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 2);
    room.reconnected([]);
    jest.advanceTimersByTime(LEAVE_GRACE_MS * 3);
    expect(seen).toEqual([null, LEFT]);
  });

  it('stops listening for goodbyes when the room is left', () => {
    const { room, stop } = watched();
    expect(room.listenerCount(RoomEvent.DataReceived)).toBe(1);
    stop();
    expect(room.listenerCount(RoomEvent.DataReceived)).toBe(0);
  });
});

/** The part of the room leaveCall uses, with a disconnect that can be held open. */
function leavingRoom(state: ConnectionState = ConnectionState.Connected) {
  const order: string[] = [];
  let finishDisconnect: () => void = () => {};
  const room = {
    state,
    localParticipant: {
      publishData: jest.fn(async (_data: Uint8Array, opts: { reliable?: boolean; topic?: string }) => {
        order.push(`goodbye:${opts.topic}:${opts.reliable ? 'reliable' : 'lossy'}`);
      }),
    },
    disconnect: jest.fn(() => new Promise<void>((resolve) => {
      order.push('disconnect');
      finishDisconnect = () => { order.push('disconnected'); resolve(); };
    })),
  };
  return { room, order, finish: () => finishDisconnect() };
}

describe('leaveCall: the goodbye, then the room\'s own disconnect, before the page moves on', () => {
  it('says goodbye on the reliable channel, then disconnects, and resolves only once the disconnect has finished', async () => {
    const { room, order, finish } = leavingRoom();
    let done = false;
    const left = leaveCall(room as unknown as DepartingRoom).then(() => { done = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual([`goodbye:${GOODBYE_TOPIC}:reliable`, 'disconnect']);
    expect(done).toBe(false);
    finish();
    await left;
    expect(order).toEqual([`goodbye:${GOODBYE_TOPIC}:reliable`, 'disconnect', 'disconnected']);
  });

  it('a room that never connected says no goodbye (nobody heard them come in) and still disconnects', async () => {
    const { room, order, finish } = leavingRoom(ConnectionState.Connecting);
    const left = leaveCall(room as unknown as DepartingRoom);
    await jest.advanceTimersByTimeAsync(0);
    finish();
    await left;
    expect(room.localParticipant.publishData).not.toHaveBeenCalled();
    expect(order).toEqual(['disconnect', 'disconnected']);
  });

  it('a goodbye that fails still disconnects', async () => {
    const { room, order, finish } = leavingRoom();
    room.localParticipant.publishData.mockRejectedValueOnce(new Error('engine closed'));
    const left = leaveCall(room as unknown as DepartingRoom);
    await jest.advanceTimersByTimeAsync(0);
    finish();
    await left;
    expect(order).toEqual(['disconnect', 'disconnected']);
  });

  // Fix round 1 (review Minor 1): a goodbye that stalls (the publisher never connects, e.g. camera and mic denied)
  // must not use up the whole bound: the disconnect still runs, and is waited for.
  it('a goodbye that never finishes is given up after GOODBYE_MS, and the disconnect still runs and is waited for', async () => {
    const { room, order, finish } = leavingRoom();
    room.localParticipant.publishData.mockImplementationOnce(() => new Promise<void>(() => {}));
    let done = false;
    const left = leaveCall(room as unknown as DepartingRoom).then(() => { done = true; });
    expect(GOODBYE_MS).toBeLessThan(DEPART_MS);
    await jest.advanceTimersByTimeAsync(GOODBYE_MS - 1);
    expect(order).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['disconnect']);
    expect(done).toBe(false);
    finish();
    await left;
    expect(order).toEqual(['disconnect', 'disconnected']);
  });

  it('never holds the person in the room: a disconnect that does not finish is given up after DEPART_MS', async () => {
    const { room } = leavingRoom();
    let done = false;
    void leaveCall(room as unknown as DepartingRoom).then(() => { done = true; });
    expect(DEPART_MS).toBeLessThanOrEqual(3_000);
    await jest.advanceTimersByTimeAsync(DEPART_MS - 1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});

const meetPage = () => fs.readFileSync(path.join(__dirname, '../../../../client/src/features/messages/MeetPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

describe('MeetPage, read from source', () => {
  it('mints the room\'s token as the person goes in (after the countdown, or "Join now anyway"), not on page load', () => {
    const src = meetPage();
    expect(src).toMatch(/const entering = scheduleChecked && !waiting && !ended;/);
    const effect = src.slice(src.indexOf('useEffect(() => {\n    if (!entering) return;'));
    expect(effect.length).toBeGreaterThan(0);
    expect(effect.slice(0, 600)).toMatch(/call-token/);
    expect(effect.slice(0, 900)).toMatch(/\}, \[entering, conversationId, kind\]\);/);
    expect(src.match(/call-token/g)).toHaveLength(1);
  });

  it('the other person leaving never ends the call: no "Call ended" screen, no timer back to the chat', () => {
    const src = meetPage();
    expect(src).not.toMatch(/setTimeout\(leave/);
    expect(src).not.toMatch(/remoteEnded/);
    expect(src).not.toMatch(/>Call ended</);
  });

  it('reads the meeting from the scheduler\'s live query, so a countdown opened before a move opens at the new time', () => {
    const src = meetPage();
    expect(src).toMatch(/useQuery<Scheduling>\(\{\s*queryKey: schedulingKey\(conversationId \?\? ''\),/);
    expect(src).toMatch(/meta: \{ entities: conversationId \? \[E\.dmConversation\(conversationId\)\] : \[\] \}/);
    // A fresh read decides, not whatever an earlier page left in the cache.
    expect(src).toMatch(/refetchOnMount: 'always',/);
    expect(src).toMatch(/const scheduleChecked = !isScheduled \|\| schedule\.isFetchedAfterMount;/);
    // No copy of it in the page's own state, read once.
    expect(src).not.toMatch(/setStartAt|setDurationMin|setScheduleChecked/);
  });

  it('once the person is in the room, neither a move nor the clock takes them back out to a countdown', () => {
    const src = meetPage();
    expect(src).toMatch(/const gated = isScheduled && !forceJoin && !live;/);
    expect(src).toMatch(/const waiting = gated && /);
    expect(src).toMatch(/const ended = gated && /);
  });

  it('uses the shared meeting rules and words: when Join opens, when a meeting is over, and a refusal\'s sentence', () => {
    const src = meetPage();
    expect(src).toMatch(/import \{ MEETING_JOIN_EARLY_MIN \} from '@rsn\/shared';/);
    expect(src).toMatch(/const EARLY_JOIN_MS = MEETING_JOIN_EARLY_MIN \* 60_000;/);
    expect(src).toMatch(/opens automatically \{MEETING_JOIN_EARLY_MIN\} minutes before/);
    expect(src).toMatch(/isMeetingOver\(meeting\?\.startAt, meeting\?\.durationMin, now\)/);
    expect(src).toMatch(/errorMessage\(e, 'Could not start the call\. Try again from the chat\.'\)/);
    // No number of its own for either rule, and no third copy of the error extractor.
    expect(src).not.toMatch(/MEETING_GRACE_MS|function failureText/);
    expect(src).not.toMatch(/\b5 minutes\b|\b30 min/);
  });

  it('the notice offers Wait (stay in the room) and Leave', () => {
    const src = meetPage();
    expect(src).toMatch(/watchPartner\(room, setLeftName\)/);
    expect(src).toMatch(/\{leftCallText\(leftName\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => setLeftName\(null\)\}[\s\S]{0,300}>\s*Wait\s*</);
    // Fix round 3 (T8): pressed, it reads "Leaving…" while the leave is on its way.
    expect(src).toMatch(/onClick=\{onLeave\}[\s\S]{0,300}\{leaving \? 'Leaving…' : 'Leave'\}/);
  });

  // Leave fix (1 Nov 2026): the goodbye used to be said only by LiveKitRoom's unmount, after the page had already
  // moved on (the router changes the address first and unmounts in a transition), so a tab closed or a network lost
  // straight after the press took the goodbye with it.
  it('leaving on purpose says goodbye and waits for the room\'s disconnect before the page moves on', () => {
    const src = meetPage();
    expect(src).toMatch(/import \{ leaveCall, leftCallText, watchPartner \} from '\.\/call-presence';/);
    // Set inside the room (the leave buttons sit outside it), and put back when the room goes.
    expect(src).toMatch(/depart\.current = \(\) => leaveCall\(room\);\s*return \(\) => \{ depart\.current = noDeparture; \};/);
    expect(src).toMatch(/<CallEndWatcher onLeave=\{leaveRoom\} leaving=\{leaving\} depart=\{departRef\} \/>/);
    // The question (read as the person leaves, before the room empties) and the departure run together; the page
    // moves on once both are done, each with its own bound (LEAVE_READ_MS, DEPART_MS).
    const leave = src.slice(src.indexOf('const leaveRoom = useCallback'));
    expect(leave).toMatch(/^const leaveRoom = useCallback\(\(\) => \{\s*if \(leftRoom\.current\) return;\s*leftRoom\.current = true;\s*setLeaving\(true\);\s*void Promise\.all\(\[\s*afterRoomLeave\(\{[\s\S]*?\}\),\s*departRef\.current\(\),\s*\]\)\.then\(\(\[to\]\) => navigate\(to\)\);/);
    expect(src.match(/navigate\(to\)/g)).toHaveLength(1);
  });

  // Fix round 1 (review Important): LiveKit's ControlBar draws its own red Leave, which disconnects the room itself, so
  // its goodbye was never said (the room was already disconnected when onDisconnected reached the leave). The bar's
  // own Leave is off; the red hang-up in the bar is ours, and it is the person leaving like every other leave.
  it('the bottom bar\'s hang-up is ours: LiveKit\'s own Leave is off, and ours leaves the room the same way', () => {
    const src = meetPage();
    expect(src.match(/<ControlBar\b/g)).toHaveLength(1);
    expect(src).toMatch(/<ControlBar variation="minimal" controls=\{\{ leave: false \}\}/);
    expect(src).not.toMatch(/DisconnectButton|useDisconnectButton|\.disconnect\(/);
    const hangUp = src.slice(src.indexOf('data-testid="call-hang-up"') - 400, src.indexOf('data-testid="call-hang-up"') + 400);
    expect(hangUp).toMatch(/onClick=\{leaveRoom\}\s*disabled=\{leaving\}\s*aria-busy=\{leaving\}/);
    expect(hangUp).toMatch(/aria-label="Leave call"/);
    expect(hangUp).toMatch(/lk-disconnect-button/);
    expect(hangUp).toMatch(/min-h-\[44px\] min-w-\[44px\]/);
  });
});
