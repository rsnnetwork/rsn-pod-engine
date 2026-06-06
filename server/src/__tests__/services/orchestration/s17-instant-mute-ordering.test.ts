// ─── S17 — instant mute/unmute (live-test 2026-06-06, Ali) ──────────────────
//
// Symptom: "host unmutes all but saif's tile shows mute" + mute/unmute
// "taking time". Root cause: Phase U revokes the target's LiveKit publish
// permission on mute; on UNMUTE the lobby:mute_command relay raced AHEAD of
// the permission restore (which sat behind a participants SELECT + entity
// fanout + two more serial SELECTs + serial LiveKit calls). The client
// re-publishes the mic the moment the relay lands → PublishTrackError
// "insufficient permissions" (the 11× Sentry cluster) → no retry → stuck
// visibly muted.
//
// Fix (direction-aware ordering):
//   UNMUTE → await permission restore BEFORE the relay (single + bulk).
//   MUTE   → relay first (instant local mute), revoke fire-and-forget.
//   The participants fanout moved fully off the latency path.
//   enforceLiveKitMute parallelizes its lookups + LiveKit calls.
//   Client: setMicrophoneEnabled gets catch + one retry (residual SFU
//   propagation), instead of unhandled fire-and-forget.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

const haSrc = () => readServer('services/orchestration/handlers/host-actions.ts');

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S17 — single-target mute ordering', () => {
  it('UNMUTE awaits the LiveKit permission restore BEFORE the relay', () => {
    const fn = sliceFn(haSrc(), 'export async function handleHostMuteParticipant');
    const restoreIdx = fn.search(/if \(!data\.muted\) \{\s*\n\s*await enforceLiveKitMute\(data\.sessionId, data\.targetUserId, true\)/);
    const relayIdx = fn.indexOf("emit('lobby:mute_command'");
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(relayIdx).toBeGreaterThan(restoreIdx);
  });

  it('MUTE relays first; the SFU revoke is fire-and-forget after it', () => {
    const fn = sliceFn(haSrc(), 'export async function handleHostMuteParticipant');
    const relayIdx = fn.indexOf("emit('lobby:mute_command'");
    const revokeIdx = fn.indexOf('enforceLiveKitMute(data.sessionId, data.targetUserId, false)');
    expect(revokeIdx).toBeGreaterThan(relayIdx);
    // Fire-and-forget — never awaited on the mute path.
    expect(fn).not.toMatch(/await enforceLiveKitMute\(data\.sessionId, data\.targetUserId, false\)/);
  });

  it('the participants fanout no longer blocks the latency path (void IIFE)', () => {
    const fn = sliceFn(haSrc(), 'export async function handleHostMuteParticipant');
    const fanoutIdx = fn.indexOf('SELECT user_id FROM session_participants');
    expect(fanoutIdx).toBeGreaterThan(-1);
    const before = fn.slice(Math.max(0, fanoutIdx - 400), fanoutIdx);
    expect(before).toMatch(/void \(async \(\) =>/);
  });
});

describe('S17 — bulk mute-all ordering', () => {
  it('UNMUTE-all chains each relay AFTER that user’s permission restore', () => {
    const fn = sliceFn(haSrc(), 'export async function handleHostMuteAll');
    // restore → .then(relay) per user
    expect(fn).toMatch(/enforceLiveKitMute\(data\.sessionId, participantId, true\)[\s\S]{0,400}?\.then\(\(\) => \{[\s\S]{0,200}?emit\('lobby:mute_command'/);
  });

  it('MUTE-all relays first, revoke follows', () => {
    const fn = sliceFn(haSrc(), 'export async function handleHostMuteAll');
    const muteBranch = fn.slice(fn.indexOf('if (data.muted) {', fn.indexOf('for (const participantId')), fn.indexOf('} else {', fn.indexOf('for (const participantId')));
    const relayIdx = muteBranch.indexOf("emit('lobby:mute_command'");
    const revokeIdx = muteBranch.indexOf('enforceLiveKitMute');
    expect(relayIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeGreaterThan(relayIdx);
  });
});

describe('S17 — enforceLiveKitMute parallelism', () => {
  it('lookups batch in one Promise.all; both permission updates fire together', () => {
    const fnIdx = haSrc().indexOf('async function enforceLiveKitMute');
    const block = haSrc().slice(fnIdx, fnIdx + 3000);
    expect(block).toMatch(/const \[sessRow, matchRow\] = await Promise\.all\(/);
    expect(block).toMatch(/await Promise\.all\(applies\)/);
  });
});

describe('S17 — client applies the command with catch + retry', () => {
  it('Lobby hostMuteCommand effect retries setMicrophoneEnabled on failure', () => {
    const src = readClient('features/live/Lobby.tsx');
    const idx = src.indexOf('if (hostMuteCommand !== null && !isHost)');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1600);
    expect(block).toMatch(/try \{\s*\n\s*await localParticipant\.setMicrophoneEnabled\(target\)/);
    expect(block).toMatch(/catch \{[\s\S]{0,300}?setTimeout[\s\S]{0,300}?setMicrophoneEnabled\(target\)\.catch/);
  });
});
