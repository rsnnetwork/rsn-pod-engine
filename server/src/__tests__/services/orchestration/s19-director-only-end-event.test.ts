// ─── S19 — ending the EVENT is the director's call alone (Ali, 6 Jun) ──────
//
// In live-test b1 a CO-HOST's end action completed the event: recap emails
// went out and participants hit the recap page mid-test. Product rule:
//   - the event ends (recap page + recap emails) ONLY when the director
//     ends it (platform super_admin keeps an emergency override);
//   - co-hosts may still start/end ROUNDS — those paths never complete
//     the session;
//   - co-hosts see the End Event button DISABLED with "Only the host can
//     end the event".

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S19 — server: handleHostEnd director gate', () => {
  const fn = () => sliceFn(readServer('services/orchestration/handlers/host-actions.ts'), 'export async function handleHostEnd');

  it('computes wouldCompleteEvent = endEvent OR the fall-through completion path', () => {
    expect(fn()).toMatch(/wouldCompleteEvent = !!data\.endEvent\s*\n\s*\|\| !\(activeSession && \(activeSession\.status === SessionStatus\.ROUND_ACTIVE/);
  });

  it('refuses non-director completion with a distinct DIRECTOR_ONLY error', () => {
    expect(fn()).toMatch(/if \(wouldCompleteEvent && !isDirector && !isSuperAdmin\)/);
    expect(fn()).toMatch(/code: 'DIRECTOR_ONLY', message: 'Only the host can end the event'/);
  });

  it('director check resolves from the active session, falling back to the DB row', () => {
    expect(fn()).toMatch(/activeSession\?\.hostUserId/);
    expect(fn()).toMatch(/SELECT host_user_id FROM sessions WHERE id = \$1/);
  });

  it('the gate sits AFTER verifyHost (co-hosts still pass for round-only paths)', () => {
    const f = fn();
    const verifyIdx = f.indexOf('verifyHost(socket, data.sessionId)');
    const gateIdx = f.indexOf('wouldCompleteEvent');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(verifyIdx);
    // And BEFORE the ROUND_ACTIVE branch, so endEvent:true is gated there too.
    const roundActiveIdx = f.indexOf('activeSession.status === SessionStatus.ROUND_ACTIVE) {');
    expect(gateIdx).toBeLessThan(roundActiveIdx);
  });
});

describe('S19 — client: End Event disabled for everyone the server would refuse', () => {
  // CRLF-normalised: on a Windows checkout the file has \r\n, and an indexOf('End Event\n') that finds
  // nothing would widen the block below to the whole file.
  const src = () => readClient('features/live/HostControls.tsx').replace(/\r\n/g, '\n');

  it('canEndEvent is the server rule (director or super_admin), computed once on the live page and passed in', () => {
    // 26 Oct 2026 (VID-03) — Stefan, a super_admin, saw End Event disabled on 25 Oct although
    // handleHostEnd lets a super_admin end the event. The client now mirrors the server.
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
