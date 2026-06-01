// ─── Dr Arch — April 19 deep audit + fixes ───────────────────────────────
//
// Architectural bugs found during live testing on 2026-04-19:
//
//   Bug 6 (sharpening) — Video tile STILL zoomed on desktop despite the
//   2026-04-18 object-contain fix. Root cause: @livekit/components-styles
//   ships `.lk-participant-media-video { object-fit: cover }` with higher
//   specificity than our Tailwind `object-contain` className on the
//   wrapper. Fix: global CSS override in client/src/index.css forces
//   object-fit: contain on .lk-participant-media-video.
//
//   Bug 7 — Manual breakout "Create" lets host yank participants out of
//   an active match (algorithm or manual). Root cause: bulk-create
//   silently reassigned existing active matches (breakout-bulk.ts:152-174)
//   AND client modal rendered the "(in room)" label in blue but kept the
//   checkbox selectable. Fix: server rejects with
//   PARTICIPANT_IN_ACTIVE_ROOM, client disables the checkbox for anyone
//   inActiveRoom.
//
//   Bug 8 — Host timer and breakout-participant timer drifted (8:17 vs
//   9:05 reported during pause/resume + extend). Root cause: timer:sync
//   interval was 5s, giving visible local-tick drift between host and
//   participants between syncs. Fix: tighten to 2s.
//
//   Bug 9 — "Another Round" skipped the Match People → preview → confirm
//   flow and dumped participants straight into a new breakout. Root
//   cause: HostControls emitted host:start_round directly. Fix: emit
//   host:generate_matches instead; server accepts CLOSING_LOBBY and
//   transitions the session back to ROUND_TRANSITION + bumps round cap.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, relPath), 'utf8');
}

describe('Dr Arch April 19 — Bug 6: LiveKit CSS override for object-contain', () => {
  it('client/src/index.css overrides .lk-participant-media-video object-fit', () => {
    const css = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/index.css'),
      'utf8',
    );
    // The override must target the LiveKit class with !important so it
    // beats the vendor stylesheet specificity.
    expect(css).toMatch(/\.lk-participant-media-video\s*\{[\s\S]*?object-fit:\s*contain\s*!important/);
  });
});

describe('Dr Arch April 19 — Bug 7: Manual breakout rejects participants in active rooms', () => {
  it('breakout-bulk rejects with PARTICIPANT_IN_ACTIVE_ROOM when participant is in active match', () => {
    const src = readSource('../../../services/orchestration/handlers/breakout-bulk.ts');
    // Pre-insertion SELECT to detect conflicts
    expect(src).toMatch(/status\s*=\s*'active'[\s\S]*?participant_a_id\s*=\s*u\.id/);
    // Error code the client should handle
    expect(src).toMatch(/PARTICIPANT_IN_ACTIVE_ROOM/);
    // Must return before the reassign loop (no silent yanking)
    const handlerStart = src.indexOf('handleHostCreateBreakoutBulk');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = src.indexOf('export async function handleHostExtendBreakoutAll');
    const handler = src.slice(handlerStart, handlerEnd);
    // Rejection path must come BEFORE the per-room transactional reassign+insert.
    // Phase 6 (5 May spec) reshaped the bulk loop body to use transaction();
    // the literal "Reassign any existing active matches" comment is gone.
    // Pin: rejection sits before the transaction wrapper.
    const rejectIdx = handler.indexOf('PARTICIPANT_IN_ACTIVE_ROOM');
    const transactionIdx = handler.indexOf('await transaction(async (client)');
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(transactionIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeLessThan(transactionIdx);
  });

  it('HostControls modal disables checkbox for participants already in an active room', () => {
    const src = readSource('../../../../../client/src/features/live/HostControls.tsx');
    // The new disable computation includes inActiveRoom.
    expect(src).toMatch(/checkboxDisabled\s*=\s*[^;]*inActiveRoom/);
    // Checkbox uses that computed disabled value.
    expect(src).toMatch(/disabled=\{checkboxDisabled\}/);
    // Modal has the explainer banner.
    expect(src).toMatch(/finish or leave their current room/i);
  });
});

describe('Dr Arch April 19 — Bug 8: Tighter timer sync interval (5s → 2s)', () => {
  it('startSegmentTimer sync interval fires every 2s (was 5s)', () => {
    const src = readSource('../../../services/orchestration/handlers/timer-manager.ts');
    // Find the syncInterval setInterval call.
    const syncBlock = src.match(/setInterval\([\s\S]*?timer:sync[\s\S]*?\}, (\d+)\)/);
    expect(syncBlock).not.toBeNull();
    expect(syncBlock![1]).toBe('2000');
  });
});

describe('Dr Arch April 19 — Bug 6.5: Desktop video cells capped at 16:9 aspect', () => {
  it('VideoRoom desktop grid cells wrap VideoTile in an aspectRatio:16/9 container', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
    // The inner wrapper around VideoTile in the desktop grid uses
    // aspectRatio: '16 / 9' inline style to match webcam source aspect.
    expect(src).toMatch(/aspectRatio:\s*['"]16\s*\/\s*9['"][\s\S]*?maxHeight:\s*['"]100%['"]/);
  });

  it('Pinned tile container uses the same 16:9 cap', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
    // Pinned view also wraps the VideoTile in an aspect-16/9 container so a
    // landscape webcam fills the pinned area without a tall black bar below.
    const pinnedBlock = src.match(/if \(pinnedTile\)[\s\S]{0,2000}/)?.[0] || '';
    expect(pinnedBlock).toMatch(/aspectRatio:\s*['"]16\s*\/\s*9['"]/);
  });
});

describe('Dr Arch April 19 — Bug 8.5: Single source of truth for timer (server endsAt)', () => {
  it('timer-manager periodic sync includes endsAt ISO string', () => {
    const src = readSource('../../../services/orchestration/handlers/timer-manager.ts');
    // The periodic emit must include endsAt so clients derive their display
    // from a single authoritative source instead of decrementing locally.
    const block = src.match(/setInterval\([\s\S]*?timer:sync[\s\S]*?\}, \d+\)/)?.[0] || '';
    expect(block).toMatch(/endsAt:\s*session\.timerEndsAt/);
  });

  it('handleHostExtendRound timer:sync includes endsAt', () => {
    const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostExtendRound');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, fnStart + 2500);
    expect(fn).toMatch(/timer:sync[\s\S]*?endsAt:\s*newEndsAt\.toISOString/);
  });

  it('handleHostPause timer:sync sends endsAt:null + paused:true', () => {
    const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostPause');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\nexport async function handleHostResume', fnStart);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 4000);
    // Pause snapshot must explicitly null endsAt so client recompute pauses
    expect(fn).toMatch(/paused:\s*true/);
    expect(fn).toMatch(/endsAt:\s*null/);
  });

  it('handleHostResume timer:sync includes refreshed endsAt', () => {
    const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostResume');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\nexport ', fnStart + 30);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 4000);
    expect(fn).toMatch(/endsAt:\s*activeSession\.timerEndsAt/);
  });

  it('emitHostDashboard payload includes timerEndsAt for unified host display', () => {
    const src = readSource('../../../services/orchestration/handlers/matching-flow.ts');
    // Phase 8 (1 May 2026) added two more emitHostDashboard* exports
    // (Force + emitHostActionConfirmed) ahead of the actual emit
    // function. Search for the implementation directly to skip the
    // wrappers — it's the only function that ACTUALLY builds the
    // payload.
    const fnStart = src.indexOf('async function emitHostDashboardImmediate(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\nexport ', fnStart + 30);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
    // host:round_dashboard payload must include timerEndsAt so the host
    // display matches participants (same source of truth).
    expect(fn).toMatch(/timerEndsAt:/);
  });

  it('client store tickTimer recomputes from timerEndsAt (no local decrement)', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/stores/sessionStore.ts'),
      'utf8',
    );
    // Find the IMPLEMENTATION (not the TS interface declaration) — the
    // implementation uses an arrow body `tickTimer: () => set(...)`.
    const implIdx = src.indexOf('tickTimer: () => set');
    expect(implIdx).toBeGreaterThan(-1);
    const tickBlock = src.slice(implIdx, implIdx + 800);
    expect(tickBlock).toMatch(/s\.timerEndsAt/);
    expect(tickBlock).toMatch(/getTime\(\)\s*-\s*Date\.now\(\)/);
    // Hard-fail if anyone re-introduces the old decrement.
    expect(tickBlock).not.toMatch(/timerSeconds\s*-\s*1/);
  });
});

describe('Dr Arch April 19 — Bug 12: Room button visible at every stage', () => {
  it('All-rounds-complete (isSessionEnding) screen exposes the Room button', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/HostControls.tsx'),
      'utf8',
    );
    const idx = src.indexOf('isSessionEnding');
    expect(idx).toBeGreaterThan(-1);
    // The early-return block (when allRoundsDone) must include the Room
    // button (UserPlus icon + "Room" label) alongside Another Round and End Event.
    const allRoundsBlock = src.match(/All rounds complete[\s\S]{0,3500}/)?.[0] || '';
    expect(allRoundsBlock).toMatch(/<UserPlus[\s\S]{0,200}Room/);
  });
});

describe('Dr Arch April 19 — Bug 9: "Another Round" routes through Match People flow', () => {
  it('HostControls "Another Round" button emits host:generate_matches (not host:start_round)', () => {
    const src = readSource('../../../../../client/src/features/live/HostControls.tsx');
    // Locate the actual JSX button (not the comment above it) via the
    // Shuffle icon + label on the same line.
    const labelMatch = src.match(/<Shuffle[^>]*\/>\s*Another Round/);
    expect(labelMatch).not.toBeNull();
    const labelIdx = src.indexOf(labelMatch![0]);
    expect(labelIdx).toBeGreaterThan(-1);
    // Look ~1500 chars BEFORE the label — the onClick handler is above it.
    const block = src.slice(Math.max(0, labelIdx - 1500), labelIdx + 100);
    expect(block).toMatch(/host:generate_matches/);
    // Must NOT emit host:start_round in this handler.
    expect(block).not.toMatch(/socket\?\.emit\(['"]host:start_round/);
  });

  it('handleHostGenerateMatches accepts CLOSING_LOBBY state', () => {
    const src = readSource('../../../services/orchestration/handlers/matching-flow.ts');
    const handlerStart = src.indexOf('export async function handleHostGenerateMatches');
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = src.slice(handlerStart, handlerStart + 3000);
    // State guard now includes CLOSING_LOBBY
    expect(handler).toMatch(/SessionStatus\.CLOSING_LOBBY/);
    // Transition back to ROUND_TRANSITION when entering from CLOSING_LOBBY
    expect(handler).toMatch(/CLOSING_LOBBY[\s\S]*?ROUND_TRANSITION/);
    // Bump numberOfRounds so the new round is a valid round N+1
    expect(handler).toMatch(/numberOfRounds[\s\S]*?\+\s*1/);
    // Cancel the closing-lobby safety timer
    expect(handler).toMatch(/clearSessionTimers/);
  });
});
