// server/src/__tests__/client/meet-room-presence.test.ts
// The 1:1 call room (MeetPage), 26 Oct 2026. Two faults:
//   - One person leaving ended the call for BOTH: the watcher swapped the room for a "Call ended" screen (which drops
//     the other person's connection) and sent them back to the chat 3.5 s later. The 25 Oct spec's Script B asks to
//     "leave and rejoin without ending the other person's meeting".
//   - The room's token was minted when the page LOADED. Opened early, the countdown waited, then entered on a token
//     minted outside the meeting window, so attendance was never stamped and calls never unlocked.
// call-presence.ts holds the watcher's rule and has no React in it, so this runs it against a stand-in room built on
// Node's EventEmitter (the local stack has no LiveKit server). MeetPage's wiring is read from source; the real room,
// with two browsers, is meeting-call.spec.ts test 9, run on the preview.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { RoomEvent } from 'livekit-client';
import { leftCallText, watchPartner, type PresenceRoom } from '../../../../client/src/features/messages/call-presence';

interface Person { identity: string; name?: string }

/** A stand-in for LiveKit's Room: the two events the watcher listens to, and who is in the room. */
class StubRoom extends EventEmitter {
  remoteParticipants = new Map<string, Person>();
  disconnect = jest.fn();
  join(p: Person) { this.remoteParticipants.set(p.identity, p); this.emit(RoomEvent.ParticipantConnected, p); }
  leave(p: Person) { this.remoteParticipants.delete(p.identity); this.emit(RoomEvent.ParticipantDisconnected, p); }
  asRoom(): PresenceRoom { return this as unknown as PresenceRoom; }
}

const stefan: Person = { identity: 'u-stefan', name: 'Stefan Avivson' };

describe('when the other person leaves, the room stays open for whoever is still in it', () => {
  it('says who left, and never leaves the room itself', () => {
    const room = new StubRoom();
    const seen: Array<string | null> = [];
    watchPartner(room.asRoom(), (name) => seen.push(name));
    room.join(stefan);
    room.leave(stefan);
    expect(seen).toEqual([null, 'Stefan Avivson']);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it('clears the notice when they come back in', () => {
    const room = new StubRoom();
    const seen: Array<string | null> = [];
    watchPartner(room.asRoom(), (name) => seen.push(name));
    room.join(stefan);
    room.leave(stefan);
    room.join(stefan);
    expect(seen[seen.length - 1]).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it('a rejoin that arrives before the old connection\'s goodbye is not a leave: they are still here', () => {
    const room = new StubRoom();
    const seen: Array<string | null> = [];
    watchPartner(room.asRoom(), (name) => seen.push(name));
    room.join(stefan);
    // The new connection is already in the room when the old one's "disconnected" arrives.
    room.emit(RoomEvent.ParticipantDisconnected, { ...stefan });
    expect(seen).toEqual([null]);
  });

  it('stops listening when the room is left', () => {
    const room = new StubRoom();
    const stop = watchPartner(room.asRoom(), () => undefined);
    expect(room.listenerCount(RoomEvent.ParticipantDisconnected)).toBe(1);
    expect(room.listenerCount(RoomEvent.ParticipantConnected)).toBe(1);
    stop();
    expect(room.listenerCount(RoomEvent.ParticipantDisconnected)).toBe(0);
    expect(room.listenerCount(RoomEvent.ParticipantConnected)).toBe(0);
  });

  it('someone the room has no name for still raises the notice (as "", never as null, which means "nobody left")', () => {
    const room = new StubRoom();
    const seen: Array<string | null> = [];
    watchPartner(room.asRoom(), (name) => seen.push(name));
    room.join({ identity: 'u-nameless' });
    room.leave({ identity: 'u-nameless' });
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

  it('the notice offers Wait (stay in the room) and Leave', () => {
    const src = meetPage();
    expect(src).toMatch(/watchPartner\(room, setLeftName\)/);
    expect(src).toMatch(/\{leftCallText\(leftName\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => setLeftName\(null\)\}[\s\S]{0,300}>\s*Wait\s*</);
    expect(src).toMatch(/onClick=\{onLeave\}[\s\S]{0,300}>\s*Leave\s*</);
  });
});
