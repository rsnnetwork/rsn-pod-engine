# Change 3.0: Architecture Hardening — Design Spec

**Date:** 2026-04-06
**Status:** Approved
**Approach:** B — Split + Harden
**Scope:** Phase 1 only (critical fixes, no Redis, no new infrastructure)
**Constraint:** Next live event is in days — ship fast, stability first

---

## Problem Statement

The RSN Pod Engine's core event flow breaks at 6 concurrent users. A full-system audit (4 parallel deep-dive agents) found 67 issues across backend, frontend, database, and infrastructure. The root causes are:

1. **All state lives in one Node.js process memory** — no persistence, no recovery
2. **No real concurrency protection** — `withSessionGuard` used on 1 of 15+ host handlers
3. **Fire-and-forget socket events** — no delivery guarantee, no retry, stale client state

This spec addresses the critical fixes that stabilize the system for the next live event without introducing new infrastructure (Redis, new providers, etc.).

---

## Section 1: Orchestration Module Split

Split `server/src/services/orchestration/orchestration.service.ts` (3,282 lines) into 6 focused modules.

### New Structure

```
server/src/services/orchestration/
  orchestration.service.ts          — Main entry: register socket handlers, delegate to modules (~300 lines)
  handlers/
    host-actions.ts                 — All host:* handlers (start, pause, resume, end, broadcast, mute, kick, cohost) (~500 lines)
    matching-flow.ts                — generate_matches, confirm_round, swap_match, exclude, regenerate, cancel_preview (~400 lines)
    round-lifecycle.ts              — transitionToRound, endRound, endRatingWindow, completeSession, closingLobby (~500 lines)
    participant-flow.ts             — session:join, session:leave, disconnect, reconnect, heartbeat, ready (~500 lines)
    timer-manager.ts                — startSegmentTimer, pauseTimer, resumeTimer, timer:sync interval, cleanup (~200 lines)
  state/
    session-state.ts                — ActiveSession type, activeSessions Map, presenceMap helpers, withSessionGuard, state persistence (~300 lines)
```

### Rules

- Each module receives `io` (Socket.IO server) and the shared `activeSessions` Map via dependency injection — no globals
- `withSessionGuard` lives in `state/session-state.ts` and is imported by every handler module
- Every socket handler in every module gets wrapped in try-catch
- Existing behavior stays identical — structural refactor only, no logic changes

---

## Section 2: Concurrency Fixes (withSessionGuard everywhere)

### Handlers that get guarded (currently unguarded)

- `host:start_round`
- `host:pause_session`
- `host:resume_session`
- `host:end_session`
- `host:generate_matches`
- `host:confirm_round`
- `host:swap_match`
- `host:exclude_participant`
- `host:regenerate_matches`
- `host:cancel_preview`
- `host:reassign`
- `host:remove_participant`
- `host:move_to_room`
- `session:join`
- `session:leave`
- `rating:submit`
- `participant:leave_conversation`

### Handlers that stay unguarded (read-only, no state mutation)

- `presence:heartbeat` — timestamp update only
- `chat:send` / `chat:react` — independent of session state
- `host:mute_participant` / `host:mute_all` — LiveKit-only
- `host:broadcast_message` — append-only

### What this fixes

- Double-click "Start Round" → second call waits, sees round started, returns early
- Join during matching → queued behind match generation, gets correct state
- Rating submit while round ending → serialized, no double-processing
- Disconnect + reconnect overlapping → serialized, no conflicting state writes

---

## Section 3: Race Condition Fixes (5 specific bugs)

### 3A: pendingRoundNumber — clear AFTER success, not before

**Current (broken):** `pendingRoundNumber` cleared before `transitionToRound()`. If transition fails, host can't retry — session stuck.

**Fix:** Clear `pendingRoundNumber` only after `transitionToRound()` succeeds. On failure, `pendingRoundNumber` remains set, host can retry.

### 3B: Matching engine timeout — 60s max

**Current:** Matching can hang forever, leaving session stuck.

**Fix:**
- Wrap `generateSchedule()` in `Promise.race` with 60s timeout
- On timeout: emit error to host, return session to lobby state, log warning
- Host can retry

### 3C: Disconnect timeout vs reconnect race

**Current:** User reconnects at 14.9s, old 15s timeout may still fire and trigger no-show logic.

**Fix:** On reconnect, after `clearTimeout()`, set `reconnectedAt` timestamp on the presence entry. Timeout callback checks: if `presenceMap.has(userId) && reconnectedAt > disconnectedAt`, skip all no-show logic.

### 3D: Rating early exit vs host end session — double state transition

**Fix:** Both `endRatingWindow()` and `handleHostEnd()` guarded by `withSessionGuard`. Inside each, check current status before transitioning. If already transitioned (status !== ROUND_RATING), return early. First writer wins, second is a no-op.

### 3E: LiveKit room creation — retry instead of silent swallow

**Current:** `Promise.allSettled()` ignores failures. Participants get tokens for non-existent rooms.

**Fix:**
- Replace `Promise.allSettled` with batched `Promise.all` (batch size 20, same as current) + per-room retry (1 retry, 2s delay)
- If room still fails after retry: mark match as `cancelled`, emit `match:bye_round` to affected participants, log error
- Remaining matches proceed normally

---

## Section 4: Client-Side Fixes

### 4A: Stale closures in socket event handlers

**Problem:** `useSessionSocket.ts` creates handlers once on mount, capturing stale state.

**Fix:** Every socket handler calls `useSessionStore.getState()` at execution time (fresh read), never references destructured values from the hook's render scope.

### 4B: Socket listener accumulation

**Problem:** Multiple mount/unmount cycles register duplicate listeners.

**Fix:** At the TOP of the useEffect, before registering any listener, call `socket.off(eventName)` for every event. Then register. On cleanup, `socket.off(eventName)` again. Guarantees exactly 1 listener per event.

### 4C: Zustand selector optimization

**Problem:** 90-field store, any change re-renders all subscribed components.

**Fix:** Replace destructured store access with field-level selectors in hot-path components:

| Component | Selects only |
|-----------|-------------|
| `LiveSessionPage.tsx` | `phase`, `sessionStatus`, `connectionStatus` |
| `Lobby.tsx` | `participants`, `hostInLobby`, `lobbyToken` |
| `VideoRoom.tsx` | `matchId`, `roomId`, `liveKitToken`, `phase` |
| `RatingPrompt.tsx` | `currentRound`, `currentPartners`, `lastRatedRound` |
| `HostControls.tsx` | `sessionStatus`, `currentRound`, `matchPreview`, `isPaused` |

Pattern: `const phase = useSessionStore(s => s.phase);`

### 4D: Error boundaries per section

**Current:** Single ErrorBoundary at app root.

**Fix:** Granular ErrorBoundary wrappers around:
- `<VideoRoom />` — video crash doesn't kill lobby
- `<Lobby />` — lobby crash doesn't kill host controls
- `<RatingPrompt />` — rating crash doesn't kill session
- `<ChatPanel />` — chat crash doesn't kill anything

Each shows "Something went wrong, click to retry" scoped to that section.

### 4E: Chat message bounded growth

**Current:** `chatMessages` array grows unbounded.

**Fix:** Cap at 200 messages. When length >= 200, shift oldest before pushing new. Simple ring buffer.

---

## Section 5: Server Hardening

### 5A: Try-catch on every socket handler

Every socket event handler across all 6 modules wrapped:
```typescript
socket.on('event:name', async (data) => {
  try {
    await handleEventName(socket, data);
  } catch (err) {
    logger.error({ err, event: 'event:name', userId }, 'Socket handler error');
    socket.emit('error', { message: 'Something went wrong. Please try again.' });
  }
});
```

### 5B: DB pool increase

| Setting | Before | After |
|---------|--------|-------|
| `DB_POOL_MAX` | 10 | 25 |
| `DB_POOL_MIN` | 2 | 5 |
| `connectionTimeoutMillis` | 5000 | 10000 |

Update both `render.yaml` and config defaults.

### 5C: Health check that verifies dependencies

**Current:** `/health` returns 200 always.

**Fix:**
- `SELECT 1` from DB with 3s timeout
- Check activeSessions count
- Return `{ status: 'ok', db: true, activeSessions: N }`
- If DB fails: return 503 `{ status: 'degraded', db: false }`
- Render auto-restarts on repeated 503s

### 5D: Timer interval cleanup

- Store interval ID on `ActiveSession` object
- `completeSession()` and TTL cleanup both clear interval explicitly
- Safety check: if interval fires and session no longer in `activeSessions`, self-clear

### 5E: Heartbeat stale detection

- Every 30 seconds, scan `presenceMap` entries
- If `lastHeartbeat` older than 45 seconds (3 missed heartbeats at 15s interval): trigger disconnect flow
- Prevents ghost "present" users who silently dropped

---

## What Does NOT Change

- All UI pages, layouts, buttons — identical
- All features (matching, ratings, pods, chat, video, host controls, cohosts)
- Database schema — all 31 migrations untouched
- API routes — every endpoint stays the same
- Socket event names and data shapes — same names, same payloads
- LiveKit integration — same rooms, tokens, video

---

## Success Criteria

1. All 17 host/participant handlers protected by `withSessionGuard`
2. Zero unhandled promise rejections in socket handlers
3. Double-click any host action → no duplicate state changes
4. Matching engine timeout after 60s with graceful recovery
5. Disconnect at 14.9s of 15s window → no false no-show
6. LiveKit room failure → affected participants get bye, rest proceed
7. Client re-renders reduced by 50%+ via Zustand selectors
8. Chat capped at 200 messages
9. Health check returns 503 when DB down
10. Stale presence entries cleaned within 45 seconds
