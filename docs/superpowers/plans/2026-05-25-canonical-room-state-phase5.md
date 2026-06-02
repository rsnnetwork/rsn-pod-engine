# Canonical Room-State — Phase 5 (Versioned Snapshot Foundation, scoped) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development (server side). Steps use `- [ ]`.

**Goal:** Add a **versioned `state:snapshot`** the server pushes (flag-gated, dark) and the client consumes **additively with a seq-guard** to harden the participant-list/state path. **No token-folding, no retirement** of `match:assigned`/`lobby:token` — those stay exactly as-is (deferred as too risky / low marginal value vs LiveKit presence). This is the safe foundation: clients gain a single authoritative, monotonically-versioned source they can't misorder.

**SAFETY:**
- Server emit is gated behind **`SNAPSHOT_EMIT_ENABLED` (default false)** → dark on main until enabled.
- Client handler is **purely additive** (new `state:snapshot` handler + new store field); existing handlers (`session:state`, `participant:joined/left`, LiveKit presence override) are untouched, so with the flag off the client receives no snapshots and behaves exactly as today.
- **No client test runner exists** → client changes are verified by `tsc`/build only; Ali validates in a browser with the flag on before trusting it.

**Ship target:** main, flag OFF (dark). Enable `SNAPSHOT_EMIT_ENABLED=true` to browser-test.

**Spec:** §8 (wire protocol) — minus token-folding/retirement.

---

## File Structure (Phase 5)

- **Modify** `server/src/config/index.ts` — `snapshotEmitEnabled: process.env.SNAPSHOT_EMIT_ENABLED === 'true'`.
- **Create** `server/src/services/orchestration/state/state-snapshot.ts` — `buildStateSnapshot(sessionId)` (from the canonical doc) + `emitStateSnapshot(io, sessionId)` (flag-gated) + `handleResync(io, socket, data)`.
- **Modify** `server/src/services/orchestration/handlers/matching-flow.ts` (`emitHostDashboard`, ~line 1177) — co-emit the snapshot (the function self-gates on the flag).
- **Modify** `server/src/services/orchestration/orchestration.service.ts` (~line 260) — register `session:resync` handler.
- **Modify** `client/src/stores/sessionStore.ts` — add `snapshotSeq` + `applyStateSnapshot()` (seq-guarded).
- **Modify** `client/src/hooks/useSessionSocket.ts` — add `'state:snapshot'` to `SOCKET_EVENTS` (line ~43) + a handler (~line 228).
- **Test** `server/src/__tests__/services/orchestration/phase5-state-snapshot.test.ts`

---

## Task 1: config flag + `buildStateSnapshot`

**Files:** `config/index.ts`, new `state/state-snapshot.ts`; test `phase5-state-snapshot.test.ts`.

`buildStateSnapshot` reads the canonical doc (Phase 3 authoritative) and projects a client-facing snapshot. Display names from `activeSession.displayNameCache` when available, else fall back to the canonical participant's role/userId (a later pass can enrich names; the foundation doesn't need perfect names).

- [ ] **Step 1: Failing test**

```typescript
// server/src/__tests__/services/orchestration/phase5-state-snapshot.test.ts
import { SessionStatus } from '@rsn/shared';
const store = new Map<string,string>();
const fakeRedis = { get: jest.fn(async (k:string)=>store.get(k)??null), setex: jest.fn(async (k:string,_t:number,v:string)=>{store.set(k,v);return 'OK';}) };
let handle:any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => handle }));
import { writeCanonical } from '../../../services/orchestration/state/canonical-state';
import { buildStateSnapshot } from '../../../services/orchestration/state/state-snapshot';
import { activeSessions } from '../../../services/orchestration/state/session-state';

beforeEach(()=>{ store.clear(); handle=fakeRedis; activeSessions.delete('s5'); });

describe('Phase 5 — buildStateSnapshot', () => {
  it('projects canonical participants into a versioned, client-facing snapshot', async () => {
    await writeCanonical({ sessionId:'s5', status:SessionStatus.ROUND_ACTIVE, currentRound:2, seq:7, hostUserId:'h',
      timer:null, participants:{
        u1:{role:'participant',connState:'connected',location:{type:'breakout',roomId:'r1',matchId:'m1'},lastSeenAt:1,userSeq:7},
        u2:{role:'participant',connState:'disconnected',location:{type:'main'},lastSeenAt:1,userSeq:7},
      }});
    const snap = await buildStateSnapshot('s5');
    expect(snap!.seq).toBe(7);
    expect(snap!.status).toBe(SessionStatus.ROUND_ACTIVE);
    const byId = Object.fromEntries(snap!.participants.map(p=>[p.userId,p]));
    expect(byId.u1.state).toBe('in_room');         // breakout
    expect(byId.u2.state).toBe('disconnected');    // not present
  });

  it('returns null when no canonical doc exists', async () => {
    expect(await buildStateSnapshot('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`config/index.ts` — add near other flags:
```typescript
  // Phase 5 — emit versioned state:snapshot to clients. Dark by default.
  snapshotEmitEnabled: process.env.SNAPSHOT_EMIT_ENABLED === 'true',
```

Create `server/src/services/orchestration/state/state-snapshot.ts`:
```typescript
// ─── Versioned State Snapshot (Phase 5) ──────────────────────────────────────
// Server-pushed, monotonically-versioned snapshot of a session's participant
// state, projected from the canonical doc. Additive + flag-gated; the client
// consumes it with a seq-guard. Does NOT carry video tokens (no token-folding).

import { Server as SocketServer, Socket } from 'socket.io';
import { config } from '../../../config';
import logger from '../../../config/logger';
import { sessionRoom, activeSessions } from './session-state';
import { readCanonical } from './canonical-state';

export interface StateSnapshotParticipant {
  userId: string;
  displayName: string;
  role: 'host' | 'cohost' | 'participant';
  connState: string;
  state: 'in_room' | 'in_main_room' | 'disconnected' | 'left';
}
export interface StateSnapshot {
  sessionId: string;
  seq: number;
  status: string;
  currentRound: number;
  participants: StateSnapshotParticipant[];
}

function deriveState(connState: string, locationType: string): StateSnapshotParticipant['state'] {
  if (locationType === 'breakout') return 'in_room';
  if (connState === 'connected') return 'in_main_room';
  if (connState === 'left' || connState === 'removed' || connState === 'no_show') return 'left';
  return 'disconnected';
}

export async function buildStateSnapshot(sessionId: string): Promise<StateSnapshot | null> {
  const doc = await readCanonical(sessionId);
  if (!doc) return null;
  const names = activeSessions.get(sessionId)?.displayNameCache;
  const participants: StateSnapshotParticipant[] = Object.entries(doc.participants).map(([userId, p]) => ({
    userId,
    displayName: names?.get(userId) || '',
    role: p.role,
    connState: p.connState,
    state: deriveState(p.connState, p.location.type),
  }));
  return { sessionId, seq: doc.seq, status: doc.status, currentRound: doc.currentRound, participants };
}

/** Flag-gated broadcast to the whole session room. No-op when disabled. */
export async function emitStateSnapshot(io: SocketServer, sessionId: string): Promise<void> {
  if (!config.snapshotEmitEnabled) return;
  try {
    const snap = await buildStateSnapshot(sessionId);
    if (snap) io.to(sessionRoom(sessionId)).emit('state:snapshot', snap);
  } catch (err) {
    logger.warn({ err, sessionId }, 'emitStateSnapshot failed');
  }
}

/** Resync: reply to the requesting socket with the current snapshot. */
export async function handleResync(_io: SocketServer, socket: Socket, data: { sessionId: string }): Promise<void> {
  if (!config.snapshotEmitEnabled || !data?.sessionId) return;
  try {
    const snap = await buildStateSnapshot(data.sessionId);
    if (snap) socket.emit('state:snapshot', snap);
  } catch (err) {
    logger.warn({ err, sessionId: data?.sessionId }, 'handleResync failed');
  }
}
```

- [ ] **Step 4: Run — PASS (2).** **Step 5: Commit** `feat(state): versioned state-snapshot builder + flag-gated emit (phase 5)`

---

## Task 2: co-emit from emitHostDashboard + register resync

**Files:** `matching-flow.ts` (`emitHostDashboard` ~1177), `orchestration.service.ts` (~260); same test file.

- [ ] **Step 1: Failing test** — pin that `emitHostDashboard` calls `emitStateSnapshot` (source-assertion, since `emitHostDashboard` has many DB deps), and that the resync handler is registered. Use a source-text check on both files:

```typescript
import * as fs from 'fs'; import * as path from 'path';
describe('Phase 5 — wiring', () => {
  it('emitHostDashboard co-emits the snapshot', () => {
    const src = fs.readFileSync(path.join(__dirname,'../../../services/orchestration/handlers/matching-flow.ts'),'utf8');
    expect(src).toMatch(/emitStateSnapshot\(io,\s*sessionId\)/);
  });
  it('session:resync is registered', () => {
    const src = fs.readFileSync(path.join(__dirname,'../../../services/orchestration/orchestration.service.ts'),'utf8');
    expect(src).toMatch(/session:resync/);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`matching-flow.ts` — import and call at the end of `emitHostDashboard` (the function self-gates, so this is a no-op when the flag is off):
```typescript
import { emitStateSnapshot } from '../state/state-snapshot';
// ... at the end of emitHostDashboard, after the dashboard emit:
  void emitStateSnapshot(io, sessionId);
```

`orchestration.service.ts` — register the resync handler near the other `wrapHandler(...)` participant calls (~line 260):
```typescript
import { handleResync } from './state/state-snapshot';
// inside the connection setup, with the other wrapHandler registrations:
    socket.on('session:resync', (data) => handleResync(io, socket, data));
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(state): co-emit snapshot from emitHostDashboard + session:resync handler (phase 5)`

---

## Task 3: full server suite + typecheck

- [ ] `npm test` — green (flag off → emit is a no-op; existing tests unchanged).
- [ ] `cd server && npx tsc --noEmit` — clean.
- [ ] Commit any fixups.

---

## Task 4: client — seq-guarded snapshot consumption (additive)

**Files:** `client/src/stores/sessionStore.ts`, `client/src/hooks/useSessionSocket.ts`. **No client test runner — verify by build/tsc only.**

- [ ] **Step 1: sessionStore — add seq + action.** In the `SessionLiveState` interface add:
```typescript
  snapshotSeq: number;
  applyStateSnapshot: (snap: { seq: number; participants: Array<{ userId: string; displayName?: string }> }) => void;
```
In the store creator, initial state `snapshotSeq: -1,` and the action:
```typescript
  applyStateSnapshot: (snap) => set((s) => {
    // Seq-guard: ignore stale/duplicate snapshots so out-of-order or replayed
    // pushes can never regress the list (the Phase-5 monotonic-version contract).
    if (!snap || typeof snap.seq !== 'number' || snap.seq <= s.snapshotSeq) return {};
    return {
      snapshotSeq: snap.seq,
      participants: snap.participants.map(p => ({ userId: p.userId, displayName: p.displayName })),
    };
  }),
```
> Note: the visible lobby tiles still come from the LiveKit-presence override (`useInRoomParticipants`); this updates the store-backed list (used where LiveKit isn't mounted) and establishes the seq-guarded channel. No behavior regression because the flag-off server never emits.

- [ ] **Step 2: useSessionSocket — register the handler.**
  - Add `'state:snapshot',` to the `SOCKET_EVENTS` array (~line 43) so cleanup is automatic.
  - Add the handler near the other participant handlers (~line 228):
```typescript
    socket.on('state:snapshot', (data: any) => {
      store.applyStateSnapshot(data);
    });
```

- [ ] **Step 3: Verify client builds.**

Run: `npm run build:client` (or `cd client && npx tsc --noEmit` if available)
Expected: compiles clean.

- [ ] **Step 4: Commit** `feat(client): consume versioned state:snapshot with seq-guard (phase 5, additive)`

---

## Activation (hand to Ali)

Set `SNAPSHOT_EMIT_ENABLED=true` in Render (and `render.yaml`), then browser-test a live event: the participant list should stay correct and converge; out-of-order pushes are ignored by the seq-guard. Leave OFF to ship dark.

## Self-Review

- **Scope:** versioned snapshot foundation only (server emit + client consume + seq-guard). NO token-folding, NO retirement of `match:assigned`/`lobby:token`. Matches Ali's "scoped + safe" choice.
- **Safety:** server emit flag-gated OFF; client handler additive (existing handlers + LiveKit override untouched); with flag off, zero behavior change. Server side is suite-tested; client verified by build (no client test runner) + Ali's browser test before enabling.
