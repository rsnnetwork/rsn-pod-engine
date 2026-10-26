// ─── S19 on the client: who may press End Event (6 Jun; 26 Oct 2026) ──────────
//
// S19 (Ali, 6 Jun — live-test b1): a co-host's end completed the event, so the
// event ends only when the director ends it; a platform super_admin keeps an
// emergency override (the server's handleHostEnd; its pin is
// services/orchestration/s19-director-only-end-event.test.ts). On 25 Oct Stefan,
// a super_admin, saw End Event disabled although the server would have accepted
// it. The client now mirrors the server: canEndEvent (the director or a
// super_admin) is computed once on the live page and passed to the host bar,
// where End Event is the only red button, with Leave just before it.
//
// These client checks used to live in the services pin; they moved here so that a
// later edit to that file's server describe on main cannot conflict.

import * as fs from 'fs';
import * as path from 'path';

function readClient(rel: string): string {
  // CRLF-normalised: on a Windows checkout an indexOf('End Event\n') that found nothing would widen the block below
  // to the whole file.
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
}

describe('S19 — client: End Event is disabled for everyone the server would refuse', () => {
  const src = () => readClient('features/live/HostControls.tsx');

  it('canEndEvent is the server rule (director or super_admin), computed once on the live page and passed in', () => {
    const roles = readClient('features/live/liveRoles.ts');
    expect(roles).toMatch(/canEndEvent: facts\.isDirector \|\| facts\.isSuperAdmin/);
    const page = readClient('features/live/LiveSessionPage.tsx');
    expect(page).toMatch(/const \{ canEndEvent, canManage \} = liveRolesOf\(\{ isDirector: isOriginalHost, isCohost, isSuperAdmin \}\)/);
    expect(page).toMatch(/<HostControls sessionId=\{sessionId\} canEndEvent=\{canEndEvent\}/);
    expect(src()).toMatch(/export default function HostControls\(\{ sessionId, canEndEvent, onLeave \}: Props\)/);
  });

  it('the End Event button is disabled for everyone else (a co-host) with the why', () => {
    const s = src();
    const idx = s.indexOf('End Event\n');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, idx - 700), idx);
    expect(block).toMatch(/onClick=\{endEvent\}/);
    expect(block).toMatch(/disabled=\{!canEndEvent\}/);
    expect(block).toMatch(/Only the host can end the event/);
  });

  it('End Event is the only red button in the host bar, with Leave just before it', () => {
    const s = src();
    const end = s.indexOf('End Event\n');
    const leave = s.lastIndexOf('<LogOut className="h-4 w-4 mr-1" /> Leave', end);
    expect(leave).toBeGreaterThan(-1);
    expect(leave).toBeLessThan(end);
    // Nothing between them but End Event's own button.
    expect((s.slice(leave, end).match(/<Button/g) ?? []).length).toBe(1);
    // Only one danger button left: End Event (Control Center is no longer red).
    expect(s.match(/variant="danger"/g)).toHaveLength(1);
    const cc = s.indexOf('<LayoutDashboard className="h-4 w-4 mr-1" /> Control Center');
    expect(s.slice(Math.max(0, cc - 300), cc)).toMatch(/variant="secondary"/);
    // The brand primary is red too, so the bar's forward actions are green.
    expect(s).toMatch(/const BAR_GO = 'min-h-\[44px\] bg-reason-green-fill hover:bg-reason-green-fill-hover'/);
    expect(s).toMatch(/onClick=\{startSession\} className=\{BAR_GO\}/);
    expect(s).toMatch(/onClick=\{confirmMatches\} className=\{BAR_GO\}/);
    expect(s).toMatch(/onClick=\{confirmRound\} className=\{`\$\{BAR_GO\} animate-pulse`\}/);
  });
});
