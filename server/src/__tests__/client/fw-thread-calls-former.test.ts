// ─── A thread never offers a call or a Join to someone who is no longer a member (final fix wave C1, 2 Nov 2026) ─────
//
// T2 put "No longer a member of REASON" on the thread's header and hid its call buttons, but the thread's own call
// affordances were never told: the "Started an audio call" line still offered Call back, and the meeting banner still
// offered Call now and Join. Pressing one opened the request dialog, and the server refused only after the send.
// The banner's Call now for a video call also read the audio rule (callsUnlocked) instead of the video one (canCall).
// The rules are pure and run here; the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import { meetingBannerAction, messageCallAction } from '../../../../client/src/features/messages/thread-call-rules';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

const base = { over: false, kind: 'video' as const, callsUnlocked: true, canCall: true, former: false };

describe('the meeting pinned at the top of the thread', () => {
  it('is not shown at all with a former member, before or after the meeting, whatever the pair could do', () => {
    for (const over of [false, true]) {
      for (const kind of ['audio', 'video'] as const) {
        expect(meetingBannerAction({ ...base, over, kind, former: true })).toBeNull();
      }
    }
  });

  it('offers Join while the meeting is in play', () => {
    expect(meetingBannerAction(base)).toBe('join');
    expect(meetingBannerAction({ ...base, callsUnlocked: false, canCall: false })).toBe('join');
  });

  it('once over, a video Call now follows canCall (the video rule), an audio one callsUnlocked', () => {
    expect(meetingBannerAction({ ...base, over: true, kind: 'video', canCall: true, callsUnlocked: false })).toBe('call');
    expect(meetingBannerAction({ ...base, over: true, kind: 'video', canCall: false, callsUnlocked: true })).toBe('pick-new-time');
    expect(meetingBannerAction({ ...base, over: true, kind: 'audio', canCall: true, callsUnlocked: false })).toBe('pick-new-time');
    expect(meetingBannerAction({ ...base, over: true, kind: 'audio', canCall: false, callsUnlocked: true })).toBe('call');
  });
});

describe("a call line's own button (Call back, Call again, Call now, Join meeting)", () => {
  const line = { scheduled: false, scheduledLive: false, kind: 'audio' as const, canCall: true, callsUnlocked: true, former: false };

  it('is never offered with a former member, whatever the line is', () => {
    for (const scheduled of [false, true]) {
      for (const scheduledLive of [false, true]) {
        for (const kind of ['audio', 'video'] as const) {
          expect(messageCallAction({ ...line, scheduled, scheduledLive, kind, former: true })).toBeNull();
        }
      }
    }
  });

  it('a scheduled meeting still in play joins; otherwise a call needs what ringing needs', () => {
    expect(messageCallAction({ ...line, scheduled: true, scheduledLive: true, canCall: false, callsUnlocked: false })).toBe('join');
    expect(messageCallAction({ ...line, kind: 'video', canCall: true, callsUnlocked: false })).toBe('call');
    expect(messageCallAction({ ...line, kind: 'video', canCall: false })).toBeNull();
    expect(messageCallAction({ ...line, kind: 'audio', callsUnlocked: false })).toBeNull();
    expect(messageCallAction({ ...line, kind: 'audio', callsUnlocked: true })).toBe('call');
  });
});

describe('the wiring', () => {
  it('the thread hands the banner whether the other person is a former member and the video rule', () => {
    expect(read('features/messages/MessagesPage.tsx')).toMatch(
      /<ThreadMeetingBanner conversationId=\{activeConv\.conversationId\} onCallNow=\{startCall\} former=\{otherIsFormer\} canCall=\{canCall\} \/>/);
  });

  it('the banner and the call line both ask the rules, and draw nothing when the rules say so', () => {
    const banner = read('features/messages/ThreadMeetingBanner.tsx');
    expect(banner).toMatch(/const action = meetingBannerAction\(\{ over, kind, callsUnlocked: !!data\?\.callsUnlocked, canCall, former \}\);/);
    expect(banner).toMatch(/if \(!action\) return null;/);
    const page = read('features/messages/MessagesPage.tsx');
    expect(page).toMatch(/const action = messageCallAction\(\{\s*scheduled: act\.scheduled, scheduledLive, kind: act\.kind, canCall, callsUnlocked, former: otherIsFormer,\s*\}\);/);
    expect(page).toMatch(/if \(!action\) return null;/);
  });
});
