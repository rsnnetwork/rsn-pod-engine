// ─── Accepting a call from inside a live event asks first (final fix wave CM4, 2 Nov 2026) ──────────────────────
//
// The incoming call banner shows in a live event too (where the chime is quiet), and Accept takes the member into the
// call, out of the event. In a breakout that ends the conversation without a word, so the banner asks first.

import * as fs from 'fs';
import * as path from 'path';
import { LEAVE_EVENT_FOR_CALL, inLiveEvent } from '../../../../client/src/features/calls/call-ring';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('accepting a call from inside a live event asks first (CM4)', () => {
  it('knows the live room by its path, and nothing else', () => {
    expect(inLiveEvent('/session/3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22/live')).toBe(true);
    expect(inLiveEvent('/session/abc/live/')).toBe(true);
    expect(inLiveEvent('/sessions/abc')).toBe(false);
    expect(inLiveEvent('/session/abc')).toBe(false);
    expect(inLiveEvent('/messages')).toBe(false);
    expect(inLiveEvent('/meet/abc')).toBe(false);
  });

  it('asks in plain words', () => {
    expect(LEAVE_EVENT_FOR_CALL).toEqual({
      question: 'Leave the event to take the call?',
      leave: 'Leave and answer',
      stay: 'Stay in the event',
    });
  });

  it('Accept in a live event asks inside the banner; the answer goes ahead only on "Leave and answer"', () => {
    const banner = read('components/ui/IncomingCallBanner.tsx');
    expect(banner).toMatch(/const \{ pathname \} = useLocation\(\);/);
    expect(banner).toMatch(/const onAccept = \(\) => \(inLiveEvent\(pathname\) \? setAsking\(true\) : void accept\(\)\);/);
    expect(banner).toMatch(/\{asking \? \(/);
    expect(banner).toContain('{LEAVE_EVENT_FOR_CALL.question}');
    expect(banner).toMatch(/onClick=\{\(\) => setAsking\(false\)\}[\s\S]*?\{LEAVE_EVENT_FOR_CALL\.stay\}/);
    expect(banner).toMatch(/onClick=\{\(\) => void accept\(\)\}[\s\S]*?\{LEAVE_EVENT_FOR_CALL\.leave\}/);
    // Every button is a 44 px target.
    const buttons = banner.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBe(4);
    for (const b of buttons) expect(b).toMatch(/min-h-\[44px\]/);
  });
});
