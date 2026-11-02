// ─── A ringing call is answered over any open sheet (final fix wave C2, 2 Nov 2026) ─────────────────────────────────
//
// C2: every REASON sheet is a `fixed inset-0 z-[200]` backdrop (features/reason/ui/Sheet.tsx). The incoming call banner
// sat at z-[100] and the Calling card at z-[98], under it: a member answering "How did it go?" when a call came saw the
// banner dimmed under the backdrop, and tapping Accept hit the backdrop, which closed the sheet. The call layer now
// sits above the sheets and below the toasts (z-[210]), so a tap reaches the banner and the sheet stays as it was.
//
// Asking first in a live event (CM4) is fw-live-call-asks-first.test.ts.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const zOf = (src: string, testId: string) => {
  const m = src.match(new RegExp(`data-testid="${testId}"[\\s\\S]*?className="[^"]*\\bz-\\[(\\d+)\\]`))
    ?? src.match(new RegExp(`className="[^"]*\\bz-\\[(\\d+)\\][^"]*"[\\s\\S]{0,200}data-testid="${testId}"`));
  return m ? Number(m[1]) : NaN;
};

describe('the call layer sits above every sheet and below the toasts', () => {
  const SHEET = Number(read('features/reason/ui/Sheet.tsx').match(/fixed inset-0 z-\[(\d+)\]/)![1]);
  const TOAST = Number(read('components/ui/Toast.tsx').match(/fixed top-4 right-4 z-\[(\d+)\]/)![1]);

  it('the incoming call banner is z-[205]: above a sheet (200), below a toast (210)', () => {
    const z = zOf(read('components/ui/IncomingCallBanner.tsx'), 'call-incoming');
    expect(z).toBe(205);
    expect(z).toBeGreaterThan(SHEET);
    expect(z).toBeLessThan(TOAST);
  });

  it('the Calling card is z-[204]: above a sheet, below the banner and the toasts', () => {
    const z = zOf(read('features/calls/OutgoingCallCard.tsx'), 'call-outgoing');
    expect(z).toBe(204);
    expect(z).toBeGreaterThan(SHEET);
    expect(z).toBeLessThan(205);
  });

  it('both are portalled to <body>, so no ancestor can hold them under a sheet', () => {
    expect(read('components/ui/IncomingCallBanner.tsx')).toMatch(/createPortal\([\s\S]*document\.body,\s*\)/);
    expect(read('features/calls/OutgoingCallCard.tsx')).toMatch(/createPortal\([\s\S]*document\.body,\s*\)/);
  });
});
