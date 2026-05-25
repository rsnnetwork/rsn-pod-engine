# Canonical Room-State Design — Pin-Perfect Participant Lists for Main Room & Breakouts

- **Date:** 2026-05-25
- **Status:** Design — awaiting implementation plan
- **Scope decisions (confirmed):** Hybrid source of truth (server commands, LiveKit reconciles) · Redis-authoritative now · Rock-solid at current scale first, multi-instance by configuration later · Locks layered (in-process guard + Postgres `FOR UPDATE`)

---

## 1. Problem

A state-management audit of the live-event orchestration layer found that participant location and presence are tracked across **four parallel stores** — `presenceMap`, `roomParticipants`, `participantStates` (all in-process on `ActiveSession`) and the Postgres `session_participants.status` projection — mutated from many call sites. They drift and race. Concrete findings:

| ID | Finding | Root cause |
|----|---------|-----------|
| C1 | Timer-fired lifecycle transitions bypass the session guard → double `endRound`/`transitionToRound` | `orchestration.service.ts:120-123` wires timer callbacks raw; `round-lifecycle.ts` has zero `withSessionGuard` |
| C2 | No session-status FSM — status is assigned, never validated | `transitionToRound:208`, `endRound:499` guard only `!activeSession` |
| C3 | Disconnect-timeout match-terminal/reassign logic runs unguarded | `participant-flow.ts:1573` raw `setTimeout` mutates matches outside any lock |
| C4 | Reconciler can mark a just-reconnected user as LEFT | `participant-state-machine.ts:377-394` acts on a stale SELECT; memory makes the transition legal |
| G1 | Participant physically in main room **and** a breakout room | Server never force-evicts; room handoff is client-driven (`moveParticipant` exists at `video.service.ts:95` but is never called) |
| M1 | Memory↔DB drift, healed only every 30s | `transitionParticipant` writes memory then DB non-atomically (`participant-state-machine.ts:172-175`) |
| M2 | Timer fires against a stale `ActiveSession` reference | `timer-manager.ts:68` captures the object; sync interval re-fetches — inconsistent |

The goal is not to patch each race but to choose a model in which **these bug classes are unrepresentable**.

## 2. Goals / Non-goals

**Goals**
- A single canonical source of truth for every participant's **location** and **presence**, per session.
- Pin-perfect participant lists in the main room and in each breakout room: clients always converge to the authoritative current state, including across refresh/reconnect.
- "One user = one location" enforced **structurally**, not by runtime guard.
- All state transitions — host, timer, disconnect, reconciler — serialized through one path.
- A foundation that scales to multiple app instances by configuration, not rewrite.

**Non-goals (deferred)**
- Multi-instance deployment itself (the design must *allow* it; we validate single-instance first).
- Delta-compressed wire protocol (full scoped snapshots are fine at current scale).
- Replacing the matching engine, rating, or recap subsystems — only their *state surface* changes.
- Event-sourced/replayable log (rejected as overkill for current needs).

## 3. Architecture — four pillars

**Pillar 1 — One canonical state, in Redis, with a monotonic version.**
Per session, a single authoritative document (§4). `location` is a single field ⇒ dual-room is unrepresentable. `seq` is a monotonic counter bumped on every mutation. Postgres is demoted to an async downstream projection (recap/analytics/REST); it is read on **no** realtime path, so M1 disappears.

**Pillar 2 — One locked transition chokepoint.**
`applyTransition(sessionId, intent)` is the only mutator, inside a per-session critical section. Timer-fired transitions, host actions, disconnect handlers, and the reconciler all go through it — closing C1/C2/C3/C4.

**Pillar 3 — Server commands LiveKit, then verifies it (hybrid).**
Every location change calls `videoService.moveParticipant(user, oldRoom, newRoom)` (severs old-room presence server-side — closes G1). A reconciliation loop ingests LiveKit webhooks and periodically sweeps `listParticipants`; any divergence between physical reality and the canonical `location` is healed. LiveKit is the truth-check, Redis is the authority.

**Pillar 4 — Versioned authoritative snapshots.**
Clients never merge fragments. They render whatever snapshot carries the highest `seq` they have seen and discard the rest. Duplicate emits, out-of-order delivery, and refresh-replay become no-ops.

## 4. Data model

```
Key:  rsn:session:{sessionId}:state      (JSON, TTL 4h refreshed on write)

{
  sessionId,
  status:        SessionStatus,           // session FSM state (§6)
  currentRound:  number,
  seq:           number,                  // monotonic; bumped on EVERY mutation
  hostUserId:    string,
  timer:         { kind, endsAt } | null, // authoritative; clients compute countdown from endsAt
  participants: {
    [userId]: {
      role:       'host' | 'cohost' | 'participant',
      connState:  'connected' | 'disconnected' | 'left' | 'removed' | 'no_show',
      location:   { type: 'main' }
                | { type: 'breakout', roomId, matchId },
      lastSeenAt: epochMs,
      userSeq:    number                  // per-user version (participant FSM)
    }
  }
}
```

### 4.1 The load-bearing idea — split *location* from *presence*

Today `ParticipantState` is one enum conflating three axes (lifecycle, presence, location), so a breakout-assigned user who disconnects forces a lossy choice (`IN_BREAKOUT` *or* `DISCONNECTED`). The new model makes them orthogonal:

- **`location`** — exactly one value; *where the server has placed you*. Single-valued ⇒ dual-room unrepresentable (structural fix for G1).
- **`connState`** — *are you online*; changes on connect/disconnect/leave **without touching `location`**.

A disconnect flips `connState` only; `location` (e.g. breakout room 3) is preserved. On reconnect the server reads the single canonical `location` and issues **exactly one** token for it — no path can hand out both a lobby and a breakout token (the reconnect dual-room).

Host view becomes pure derivation:
```
location.breakout                      → "in room {roomId}"  (dimmed if connState=disconnected)
location.main & connState=connected    → "in main room"
connState=disconnected                 → "disconnected"      (last location greyed)
connState in {left,removed,no_show}    → "Left" tab
```

## 5. Lock layering & the commit point

`applyTransition` is the only mutator. Critical section:

```
withSessionGuard(sessionId)            // in-process mutex — fast path, same-instance
  └─ withSessionLock(sessionId)        // Postgres FOR UPDATE — cross-instance backstop
       ├─ read canonical doc from Redis
       ├─ validate intent against the FSM (reject illegal / no-op idempotent)
       ├─ mutate doc, bump seq
       └─ WRITE Redis        ← THE COMMIT POINT
  (release both locks)
then, OUTSIDE the locks:
  ├─ command LiveKit  (moveParticipant / closeRoom)   — best-effort, reconciled
  ├─ enqueue Postgres projection                       — async, batched
  └─ broadcast authoritative snapshot (with new seq)
```

- **Redis write is the commit point.** LiveKit and Postgres are downstream effects.
- Locks are **not** held across the LiveKit network call (avoids tying up a DB connection on external I/O and avoids a slow LiveKit call stalling the session). A failed/out-of-order LiveKit command is healed by the reconciliation loop because Redis is authority.
- Each LiveKit command is tagged with the `seq` it was computed at; a superseded command is skipped. Only matters at multi-instance — at current scale the in-process guard already serializes issuance.
- Both lock primitives already exist (`withSessionGuard` in `session-state.ts:102`, `withSessionLock` in `db/index.ts:109`); no new lock dependency is introduced.

## 6. Session-status FSM (fixes C2)

A legal-transition table; every transition (host / timer / disconnect / reconciler) goes through `applyTransition`.

```
SCHEDULED        → LOBBY_OPEN
LOBBY_OPEN       → ROUND_ACTIVE | CLOSING_LOBBY
ROUND_ACTIVE     → ROUND_RATING | CLOSING_LOBBY
ROUND_RATING     → ROUND_TRANSITION | CLOSING_LOBBY
ROUND_TRANSITION → ROUND_ACTIVE | CLOSING_LOBBY
CLOSING_LOBBY    → COMPLETED
COMPLETED        → (terminal)
```

Each intent carries its precondition. `endRound(n)` = "`ROUND_ACTIVE(n)` → `ROUND_RATING(n)`". A duplicate timer firing after the host already ended the round finds status already `ROUND_RATING`; the precondition fails → **no-op**. This is what makes the C1 double-fire harmless: the second invocation cannot re-emit, re-arm the rating timer, or re-generate matches. Idempotent self-transitions are allowed and logged.

## 7. Participant FSM — two small machines

**connState** (presence/lifecycle):
```
connected    ⇄ disconnected
disconnected → connected | left | removed | no_show
connected    → left | removed
(left/removed terminal; no_show → connected on late arrival)
```
A disconnect/heartbeat-stale event touches **only** `connState`. The reconciler's stale escalation (C4 fix) re-reads `connState` from Redis under the lock immediately before escalating to `left`; a user who reconnected in the race window is now `connected` and the FSM rejects the escalation.

**location** (placement) — changed **only** by session-FSM transitions, never by a presence event:
```
round start  (transitionToRound):  matched users  main → breakout(roomId); byes stay main
round end    (endRatingWindow):    all            breakout → main
host pull-back:                    one user        breakout → main
host manual breakout:              users           main → breakout
```
Every location change issues exactly one `moveParticipant` and one rebroadcast.

`lastSeenAt` is fed by both the socket heartbeat and LiveKit webhooks; `connState` flips to `disconnected` only when both are absent past the grace window. LiveKit physical presence is the stronger signal, replacing today's heartbeat-staleness guessing.

## 8. Wire protocol

**`state:snapshot`** — scoped per recipient; sent on join, reconnect, and after every mutation:
```
{ seq, status, currentRound, timer:{endsAt},
  you:    { location, connState, role, token? },   // token for YOUR current location
  roster: [ {userId, displayName, role, connState, derivedState} ] }
```
Scoping: main-room client → main roster; breakout client → their 2–3-person breakout roster; host/cohost → full derived view. At current scale, on any mutation the server re-emits the main snapshot to all main clients, each breakout's snapshot to its occupants, and the host snapshot to the host.

**Per-client `seq` guard.** Client stores `lastAppliedSeq`; ignores any snapshot with `seq ≤ lastAppliedSeq`. Antidote to the dual-emit / stale-view class.

**Reconnect = full resync.** On reconnect the client sends `session:resync {sessionId, haveSeq}`; server replies with the current authoritative snapshot; client replaces its view wholesale. No delta replay; always converges to *now*.

**Token folds into the snapshot.** This retires the separate `match:assigned` / `lobby:token` events (where the dual-token race lives). `you.token` carries the single token for the client's *current canonical location*. The client reacts to a location change by disconnecting its current LiveKit room and connecting with the new token. The server has already force-evicted from the old room, so even a lagging client converges. **Touches the client contract** (`VideoRoom.tsx`, `Lobby.tsx`, the session socket hook).

**Timer.** `timer.endsAt` is in the snapshot; the existing ~2s `timer:sync` may remain but is stamped with `seq` so it cannot resurrect a stale segment.

## 9. Reconciliation loop (Pillar 3 detail)

- **LiveKit webhooks (push):**
  - `participant_joined(room, user)` — if `room` ≠ canonical `location` → evict (`moveParticipant` to canonical). If it matches → update `lastSeenAt`, `connState=connected`.
  - `participant_left(room, user)` — if it is the canonical room and not a server-initiated move → flip `connState=disconnected`, start grace.
  - `room_finished` — cleanup.
- **Periodic sweep (~15s):** for each active room, `listParticipants(room)` vs canonical roster; heal diffs (catches missed webhooks).
- All heals go through `applyTransition` so they are serialized and versioned like any other mutation.

## 10. Issue → fix mapping

| Finding | Eliminated by |
|---|---|
| C1 timer bypasses guard | All transitions route through locked `applyTransition` (Pillar 2) |
| C2 no session FSM | Session-status FSM with preconditions (§6); double-fire → no-op |
| C3 disconnect-timeout unguarded | Timeout fires an intent through `applyTransition` (locked) |
| C4 reconciler wrongful LEFT | Escalation re-reads `connState` from Redis under lock; reconnected user rejected by FSM |
| G1 dual-room (physical) | `location` single-valued + `moveParticipant` force-evict + webhook reconcile |
| G1 dual-room (reconnect) | `location` preserved across disconnect; reconnect issues exactly one token |
| M1 memory↔DB drift | Redis sole realtime authority; Postgres async projection |
| M2 timer stale reference | Timers keyed by `sessionId` in a registry; on fire, re-read Redis + transition via chokepoint |
| dual-emit / stale client | Versioned snapshots; client ignores `seq ≤ applied` |

## 11. Components & boundaries

- **`canonical-state.ts`** — Redis read/write of the session doc; `seq` bump; TTL. Pure storage seam (swap target for sharding later). No business logic.
- **`session-fsm.ts`** — session-status legal-transition table + validation.
- **`participant-fsm.ts`** — `connState` and `location` transition rules (evolves the existing `participant-state-machine.ts`).
- **`apply-transition.ts`** — the chokepoint: lock → read → validate → write → (post-lock) LiveKit command + projection enqueue + broadcast.
- **`livekit-reconcile.ts`** — webhook ingest + periodic sweep, emitting heal intents.
- **`snapshot.ts`** — builds per-recipient scoped snapshots; emits `state:snapshot`.
- **`projection.ts`** — async batched write of canonical state → Postgres `session_participants` (downstream only).

Each unit has one purpose, a defined interface, and is independently testable.

## 12. Migration / phasing

1. **Introduce the canonical doc + `applyTransition` behind the existing API**, writing through to today's in-process maps so behavior is unchanged (parallel-run, shadow).
2. **Add the session-status FSM** and route timer + host + disconnect transitions through `applyTransition` (closes C1/C2/C3).
3. **Flip reads to the canonical doc**; demote Postgres to projection (closes M1). Retire the 30s drift reconciler for state (keep stale-escalation, now under lock — closes C4).
4. **Add server-side eviction + LiveKit reconcile loop** (closes G1 physical).
5. **Switch the wire to versioned snapshots + resync**; fold tokens in; retire `match:assigned`/`lobby:token`. Update client contract.
6. **Timer registry** keyed by `sessionId` (closes M2).

Each phase is shippable and independently verifiable.

## 13. Scaling path (validate single-instance first)

The design runs on one app instance + one Redis. Going multi-instance is configuration, not rewrite:
- State already in Redis (not in-process).
- Cross-instance lock already present (`withSessionLock`).
- Add the **Socket.IO Redis adapter** so snapshots fan out across instances.
- The `seq`-tagged LiveKit commands already tolerate cross-instance ordering.
- Timer ownership becomes a single-owner-per-session lease (later).

## 14. Testing strategy

- **FSM unit tests** — every legal/illegal session and participant transition; idempotent self-transition is a no-op.
- **Concurrency tests** — fire host `endRound` and timer `endRound` simultaneously → exactly one effect (C1). Reconnect during reconciler stale window → no wrongful LEFT (C4).
- **Dual-room property test** — no sequence of transitions can produce a participant with two locations or two active tokens (G1).
- **Snapshot ordering** — out-of-order / duplicate `state:snapshot` with `seq ≤ applied` is ignored.
- **Reconnect resync** — refresh mid-round restores the exact canonical location + single token.
- **LiveKit reconcile** — a participant physically in the wrong room is evicted to canonical within one sweep.
- **Projection** — Postgres eventually matches Redis; never read on a realtime path.

## 15. Risks & open questions

- **Client contract change** (token folding, §8) is the largest blast radius; needs coordinated client work and a back-compat window or a same-deploy cutover.
- **LiveKit webhook reliability** — the periodic sweep is the backstop; sweep interval is a tunable (start 15s).
- **Redis as a new hard dependency on the realtime path** — needs graceful degradation defined (Redis down = reject mutations, serve last snapshot read-only?) before production. Open question for the plan.
- **Postgres projection lag** — acceptable for recap/analytics; confirm no REST surface depends on it being synchronous.
