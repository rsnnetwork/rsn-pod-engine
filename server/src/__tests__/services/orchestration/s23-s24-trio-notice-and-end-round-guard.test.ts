// ─── S23 + S24 — live-test bb (2026-06-06 late) ────────────────────────────
//
// S23: a trio member pressing "Back to Main Room" left the survivors with
// (a) no visible message — the 3s toast was missable mid-conversation — and
// (b) a stuck trio grid with a hole where the leaver sat (isTrio derives
// from currentPartners.length, and nothing removed the leaver). Now the
// socket handler removes the leaver from currentPartners (grid reflows to
// the pair layout) and raises an ~8s in-room banner rendered by VideoRoom.
//
// S24: with manual rooms up and NO algorithm round running, the host's
// stale dashboard still offered "End Round"; the click emitted
// host:end_session WITHOUT endEvent, and the handler's fall-through path
// COMPLETED THE EVENT (recap pages + emails mid-test). A plain End Round
// can never complete the event now; the fall-through requires endEvent:true.
// completeSession also closes any match still active at event end (bb's
// 3-person manual room dangled active-in-a-completed-session forever).

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

describe('S23 — trio leave: visible notice + layout reflow', () => {
  it('the participant_left handler removes the leaver from currentPartners and raises roomNotice', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    const i = src.indexOf("socket.on('match:participant_left'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1200);
    expect(block).toMatch(/store\.removePartner\(data\.leftUserId\)/);
    expect(block).toMatch(/setRoomNotice\(`\$\{name\} returned to the main room — you can keep talking`\)/);
  });

  it('the store exposes removePartner (filters currentPartners) and roomNotice', () => {
    const src = readClient('stores/sessionStore.ts');
    expect(src).toMatch(/removePartner: \(userId\) => set\(\(s\) => \(\{\s*\n\s*currentPartners: s\.currentPartners\.filter\(p => p\.userId !== userId\)/);
    expect(src).toMatch(/roomNotice: string \| null/);
  });

  it('VideoRoom renders the in-room notice banner', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).toMatch(/data-testid="room-notice"/);
    expect(src).toMatch(/\{roomNotice\}/);
  });
});

describe('S24 — the reconnect dashboard replay labels manual rooms', () => {
  it('the host-reconnect room payload carries isManual (the bb root cause)', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');
    const i = src.indexOf("socket.emit('host:round_dashboard'");
    expect(i).toBeGreaterThan(-1);
    // The room objects built just above this emit must include isManual.
    const before = src.slice(Math.max(0, i - 4000), i);
    expect(before).toMatch(/isTrio: !!m\.participantCId, isManual: m\.isManual === true/);
  });
});

describe('S24 — End Round can never complete the event', () => {
  it('the fall-through completion path requires endEvent:true', () => {
    const fn = sliceFn(readServer('services/orchestration/handlers/host-actions.ts'), 'export async function handleHostEnd');
    const guardIdx = fn.indexOf("code: 'NO_ACTIVE_ROUND'");
    const completeIdx = fn.indexOf('_completeSession(io, data.sessionId)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(guardIdx);
    // The refusal block triggers exactly when endEvent is absent.
    const before = fn.slice(Math.max(0, guardIdx - 400), guardIdx);
    expect(before).toMatch(/if \(!data\.endEvent\) \{/);
  });

  it('completeSession closes any match still active at event end', () => {
    const fn = sliceFn(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function completeSession');
    expect(fn).toMatch(/UPDATE matches SET status = 'completed', ended_at = NOW\(\)\s*\n\s*WHERE session_id = \$1 AND status = 'active'/);
  });

  it('the client maps NO_ACTIVE_ROUND and DIRECTOR_ONLY to friendly toasts', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    expect(src).toMatch(/NO_ACTIVE_ROUND: \{ msg: 'No active round to end\.', severity: 'info' \}/);
    expect(src).toMatch(/DIRECTOR_ONLY: \{ msg: 'Only the host can end the event\.', severity: 'info' \}/);
  });
});
