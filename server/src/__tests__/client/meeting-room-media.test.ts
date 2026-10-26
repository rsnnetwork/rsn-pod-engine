// ─── The meeting room's mic, reconnects, chat and invite link (fix round 1, 26 Oct 2026) ──
//
// Two faults the review found, only visible with real LiveKit:
//   1. A muted person was unmuted when the room connected again (the iPhone lock
//      screen or a phone call, then ReconnectOnReturn; or a retry): the room passed
//      the join-time mic choice as <LiveKitRoom audio>, and LiveKitRoom applies
//      `audio` on every connection. The choice is now applied once per connection
//      by useLocalMediaToggles, from the person's latest choice.
//   2. A microphone that cannot open (denied, missing, or held by another app)
//      reconnected the room every few seconds for the whole meeting: LiveKitRoom
//      hands publish failures to onError, and every connect refilled the retries.
//      Only a connection failure is retried now, at most twice, and a connection
//      earns its retries back only by holding for a minute.
// Plus the rulings: chat in a running meeting needs no host in the room; one
// invite-link hook; a 44px pin button; no ghost in the reconnect hold; the
// reaction gate as the server has it.
// Fix round 2: a pending retry is cleared when the room connects again another
// way (ReconnectOnReturn), the three <LiveKitRoom> callbacks keep their identity
// (LiveKitRoom connects again whenever onError changes, which during the SDK's
// own resume replaced it with a fresh join), the stage shows the room's
// connection state for the specs (data-room), and a picture too short for a name
// plate shows the picture alone.

import * as fs from 'fs';
import * as path from 'path';
import { isRetryableRoomError, ROOM_RETRY_LIMIT, ROOM_RETRY_DELAY_MS, ROOM_STABLE_MS } from '../../../../client/src/features/live/meeting/roomRetry';

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
}

const ROOM = 'features/live/meeting/MeetingRoom.tsx';
const HOOK = 'features/live/meeting/useLocalMediaToggles.ts';
const STAGE = 'features/live/meeting/MeetingStage.tsx';
const CHAT = 'features/live/ChatPanel.tsx';
const PAGE = 'features/live/LiveSessionPage.tsx';
const HOST = 'features/live/HostControls.tsx';
const INVITE = 'features/live/useEventInviteLink.ts';
const REACT = 'features/live/ReactionBar.tsx';

const between = (s: string, from: string, to: string) => {
  const i = s.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  const j = s.indexOf(to, i + from.length);
  expect(j).toBeGreaterThan(i);
  return s.slice(i, j);
};

describe('a room that connects again keeps a muted mic muted', () => {
  it('the meeting room never publishes the mic through <LiveKitRoom audio>', () => {
    const s = readClient(ROOM);
    const room = between(s, '<LiveKitRoom', '</LiveKitRoom>');
    expect(room).toMatch(/\baudio=\{false\}/);
    expect(room.match(/\baudio=/g)).toHaveLength(1);
    expect(s).not.toMatch(/joinWithMic|savedMicChoice/);
  });

  it('the choice is applied once per connection (the local participant SID), once it is connected', () => {
    const h = readClient(HOOK);
    expect(h).toMatch(/^const micChoiceAppliedFor = new Set<string>\(\);$/m);
    const fx = between(h, '// Once this connection is up', '// A host muted or unmuted');
    expect(fx).toMatch(/if \(connectionState !== ConnectionState\.Connected\) return;/);
    expect(fx).toMatch(/const sid = localParticipant\.sid;/);
    expect(fx).toMatch(/if \(!sid \|\| micChoiceAppliedFor\.has\(sid\)\) return;/);
    expect(fx).toMatch(/micChoiceAppliedFor\.add\(sid\);/);
    expect(fx).toMatch(/if \(!savedMicChoice\(\)\) return;/);
    expect(fx).toMatch(/localParticipant\.setMicrophoneEnabled\(true\)/);
    // A mic that cannot open is said in words; the person stays in, mic off.
    expect(fx).toMatch(/addToast\(MIC_FAILED, 'error'\)/);
    expect(fx).toMatch(/\}, \[connectionState, localParticipant\]\);/);
  });

  it('every mute, by the person or a host, is the choice the next connection reads', () => {
    const h = readClient(HOOK);
    expect(h).toMatch(/export function savedMicChoice\(\): boolean \{\n\s*return sessionStorage\.getItem\('rsn_mic'\) !== 'false';/);
    expect(between(h, 'const toggleMic = useCallback', 'const camStarting')).toMatch(/sessionStorage\.setItem\('rsn_mic', String\(next\)\)/);
    expect(between(h, '// A host muted or unmuted', 'const toggleMic')).toMatch(/sessionStorage\.setItem\('rsn_mic', String\(target\)\)/);
  });

  it('leaving the meeting clears its markers', () => {
    const s = readClient(ROOM);
    expect(between(s, 'useEffect(() => () => {', '}, []);')).toMatch(/clearMicChoiceMarkers\(\);/);
  });
});

describe('isRetryableRoomError: only a connection failure reconnects the room', () => {
  it('a failure to reach or keep the room is retried (an expired token included: a fresh one mends it)', () => {
    for (const reasonName of ['ServerUnreachable', 'NotAllowed', 'Timeout', 'InternalError', 'WebSocket']) {
      expect(isRetryableRoomError({ name: 'ConnectionError', reasonName })).toBe(true);
    }
  });

  it('a camera or microphone that cannot open is never retried', () => {
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError',
      'PermissionDeniedError', 'TrackStartError', 'DeviceUnsupportedError', 'TrackInvalidError', 'PublishTrackError']) {
      expect(isRetryableRoomError({ name, message: 'device failure' })).toBe(false);
    }
    expect(isRetryableRoomError(new DOMException('Could not start audio source', 'NotReadableError'))).toBe(false);
  });

  it('our own cancelled connection, and the server telling us to leave, are not retried', () => {
    expect(isRetryableRoomError({ name: 'ConnectionError', reasonName: 'Cancelled' })).toBe(false);
    expect(isRetryableRoomError({ name: 'ConnectionError', reasonName: 'LeaveRequest' })).toBe(false);
  });

  it('anything else is not retried', () => {
    for (const err of [null, undefined, 'ConnectionError', 42, new Error('boom'), {}]) {
      expect(isRetryableRoomError(err)).toBe(false);
    }
  });
});

describe('the room retries at most twice, and only a connection that holds earns its retries back', () => {
  const s = () => readClient(ROOM);

  it('onError retries only a retryable error, within the limit, one pending retry at a time', () => {
    const fn = between(s(), 'const onRoomError = useCallback(', '}, [reconnectRoom]);');
    expect(fn).toMatch(/if \(!isRetryableRoomError\(err\) \|\| retries\.current >= ROOM_RETRY_LIMIT \|\| retryTimer\.current\) return;/);
    expect(fn).toMatch(/retries\.current \+= 1;/);
    expect(fn).toMatch(/retryTimer\.current = setTimeout\(reconnectRoom, ROOM_RETRY_DELAY_MS\);/);
    expect(ROOM_RETRY_LIMIT).toBe(2);
    expect(ROOM_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });

  it('a connect does not refill the retries; holding for ROOM_STABLE_MS does', () => {
    const src = s();
    const connected = between(src, 'const onRoomConnected', 'const onRoomDisconnected');
    expect(connected).toMatch(/setTimeout\(\(\) => \{ retries\.current = 0; stableTimer\.current = null; \}, ROOM_STABLE_MS\)/);
    expect(connected.replace(/setTimeout\([\s\S]*?ROOM_STABLE_MS\)/, '')).not.toMatch(/retries\.current = 0/);
    expect(ROOM_STABLE_MS).toBeGreaterThanOrEqual(30_000);
    expect(between(src, 'const onRoomDisconnected', 'const onRoomError')).toMatch(/clearTimeout\(stableTimer\.current\)/);
    const room = between(src, '<LiveKitRoom', '</LiveKitRoom>');
    expect(room).toMatch(/onConnected=\{onRoomConnected\}/);
    expect(room).toMatch(/onDisconnected=\{onRoomDisconnected\}/);
    expect(room).toMatch(/onError=\{onRoomError\}/);
  });

  it('coming back to the page is a fresh start; leaving the meeting clears the pending timers', () => {
    const src = s();
    expect(src).toMatch(/<ReconnectOnReturn onReconnect=\{reconnectOnReturn\} \/>/);
    expect(src).toMatch(/const reconnectOnReturn = useCallback\(\(\) => \{\n\s*retries\.current = 0;\n\s*reconnectRoom\(\);/);
    const unmount = between(src, 'useEffect(() => () => {', '}, []);');
    expect(unmount).toMatch(/clearTimeout\(retryTimer\.current\)/);
    expect(unmount).toMatch(/clearTimeout\(stableTimer\.current\)/);
  });

  it('the three <LiveKitRoom> callbacks keep their identity across renders (fix round 2)', () => {
    // <LiveKitRoom> lists onError in its connect effect's dependencies: a new function on every render called
    // room.connect() on every render, which during the SDK's own resume replaced it with a fresh join.
    const src = s();
    expect(src).toMatch(/const onRoomConnected = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[\]\);/);
    expect(src).toMatch(/const onRoomDisconnected = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[\]\);/);
    expect(src).toMatch(/const onRoomError = useCallback\(\(err: Error\) => \{[\s\S]*?\n {2}\}, \[reconnectRoom\]\);/);
    // reconnectRoom itself changes only with the event.
    expect(src).toMatch(/const reconnectRoom = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[sessionId\]\);/);
    // No callback is written inline on the room (each would be a new function per render).
    const room = between(src, '<LiveKitRoom', '</LiveKitRoom>');
    expect(room).not.toMatch(/on(Connected|Disconnected|Error)=\{\(/);
    expect(room).not.toMatch(/on(Connected|Disconnected|Error)=\{function/);
  });

  it('a retry still waiting is cleared when the room connects again another way (fix round 2)', () => {
    // ReconnectOnReturn while a retry is pending: the pending timer used to fire as well (a second token, a
    // second remount).
    const fn = between(s(), 'const reconnectRoom = useCallback', '}, [sessionId]);');
    expect(fn).toMatch(/if \(retryTimer\.current\) clearTimeout\(retryTimer\.current\);\n\s*retryTimer\.current = null;/);
    expect(fn.indexOf('clearTimeout(retryTimer.current)')).toBeLessThan(fn.indexOf("api.post(`/sessions/${sessionId}/token`"));
  });

  it('never connects again once the meeting is over, for someone removed, or for a tab another one replaced', () => {
    const fn = between(s(), 'const reconnectRoom = useCallback', '}, [sessionId]);');
    expect(fn).toMatch(/st\.phase === 'complete'/);
    expect(fn).toMatch(/st\.transitionStatus === 'evicted'/);
    expect(fn).toMatch(/st\.removedFromEvent/);
    expect(fn).toMatch(/st\.sessionStatus === 'completed' \|\| st\.sessionStatus === 'cancelled'/);
  });
});

describe('chat in a running meeting', () => {
  it('is open whether or not the director is in the room (ruling), with no second home-indicator inset', () => {
    expect(readClient(ROOM)).toMatch(/<ChatPanel sessionId=\{sessionId\} onClose=\{\(\) => setChatOpen\(false\)\} alwaysOpen=\{!preStart\} padBottomInset=\{false\} \/>/);
    const chat = readClient(CHAT);
    expect(chat).toMatch(/alwaysOpen = false, padBottomInset = true/);
    expect(chat).toMatch(/const chatDisabled = !alwaysOpen && scope === 'lobby' && !hostPresent && !isHostOrCohost;/);
    expect(chat).toMatch(/padBottomInset \? 'pb-\[max\(0\.75rem,env\(safe-area-inset-bottom\)\)\]' : 'pb-3'/);
  });

  it('speed networking keeps its gate; for a host the host bar below carries the inset', () => {
    const page = readClient(PAGE);
    expect(page).toMatch(/<ChatPanel sessionId=\{sessionId\} onClose=\{\(\) => setChatOpen\(false\)\} padBottomInset=\{!isHost\} \/>/);
    expect(page).not.toMatch(/alwaysOpen/);
  });
});

describe('one invite-link hook for the host bar and the meeting room', () => {
  it('both use useEventInviteLink; the query and the mutation live only there', () => {
    expect(readClient(HOST)).toMatch(/useEventInviteLink\(\s*sessionId, showInviteModal, session\?\.config\?\.maxParticipants \?\? 500,\s*\)/);
    expect(readClient(ROOM)).toMatch(/useEventInviteLink\(sessionId, open, maxUses\)/);
    for (const f of [HOST, ROOM]) {
      expect(readClient(f)).not.toMatch(/session-pending-invites/);
      expect(readClient(f)).not.toMatch(/api\.post\('\/invites'/);
    }
    const hook = readClient(INVITE);
    expect(hook).toMatch(/queryKey: \['session-pending-invites', sessionId\]/);
    expect(hook).toMatch(/meta: \{ entities: \[E\.sessionInvites\(sessionId\)\] \}/);
    expect(hook).toMatch(/api\.post\('\/invites', \{ type: 'session', sessionId, maxUses, expiresInHours: 168 \}\)/);
    // One open link per opening: made only once the list has settled without one.
    expect(hook).toMatch(/if \(invites\.isLoading \|\| invites\.isError \|\| invites\.data === undefined \|\| openLink \|\| asked\.current\) return;/);
  });
});

describe('the stage', () => {
  it('two people sit side by side by the WINDOW, not the stage (ruling): the media query feeds the plan', () => {
    const stage = readClient(STAGE);
    expect(stage).toMatch(/const wide = useMediaQuery\(SIDE_BY_SIDE_QUERY\);/);
    expect(between(stage, 'const plan = useMemo(', ');')).toMatch(/pairView, wide,/);
  });

  it('its pin control is a 44px button (the small circle inside is what shows)', () => {
    const stage = readClient(STAGE);
    const pin = between(stage, "action.kind === 'pin' && (", '</button>');
    expect(pin).toMatch(/flex h-11 w-11 items-center justify-center/);
    expect(pin).not.toMatch(/after:-inset/);
  });

  it('shows the room\'s connection state for the specs, as data-room on the stage (fix round 2)', () => {
    const src = readClient(STAGE);
    expect(src).toMatch(/data-testid="meeting-stage" data-layout=\{plan\.layout\} data-room=\{roomState\}/);
    expect(src).toMatch(/roomState=\{connectionState\}/);
    expect(src).toMatch(/const connectionState = useConnectionState\(\);/);
  });

  it('a picture too short for a name plate shows the picture alone, or the initial (fix round 2)', () => {
    const src = readClient(STAGE);
    expect(src).toMatch(/const TINY_TILE_H = 64;/);
    // A live picture: LiveKit's own video element, no breakout tile (whose name plate would cover most of it).
    expect(src).toMatch(/box\.h < TINY_TILE_H && isTrackReference\(tile\.trackRef\)\n\s*\? <VideoTrack trackRef=\{tile\.trackRef\}/);
    // A camera that is off: the initial, sized to fit, and no name under it.
    const none = between(src, 'function NoPicture', '\n}\n');
    expect(none).toMatch(/const tiny = box\.h < TINY_TILE_H;/);
    expect(none).toMatch(/\{tiny \? null : small \?/);
  });

  it('the reconnect hold is refreshed on every connected render, so nobody who left is held as a ghost', () => {
    const hold = between(readClient(STAGE), 'if (connected) {', '} else if (holdUntilRef.current === 0');
    expect(hold).toMatch(/heldRef\.current = live\.map\(/);
    expect(hold).not.toMatch(/if \(live\.length > 1\)/);
  });
});

describe('reactions in speed networking: the server\'s own gate; the offset for whoever has the host bar', () => {
  it('before the host is in, only the director and co-hosts may react (the server drops the rest)', () => {
    const r = readClient(REACT);
    expect(r).toMatch(/const reactionsDisabled = phase === 'lobby' && !hostPresent && !\(isDirector \|\| isCohost\);/);
    expect(r).toMatch(/const floatAt = canManage \?/);
    expect(r).toMatch(/const buttonAt = canManage \?/);
  });
});
