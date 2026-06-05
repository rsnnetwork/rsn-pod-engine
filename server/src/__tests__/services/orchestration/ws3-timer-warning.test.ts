// ─── WS3/B2+B3 (27 May remaining work) — timer warnings + final stretch ────
//
// B2 "abrupt round end": the server's segment timer now emits timer:warning
// at the T-30s and T-10s threshold crossings of an ACTIVE ROUND (rides the
// existing 2s sync interval — closure-state crossing detection, so pause/
// resume restarts naturally and there are no extra timeouts to clean up).
// Client shows a wrap-up banner + soft WebAudio chime in the breakout.
//
// B3 "final stretch sticks": VideoRoom's timer display AND its visibility
// thresholds ("Timer hidden until final stretch") used to read the store's
// ticked timerSeconds, which freezes when the global 1s tick stalls (tab
// throttling, missed syncs). They now derive remaining time from the
// authoritative timerEndsAt on the component's own 1s heartbeat.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

describe('WS3/B2 — server emits timer:warning at round T-30/T-10', () => {
  const src = () => readServer('services/orchestration/handlers/timer-manager.ts');

  it('warning thresholds are 30 and 10 seconds', () => {
    expect(src()).toMatch(/warnThresholds = \[30, 10\]/);
  });

  it('warnings fire on threshold CROSSINGS (no re-fire every 2s tick)', () => {
    expect(src()).toMatch(/secondsRemaining <= threshold && prevRemainingSeconds > threshold/);
  });

  it('warnings are gated to ROUND_ACTIVE segments only', () => {
    const fn = src();
    const warnIdx = fn.indexOf("emit('timer:warning'");
    expect(warnIdx).toBeGreaterThan(-1);
    const before = fn.slice(Math.max(0, warnIdx - 600), warnIdx);
    expect(before).toMatch(/SessionStatus\.ROUND_ACTIVE/);
  });

  it('the warning payload carries segmentType + threshold + endsAt', () => {
    const fn = src();
    const warnIdx = fn.indexOf("emit('timer:warning'");
    const block = fn.slice(warnIdx, warnIdx + 400);
    expect(block).toMatch(/threshold/);
    expect(block).toMatch(/segmentType/);
    expect(block).toMatch(/endsAt/);
  });

  it('shared events declare timer:warning (and timer:sync endsAt/serverNow)', () => {
    const ev = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../shared/src/types/events.ts'), 'utf8',
    );
    expect(ev).toMatch(/'timer:warning':/);
    expect(ev).toMatch(/'timer:sync': \(data: \{[^}]*endsAt\?/);
  });
});

describe('WS3/B2 — client banner + chime', () => {
  it('useSessionSocket listens for timer:warning and stores it + chimes in-room', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    expect(src).toMatch(/socket\.on\('timer:warning'/);
    expect(src).toMatch(/setTimerWarning/);
    expect(src).toMatch(/playTimerChime/);
  });

  it('the chime is WebAudio and fail-open (no asset, never throws into the room UI)', () => {
    const src = readClient('lib/chime.ts');
    expect(src).toMatch(/AudioContext/);
    expect(src).toMatch(/fail-open/);
  });

  it('VideoRoom renders the wrap-up banner with distinct 30s/10s copy', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).toMatch(/30 seconds left/);
    expect(src).toMatch(/10 seconds left/);
  });
});

describe('WS3/B3 — final-stretch visibility derives from timerEndsAt', () => {
  it('VideoRoom computes derivedTimerSeconds from timerEndsAt + clockOffset', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).toMatch(/derivedTimerSeconds/);
    expect(src).toMatch(/timerEndsAt\.getTime\(\) - \(Date\.now\(\) \+ clockOffset\)/);
  });

  it('VideoRoom runs its OWN 1s heartbeat so the reveal survives a stalled global tick', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).toMatch(/forceTimerTick/);
  });

  it('the visibility thresholds no longer read the freezable timerSeconds', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).not.toMatch(/timerVisibility === 'last_30s' && timerSeconds/);
    expect(src).toMatch(/timerVisibility === 'last_30s' && derivedTimerSeconds <= 30/);
  });
});
