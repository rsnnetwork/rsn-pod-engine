// ─── S26 — the start signal cannot be missed (live-test 2026-06-07) ────────
//
// Ali pressed Start with 3 participants waiting; alihammza's socket had
// silently dropped out of sessionRoom, never heard the room-only
// session:status_changed broadcast, and sat on "waiting for host" until a
// manual refresh. Same failure class as #11 (23 May — a HOST missed
// session:completed for the same reason). Two layers now:
//   1. BOTH start paths (socket host:start_session + REST) also fan the
//      LOBBY_OPEN status out per-participant via userRoom (#11 pattern —
//      userRoom is re-joined on every connect, far more stable);
//   2. the waiting screen itself polls the REST state snapshot every 10s
//      (server truth, fully socket-independent) and opens the gate the
//      moment the event is live.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

describe('S26 — per-user start fan-out (both start paths)', () => {
  const src = () => readServer('services/orchestration/handlers/host-actions.ts');

  it('handleHostStart fans LOBBY_OPEN per participant via userRoom', () => {
    const s = src();
    const i = s.indexOf('export async function handleHostStart');
    const fn = s.slice(i, s.indexOf('\nexport ', i + 1));
    const roomIdx = fn.indexOf("io.to(sessionRoom(data.sessionId)).emit('session:status_changed'");
    const userIdx = fn.indexOf("io.to(userRoom(r.user_id)).emit('session:status_changed'");
    expect(roomIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(roomIdx);
    expect(fn).toMatch(/status NOT IN \('removed', 'no_show'\)/);
  });

  it('the REST start twin fans per participant too', () => {
    const s = src();
    const i = s.indexOf("'Session started via REST");
    expect(i).toBeGreaterThan(-1);
    const before = s.slice(Math.max(0, i - 2200), i);
    expect(before).toMatch(/_io\.to\(userRoom\(r\.user_id\)\)\.emit\('session:status_changed'/);
  });
});

describe('S26/S27 — waiting screen polls server truth and converges FULLY', () => {
  it('PreLobbyWaitingRoom applies the whole snapshot + pulls BOTH token rails', () => {
    // S27 (alihammza's blank Main Room, mobile, event v1) — flipping only
    // the status flag opened the gate into a tokenless, video-less lobby.
    // The poll now applies the full snapshot atomically, emits the socket
    // resync (works on unseated sockets) AND REST-mints the lobby token
    // (works with ZERO functional sockets — the mobile zombie case).
    const src = readClient('features/live/Lobby.tsx');
    const i = src.indexOf('function PreLobbyWaitingRoom');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, i + 3600);
    expect(fn).toMatch(/api\.get\(`\/sessions\/\$\{sessionId\}\/state`\)/);
    expect(fn).toMatch(/d\.sessionStatus !== 'scheduled'/);
    expect(fn).toMatch(/s\.applyFullState\(d\)/);
    expect(fn).toMatch(/emit\('session:resync' as any/);
    expect(fn).toMatch(/api\.post\(`\/sessions\/\$\{sessionId\}\/token`, \{\}\)/);
    expect(fn).toMatch(/setLobbyToken\(td\.token, td\.livekitUrl, td\.roomId \?\? null\)/);
    expect(fn).toMatch(/10_000/);
  });

  it('the 30s tokenless-lobby belt also REST-mints (zombie-socket heal)', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    const i = src.indexOf('Ship C belt — sitting in the lobby without a token');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1500);
    expect(block).toMatch(/sessionStatus !== 'scheduled'/);
    expect(block).toMatch(/emit\('session:resync'/);
    expect(block).toMatch(/api\.post\(`\/sessions\/\$\{sessionId\}\/token`, \{\}\)/);
    expect(block).toMatch(/cur\.setLobbyToken\(td\.token, td\.livekitUrl, td\.roomId \?\? null\)/);
  });
});
