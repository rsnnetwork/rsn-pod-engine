// ─── A direct video call with a connection, on the preview (1 Nov 2026, 30 Oct review item 4, L12) ──
//
// Stefan: "Users should be able to start a video call right away with a connection, without scheduling a
// meeting." The server lets any connection ring for video (canCall); these pin the screens:
//   - the ring is heard app-wide: call:request/accepted/declined/cancelled are handled once, above every route
//     (CallLayer in App.tsx, useCallSignals), and no longer inside MessagesPage, so a call rung from a profile
//     enters the room when it is answered;
//   - one "Video call" button, shown where canCall says, on the profile and in the thread (desktop row and the
//     phone's More menu), while audio keeps the 9 Sep unlock;
//   - the banner and the "Calling…" card, their words, and where they sit;
//   - the pure rules of a ringing call (call-ring.ts).

import * as fs from 'fs';
import * as path from 'path';
import type { LiveCallRequest } from '@rsn/shared';
import {
  CALL_RING_MS, callRoomPath, countdown, fromLive, fromRung, reconcile, refusalCode, ringRefusal, type RingingCall,
} from '../../../../client/src/features/calls/call-ring';
import { E as clientE } from '../../../../client/src/realtime/entities';

const CLIENT = path.join(__dirname, '../../../../client/src');
/** A client file, comments stripped, so a word in a comment is never read as code. */
const src = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the ring is heard app-wide, not only in the open thread', () => {
  it('MessagesPage no longer listens for any call:* event, nor keeps a ringing call of its own', () => {
    const page = src('features/messages/MessagesPage.tsx');
    expect(page).not.toMatch(/'call:(accepted|declined|cancelled|request)'/);
    expect(page).not.toMatch(/pendingCall|setPendingCall|call\/pending|CallWaitingCard|IncomingCallCard/);
  });

  it('useCallSignals handles call:accepted, and the other three, for every screen', () => {
    const signals = src('features/calls/useCallSignals.ts');
    for (const event of ['call:request', 'call:accepted', 'call:declined', 'call:cancelled']) {
      expect(signals).toContain(`socket.on('${event}'`);
      expect(signals).toContain(`socket.off('${event}'`);
    }
    // The answer takes the caller into the room from wherever they are, and only from the tab that rang (F3: the
    // handlers are in call-signals.ts, run two tabs at a time in f3-one-tab-enters-the-call.test.ts).
    const handlers = src('features/calls/call-signals.ts');
    expect(handlers).toMatch(/if \(mine\?\.requestId !== d\.requestId\) return;[\s\S]*?if \(mine\.placedHere\) navigate\(callRoomPath\(d\.conversationId, d\.kind\)\);/);
    expect(handlers).toContain("toast(`${d.byName} can't take the call right now.`);");
    expect(signals).toContain("toast: (m) => addToast(m, 'info')");
  });

  it('App mounts the call layer once for a signed-in member, above the routes (the shell does not cover /people/:id or /meet/*)', () => {
    const app = src('App.tsx');
    expect(app).toMatch(/\{isAuthenticated && <CallLayer \/>\}\s*<Routes>/);
    expect(app).not.toMatch(/<IncomingCallBanner/);
    const layer = src('features/calls/CallLayer.tsx');
    expect(layer).toMatch(/useCallSignals\(\);/);
    expect(layer).toMatch(/<IncomingCallBanner \/>/);
    expect(layer).toMatch(/<OutgoingCallCard \/>/);
  });

  it('after a refresh or a lost connection the calls ringing now are read again, and kept live by the member\'s own calls tag', () => {
    const signals = src('features/calls/useCallSignals.ts');
    expect(signals).toMatch(/fetchIncomingCall\(\)/);
    expect(signals).toMatch(/fetchOutgoingCall\(\)/);
    expect(signals.match(/meta: \{ entities: me \? \[E\.userCalls\(me\)\] : \[\] \}/g)).toHaveLength(2);
    // After a lost connection the app-wide handler reads every tagged query again (P1 item 17), these two included.
    expect(signals).not.toMatch(/socket\.on\('connect'/);
    expect(clientE.userCalls('u-1')).toBe('user:u-1:calls');
    const api = src('features/calls/call-api.ts');
    expect(api).toContain("api.get('/dm/call/requests/incoming')");
    expect(api).toContain("api.get('/dm/call/requests/outgoing')");
  });
});

describe('one Video call button, where canCall says', () => {
  it('is a video icon and the words, 44px, in three looks', () => {
    const button = src('features/calls/CallButton.tsx');
    expect(button).toContain("export const VIDEO_CALL = 'Video call';");
    expect(button).toMatch(/<Video /);
    expect(button).toMatch(/hero: 'inline-flex h-11 min-h-\[44px\] shrink-0/);
    expect(button).toMatch(/icon: 'flex h-11 w-11/);
    expect(button).toMatch(/menu: 'flex min-h-\[44px\]/);
  });

  it('the thread offers Video call on canCall, on the desktop row and in the phone\'s More menu; audio stays on callsUnlocked', () => {
    const page = src('features/messages/MessagesPage.tsx');
    expect(page).toContain('const canCall = !!scheduling?.canCall;');
    // With T2 (1 Nov 2026): a former member's thread offers no call, so every call button also asks !otherIsFormer.
    // 11 Nov 2026 (item 16): nor a thread with someone I blocked (readOnly = otherIsFormer || blockedByMe); the phone's
    // menu items sit in the one labelled More menu, shown at every width, each wrapped sm:hidden.
    expect(page).toMatch(/\{activeConv && !readOnly && canCall && \(\s*<CallButton\s+variant="icon"/);
    expect(page).toMatch(/\{activeConv && !readOnly && canCall && \(\s*<div className="sm:hidden">\s*<CallButton\s+variant="menu"/);
    expect(page.match(/\{activeConv && !readOnly && callsUnlocked && \(/g)).toHaveLength(2); // the two audio buttons
    expect(page).toMatch(/onClick=\{\(\) => startCall\('audio'\)\}/);
    // The scheduler keeps its place: it still steps aside only once calls are unlocked.
    expect(page.match(/\{activeConv && !readOnly && !callsUnlocked && \(/g)).toHaveLength(2);
    // Before calls unlock, the dialog offers video only (audio would be refused).
    expect(page).toContain('<CallRequestModal {...callRequest.modal} videoOnly={!callsUnlocked} />');
  });

  it('the profile shows it beside the hero\'s other actions only when the brief says canCall, ringing the person by id, video only', () => {
    const hero = src('features/reason/human/ProfileHero.tsx');
    // With T5 (1 Nov 2026): inside the hero's actions row, after Message, and also where Message is not offered.
    expect(hero).toMatch(/actions=\{<ProfileHeroActions brief=\{brief\} userId=\{userId\} call=\{brief\.canCall && <ProfileCallButton brief=\{brief\} userId=\{userId\} name=\{who\.name\} \/>\} \/>\}/);
    const row = src('features/reason/human/ProfileHeroActions.tsx');
    expect(row).toMatch(/if \(!message && !call\) return closed;/);
    expect(row).toMatch(/data-testid="profile-hero-actions">[\s\S]*Message[\s\S]*\{call\}\s*<\/div>/);
    const button = src('features/calls/ProfileCallButton.tsx');
    // 11 Nov 2026 (RSN 07): with the person's presence, so a press while they are offline opens the offline sheet.
    expect(button).toMatch(/useCallRequest\(brief\.canCall \? \{ userId \} : null, name, \{/);
    expect(button).toMatch(/if \(!brief\.canCall\) return null;/);
    expect(button).toMatch(/<CallRequestModal \{\.\.\.call\.modal\} videoOnly \/>/);
    const api = src('features/calls/call-api.ts');
    expect(api).toContain("api.post(`/calls/user/${encodeURIComponent(target.userId)}`, { kind: 'video', durationMin })");
  });

  it('the dialog keeps "choose the intended duration", starting at 15 minutes of video', () => {
    const modal = src('features/messages/CallRequest.tsx');
    expect(modal).toContain("useState<string>('15')");
    expect(modal).toMatch(/setChosenKind\(videoOnly \? 'video' : kind\); setMinutes\('15'\);/);
    expect(src('features/calls/useCallRequest.ts')).toMatch(/kind: kind \?\? 'video'/);
  });

  it('a refused ring says the server\'s sentence; both ringing at once shows the other\'s call instead of an error', () => {
    const hook = src('features/calls/useCallRequest.ts');
    expect(hook).toMatch(/refusalCode\(err\) === 'CALL_ALREADY_WAITING' && \(await showWaitingCall\(\)\)/);
    expect(hook).toMatch(/addToast\(ringRefusal\(err\), 'info'\)/);
  });
});

describe('the banner and the Calling card', () => {
  it('the banner says who is calling and how long, with Accept and Decline, clear of the notch, on every screen', () => {
    const banner = src('components/ui/IncomingCallBanner.tsx');
    expect(banner).toContain('{req.partnerName} is calling you');
    expect(banner).toContain('{req.durationMin}-min {kindWord} call');
    expect(banner).toMatch(/> Decline\n/);
    expect(banner).toMatch(/> Accept\n/);
    expect(banner).toContain('top-[calc(16px+env(safe-area-inset-top))]');
    // Accept and Decline, and (final fix wave CM4) the live event's Stay in the event and Leave and answer.
    expect(banner.match(/min-h-\[44px\]/g)).toHaveLength(4);
    expect(banner).toMatch(/createPortal\([\s\S]*document\.body,\s*\)/);
    expect(banner).toMatch(/useCallStore\(\(s\) => s\.incoming\)/);
  });

  it('the Calling card says "Calling {Name}…" with Cancel and the countdown, above the bottom bar and the move bar', () => {
    const card = src('features/calls/OutgoingCallCard.tsx');
    expect(card).toContain('Calling {call.partnerName}…');
    expect(card).toContain('{countdown(call.expiresAt - now)}');
    expect(card).toMatch(/> Cancel\n/);
    expect(card).toContain('bottom-[calc(92px+env(safe-area-inset-bottom))]');
    expect(card).toMatch(/createPortal\([\s\S]*document\.body,\s*\)/);
  });
});

describe('fix round 1: a withdraw that lost to an answer, and signing out', () => {
  it('Cancel that the server answers "accepted" (the answer came first) takes the caller into the room, from the tab that rang', () => {
    const card = src('features/calls/OutgoingCallCard.tsx');
    expect(card).toMatch(/const outcome = await withdrawCall\(call\.requestId\);/);
    expect(card).toMatch(/if \(outcome\.status === 'accepted' && call\.placedHere\) navigate\(callRoomPath\(outcome\.conversationId, outcome\.kind\)\);/);
    expect(src('features/calls/call-api.ts')).toMatch(/withdrawCall = \(requestId: string\) =>[\s\S]*?r\.data\.data as WithdrawOutcome/);
  });

  it('a withdraw that never reached the server puts the card back while the call still rings', () => {
    const card = src('features/calls/OutgoingCallCard.tsx');
    expect(card).toMatch(/catch \{\s*if \(call\.expiresAt > Date\.now\(\)\) useCallStore\.getState\(\)\.setOutgoing\(call\);/);
  });

  it('signing out takes every call off this device: the layer clears the store as it goes', () => {
    const layer = src('features/calls/CallLayer.tsx');
    expect(layer).toMatch(/useEffect\(\(\) => \(\) => \{\s*useCallStore\.getState\(\)\.setIncoming\(null\);\s*useCallStore\.getState\(\)\.setOutgoing\(null\);\s*\}, \[\]\);/);
  });
});

describe('a ringing call (call-ring.ts)', () => {
  const live: LiveCallRequest = {
    id: 'rq-1', conversationId: 'conv-1', fromUserId: 'u-a', toUserId: 'u-b', partnerName: 'Ana', kind: 'video',
    durationMin: 15, createdAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-11-01T10:02:00.000Z',
  };
  const ringing = (over: Partial<RingingCall> = {}): RingingCall => ({ ...fromLive(live, 'incoming', 1000), ...over });

  it('a call read from the server names the other person on each side', () => {
    expect(fromLive(live, 'incoming', 5)).toEqual({
      requestId: 'rq-1', conversationId: 'conv-1', partnerId: 'u-a', partnerName: 'Ana', kind: 'video', durationMin: 15,
      expiresAt: Date.parse('2026-11-01T10:02:00.000Z'), seenAt: 5, placedHere: false,
    });
    expect(fromLive(live, 'outgoing', 5).partnerId).toBe('u-b');
  });

  it('a call just rung lapses two minutes after the server made it', () => {
    const rung = fromRung({ id: 'rq-2', conversationId: 'c', fromUserId: 'u-a', toUserId: 'u-b', kind: 'video', durationMin: 30, createdAt: '2026-11-01T10:00:00.000Z' }, 'Bo', 7);
    expect(rung).toMatchObject({ partnerId: 'u-b', partnerName: 'Bo', expiresAt: Date.parse('2026-11-01T10:00:00.000Z') + CALL_RING_MS, seenAt: 7 });
    expect(CALL_RING_MS).toBe(120_000);
  });

  it('a read brings back a call the device does not show, and leaves the one it shows', () => {
    expect(reconcile(null, ringing(), 2000)).toEqual(ringing());
    expect(reconcile(ringing(), ringing({ seenAt: 3000 }), 3000)).toBeUndefined();
    expect(reconcile(ringing({ requestId: 'old' }), ringing(), 3000)).toEqual(ringing());
  });

  it('a read that finds nothing takes a call away only if the device knew of it before the read began', () => {
    expect(reconcile(ringing({ seenAt: 1000 }), null, 2000)).toBeNull();
    // Rang while the read was on its way: the read cannot hide it.
    expect(reconcile(ringing({ seenAt: 2500 }), null, 2000)).toBeUndefined();
    expect(reconcile(null, null, 2000)).toBeUndefined();
  });

  it('the room a call opens has no countdown', () => {
    expect(callRoomPath('conv-1', 'video')).toBe('/meet/conv-1?kind=video');
    expect(callRoomPath('conv-1', 'audio')).not.toContain('scheduled=1');
  });

  it('the countdown reads minutes and seconds, never below 0:00', () => {
    expect(countdown(120_000)).toBe('2:00');
    expect(countdown(59_001)).toBe('1:00');
    expect(countdown(5_000)).toBe('0:05');
    expect(countdown(-10)).toBe('0:00');
  });

  it('a refusal says the server\'s sentence, the offline one exactly; a lost connection says so; codes are read', () => {
    const offline = { response: { status: 409, data: { error: { code: 'CALL_PARTNER_OFFLINE', message: "Bo isn't online right now. Send a message instead." } } } };
    expect(ringRefusal(offline)).toBe("Bo isn't online right now. Send a message instead.");
    expect(refusalCode(offline)).toBe('CALL_PARTNER_OFFLINE');
    expect(ringRefusal({ response: { status: 403, data: { error: { message: 'You cannot call this member.' } } } })).toBe('You cannot call this member.');
    expect(ringRefusal({ response: { status: 429, data: { error: { message: 'You have rung a lot of calls in the last few minutes. Try again in a little while.' } } } }))
      .toBe('You have rung a lot of calls in the last few minutes. Try again in a little while.');
    expect(ringRefusal({ isAxiosError: true })).toBe('Connection lost. Check your internet and try again.');
    expect(ringRefusal({ response: { status: 500, data: {} } })).toBe('Could not ring them just now. Try again in a moment.');
    expect(refusalCode(new Error('x'))).toBeNull();
  });
});

describe('an answered call under Events', () => {
  it('is headed as a call, not a meeting, and offers no calendar, Reschedule or Cancel while it stands', () => {
    expect(src('features/meetings/meeting-words.ts')).toMatch(/meeting\.source === 'instant' \? `\$\{kindLabel\(meeting\.kind\)\} call with \$\{name\}` : `Meeting with \$\{name\}`/);
    expect(src('features/meetings/MeetingCard.tsx')).toContain('{meetingTitle(meeting)}');
    const page = src('features/meetings/MeetingDetailPage.tsx');
    expect(page).toContain('{meetingTitle(meeting)}');
    expect(page).toContain("const standing = stands && meeting.source !== 'instant';");
    expect(page).toMatch(/\{stands && <JoinOrCountdown/);
  });
});
