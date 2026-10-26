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
  LEAVE_GRACE_MS, leftCallText, watchPartner, type PresenceRoom,
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
    expect(src).toMatch(/onClick=\{onLeave\}[\s\S]{0,300}>\s*Leave\s*</);
  });
});
