# Canonical Room-State — Phase 3 (Make Canonical Authoritative + Flip Participant-List Reads) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development. Steps use `- [ ]`.

**Goal:** Make the canonical Redis doc *authoritative* by having the existing state-mutation chokepoints write it on every change, fix the C4 reconciler race, and flip the **host participant view** to read location/connState from canonical — **with a fallback to today's derivation** so any canonical gap degrades to current behavior, never worse. Closes **M1** (memory↔DB drift: canonical becomes the live authority, written synchronously in the chokepoint) and **C4** (reconciler LEFT-races a reconnect).

**Scope deliberately bounded for a staging test:** this phase flips ONLY the host participant view's per-user state. The client snapshot flip and full Postgres demotion are a later sub-phase. Canonical writes are **additive** (the existing maps + DB are still written); only the host-view READ changes, and it falls back to the existing derivation.

**Ship target:** STAGING. Hand off to Ali to test on staging before promoting to main.

**Tech Stack:** TypeScript, Jest. `npm test` (server). Spec: §4, §4.1, §7 (C4), §10.

---

## File Structure (Phase 3)

- **Modify** `server/src/services/orchestration/state/canonical-state.ts` — add `updateCanonicalParticipant()` and `updateCanonicalSessionStatus()` (read-modify-write the doc under the assumption the caller holds the session guard; bump `seq`).
- **Modify** `server/src/services/orchestration/state/participant-state-machine.ts` — `transitionParticipant()` writes the participant's canonical location/connState after its DB write; `setPresence()` updates canonical connState/lastSeenAt; the C4 fix in `reconcileSessionStates()`.
- **Modify** `server/src/services/orchestration/handlers/round-lifecycle.ts` — the 4 lifecycle fns write canonical session status (one helper call each, next to the existing `activeSession.status = …`).
- **Modify** `server/src/services/orchestration/handlers/host-participants-view.ts` — prefer canonical location/connState when the doc exists; fallback to current derivation.
- **Test** `server/src/__tests__/services/orchestration/phase3-canonical-authority.test.ts`

---

## Task 1: Canonical mutators (`updateCanonicalParticipant`, `updateCanonicalSessionStatus`)

**Files:**
- Modify: `server/src/services/orchestration/state/canonical-state.ts`
- Test: `server/src/__tests__/services/orchestration/phase3-canonical-authority.test.ts`

These do a read-modify-write of the single canonical doc. Callers hold `withSessionGuard` (the transition chokepoint and lifecycle fns run under it), so the RMW is atomic per session. Best-effort: no-op if Redis down or doc absent (the Phase-1 shadow projection still backfills).

- [ ] **Step 1: Failing test**

```typescript
// server/src/__tests__/services/orchestration/phase3-canonical-authority.test.ts
import { SessionStatus } from '@rsn/shared';
const store = new Map<string,string>();
const fakeRedis = {
  get: jest.fn(async (k:string)=>store.get(k)??null),
  setex: jest.fn(async (k:string,_t:number,v:string)=>{store.set(k,v);return 'OK';}),
};
let handle:any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => handle }));
import { writeCanonical, readCanonical, updateCanonicalParticipant, updateCanonicalSessionStatus, CanonicalSessionState } from '../../../services/orchestration/state/canonical-state';

const base: CanonicalSessionState = { sessionId:'s3', status:SessionStatus.ROUND_ACTIVE, currentRound:1, seq:1, hostUserId:'h', timer:null, participants:{ u1:{role:'participant',connState:'connected',location:{type:'main'},lastSeenAt:1,userSeq:1} } };
beforeEach(()=>{ store.clear(); handle=fakeRedis; jest.clearAllMocks(); });

describe('Phase 3 — canonical mutators', () => {
  it('updateCanonicalParticipant patches one participant and bumps seq', async () => {
    await writeCanonical(base);
    await updateCanonicalParticipant('s3','u1',{ location:{type:'breakout',roomId:'r1',matchId:'m1'}, connState:'connected' });
    const doc = await readCanonical('s3');
    expect(doc!.participants.u1.location).toEqual({type:'breakout',roomId:'r1',matchId:'m1'});
    expect(doc!.seq).toBe(2);
  });
  it('updateCanonicalParticipant inserts a not-yet-present participant', async () => {
    await writeCanonical(base);
    await updateCanonicalParticipant('s3','u2',{ connState:'connected', location:{type:'main'}, role:'participant' });
    const doc = await readCanonical('s3');
    expect(doc!.participants.u2.connState).toBe('connected');
  });
  it('updateCanonicalSessionStatus sets status + bumps seq', async () => {
    await writeCanonical(base);
    await updateCanonicalSessionStatus('s3', SessionStatus.ROUND_RATING);
    expect((await readCanonical('s3'))!.status).toBe(SessionStatus.ROUND_RATING);
  });
  it('no-ops when the doc does not exist yet (shadow projection will create it)', async () => {
    await expect(updateCanonicalParticipant('nope','u1',{connState:'left'})).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL** (mutators undefined).

Run: `cd server && npx jest src/__tests__/services/orchestration/phase3-canonical-authority.test.ts -t "canonical mutators"`

- [ ] **Step 3: Implement** — append to `canonical-state.ts`:

```typescript
/**
 * Patch a single participant in the canonical doc and bump seq. Read-modify-
 * write of the one key; callers MUST hold withSessionGuard for the session
 * (the transition chokepoint does). Best-effort: no-op if Redis down or the
 * doc doesn't exist yet (the periodic shadow projection backfills it).
 */
export async function updateCanonicalParticipant(
  sessionId: string,
  userId: string,
  patch: Partial<CanonicalParticipant>,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const doc = await readCanonical(sessionId);
    if (!doc) return;
    const prev = doc.participants[userId] ?? {
      role: 'participant', connState: 'disconnected',
      location: { type: 'main' }, lastSeenAt: 0, userSeq: doc.seq,
    } as CanonicalParticipant;
    doc.participants[userId] = { ...prev, ...patch, userSeq: doc.seq + 1 };
    doc.seq += 1;
    await redis.setex(canonicalKey(sessionId), CANONICAL_TTL, JSON.stringify(doc));
  } catch (err) {
    logger.warn({ err, sessionId, userId }, 'updateCanonicalParticipant failed');
  }
}

/** Set the canonical session status and bump seq. Same guard/best-effort rules. */
export async function updateCanonicalSessionStatus(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const doc = await readCanonical(sessionId);
    if (!doc) return;
    doc.status = status;
    doc.seq += 1;
    await redis.setex(canonicalKey(sessionId), CANONICAL_TTL, JSON.stringify(doc));
  } catch (err) {
    logger.warn({ err, sessionId, status }, 'updateCanonicalSessionStatus failed');
  }
}
```

`CANONICAL_TTL` and `canonicalKey` already exist in this file; `CanonicalParticipant`, `SessionStatus`, `logger` already imported.

- [ ] **Step 4: Run — PASS (4).** **Step 5: Commit** `feat(state): canonical participant + session mutators (phase 3)`

---

## Task 2: Chokepoint writes canonical (authoritative participant state)

**Files:**
- Modify: `server/src/services/orchestration/state/participant-state-machine.ts` (`transitionParticipant` after its DB write ~line 278; `setPresence` ~line 294)
- Test: same Phase 3 file

Map the participant-state-machine state → canonical `location`/`connState` and write it. This is what makes canonical authoritative (driven by the real mutation, not the periodic projection).

Mapping (mirror Phase-1 projection): `IN_BREAKOUT` → `location {breakout, currentRoomId}`; any other live state → `location {main}`. connState: `DISCONNECTED`→`disconnected`, `LEFT`→`left`, `REMOVED`→`removed`, `NO_SHOW`→`no_show`, everything else → `connected`.

- [ ] **Step 1: Failing test** — drive `transitionParticipant` against a seeded `activeSession` + canonical doc, assert canonical reflects the new location/connState. (Set up `activeSessions.set(...)` with a `participantStates` map; mock redis as in Task 1; call `transitionParticipant('s3','u1',ParticipantState.IN_BREAKOUT,{currentRoomId:'r1'})`; expect canonical `u1.location.type==='breakout'`.) Include a case: `transitionParticipant(...,LEFT)` → canonical `connState==='left'`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `transitionParticipant`, after the `if (persistToDb) { … }` block and before `return { ok:true, … }`, add a best-effort canonical write:

```typescript
  // Phase 3 — canonical authoritative write. Mirror the state → location/
  // connState mapping. Best-effort; caller holds withSessionGuard.
  const canonConn =
    toState === ParticipantState.DISCONNECTED ? 'disconnected' :
    toState === ParticipantState.LEFT ? 'left' :
    toState === ParticipantState.REMOVED ? 'removed' :
    toState === ParticipantState.NO_SHOW ? 'no_show' : 'connected';
  const canonLoc: import('./canonical-state').ParticipantLocation =
    toState === ParticipantState.IN_BREAKOUT && currentRoomId
      ? { type: 'breakout', roomId: currentRoomId, matchId: '' }
      : { type: 'main' };
  void (await import('./canonical-state')).updateCanonicalParticipant(
    sessionId, userId, { connState: canonConn as any, location: canonLoc });
```

(The `matchId:''` is acceptable here — Phase-3 host-view keys on `location.type` + `roomId`; `setRoomAssignment` carries the real matchId into the doc via the shadow projection. A later sub-phase threads matchId through `TransitionOpts`.)

In `setPresence`, after the map mutation, when setting a presence record (not clearing), best-effort mark canonical `connState:'connected'` + `lastSeenAt`:

```typescript
  if (presence !== null) {
    void import('./canonical-state').then(m =>
      m.updateCanonicalParticipant(sessionId, userId,
        { connState: 'connected', lastSeenAt: presence.lastHeartbeat.getTime() }));
  }
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(state): transitionParticipant + setPresence write canonical (phase 3, M1)`

---

## Task 3: Lifecycle fns write canonical session status

**Files:** Modify `server/src/services/orchestration/handlers/round-lifecycle.ts`; same test file.

Next to each `activeSession.status = SessionStatus.X` assignment in `transitionToRound` (ROUND_ACTIVE), `endRound` (ROUND_RATING), `endRatingWindow` (ROUND_TRANSITION / CLOSING_LOBBY), `completeSession` (COMPLETED), add a best-effort canonical write.

- [ ] **Step 1: Failing test** — call `endRound` (seeded ROUND_ACTIVE session + canonical doc), assert canonical `status==='round_rating'`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** — add import `import { updateCanonicalSessionStatus } from '../state/canonical-state';` and after each status assignment:
```typescript
    void updateCanonicalSessionStatus(sessionId, SessionStatus.<NEW_STATUS>);
```
(4 call sites: lines ~233, ~522, ~730/~770, ~867.)
- [ ] **Step 4: PASS.** **Step 5: Commit** `feat(state): lifecycle transitions write canonical status (phase 3, M1)`

---

## Task 4: C4 — reconciler re-checks live state under guard before LEFT

**Files:** Modify `server/src/services/orchestration/state/participant-state-machine.ts` (`reconcileSessionStates` stale-escalation, ~lines 392-406); same test file.

Before escalating a stale-DISCONNECTED user to LEFT, re-read the **in-memory** state and presence and skip if they reconnected.

- [ ] **Step 1: Failing test** — seed a session where DB says `disconnected` >90s but the user is back in `presenceMap` (and in-memory state IN_MAIN_ROOM); run `reconcileSessionStates`; assert the user was NOT transitioned to LEFT (`staleEscalated===0`).
- [ ] **Step 2: FAIL** (today it LEFT-escalates off the stale SELECT).
- [ ] **Step 3: Implement** — inside the `for (const row of staleRows.rows)` loop, before `transitionParticipant(…, LEFT)`:
```typescript
      // C4 (Phase 3) — the stale SELECT is a snapshot; re-check live state
      // before escalating. If the user reconnected in the window (present in
      // presenceMap, or in-memory state already non-DISCONNECTED), skip —
      // escalating here would wrongly mark a present user as LEFT.
      const live = activeSession.participantStates?.get(row.user_id);
      if (activeSession.presenceMap.has(row.user_id) ||
          (live && live.state !== ParticipantState.DISCONNECTED)) {
        continue;
      }
```
- [ ] **Step 4: PASS.** **Step 5: Commit** `fix(state): reconciler re-checks live presence before LEFT-escalation (phase 3, C4)`

---

## Task 5: Flip host participant view to canonical (with fallback)

**Files:** Modify `server/src/services/orchestration/handlers/host-participants-view.ts` (`buildHostParticipantsView`, the state-derivation block ~lines 189-208); same test file.

Prefer the canonical doc when it exists; fall back to the existing presence/match/DB derivation otherwise.

- [ ] **Step 1: Failing test** — seed a canonical doc where `u1.location` is breakout and `u2.connState` is disconnected; call `buildHostParticipantsView`; assert `u1.state==='in_room'` and `u2.state==='disconnected'` **sourced from canonical** (e.g. set up so the legacy derivation would disagree, proving canonical wins). Add a fallback test: no canonical doc → behavior identical to today.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** — at the top of `buildHostParticipantsView`, load the doc once: `const canon = await readCanonical(opts.sessionId);` (import `readCanonical`). In the per-row `.map`, before the legacy `if (inMatch) …` block, prefer canonical:
```typescript
    const c = canon?.participants[r.user_id];
    let state: HostParticipantState;
    if (c) {
      // Phase 3 — canonical is authoritative when present.
      if (c.location.type === 'breakout') state = 'in_room';
      else if (c.connState === 'connected') state = 'in_main_room';
      else if (c.connState === 'left' || c.connState === 'removed' || c.connState === 'no_show') state = 'left';
      else state = 'disconnected';
    } else {
      // Fallback: existing presence/match/DB derivation (unchanged).
      const inMatch = userToMatch.get(r.user_id);
      const isPresent = opts.presenceMap.has(r.user_id);
      if (inMatch) state = 'in_room';
      else if (isPresent) state = 'in_main_room';
      else if (r.status === 'left' || r.status === 'no_show' || r.status === 'removed') state = 'left';
      else state = 'disconnected';
    }
```
(Remove the now-duplicated legacy `inMatch`/`isPresent`/`state` lines that this replaces; keep everything else — role derivation, fallback display name — intact.)

- [ ] **Step 4: PASS.** **Step 5: Commit** `feat(state): host participant view reads canonical with fallback (phase 3, M1)`

---

## Task 6: Full-suite gate + typecheck

- [ ] `npm test` — all green. The canonical writes are additive and the host-view read has a fallback, so existing tests (which run without Redis → `getRedisClient()` null → canonical absent → fallback path) must be UNCHANGED. If a host-view test changes, the fallback path isn't matching the old derivation exactly — reconcile.
- [ ] `cd server && npx tsc --noEmit` — clean.
- [ ] Commit any fixups.

---

## Self-Review

- **M1:** canonical written synchronously in the chokepoint (Task 2) + lifecycle (Task 3) → authoritative; host view reads it (Task 5). **C4:** Task 4. Scope bounded: only the host-view read flips; client snapshot + PG demotion deferred.
- **Safety:** all canonical writes best-effort/no-op without Redis; the host-view read falls back to today's exact derivation when canonical is absent — so CI (no Redis) exercises the fallback and must stay green, and a prod Redis blip degrades to current behavior, never worse.
- **Staging test focus for Ali:** run an event on staging; watch the host dashboard participant list through join → match → breakout → round end → rating → next round. States should track correctly (in main / in room / disconnected / left) with no dual-room and no stale entries.
