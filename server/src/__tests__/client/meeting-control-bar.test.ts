// ─── The meeting room's exits and controls (26 Oct 2026, VID-03/04) ──────────
//
// On 25 Oct, in a two-person video meeting, the guest "couldn't hang up": Leave
// was a red text button top-right, End Event sat bottom-right beside a look-alike
// red Control Center, and Stefan (a super_admin) saw End Event disabled although
// the server lets him end it. A video meeting now has one bottom bar, for
// everyone: Mic, Camera, Chat, People and Leave, 44px targets, padded clear of
// the iPhone home indicator; the director and a super_admin also get "End for
// everyone". Both exits ask first, in the app's own dialog. Leave keeps the
// meeting running for the others and lands on the event page.
//
// These read the client source (the client has no unit runner) and import the
// pure role rule directly.

import * as fs from 'fs';
import * as path from 'path';
import { liveRolesOf, liveRoleFactsFor } from '../../../../client/src/features/live/liveRoles';

function readClient(rel: string): string {
  // CRLF-normalised: a Windows checkout has \r\n, the CI checkout \n.
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
}

const BAR = 'features/live/meeting/MeetingControlBar.tsx';
const ROOM = 'features/live/meeting/MeetingRoom.tsx';
const PAGE = 'features/live/LiveSessionPage.tsx';

describe('liveRolesOf: who may end a live event, and who runs it (the server\'s rule)', () => {
  it('the director and a super_admin may end it for everyone; a co-host and a participant may not', () => {
    expect(liveRolesOf({ isDirector: true, isCohost: false, isSuperAdmin: false }).canEndEvent).toBe(true);
    expect(liveRolesOf({ isDirector: false, isCohost: false, isSuperAdmin: true }).canEndEvent).toBe(true);
    expect(liveRolesOf({ isDirector: false, isCohost: true, isSuperAdmin: false }).canEndEvent).toBe(false);
    expect(liveRolesOf({ isDirector: false, isCohost: false, isSuperAdmin: false }).canEndEvent).toBe(false);
  });

  it('the director, a co-host and a super_admin run it; a participant does not', () => {
    expect(liveRolesOf({ isDirector: true, isCohost: false, isSuperAdmin: false }).canManage).toBe(true);
    expect(liveRolesOf({ isDirector: false, isCohost: true, isSuperAdmin: false }).canManage).toBe(true);
    expect(liveRolesOf({ isDirector: false, isCohost: false, isSuperAdmin: true }).canManage).toBe(true);
    expect(liveRolesOf({ isDirector: false, isCohost: false, isSuperAdmin: false }).canManage).toBe(false);
  });

  it('liveRoleFactsFor reads the viewer against the director and the co-hosts; an admin is not a host', () => {
    const cohosts = new Set(['co']);
    expect(liveRoleFactsFor({ id: 'dir', role: 'member' }, 'dir', cohosts)).toEqual({ isDirector: true, isCohost: false, isSuperAdmin: false });
    expect(liveRoleFactsFor({ id: 'co', role: 'member' }, 'dir', cohosts)).toEqual({ isDirector: false, isCohost: true, isSuperAdmin: false });
    expect(liveRoleFactsFor({ id: 'sa', role: 'super_admin' }, 'dir', cohosts)).toEqual({ isDirector: false, isCohost: false, isSuperAdmin: true });
    expect(liveRolesOf(liveRoleFactsFor({ id: 'ad', role: 'admin' }, 'dir', cohosts)).canManage).toBe(false);
    expect(liveRoleFactsFor(null, 'dir', cohosts)).toEqual({ isDirector: false, isCohost: false, isSuperAdmin: false });
    expect(liveRoleFactsFor({ id: undefined, role: 'member' }, undefined, cohosts).isDirector).toBe(false);
  });
});

describe('MeetingControlBar: Leave for everyone, End for everyone only for the director and a super_admin', () => {
  const bar = () => readClient(BAR);

  it('renders Leave unconditionally, with a label people and screen readers can find', () => {
    const s = bar();
    expect(s).toMatch(/data-testid="meeting-leave"/);
    expect(s).toMatch(/aria-label="Leave meeting"/);
    expect(s).toMatch(/PhoneOff/);
    // Not behind any role: the Leave button's opening tag is not inside a canEndEvent / canManage condition.
    const i = s.indexOf('data-testid="meeting-leave"');
    const before = s.slice(Math.max(0, i - 400), i);
    expect(before).not.toMatch(/\{\s*(canEndEvent|canManage)\s*&&\s*\(\s*(<[^>]*)?$/);
  });

  it('renders "End for everyone" only behind canEndEvent', () => {
    const s = bar();
    const i = s.indexOf('data-testid="meeting-end"');
    expect(i).toBeGreaterThan(-1);
    // Its condition starts with canEndEvent (it also waits for the meeting to have started).
    expect(s.slice(Math.max(0, i - 300), i)).toMatch(/\{canEndEvent && [^}]*\(\s*<button[^>]*$/);
    expect(s).toMatch(/End for everyone/);
  });

  it('asks before leaving, in the app\'s own dialog (portalled to body), with the agreed words', () => {
    const s = bar();
    expect(s).toMatch(/import Modal from '@\/components\/ui\/Modal'/);
    expect(s).not.toMatch(/window\.confirm|[^.\w]confirm\(/);
    expect(s).toMatch(/Leave the meeting\?/);
    expect(s).toMatch(/The others can carry on\. You can rejoin from the event page\./);
  });

  it('asks before ending, with the agreed words', () => {
    const s = bar();
    expect(s).toMatch(/End the meeting for everyone\?/);
    expect(s).toMatch(/Everyone will be disconnected\./);
  });

  it('tells a co-host who can end the meeting: "Only {director} can end the meeting for everyone."', () => {
    const s = bar();
    expect(s).toMatch(/Only \$\{directorName\} can end the meeting for everyone\./);
    expect(s).toMatch(/showEndNote/);
  });

  it('ends the event with the same payload the host bar sends (endEvent: true), once per press', () => {
    const s = bar();
    expect(s).toMatch(/emit\('host:end_session', \{ sessionId, endEvent: true \}\)/);
    expect(s).toMatch(/runLocked\('end_event'/);
  });

  it('Leave keeps the meeting running for the others and lands on the event page, replacing the live page', () => {
    const s = bar();
    expect(s).toMatch(/emit\('session:leave', \{ sessionId \}\)/);
    // The app's one live connection stays up (C10, COM-05): cutting it left the guest "Reconnecting…" on the
    // event page and without bells or the "Ended" flip until the token rotated.
    expect(s).not.toMatch(/disconnectSocket/);
    expect(s).toMatch(/navigate\(`\/sessions\/\$\{sessionId\}`, \{ replace: true \}\)/);
    // Leaving never ends the event.
    const leave = s.slice(s.indexOf('const leaveMeeting'), s.indexOf('const leaveMeeting') + 600);
    expect(leave).not.toMatch(/host:end_session/);
  });

  it('every control is at least 44px', () => {
    const s = bar();
    // Each opening <button ...> tag; an arrow function's "=>" inside an attribute does not end it.
    const buttons = s.match(/<button\b(?:=>|[^>])*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    for (const b of buttons) expect(b).toMatch(/min-h-\[44px\]|h-11|BAR_BUTTON|DIALOG_BUTTON/);
    expect(s).toMatch(/const BAR_BUTTON = [^;]*min-h-\[44px\][^;]*min-w-\[44px\]/);
    expect(s).toMatch(/const DIALOG_BUTTON = [^;]*min-h-\[44px\]/);
  });

  it('the bar is padded clear of the home indicator (safe area)', () => {
    expect(bar()).toMatch(/pb-\[max\(0\.5rem,env\(safe-area-inset-bottom\)\)\]/);
  });

  it('offers Mic, Camera, Chat and People, the director a Start meeting before it starts', () => {
    const s = bar();
    expect(s).toMatch(/aria-label=\{micOn \? 'Mic on' : 'Mic off'\}/);
    expect(s).toMatch(/aria-label=\{camStarting \? 'Starting camera' : camOn \? 'Camera on' : 'Camera off'\}/);
    expect(s).toMatch(/aria-label="Chat"/);
    expect(s).toMatch(/aria-label="People"/);
    expect(s).toMatch(/Start meeting/);
    expect(s).toMatch(/emit\('host:start_session', \{ sessionId \}\)/);
  });
});

describe('MeetingRoom and the live page: one branch on the format, speed networking untouched', () => {
  it('LiveSessionPage branches once on the format read from the event itself', () => {
    const s = readClient(PAGE);
    expect(s).toMatch(/import \{ liveKindOf, resolveEventFormat \} from '@rsn\/shared'/);
    expect(s).toMatch(/liveKindOf\(resolveEventFormat\(session\)\) !== 'rounds'/);
    expect(s.match(/resolveEventFormat\(/g)).toHaveLength(1);
    expect(s).toMatch(/<MeetingRoom/);
  });

  it('a loader shows while the event loads, so a meeting never flashes the speed-networking grid', () => {
    const s = readClient(PAGE);
    const branch = s.indexOf("liveKindOf(resolveEventFormat(session)) !== 'rounds'");
    const loader = s.indexOf('if (!session)');
    expect(loader).toBeGreaterThan(-1);
    expect(loader).toBeLessThan(branch);
  });

  it('the roles are computed once in LiveSessionPage and passed down', () => {
    const s = readClient(PAGE);
    expect(s).toMatch(/const \{ canEndEvent, canManage \} = liveRolesOf\(\{ isDirector: isOriginalHost, isCohost, isSuperAdmin \}\)/);
    expect(s).toMatch(/<HostControls sessionId=\{sessionId\} canEndEvent=\{canEndEvent\} onLeave=\{handleLeave\} \/>/);
    expect(s).toMatch(/canEndEvent=\{canEndEvent\}[\s\S]{0,200}canManage=\{canManage\}/);
  });

  it('the meeting room mounts the bar, the stage and the room plumbing inside its own <LiveKitRoom>', () => {
    const s = readClient(ROOM);
    const i = s.indexOf('<LiveKitRoom');
    const j = s.indexOf('</LiveKitRoom>');
    expect(i).toBeGreaterThan(-1);
    const room = s.slice(i, j);
    for (const piece of ['<LiveKitPresenceSync />', '<BgCameraPublisher />', '<RoomAudioRenderer />', '<ReconnectOnReturn', '<MeetingStage']) {
      expect(room).toContain(piece);
    }
    expect(s).toMatch(/<MeetingControlBar/);
    // No speed-networking chrome in a meeting.
    for (const absent of ['EventCheckInModal', 'HostControls', 'DensityToggle', 'EventPlanStrip', 'MatchingOverlay', 'ReactionBar']) {
      expect(s).not.toContain(absent);
    }
  });

  it('a meeting that ends shows "Meeting ended", a removed person the removed message', () => {
    const room = readClient(ROOM);
    expect(room).toMatch(/<MeetingEnded/);
    expect(room).toMatch(/removed=\{removedFromEvent\}/);
    // Ended the moment the server says so, also through the live status (a socket that joined just after the
    // end gets no session:completed, and would otherwise wait for the page's 30-second refetch).
    expect(room).toMatch(/const ended = phase === 'complete' \|\| transitionStatus === 'session_ending' \|\| status === 'completed' \|\| status === 'cancelled'/);
    const ended = readClient('features/live/meeting/MeetingEnded.tsx');
    expect(ended).toMatch(/Meeting ended/);
    expect(ended).toMatch(/Back to event/);
    expect(ended).toMatch(/Back to pod/);
  });

  it('a guest waiting for the start reads "Waiting for {host} to start the meeting"', () => {
    const room = readClient(ROOM);
    expect(room).toMatch(/Waiting for \$\{hostName\} to start the meeting/);
    expect(room).toMatch(/<PreLobbyWaitingRoom/);
  });

  it('the host on the solo stage can invite people, through the live invite link the specs key on', () => {
    expect(readClient(ROOM)).toMatch(/data-testid="live-invite-link"/);
  });

  it('the page is padded clear of the notch and the rounded corners (safe area)', () => {
    const room = readClient(ROOM);
    expect(room).toMatch(/pt-\[env\(safe-area-inset-top\)\]/);
    expect(room).toMatch(/pl-\[env\(safe-area-inset-left\)\]/);
    expect(room).toMatch(/pr-\[env\(safe-area-inset-right\)\]/);
  });
});
