# Canonical Room-State — Phase 2 (Locked Transition Chokepoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development. Steps use `- [ ]` tracking.

**Goal:** Route every session-lifecycle transition — timer-fired, host-clicked, and disconnect-driven — so they are serialized under one per-session lock and validated by the session-status FSM. Closes audit findings **C1** (timer bypasses the guard → double `endRound`/`transitionToRound`), **C2** (no status precondition → duplicate/illegal transitions), **C3** (disconnect-timeout mutates matches unguarded).

**Architecture:** Surgical. We do NOT make `withSessionGuard` re-entrant and we do NOT wrap the lifecycle functions themselves (host handlers already call them *inside* the guard — proven non-re-entrant). Instead we (1) wrap the timer-callback closures and the disconnect-timeout body at their **entry points**, and (2) add precondition guards at the top of the lifecycle functions using the Phase-1 `session-fsm`. No read path changes; the canonical doc is not consulted yet (that is Phase 3).

**Tech Stack:** TypeScript, Jest. Test command: `npm test` (server workspace). Single file: `cd server && npx jest <path>`.

**Spec:** `docs/superpowers/specs/2026-05-25-canonical-room-state-design.md` (§5 lock layering, §6 session FSM).

**Re-entrancy proof (why this is safe):** `withSessionGuard` (`session-state.ts:102`) is a non-re-entrant promise mutex. Host handlers (e.g. `handleHostEndRound`, `host-actions.ts`) run `withSessionGuard(sessionId, () => … endRound(…))` and do not deadlock today — therefore `endRound`/`transitionToRound`/`completeSession`/`endRatingWindow` and their callees (`maybeAutoEndEmptyRound`, `emitHostDashboard`, `findIsolatedParticipants`) never acquire the guard themselves. Wrapping the **timer** and **disconnect-timeout** entry points (neither currently holds the guard) is therefore safe and symmetric with the host path.

---

## File Structure (Phase 2)

- **Modify** `server/src/services/orchestration/orchestration.service.ts:119-124` — wrap the 4 `timerCallbacks` closures in `withSessionGuard` (C1).
- **Modify** `server/src/services/orchestration/handlers/round-lifecycle.ts` — add FSM precondition guard to `transitionToRound` (~line 208) and `endRound` (~line 499); add idempotency guard to `completeSession` (~line 818) (C2).
- **Modify** `server/src/services/orchestration/handlers/participant-flow.ts:1573` — wrap the disconnect-timeout `setTimeout` async body in `withSessionGuard` (C3).
- **Test** `server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts`

`endRatingWindow` already has the precondition guard (FIX 3D, `round-lifecycle.ts:690`) — leave it; optionally note it uses the same pattern.

---

## Task 1: C2 — FSM precondition guard on `endRound`

**Files:**
- Modify: `server/src/services/orchestration/handlers/round-lifecycle.ts` (top of `endRound`, ~line 499)
- Test: `server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts`

`endRound` is the highest-risk double-fire (host "End Round" + round timer racing). Its only legal source status is `ROUND_ACTIVE`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts
import { SessionStatus } from '@rsn/shared';
import { activeSessions } from '../../../services/orchestration/state/session-state';

// Mock collaborators that endRound touches so we can drive it in isolation.
jest.mock('../../../db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: jest.fn(async () => {}),
  getSessionById: jest.fn(async () => ({ lobbyRoomId: null })),
  incrementRoundsCompletedBatch: jest.fn(async () => {}),
}));
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: jest.fn(async () => []),
}));

const io: any = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) };

import { endRound } from '../../../services/orchestration/handlers/round-lifecycle';

function makeSession(status: SessionStatus) {
  activeSessions.set('s2', {
    sessionId: 's2', hostUserId: 'h', config: { numberOfRounds: 3, ratingWindowSeconds: 30 } as any,
    currentRound: 1, status, timer: null, timerSyncInterval: null, timerEndsAt: null,
    isPaused: false, pausedTimeRemaining: null, presenceMap: new Map(),
    pendingRoundNumber: null, manuallyLeftRound: new Set(),
  } as any);
}
afterEach(() => { activeSessions.delete('s2'); jest.clearAllMocks(); });

describe('Phase 2 — endRound precondition (C2)', () => {
  it('transitions to ROUND_RATING from ROUND_ACTIVE', async () => {
    makeSession(SessionStatus.ROUND_ACTIVE);
    await endRound(io, 's2', 1);
    expect(activeSessions.get('s2')!.status).toBe(SessionStatus.ROUND_RATING);
  });

  it('is a no-op when already in ROUND_RATING (duplicate timer+host fire)', async () => {
    makeSession(SessionStatus.ROUND_RATING);
    const sessionService = require('../../../services/session/session.service');
    await endRound(io, 's2', 1);
    // Still ROUND_RATING and did NOT re-issue the status write
    expect(activeSessions.get('s2')!.status).toBe(SessionStatus.ROUND_RATING);
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect the second test to FAIL** (today `endRound` has no guard, so it re-runs and calls `updateSessionStatus`).

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts -t "endRound precondition"`
Expected: the "no-op when already in ROUND_RATING" test FAILS.

- [ ] **Step 3: Add the guard.** At the very top of `endRound`'s `try` body in `round-lifecycle.ts` (immediately after `if (!activeSession) return;`, before the `UPDATE matches` query), add:

```typescript
    // C2 (Phase 2) — precondition: ROUND_ACTIVE is the only legal source for
    // ending a round. A duplicate fire (host "End Round" racing the round
    // timer) finds status already past ROUND_ACTIVE and no-ops, so it cannot
    // re-emit round_ended, re-arm the rating timer, or re-complete matches.
    if (!canTransitionSession(activeSession.status, SessionStatus.ROUND_RATING)) {
      logger.warn({ sessionId, currentStatus: activeSession.status, roundNumber },
        'endRound: not in ROUND_ACTIVE — skipping duplicate/illegal transition (C2)');
      return;
    }
```

Add the import at the top of the file (alongside other state imports):

```typescript
import { canTransitionSession } from '../state/session-fsm';
```

- [ ] **Step 4: Run — both tests PASS.**

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts -t "endRound precondition"`
Expected: PASS (2).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/handlers/round-lifecycle.ts server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts
git commit -m "fix(state): guard endRound with session FSM precondition (phase 2, C2)"
```

---

## Task 2: C2 — FSM precondition on `transitionToRound` + idempotency guard on `completeSession`

**Files:**
- Modify: `server/src/services/orchestration/handlers/round-lifecycle.ts` (top of `transitionToRound` ~line 208; top of `completeSession` ~line 818)
- Test: same Phase 2 test file

`transitionToRound`'s legal sources are `LOBBY_OPEN` (round 1) and `ROUND_TRANSITION` (round n+1); both may transition to `ROUND_ACTIVE`. `completeSession` is reached from MULTIPLE states by design (`CLOSING_LOBBY`, and the `#11 endRequested` path calls it from `ROUND_RATING` at line 723, and host End-Event) — so it must NOT be FSM-gated; use an idempotency guard instead.

- [ ] **Step 1: Write the failing tests** (append to the same describe-file)

```typescript
import { transitionToRound, completeSession } from '../../../services/orchestration/handlers/round-lifecycle';

describe('Phase 2 — transitionToRound precondition (C2)', () => {
  it('is a no-op when already ROUND_ACTIVE (duplicate start)', async () => {
    makeSession(SessionStatus.ROUND_ACTIVE);
    const sessionService = require('../../../services/session/session.service');
    await transitionToRound(io, 's2', 1);
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });
});

describe('Phase 2 — completeSession idempotency (C2)', () => {
  it('is a no-op when already COMPLETED', async () => {
    makeSession(SessionStatus.COMPLETED);
    const sessionService = require('../../../services/session/session.service');
    await completeSession(io, 's2');
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (no guards yet).

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts -t "precondition|idempotency"`
Expected: the two new tests FAIL.

- [ ] **Step 3: Add the guards.**

At the top of `transitionToRound` (after `if (!activeSession) return;`, before the bonus-round bump at ~line 216):

```typescript
    // C2 (Phase 2) — precondition: ROUND_ACTIVE is reachable only from
    // LOBBY_OPEN (round 1) or ROUND_TRANSITION (round n+1). A duplicate start
    // (host "Start Round" racing a transition timer) finds status already
    // ROUND_ACTIVE and no-ops, preventing a double match-generation.
    if (!canTransitionSession(activeSession.status, SessionStatus.ROUND_ACTIVE)) {
      logger.warn({ sessionId, currentStatus: activeSession.status, roundNumber },
        'transitionToRound: illegal/duplicate start — skipping (C2)');
      return;
    }
```

At the top of `completeSession` (after its `const activeSession = activeSessions.get(sessionId);` / null check):

```typescript
    // C2 (Phase 2) — idempotency guard only. completeSession is legitimately
    // reached from several states (CLOSING_LOBBY, the #11 endRequested path
    // from ROUND_RATING, host End-Event), so it is NOT FSM-gated; we only
    // refuse a re-entrant completion.
    if (activeSession.status === SessionStatus.COMPLETED) {
      logger.warn({ sessionId }, 'completeSession: already COMPLETED — skipping (C2)');
      return;
    }
```

(If `completeSession` already null-checks `activeSession`, place the guard right after. If it lacks `canTransitionSession`/`logger`/`SessionStatus` imports, they already exist in this file.)

- [ ] **Step 4: Run — all four Phase-2 C2 tests PASS.**

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/handlers/round-lifecycle.ts server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts
git commit -m "fix(state): guard transitionToRound (FSM) + completeSession (idempotent) (phase 2, C2)"
```

---

## Task 3: C1 — wrap timer callbacks in `withSessionGuard`

**Files:**
- Modify: `server/src/services/orchestration/orchestration.service.ts:119-124`
- Test: same Phase 2 test file (source-assertion pin, matching the repo's spine-test convention)

- [ ] **Step 1: Write the failing pin test**

```typescript
import * as fs from 'fs';
import * as path from 'path';
describe('Phase 2 — timer callbacks are guarded (C1)', () => {
  it('wraps each timer callback in withSessionGuard', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/orchestration/orchestration.service.ts'), 'utf8');
    const block = src.slice(src.indexOf('const timerCallbacks'), src.indexOf('const timerCallbacks') + 600);
    expect(block).toMatch(/transitionToRound:\s*\(sessionId, roundNumber\)\s*=>\s*withSessionGuard\(/);
    expect(block).toMatch(/endRound:\s*\(sessionId, roundNumber\)\s*=>\s*withSessionGuard\(/);
    expect(block).toMatch(/endRatingWindow:\s*\(sessionId, roundNumber\)\s*=>\s*withSessionGuard\(/);
    expect(block).toMatch(/completeSession:\s*\(sessionId\)\s*=>\s*withSessionGuard\(/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts -t "timer callbacks are guarded"`
Expected: FAIL.

- [ ] **Step 3: Wrap the callbacks.** Replace the `timerCallbacks` object (`orchestration.service.ts:119-124`) with:

```typescript
  // C1 (Phase 2) — timer-fired transitions run OUTSIDE any host guard. Wrap
  // each in withSessionGuard so a timer firing cannot run concurrently with a
  // host-clicked transition on the same session. Safe (non-re-entrant): the
  // lifecycle fns never acquire the guard themselves (host handlers already
  // call them while holding it).
  const timerCallbacks: TimerCallbacks = {
    transitionToRound: (sessionId, roundNumber) => withSessionGuard(sessionId, () => transitionToRound(io, sessionId, roundNumber)),
    endRound: (sessionId, roundNumber) => withSessionGuard(sessionId, () => endRound(io, sessionId, roundNumber)),
    endRatingWindow: (sessionId, roundNumber) => withSessionGuard(sessionId, () => endRatingWindow(io, sessionId, roundNumber)),
    completeSession: (sessionId) => withSessionGuard(sessionId, () => completeSession(io, sessionId)),
  };
```

Ensure `withSessionGuard` is imported in `orchestration.service.ts` (it is exported from `./state/session-state`). If not already imported, add it to the existing import from that module.

- [ ] **Step 4: Run — PASS.**

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts -t "timer callbacks are guarded"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/orchestration.service.ts server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts
git commit -m "fix(state): serialize timer-fired transitions under withSessionGuard (phase 2, C1)"
```

---

## Task 4: C3 — wrap the disconnect-timeout body in `withSessionGuard`

**Files:**
- Modify: `server/src/services/orchestration/handlers/participant-flow.ts:1573` (the `setTimeout(async () => { … })` body)
- Test: same Phase 2 test file (source-assertion pin)

The 15s disconnect timeout mutates matches (terminal status, auto-reassign) outside any lock, racing host actions and `endRound`. Wrap its body so it serializes on the session.

- [ ] **Step 1: Write the failing pin test**

```typescript
describe('Phase 2 — disconnect timeout is guarded (C3)', () => {
  it('runs the disconnect-timeout body under withSessionGuard', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'), 'utf8');
    // The setTimeout callback should delegate its body to withSessionGuard.
    expect(src).toMatch(/setTimeout\(async \(\) => \{\s*disconnectTimeouts\.delete\(timeoutKey\);\s*await withSessionGuard\(/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts -t "disconnect timeout is guarded"`
Expected: FAIL.

- [ ] **Step 3: Wrap the body.** In `participant-flow.ts`, the timeout currently reads:

```typescript
            const timeoutId = setTimeout(async () => {
              disconnectTimeouts.delete(timeoutKey);
              try {
                const currentSession = activeSessions.get(sessionId);
                … (existing body) …
              } catch (err) { … }
            }, 15000);
```

Wrap the inner work in `withSessionGuard`, keeping the `disconnectTimeouts.delete` outside (it is a Map op on a module-level store, not session state):

```typescript
            const timeoutId = setTimeout(async () => {
              disconnectTimeouts.delete(timeoutKey);
              await withSessionGuard(sessionId, async () => {
              try {
                const currentSession = activeSessions.get(sessionId);
                … (EXISTING body unchanged) …
              } catch (err) { … existing catch … }
              });
            }, 15000);
```

Confirm `withSessionGuard` is imported in `participant-flow.ts` (it is — used at lines 225/793/1133). Do NOT change any logic inside the body; only add the `withSessionGuard(sessionId, async () => { … })` wrapper around the existing `try/catch`.

> Re-entrancy note: the disconnect-timeout body is fired from a bare `setTimeout` (not inside a guard), and its callees (`maybeAutoEndEmptyRound`, `emitHostDashboard`, `findIsolatedParticipants`, match INSERTs) do not acquire the guard. Safe.

- [ ] **Step 4: Run the pin test + full disconnect test files.**

Run: `cd server && npx jest src/__tests__/services/orchestration/phase2-locked-transitions.test.ts src/__tests__/services/orchestration/disconnect-rejoin.test.ts`
Expected: PASS (the existing disconnect-rejoin behavior is unchanged; the wrapper only serializes it).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/handlers/participant-flow.ts server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts
git commit -m "fix(state): serialize disconnect-timeout match logic under withSessionGuard (phase 2, C3)"
```

---

## Task 5: Full-suite regression gate

- [ ] **Step 1: Run the FULL server suite.**

Run: `npm test`
Expected: all suites green. The precondition guards must not break any existing round-lifecycle / disconnect / host-action test. If a pre-existing test now fails, the guard is too strict — STOP and reconcile against the actual status flow (esp. bonus rounds, `#11 endRequested`, manual breakouts) before proceeding.

- [ ] **Step 2: Typecheck.**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit (if any fixups were needed; otherwise skip).**

---

## Self-Review

- **Spec coverage:** C1 (Task 3 — guarded timer callbacks), C2 (Tasks 1+2 — FSM/idempotency preconditions), C3 (Task 4 — guarded disconnect timeout). Matches spec §5/§6 and §12 step 2.
- **No over-build:** reads still hit existing stores; canonical doc untouched (Phase 3). No re-entrant-lock rework.
- **Safety:** the re-entrancy proof (host path already calls lifecycle fns inside the guard) underwrites both the timer-wrap and disconnect-wrap. `completeSession` deliberately uses idempotency (not FSM) because End-Event fires from multiple states. `endRatingWindow` already guarded — untouched.
