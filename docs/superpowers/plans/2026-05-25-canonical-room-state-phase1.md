# Canonical Room-State — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical-state storage seam, the session-status FSM, and a continuously-written *shadow* projection of the live `ActiveSession` into the canonical Redis document — with **zero behavior change** (no read path switched, no mutation path replaced).

**Architecture:** A single canonical session document in Redis (namespace `rsn:canonical:`, distinct from the existing `rsn:session:` write-through blob), a pure session-status FSM mirroring the existing participant FSM, and a pure projection function that maps today's four in-process stores (`presenceMap`, `roomParticipants`, `participantStates`, `hostUserId`) onto the orthogonal `location` + `connState` model. The shadow write is fired (best-effort, non-blocking) from the existing `persistSessionState`. Reads stay on the current code; this phase only *populates and validates* the new model.

**Tech Stack:** TypeScript, Node, ioredis (already wired with graceful fallback in `server/src/services/redis/redis.client.ts`), Jest + ts-jest. Test command: `npm test` (root script runs the **server** workspace only — `npm run test --workspace=server`).

**Spec:** `docs/superpowers/specs/2026-05-25-canonical-room-state-design.md`

---

## Six-Phase Roadmap (from spec §12)

This plan covers **Phase 1 only**. Each subsequent phase gets its own plan after its predecessor ships and is verified.

1. **Phase 1 — Foundation (THIS PLAN):** canonical doc + session FSM + shadow projection. Zero behavior change.
2. **Phase 2 — `applyTransition` chokepoint + route timers/host/disconnect through it** (closes C1, C2, C3).
3. **Phase 3 — Flip reads to canonical; demote Postgres to async projection; reconciler under lock** (closes M1, C4).
4. **Phase 4 — Server-side LiveKit eviction + webhook/sweep reconcile** (closes G1 physical).
5. **Phase 5 — Versioned-snapshot wire protocol + resync; fold tokens in; retire `match:assigned`/`lobby:token`** (closes dual-emit; touches client).
6. **Phase 6 — Timer registry keyed by `sessionId`** (closes M2).

**Spec drift note:** spec §6 omits the existing `SessionStatus.CANCELLED`. This plan includes it in the FSM (cancel-from-any-non-terminal → terminal). Update spec §6 to match when convenient.

---

## File Structure (Phase 1)

- **Create** `server/src/services/orchestration/state/session-fsm.ts` — session-status legal-transition table + `canTransitionSession` / `isIdempotentSessionTransition`. Pure, no I/O.
- **Create** `server/src/services/orchestration/state/canonical-state.ts` — canonical types (`ParticipantLocation`, `ConnState`, `CanonicalParticipant`, `CanonicalSessionState`) + Redis `readCanonical` / `writeCanonical` (namespace `rsn:canonical:`).
- **Create** `server/src/services/orchestration/state/canonical-projection.ts` — `projectActiveSessionToCanonical(activeSession, prevSeq)` mapping the four stores → `location` + `connState`.
- **Modify** `server/src/services/orchestration/state/session-state.ts` — fire a best-effort shadow write from `persistSessionState`.
- **Test** `server/src/__tests__/services/orchestration/session-fsm.test.ts`
- **Test** `server/src/__tests__/services/orchestration/canonical-state.test.ts`
- **Test** `server/src/__tests__/services/orchestration/canonical-projection.test.ts`
- **Test** `server/src/__tests__/services/orchestration/canonical-shadow-write.test.ts`

All test import paths from `server/src/__tests__/services/orchestration/` to source use `../../../services/...`.

---

## Task 1: Session-status FSM

**Files:**
- Create: `server/src/services/orchestration/state/session-fsm.ts`
- Test: `server/src/__tests__/services/orchestration/session-fsm.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/services/orchestration/session-fsm.test.ts
import { SessionStatus } from '@rsn/shared';
import {
  SESSION_LEGAL_TRANSITIONS,
  canTransitionSession,
  isIdempotentSessionTransition,
} from '../../../services/orchestration/state/session-fsm';

describe('session-status FSM', () => {
  it('transition table is exhaustive over SessionStatus', () => {
    for (const status of Object.values(SessionStatus)) {
      expect(SESSION_LEGAL_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the happy-path lifecycle transitions', () => {
    expect(canTransitionSession(SessionStatus.SCHEDULED, SessionStatus.LOBBY_OPEN)).toBe(true);
    expect(canTransitionSession(SessionStatus.LOBBY_OPEN, SessionStatus.ROUND_ACTIVE)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_RATING)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_RATING, SessionStatus.ROUND_TRANSITION)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_TRANSITION, SessionStatus.ROUND_ACTIVE)).toBe(true);
    expect(canTransitionSession(SessionStatus.CLOSING_LOBBY, SessionStatus.COMPLETED)).toBe(true);
  });

  it('rejects the C1/C2 double-fire transition (RATING is not reachable from RATING via endRound)', () => {
    // endRound = ROUND_ACTIVE -> ROUND_RATING. A duplicate fire when already
    // in ROUND_RATING must be rejected (not legal), so the caller no-ops.
    expect(canTransitionSession(SessionStatus.ROUND_RATING, SessionStatus.ROUND_RATING)).toBe(false);
    expect(canTransitionSession(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_ACTIVE)).toBe(false);
  });

  it('flags a self-transition as idempotent', () => {
    expect(isIdempotentSessionTransition(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_ACTIVE)).toBe(true);
    expect(isIdempotentSessionTransition(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_RATING)).toBe(false);
  });

  it('allows CANCELLED from any non-terminal state and treats it as terminal', () => {
    expect(canTransitionSession(SessionStatus.LOBBY_OPEN, SessionStatus.CANCELLED)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_ACTIVE, SessionStatus.CANCELLED)).toBe(true);
    expect(SESSION_LEGAL_TRANSITIONS[SessionStatus.CANCELLED]).toEqual([]);
    expect(SESSION_LEGAL_TRANSITIONS[SessionStatus.COMPLETED]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/__tests__/services/orchestration/session-fsm.test.ts`
Expected: FAIL — `Cannot find module '../../../services/orchestration/state/session-fsm'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/services/orchestration/state/session-fsm.ts
// ─── Session-Status FSM ──────────────────────────────────────────────────────
// Canonical-room-state Phase 1. The session lifecycle had no transition guard
// (status was assigned, never validated — audit C2). This table is the seam
// applyTransition (Phase 2) validates against, so a duplicate timer fire after
// a host already advanced the round becomes a no-op (audit C1).

import { SessionStatus } from '@rsn/shared';

export const SESSION_LEGAL_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  [SessionStatus.SCHEDULED]:        [SessionStatus.LOBBY_OPEN, SessionStatus.CANCELLED],
  [SessionStatus.LOBBY_OPEN]:       [SessionStatus.ROUND_ACTIVE, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.ROUND_ACTIVE]:     [SessionStatus.ROUND_RATING, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.ROUND_RATING]:     [SessionStatus.ROUND_TRANSITION, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.ROUND_TRANSITION]: [SessionStatus.ROUND_ACTIVE, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.CLOSING_LOBBY]:    [SessionStatus.COMPLETED, SessionStatus.CANCELLED],
  [SessionStatus.COMPLETED]:        [],
  [SessionStatus.CANCELLED]:        [],
};

/** True when `to` is a legal next status from `from`. Self-transitions are NOT
 *  legal (use isIdempotentSessionTransition to no-op those at the call site). */
export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return (SESSION_LEGAL_TRANSITIONS[from] || []).includes(to);
}

/** True when the requested transition is a self-transition (no-op). */
export function isIdempotentSessionTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/__tests__/services/orchestration/session-fsm.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/state/session-fsm.ts server/src/__tests__/services/orchestration/session-fsm.test.ts
git commit -m "feat(state): add session-status FSM (canonical room-state phase 1)"
```

---

## Task 2: Canonical types + Redis read/write

**Files:**
- Create: `server/src/services/orchestration/state/canonical-state.ts`
- Test: `server/src/__tests__/services/orchestration/canonical-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/services/orchestration/canonical-state.test.ts
import { SessionStatus } from '@rsn/shared';

// Mock the redis client module so we control availability + capture writes.
const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
let redisHandle: any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => redisHandle,
}));

import {
  canonicalKey,
  readCanonical,
  writeCanonical,
  CanonicalSessionState,
} from '../../../services/orchestration/state/canonical-state';

const sample: CanonicalSessionState = {
  sessionId: 's1',
  status: SessionStatus.LOBBY_OPEN,
  currentRound: 0,
  seq: 1,
  hostUserId: 'host1',
  timer: null,
  participants: {
    u1: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1000, userSeq: 1 },
  },
};

beforeEach(() => { store.clear(); redisHandle = fakeRedis; jest.clearAllMocks(); });

describe('canonical-state', () => {
  it('uses the rsn:canonical: namespace (distinct from rsn:session:)', () => {
    expect(canonicalKey('s1')).toBe('rsn:canonical:s1');
  });

  it('round-trips a state document through Redis', async () => {
    await writeCanonical(sample);
    expect(fakeRedis.setex).toHaveBeenCalledWith('rsn:canonical:s1', 14400, expect.any(String));
    const read = await readCanonical('s1');
    expect(read).toEqual(sample);
  });

  it('readCanonical returns null when the key is missing', async () => {
    expect(await readCanonical('missing')).toBeNull();
  });

  it('no-ops gracefully when Redis is unavailable', async () => {
    redisHandle = null;
    await expect(writeCanonical(sample)).resolves.toBeUndefined();
    expect(await readCanonical('s1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-state.test.ts`
Expected: FAIL — `Cannot find module '../../../services/orchestration/state/canonical-state'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/services/orchestration/state/canonical-state.ts
// ─── Canonical Session State ─────────────────────────────────────────────────
// Canonical-room-state Phase 1. ONE authoritative document per session, in
// Redis. `location` is single-valued so dual-room is unrepresentable; `seq` is
// a monotonic version so clients can discard stale snapshots. Phase 1 only
// WRITES this doc (shadow); reads stay on the existing code until Phase 3.
//
// Namespace note: the existing write-through blob lives at `rsn:session:{id}`
// and restoreAllFromRedis globs `rsn:session:*`. This doc MUST use a separate
// namespace (`rsn:canonical:`) or that glob would mis-parse it.

import { SessionStatus } from '@rsn/shared';
import logger from '../../../config/logger';
import { getRedisClient } from '../../redis/redis.client';

export type ParticipantLocation =
  | { type: 'main' }
  | { type: 'breakout'; roomId: string; matchId: string };

export type ConnState = 'connected' | 'disconnected' | 'left' | 'removed' | 'no_show';

export interface CanonicalParticipant {
  role: 'host' | 'cohost' | 'participant';
  connState: ConnState;
  location: ParticipantLocation;
  lastSeenAt: number; // epoch ms
  userSeq: number;
}

export interface CanonicalSessionState {
  sessionId: string;
  status: SessionStatus;
  currentRound: number;
  seq: number; // monotonic; bumped on every mutation
  hostUserId: string;
  timer: { kind: string; endsAt: number } | null;
  participants: Record<string, CanonicalParticipant>;
}

const CANONICAL_PREFIX = 'rsn:canonical:';
const CANONICAL_TTL = 14400; // 4h — matches existing session TTL

export function canonicalKey(sessionId: string): string {
  return `${CANONICAL_PREFIX}${sessionId}`;
}

/** Read the canonical doc. Returns null if Redis is unavailable or key absent. */
export async function readCanonical(sessionId: string): Promise<CanonicalSessionState | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(canonicalKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as CanonicalSessionState;
  } catch (err) {
    logger.warn({ err, sessionId }, 'readCanonical failed');
    return null;
  }
}

/** Write the canonical doc with TTL. No-op when Redis is unavailable. */
export async function writeCanonical(state: CanonicalSessionState): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.setex(canonicalKey(state.sessionId), CANONICAL_TTL, JSON.stringify(state));
  } catch (err) {
    logger.warn({ err, sessionId: state.sessionId }, 'writeCanonical failed');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/state/canonical-state.ts server/src/__tests__/services/orchestration/canonical-state.test.ts
git commit -m "feat(state): canonical session-state types + Redis read/write (phase 1)"
```

---

## Task 3: Projection from ActiveSession → canonical doc

**Files:**
- Create: `server/src/services/orchestration/state/canonical-projection.ts`
- Test: `server/src/__tests__/services/orchestration/canonical-projection.test.ts`

This is the heart of Phase 1: derive the orthogonal `location` + `connState` model from today's four stores.

Mapping rules:
- **location:** if the user is in `roomParticipants` → `{ type:'breakout', roomId, matchId }`; else `{ type:'main' }`.
- **connState:** if the user is in `presenceMap` → `'connected'`; else derive from `participantStates[uid].state`: `disconnected`→`'disconnected'`, `left`→`'left'`, `removed`→`'removed'`, `no_show`→`'no_show'`, anything else (present-less but non-terminal) → `'disconnected'`.
- **role:** `'host'` if `uid === hostUserId`, else `'participant'`. (Cohost enrichment needs host-view data not on `ActiveSession`; deferred to a later phase — documented.)
- **participant set:** union of keys across `participantStates`, `presenceMap`, `roomParticipants`, plus `hostUserId`.
- **seq:** `prevSeq + 1`.
- **timer:** `{ kind: status, endsAt: timerEndsAt.getTime() }` if `timerEndsAt` set, else `null`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/services/orchestration/canonical-projection.test.ts
import { SessionStatus } from '@rsn/shared';
import { projectActiveSessionToCanonical } from '../../../services/orchestration/state/canonical-projection';
import type { ActiveSession } from '../../../services/orchestration/state/session-state';

function baseSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: 's1',
    hostUserId: 'host1',
    config: {} as any,
    currentRound: 2,
    status: SessionStatus.ROUND_ACTIVE,
    timer: null,
    timerSyncInterval: null,
    timerEndsAt: new Date(1_700_000_000_000),
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map(),
    pendingRoundNumber: null,
    manuallyLeftRound: new Set(),
    ...overrides,
  } as ActiveSession;
}

describe('projectActiveSessionToCanonical', () => {
  it('places a room-participant in a breakout and a present-only user in main', () => {
    const s = baseSession({
      presenceMap: new Map([
        ['u1', { lastHeartbeat: new Date(), socketId: 'a' }],
        ['u2', { lastHeartbeat: new Date(), socketId: 'b' }],
      ]),
      roomParticipants: new Map([
        ['u1', { matchId: 'm1', roomId: 'match-s1-r2-abc', joinedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 5);
    expect(doc.participants.u1.location).toEqual({ type: 'breakout', roomId: 'match-s1-r2-abc', matchId: 'm1' });
    expect(doc.participants.u1.connState).toBe('connected');
    expect(doc.participants.u2.location).toEqual({ type: 'main' });
    expect(doc.participants.u2.connState).toBe('connected');
  });

  it('preserves breakout location for a disconnected user (location independent of presence)', () => {
    const s = baseSession({
      presenceMap: new Map(), // u1 NOT present
      roomParticipants: new Map([
        ['u1', { matchId: 'm1', roomId: 'match-s1-r2-abc', joinedAt: new Date() }],
      ]),
      participantStates: new Map([
        ['u1', { state: 'disconnected', currentRoomId: 'match-s1-r2-abc', updatedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 0);
    expect(doc.participants.u1.location).toEqual({ type: 'breakout', roomId: 'match-s1-r2-abc', matchId: 'm1' });
    expect(doc.participants.u1.connState).toBe('disconnected');
  });

  it('maps terminal participant states to connState and host role', () => {
    const s = baseSession({
      participantStates: new Map([
        ['u3', { state: 'left', currentRoomId: null, updatedAt: new Date() }],
        ['u4', { state: 'no_show', currentRoomId: null, updatedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 9);
    expect(doc.participants.u3.connState).toBe('left');
    expect(doc.participants.u4.connState).toBe('no_show');
    expect(doc.participants.host1.role).toBe('host');
    expect(doc.participants.host1.location).toEqual({ type: 'main' });
  });

  it('stamps seq = prevSeq + 1, status, currentRound and timer.endsAt', () => {
    const doc = projectActiveSessionToCanonical(baseSession(), 41);
    expect(doc.seq).toBe(42);
    expect(doc.status).toBe(SessionStatus.ROUND_ACTIVE);
    expect(doc.currentRound).toBe(2);
    expect(doc.timer).toEqual({ kind: SessionStatus.ROUND_ACTIVE, endsAt: 1_700_000_000_000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-projection.test.ts`
Expected: FAIL — `Cannot find module '../../../services/orchestration/state/canonical-projection'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/services/orchestration/state/canonical-projection.ts
// ─── Canonical Projection ────────────────────────────────────────────────────
// Canonical-room-state Phase 1 (shadow). Derives the orthogonal location +
// connState model from today's four stores so the canonical doc is populated
// and can be validated against reality before any read path is switched.

import type { ActiveSession } from './session-state';
import type {
  CanonicalSessionState,
  CanonicalParticipant,
  ParticipantLocation,
  ConnState,
} from './canonical-state';

function connStateFor(
  uid: string,
  presenceMap: ActiveSession['presenceMap'],
  participantStates: ActiveSession['participantStates'],
): ConnState {
  if (presenceMap.has(uid)) return 'connected';
  const dbState = participantStates?.get(uid)?.state;
  switch (dbState) {
    case 'left':     return 'left';
    case 'removed':  return 'removed';
    case 'no_show':  return 'no_show';
    default:         return 'disconnected';
  }
}

function locationFor(
  uid: string,
  roomParticipants: ActiveSession['roomParticipants'],
): ParticipantLocation {
  const room = roomParticipants?.get(uid);
  if (room) return { type: 'breakout', roomId: room.roomId, matchId: room.matchId };
  return { type: 'main' };
}

/** Project the live ActiveSession into a canonical document. Pure function. */
export function projectActiveSessionToCanonical(
  s: ActiveSession,
  prevSeq: number,
): CanonicalSessionState {
  const ids = new Set<string>();
  s.participantStates?.forEach((_v, k) => ids.add(k));
  s.presenceMap.forEach((_v, k) => ids.add(k));
  s.roomParticipants?.forEach((_v, k) => ids.add(k));
  ids.add(s.hostUserId);

  const participants: Record<string, CanonicalParticipant> = {};
  for (const uid of ids) {
    participants[uid] = {
      role: uid === s.hostUserId ? 'host' : 'participant',
      connState: connStateFor(uid, s.presenceMap, s.participantStates),
      location: locationFor(uid, s.roomParticipants),
      lastSeenAt: s.presenceMap.get(uid)?.lastHeartbeat.getTime() ?? 0,
      userSeq: prevSeq + 1,
    };
  }

  return {
    sessionId: s.sessionId,
    status: s.status,
    currentRound: s.currentRound,
    seq: prevSeq + 1,
    hostUserId: s.hostUserId,
    timer: s.timerEndsAt ? { kind: s.status, endsAt: s.timerEndsAt.getTime() } : null,
    participants,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-projection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/state/canonical-projection.ts server/src/__tests__/services/orchestration/canonical-projection.test.ts
git commit -m "feat(state): project ActiveSession -> canonical location/connState model (phase 1)"
```

---

## Task 4: Fire the shadow write from persistSessionState

**Files:**
- Create: `server/src/services/orchestration/state/canonical-shadow.ts` (small, testable wrapper)
- Modify: `server/src/services/orchestration/state/session-state.ts` (call the wrapper from `persistSessionState`, line ~143 alongside the existing `persistToRedis`)
- Test: `server/src/__tests__/services/orchestration/canonical-shadow-write.test.ts`

The wrapper reads the previous canonical `seq`, projects, and writes — all best-effort. Extracting it keeps `session-state.ts` untouched except one added call, and makes the behavior unit-testable.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/services/orchestration/canonical-shadow-write.test.ts
import { SessionStatus } from '@rsn/shared';

const reads: string[] = [];
const writes: any[] = [];
jest.mock('../../../services/orchestration/state/canonical-state', () => ({
  readCanonical: jest.fn(async (id: string) => { reads.push(id); return { seq: 7 }; }),
  writeCanonical: jest.fn(async (state: any) => { writes.push(state); }),
}));

import { shadowWriteCanonical } from '../../../services/orchestration/state/canonical-shadow';
import type { ActiveSession } from '../../../services/orchestration/state/session-state';

function session(): ActiveSession {
  return {
    sessionId: 's1', hostUserId: 'h1', config: {} as any, currentRound: 1,
    status: SessionStatus.LOBBY_OPEN, timer: null, timerSyncInterval: null,
    timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map([['h1', { lastHeartbeat: new Date(), socketId: 'x' }]]),
    pendingRoundNumber: null, manuallyLeftRound: new Set(),
  } as ActiveSession;
}

beforeEach(() => { reads.length = 0; writes.length = 0; jest.clearAllMocks(); });

describe('shadowWriteCanonical', () => {
  it('bumps seq from the previous canonical doc and writes the projection', async () => {
    await shadowWriteCanonical(session());
    expect(reads).toEqual(['s1']);
    expect(writes).toHaveLength(1);
    expect(writes[0].seq).toBe(8); // prev 7 + 1
    expect(writes[0].sessionId).toBe('s1');
    expect(writes[0].participants.h1.role).toBe('host');
  });

  it('never throws (best-effort) even if projection inputs are minimal', async () => {
    await expect(shadowWriteCanonical(session())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-shadow-write.test.ts`
Expected: FAIL — `Cannot find module '../../../services/orchestration/state/canonical-shadow'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/services/orchestration/state/canonical-shadow.ts
// ─── Canonical Shadow Write ──────────────────────────────────────────────────
// Canonical-room-state Phase 1. Best-effort: read prev seq, project the live
// ActiveSession, write the canonical doc. Fired from persistSessionState. Never
// throws — it is purely additive and must not affect existing behavior.

import type { ActiveSession } from './session-state';
import { readCanonical, writeCanonical } from './canonical-state';
import { projectActiveSessionToCanonical } from './canonical-projection';
import logger from '../../../config/logger';

export async function shadowWriteCanonical(activeSession: ActiveSession): Promise<void> {
  try {
    const prev = await readCanonical(activeSession.sessionId);
    const doc = projectActiveSessionToCanonical(activeSession, prev?.seq ?? 0);
    await writeCanonical(doc);
  } catch (err) {
    logger.warn({ err, sessionId: activeSession.sessionId }, 'shadowWriteCanonical failed (non-fatal)');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-shadow-write.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the call into persistSessionState**

In `server/src/services/orchestration/state/session-state.ts`, add the import near the other state imports at the top of the file:

```typescript
import { shadowWriteCanonical } from './canonical-shadow';
```

Then in `persistSessionState`, immediately after the existing line `persistToRedis(sessionId, activeSession).catch(() => {});` (currently ~line 143), add:

```typescript
  // Canonical-room-state Phase 1 (shadow) — additive, non-blocking. Populates
  // rsn:canonical:{id} so the new model can be validated against reality before
  // any read path is switched (Phase 3).
  shadowWriteCanonical(activeSession).catch(() => {});
```

> Note: `canonical-shadow.ts` imports a type from `session-state.ts` and `session-state.ts` imports a function from `canonical-shadow.ts`. This is a value↔type cross-import; the type import in `canonical-shadow.ts` is `import type { ActiveSession }`, which is erased at compile time, so there is no runtime circular dependency.

- [ ] **Step 6: Run the targeted tests + typecheck**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-shadow-write.test.ts && npx tsc --noEmit`
Expected: tests PASS; `tsc --noEmit` reports no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/orchestration/state/canonical-shadow.ts server/src/services/orchestration/state/session-state.ts server/src/__tests__/services/orchestration/canonical-shadow-write.test.ts
git commit -m "feat(state): fire best-effort canonical shadow write from persistSessionState (phase 1)"
```

---

## Task 5: Architectural pin + full-suite regression gate

**Files:**
- Test: `server/src/__tests__/services/orchestration/canonical-phase1-spine.test.ts`

A source-text pin (matching the existing `phase1-state-machine-spine.test.ts` convention) that locks the Phase 1 surface, plus a full-suite run to confirm zero behavior change.

- [ ] **Step 1: Write the pin test**

```typescript
// server/src/__tests__/services/orchestration/canonical-phase1-spine.test.ts
import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

describe('Canonical room-state Phase 1 — spine', () => {
  it('canonical-state uses a namespace distinct from the rsn:session: blob', () => {
    const src = readServer('services/orchestration/state/canonical-state.ts');
    expect(src).toMatch(/rsn:canonical:/);
    expect(src).not.toMatch(/['"`]rsn:session:['"`]/);
  });

  it('session-fsm exports the transition table and guard', () => {
    const src = readServer('services/orchestration/state/session-fsm.ts');
    expect(src).toMatch(/export const SESSION_LEGAL_TRANSITIONS/);
    expect(src).toMatch(/export function canTransitionSession/);
  });

  it('persistSessionState fires the shadow write', () => {
    const src = readServer('services/orchestration/state/session-state.ts');
    expect(src).toMatch(/shadowWriteCanonical\(activeSession\)/);
  });
});
```

- [ ] **Step 2: Run the pin test**

Run: `cd server && npx jest src/__tests__/services/orchestration/canonical-phase1-spine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Run the FULL server suite (zero-behavior-change gate)**

Run: `npm test`
Expected: the entire existing suite is green. Phase 1 added only new files + one additive non-blocking call, so no existing test should change. If any existing test fails, STOP and investigate before committing — Phase 1's contract is *zero behavior change*.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/services/orchestration/canonical-phase1-spine.test.ts
git commit -m "test(state): pin canonical room-state phase 1 surface + full-suite gate"
```

---

## Self-Review (completed by plan author)

- **Spec coverage (Phase 1 scope):** spec §4 data model → Task 2 types; §4.1 location/connState split → Task 3 projection; §6 session FSM → Task 1; §12 step 1 "canonical doc + shadow, zero behavior change" → Tasks 2–5. Pillars 2–4 (chokepoint, eviction, snapshots) are explicitly out of Phase 1 scope (Phases 2/4/5).
- **Placeholder scan:** every code step contains complete, compilable code; no TBD/TODO.
- **Type consistency:** `CanonicalSessionState`, `CanonicalParticipant`, `ParticipantLocation`, `ConnState` are defined once in Task 2 and imported by Tasks 3–4. `projectActiveSessionToCanonical(s, prevSeq)`, `shadowWriteCanonical(activeSession)`, `readCanonical/writeCanonical`, `canonicalKey`, `SESSION_LEGAL_TRANSITIONS`, `canTransitionSession`, `isIdempotentSessionTransition` are referenced with consistent names/signatures across tasks.
- **Known simplifications (documented):** role projection is host/participant only (cohost enrichment deferred); `seq` is read-modify in shadow mode (atomic monotonic counter moves into `applyTransition` in Phase 2). Both are intentional and noted at their definitions.
