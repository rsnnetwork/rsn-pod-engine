# Change 3.0: Architecture Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the RSN Pod Engine's core event flow by splitting the 3,282-line orchestration monolith into focused modules, adding concurrency guards to all handlers, fixing 5 critical race conditions, and hardening both client and server.

**Architecture:** Split `orchestration.service.ts` into 6 modules (state, timer, participant-flow, host-actions, matching-flow, round-lifecycle) connected via dependency injection. Apply `withSessionGuard` to 17 handlers. Fix client-side stale closures and re-render cascade.

**Tech Stack:** Node.js, Express, Socket.IO, PostgreSQL (pg), LiveKit, React 18, Zustand 5, Vite

**Spec:** `docs/superpowers/specs/2026-04-06-change-3-0-architecture-hardening-design.md`

---

## File Map

### Server — New Files
| File | Responsibility |
|------|---------------|
| `server/src/services/orchestration/state/session-state.ts` | ActiveSession type, activeSessions Map, chatMessages Map, disconnectTimeouts Map, withSessionGuard, presenceMap helpers, state persistence |
| `server/src/services/orchestration/handlers/timer-manager.ts` | startSegmentTimer, getTimerCallbackForState, timer interval cleanup |
| `server/src/services/orchestration/handlers/participant-flow.ts` | handleJoinSession, handleLeaveSession, handleHeartbeat, handleReady, handleDisconnect, heartbeat stale detection |
| `server/src/services/orchestration/handlers/host-actions.ts` | All host:* handlers except matching (start, pause, resume, end, broadcast, remove, reassign, mute, room management, cohost) |
| `server/src/services/orchestration/handlers/matching-flow.ts` | handleHostGenerateMatches, handleHostConfirmRound, handleHostSwapMatch, handleHostExclude, handleHostRegenerate, handleHostCancelPreview, sendMatchPreview, emitHostDashboard |
| `server/src/services/orchestration/handlers/round-lifecycle.ts` | transitionToRound, endRound, endRatingWindow, completeSession, cleanupLiveKitRooms, sendRecapEmails, detectNoShows |
| `server/src/services/orchestration/handlers/chat-handlers.ts` | handleChatSend, handleChatReact, handleReactionSend |

### Server — Modified Files
| File | Changes |
|------|---------|
| `server/src/services/orchestration/orchestration.service.ts` | Gutted to thin entry point (~200 lines): imports modules, registers socket handlers with try-catch, delegates |
| `server/src/db/index.ts` | No changes (withSessionLock already exists) |
| `server/src/config/index.ts` | Update dbPoolMin/dbPoolMax defaults |
| `server/src/index.ts` | Upgrade health check endpoint |
| `render.yaml` | Update DB_POOL_MIN/MAX values |

### Client — Modified Files
| File | Changes |
|------|---------|
| `client/src/hooks/useSessionSocket.ts` | Fix stale closures, fix listener accumulation |
| `client/src/stores/sessionStore.ts` | Cap chatMessages at 200 |
| `client/src/features/live/LiveSessionPage.tsx` | Zustand selectors, wrap children in error boundaries |
| `client/src/features/live/VideoRoom.tsx` | Zustand selectors |
| `client/src/features/live/Lobby.tsx` | Zustand selectors (already partially done) |
| `client/src/features/live/RatingPrompt.tsx` | Zustand selectors |
| `client/src/features/live/HostControls.tsx` | Zustand selectors (already partially done) |
| `client/src/components/ErrorBoundary.tsx` | Add SectionErrorBoundary variant |

---

## Task 1: Create state/session-state.ts

**Files:**
- Create: `server/src/services/orchestration/state/session-state.ts`

This module extracts all shared state, types, and the session guard from orchestration.service.ts.

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p server/src/services/orchestration/state
mkdir -p server/src/services/orchestration/handlers
```

- [ ] **Step 2: Create session-state.ts with types and maps**

Extract from `orchestration.service.ts`:
- Lines 26-39: `ActiveSession` interface
- Lines 43-49: `activeSessions`, `disconnectTimeouts`, `sessionLocks` Maps
- Lines 150-163: `ChatMessage` interface, `MAX_CHAT_MESSAGES`, `chatMessages` Map
- Lines 247-257: `sessionRoom()`, `userRoom()`, `getUserIdFromSocket()` helpers
- Lines 50-64: `withSessionGuard()` function
- Lines 69-92: `persistSessionState()`, `clearPersistedState()` functions

```typescript
// server/src/services/orchestration/state/session-state.ts

import { Server as SocketServer, Socket } from 'socket.io';
import { SessionStatus, SessionConfig, ServerToClientEvents, ClientToServerEvents } from '@rsn/shared';
import logger from '../../../config/logger';
import { query } from '../../../db';

// ── Types ──────────────────────────────────────────────────────

export interface ActiveSession {
  sessionId: string;
  hostUserId: string;
  config: SessionConfig;
  status: SessionStatus;
  currentRound: number;
  timer: NodeJS.Timeout | null;
  timerEndsAt: Date | null;
  timerSyncInterval: NodeJS.Timeout | null; // NEW: track sync interval for cleanup
  isPaused: boolean;
  pausedTimeRemaining: number | null;
  pendingRoundNumber: number | null;
  presenceMap: Map<string, { lastHeartbeat: Date; socketId: string; reconnectedAt?: Date }>; // ADDED reconnectedAt
  manuallyLeftRound: Set<string>;
}

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  message: string;
  timestamp: string;
  scope: 'lobby' | 'room';
  roomId?: string;
  reactions: Record<string, string[]>;
}

// ── Shared State ───────────────────────────────────────────────

export const activeSessions = new Map<string, ActiveSession>();
export const disconnectTimeouts = new Map<string, NodeJS.Timeout>();
export const MAX_CHAT_MESSAGES = 50;
export const chatMessages = new Map<string, ChatMessage[]>();

// Session-level operation lock (application layer)
const sessionLocks = new Map<string, Promise<void>>();

export async function withSessionGuard<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  while (sessionLocks.has(sessionId)) {
    await sessionLocks.get(sessionId);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  sessionLocks.set(sessionId, lock);
  try {
    return await fn();
  } finally {
    sessionLocks.delete(sessionId);
    resolve!();
  }
}

// ── Room Helpers ───────────────────────────────────────────────

export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function getUserIdFromSocket(socket: Socket): string {
  return socket.data.userId;
}

// ── State Persistence ──────────────────────────────────────────

export async function persistSessionState(sessionId: string, activeSession: ActiveSession): Promise<void> {
  // Copy existing logic from orchestration.service.ts lines 69-86
  // Persist minimal state (status, round, timer, pause) to sessions.active_state column
  try {
    const state = {
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      timerEndsAt: activeSession.timerEndsAt?.toISOString() || null,
      isPaused: activeSession.isPaused,
      pausedTimeRemaining: activeSession.pausedTimeRemaining,
      pendingRoundNumber: activeSession.pendingRoundNumber,
    };
    await query(
      `UPDATE sessions SET active_state = $1, active_state_updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(state), sessionId]
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to persist session state');
  }
}

export async function clearPersistedState(sessionId: string): Promise<void> {
  try {
    await query(
      `UPDATE sessions SET active_state = NULL, active_state_updated_at = NULL WHERE id = $1`,
      [sessionId]
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to clear persisted state');
  }
}

// ── Chat Helpers ───────────────────────────────────────────────

export function getSessionChat(sessionId: string): ChatMessage[] {
  return chatMessages.get(sessionId) || [];
}

export function addSessionChat(sessionId: string, message: ChatMessage): void {
  if (!chatMessages.has(sessionId)) {
    chatMessages.set(sessionId, []);
  }
  const messages = chatMessages.get(sessionId)!;
  messages.push(message);
  if (messages.length > MAX_CHAT_MESSAGES) {
    messages.shift();
  }
}

export function cleanupChatMessages(sessionId: string): void {
  chatMessages.delete(sessionId);
}
```

- [ ] **Step 3: Verify the file compiles**

```bash
cd server && npx tsc --noEmit src/services/orchestration/state/session-state.ts 2>&1 | head -20
```

Expected: No errors (or only errors from missing imports that will be resolved when full split is done). If there are import issues, fix them.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/orchestration/state/session-state.ts
git commit -m "refactor: extract session state module from orchestration monolith"
```

---

## Task 2: Create handlers/timer-manager.ts

**Files:**
- Create: `server/src/services/orchestration/handlers/timer-manager.ts`

Extract from `orchestration.service.ts`:
- Lines 2775-2817: `startSegmentTimer()` — with FIX 5D (store interval ID on ActiveSession, self-clear safety)
- Lines 2819-2834: `getTimerCallbackForState()`

- [ ] **Step 1: Create timer-manager.ts**

```typescript
// server/src/services/orchestration/handlers/timer-manager.ts

import { Server as SocketServer } from 'socket.io';
import logger from '../../../config/logger';
import {
  ActiveSession,
  activeSessions,
  sessionRoom,
  persistSessionState,
} from '../state/session-state';

/**
 * Start a segment timer with 5-second sync broadcasts.
 * FIX 5D: Stores timerSyncInterval on ActiveSession for explicit cleanup.
 * Safety: interval self-clears if session no longer exists.
 */
export function startSegmentTimer(
  io: SocketServer,
  sessionId: string,
  durationSeconds: number,
  callback: () => void
): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  // Clear any previous timer and sync interval
  if (activeSession.timer) {
    clearTimeout(activeSession.timer);
    activeSession.timer = null;
  }
  if (activeSession.timerSyncInterval) {
    clearInterval(activeSession.timerSyncInterval);
    activeSession.timerSyncInterval = null;
  }

  const durationMs = durationSeconds * 1000;
  activeSession.timerEndsAt = new Date(Date.now() + durationMs);

  // Main timer
  activeSession.timer = setTimeout(() => {
    activeSession.timer = null;
    callback();
  }, durationMs);

  // 5-second sync broadcast
  activeSession.timerSyncInterval = setInterval(() => {
    // FIX 5D: Safety — self-clear if session removed
    const session = activeSessions.get(sessionId);
    if (!session) {
      clearInterval(activeSession.timerSyncInterval!);
      activeSession.timerSyncInterval = null;
      return;
    }

    if (!session.timerEndsAt || session.isPaused) return;

    const remaining = Math.max(0, Math.ceil((session.timerEndsAt.getTime() - Date.now()) / 1000));
    io.to(sessionRoom(sessionId)).emit('timer:sync', { secondsRemaining: remaining });
  }, 5000);

  // Persist updated timer state
  persistSessionState(sessionId, activeSession);
}

/**
 * Clear all timers for a session (main timer + sync interval).
 * Called on session completion, pause, and TTL cleanup.
 */
export function clearSessionTimers(sessionId: string): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  if (activeSession.timer) {
    clearTimeout(activeSession.timer);
    activeSession.timer = null;
  }
  if (activeSession.timerSyncInterval) {
    clearInterval(activeSession.timerSyncInterval);
    activeSession.timerSyncInterval = null;
  }
  activeSession.timerEndsAt = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/orchestration/handlers/timer-manager.ts
git commit -m "refactor: extract timer manager with interval cleanup fix"
```

---

## Task 3: Create handlers/participant-flow.ts

**Files:**
- Create: `server/src/services/orchestration/handlers/participant-flow.ts`

Extract from `orchestration.service.ts`:
- Lines 261-552: `handleJoinSession()` — ADD withSessionGuard
- Lines 556-591: `handleLeaveSession()` — ADD withSessionGuard
- Lines 595-609: `handleHeartbeat()` — stays unguarded
- Lines 613-623: `handleReady()` — stays unguarded
- Lines 837-1018: `handleDisconnect()` — ADD FIX 3C (reconnectedAt timestamp)
- Lines 627-650: `handleRatingSubmit()` — ADD withSessionGuard
- Lines 656-724: `checkAllRatingsCompleteByUserId()`, `notifyRatingSubmitted()`
- Lines 728-833: `handleLeaveConversation()` — ADD withSessionGuard
- NEW: Heartbeat stale detection (FIX 5E)

- [ ] **Step 1: Create participant-flow.ts**

This is the largest handler file. Key changes to apply during extraction:

**FIX: withSessionGuard on handleJoinSession, handleLeaveSession, handleRatingSubmit, handleLeaveConversation:**
```typescript
// Wrap the body of each handler:
export async function handleJoinSession(io: SocketServer, socket: Socket, data: { sessionId: string }) {
  return withSessionGuard(data.sessionId, async () => {
    // ... existing join logic from lines 261-552
  });
}
```

**FIX 3C: Disconnect timeout vs reconnect race:**
In `handleDisconnect`, when scheduling the 15s timeout (original line 885), record `disconnectedAt`:
```typescript
// Inside disconnect handler, when scheduling timeout:
const disconnectedAt = new Date();

// Inside the timeout callback (original line 890), add check:
const presence = activeSession.presenceMap.get(userId);
if (presence && presence.reconnectedAt && presence.reconnectedAt > disconnectedAt) {
  logger.info({ userId, sessionId }, 'User reconnected during timeout window — skipping no-show');
  return;
}
```

In `handleJoinSession`, when cancelling disconnect timeout (original line ~314-318), set `reconnectedAt`:
```typescript
// After clearTimeout for disconnect:
if (disconnectTimeouts.has(userId)) {
  clearTimeout(disconnectTimeouts.get(userId)!);
  disconnectTimeouts.delete(userId);
}
// Set reconnectedAt on presence entry
activeSession.presenceMap.set(userId, {
  lastHeartbeat: new Date(),
  socketId: socket.id,
  reconnectedAt: new Date(),
});
```

**FIX 5E: Heartbeat stale detection:**
```typescript
const STALE_HEARTBEAT_MS = 45_000; // 3 missed heartbeats at 15s interval
const STALE_CHECK_INTERVAL_MS = 30_000;

export function startHeartbeatStaleDetection(io: SocketServer): void {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      for (const [userId, presence] of session.presenceMap) {
        if (now - presence.lastHeartbeat.getTime() > STALE_HEARTBEAT_MS) {
          logger.warn({ userId, sessionId }, 'Stale heartbeat detected — triggering disconnect flow');
          session.presenceMap.delete(userId);
          // Trigger the same logic as handleDisconnect for this user
          handleStaleDisconnect(io, sessionId, userId);
        }
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd server && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/orchestration/handlers/participant-flow.ts
git commit -m "refactor: extract participant flow with session guards and disconnect race fix"
```

---

## Task 4: Create handlers/host-actions.ts

**Files:**
- Create: `server/src/services/orchestration/handlers/host-actions.ts`

Extract from `orchestration.service.ts`:
- Lines 1070-1156: `handleHostStart()` — already has withSessionGuard
- Lines 1160-1218: `handleHostStartRound()` — ADD withSessionGuard
- Lines 1222-1255: `handleHostPause()` — ADD withSessionGuard
- Lines 1259-1294: `handleHostResume()` — ADD withSessionGuard
- Lines 1298-1333: `handleHostEnd()` — ADD withSessionGuard
- Lines 1337-1353: `handleHostBroadcast()` — stays unguarded (append-only)
- Lines 1357-1393: `handleHostRemoveParticipant()` — ADD withSessionGuard
- Lines 1397-1477: `handleHostReassign()` — ADD withSessionGuard
- Lines 1778-1801: `handleHostMuteParticipant()` — stays unguarded (LiveKit-only)
- Lines 1803-1831: `handleHostMuteAll()` — stays unguarded (LiveKit-only)
- Lines 1835-1887: `handleHostRemoveFromRoom()` — ADD withSessionGuard
- Lines 1891-1996: `handleHostMoveToRoom()` — ADD withSessionGuard
- Lines 3215-3249: `handleAssignCohost()` — ADD withSessionGuard
- Lines 3251-3277: `handleRemoveCohost()` — ADD withSessionGuard
- Lines 1025-1066: `getAllHostIds()`, `verifyHost()` helper functions
- Lines 2903-3019: REST API exports (startSession, pauseSession, resumeSession, endSession, broadcastMessage)

- [ ] **Step 1: Create host-actions.ts**

Key pattern for every guarded handler:
```typescript
export async function handleHostStartRound(io: SocketServer, socket: Socket, data: { sessionId: string }) {
  return withSessionGuard(data.sessionId, async () => {
    await verifyHost(socket, data.sessionId);
    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) {
      socket.emit('error', { message: 'Event not active' });
      return;
    }
    // ... existing logic from lines 1160-1218
  });
}
```

Apply this pattern to: `handleHostStartRound`, `handleHostPause`, `handleHostResume`, `handleHostEnd`, `handleHostRemoveParticipant`, `handleHostReassign`, `handleHostRemoveFromRoom`, `handleHostMoveToRoom`, `handleAssignCohost`, `handleRemoveCohost`.

- [ ] **Step 2: Commit**

```bash
git add server/src/services/orchestration/handlers/host-actions.ts
git commit -m "refactor: extract host actions with withSessionGuard on all state-mutating handlers"
```

---

## Task 5: Create handlers/matching-flow.ts

**Files:**
- Create: `server/src/services/orchestration/handlers/matching-flow.ts`

Extract from `orchestration.service.ts`:
- Lines 1481-1553: `handleHostGenerateMatches()` — ADD withSessionGuard + FIX 3B (60s timeout)
- Lines 1557-1600: `handleHostConfirmRound()` — ADD withSessionGuard + FIX 3A (clear pendingRoundNumber AFTER success)
- Lines 1604-1655: `handleHostSwapMatch()` — ADD withSessionGuard
- Lines 1659-1704: `handleHostExcludeFromRound()` — ADD withSessionGuard
- Lines 1708-1740: `handleHostRegenerateMatches()` — ADD withSessionGuard
- Lines 1744-1774: `handleHostCancelPreview()` — ADD withSessionGuard
- Lines 2000-2080: `sendMatchPreview()`
- Lines 2088-2174: `emitHostDashboard()`

- [ ] **Step 1: Create matching-flow.ts**

**FIX 3B: Matching engine timeout:**
```typescript
import * as matchingService from '../../matching/matching.service';

const MATCHING_TIMEOUT_MS = 60_000;

async function generateMatchesWithTimeout(sessionId: string, roundNumber: number, config: any) {
  const matchPromise = matchingService.generateSingleRound(sessionId, roundNumber, config);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Matching engine timeout after 60s')), MATCHING_TIMEOUT_MS)
  );
  return Promise.race([matchPromise, timeoutPromise]);
}

export async function handleHostGenerateMatches(io: SocketServer, socket: Socket, data: { sessionId: string }) {
  return withSessionGuard(data.sessionId, async () => {
    await verifyHost(socket, data.sessionId);
    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) { socket.emit('error', { message: 'Event not active' }); return; }

    // ... existing validation logic ...

    try {
      const matches = await generateMatchesWithTimeout(data.sessionId, nextRound, activeSession.config);
      activeSession.pendingRoundNumber = nextRound;
      await sendMatchPreview(io, data.sessionId, matches);
      persistSessionState(data.sessionId, activeSession);
    } catch (err: any) {
      if (err.message?.includes('timeout')) {
        logger.error({ sessionId: data.sessionId }, 'Matching engine timed out after 60s');
        socket.emit('error', { message: 'Matching took too long. Please try again.' });
        // Session stays in current state — host can retry
      } else {
        throw err;
      }
    }
  });
}
```

**FIX 3A: pendingRoundNumber cleared AFTER success:**
```typescript
export async function handleHostConfirmRound(io: SocketServer, socket: Socket, data: { sessionId: string }) {
  return withSessionGuard(data.sessionId, async () => {
    await verifyHost(socket, data.sessionId);
    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) { socket.emit('error', { message: 'Event not active' }); return; }

    const roundNumber = activeSession.pendingRoundNumber;
    if (roundNumber == null) {
      socket.emit('error', { message: 'No pending matches to confirm' });
      return;
    }

    // FIX 3A: Do NOT clear pendingRoundNumber before transition
    await transitionToRound(io, data.sessionId, roundNumber);

    // FIX 3A: Clear ONLY after successful transition
    activeSession.pendingRoundNumber = null;
    persistSessionState(data.sessionId, activeSession);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/orchestration/handlers/matching-flow.ts
git commit -m "refactor: extract matching flow with timeout + pendingRoundNumber fix"
```

---

## Task 6: Create handlers/round-lifecycle.ts

**Files:**
- Create: `server/src/services/orchestration/handlers/round-lifecycle.ts`

Extract from `orchestration.service.ts`:
- Lines 2178-2350: `transitionToRound()` — FIX 3E (LiveKit room retry)
- Lines 2354-2453: `endRound()`
- Lines 2457-2548: `endRatingWindow()` — FIX 3D (check status before transition)
- Lines 2552-2604: `completeSession()` — use clearSessionTimers()
- Lines 2608-2633: `cleanupLiveKitRooms()`
- Lines 2637-2769: `sendRecapEmails()`
- Lines 2840-2897: `detectNoShows()`
- Lines 94-146: `recoverActiveSessions()`

- [ ] **Step 1: Create round-lifecycle.ts**

**FIX 3E: LiveKit room creation with retry:**
```typescript
/**
 * Create a LiveKit room with 1 retry on failure.
 * If both attempts fail, returns null (match will be cancelled).
 */
async function createRoomWithRetry(
  sessionId: string,
  roundNumber: number,
  matchIdShort: string
): Promise<boolean> {
  try {
    await videoService.createMatchRoom(sessionId, roundNumber, matchIdShort);
    return true;
  } catch (err) {
    logger.warn({ err, sessionId, roundNumber, matchIdShort }, 'LiveKit room creation failed — retrying in 2s');
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      await videoService.createMatchRoom(sessionId, roundNumber, matchIdShort);
      return true;
    } catch (retryErr) {
      logger.error({ err: retryErr, sessionId, roundNumber, matchIdShort }, 'LiveKit room creation failed after retry');
      return false;
    }
  }
}

// In transitionToRound, replace the Promise.allSettled block:
// Process in batches of 20
for (let i = 0; i < matchBatches.length; i += 20) {
  const batch = matchBatches.slice(i, i + 20);
  const results = await Promise.all(
    batch.map(async (match) => {
      const success = await createRoomWithRetry(sessionId, roundNumber, match.matchIdShort);
      return { match, success };
    })
  );

  // Handle failed rooms: cancel match, send bye to affected participants
  for (const { match, success } of results) {
    if (!success) {
      await query(
        `UPDATE matches SET status = 'cancelled' WHERE id = $1`,
        [match.matchId]
      );
      const affectedUserIds = [match.participantAId, match.participantBId, match.participantCId].filter(Boolean);
      for (const uid of affectedUserIds) {
        io.to(userRoom(uid!)).emit('match:bye_round', { roundNumber });
      }
      logger.error({ matchId: match.matchId }, 'Match cancelled due to room creation failure');
    }
  }
}
```

**FIX 3D: Rating early exit guard:**
```typescript
export async function endRatingWindow(io: SocketServer, sessionId: string, roundNumber: number): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  // FIX 3D: Guard — only transition if we're actually in ROUND_RATING
  if (activeSession.status !== SessionStatus.ROUND_RATING) {
    logger.warn({ sessionId, currentStatus: activeSession.status }, 'endRatingWindow called but not in ROUND_RATING — skipping');
    return;
  }

  clearSessionTimers(sessionId);

  // ... existing endRatingWindow logic ...
}
```

**completeSession cleanup:**
```typescript
export async function completeSession(io: SocketServer, sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  // Clear ALL timers (FIX 5D)
  clearSessionTimers(sessionId);

  // ... existing completion logic ...

  // Cleanup
  activeSessions.delete(sessionId);
  cleanupChatMessages(sessionId);
  await clearPersistedState(sessionId);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/orchestration/handlers/round-lifecycle.ts
git commit -m "refactor: extract round lifecycle with LiveKit retry and rating guard fixes"
```

---

## Task 7: Create handlers/chat-handlers.ts and rewrite orchestration.service.ts entry point

**Files:**
- Create: `server/src/services/orchestration/handlers/chat-handlers.ts`
- Modify: `server/src/services/orchestration/orchestration.service.ts`

- [ ] **Step 1: Create chat-handlers.ts**

Extract from `orchestration.service.ts`:
- Lines 3023-3119: `handleChatSend()`
- Lines 3125-3161: `handleChatReact()`
- Lines 3167-3211: `handleReactionSend()`
- Lines 3123, 3165: Constants `CHAT_REACTION_EMOJIS`, `VALID_REACTIONS`

No guards needed (chat is independent of session state machine).

- [ ] **Step 2: Rewrite orchestration.service.ts as thin entry point**

Replace the entire 3,282-line file with a ~200-line entry point that:
1. Imports all handler modules
2. Registers socket handlers with try-catch wrappers (FIX 5A)
3. Starts heartbeat stale detection
4. Runs session recovery on init
5. Runs TTL cleanup interval
6. Re-exports public API functions

```typescript
// server/src/services/orchestration/orchestration.service.ts
import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../config/logger';
import { activeSessions, getUserIdFromSocket, sessionRoom } from './state/session-state';
import { startHeartbeatStaleDetection, handleJoinSession, handleLeaveSession, handleHeartbeat, handleReady, handleDisconnect, handleRatingSubmit, handleLeaveConversation } from './handlers/participant-flow';
import { handleHostStart, handleHostStartRound, handleHostPause, handleHostResume, handleHostEnd, handleHostBroadcast, handleHostRemoveParticipant, handleHostReassign, handleHostMuteParticipant, handleHostMuteAll, handleHostRemoveFromRoom, handleHostMoveToRoom, handleAssignCohost, handleRemoveCohost } from './handlers/host-actions';
import { handleHostGenerateMatches, handleHostConfirmRound, handleHostSwapMatch, handleHostExcludeFromRound, handleHostRegenerateMatches, handleHostCancelPreview } from './handlers/matching-flow';
import { recoverActiveSessions } from './handlers/round-lifecycle';
import { handleChatSend, handleChatReact, handleReactionSend } from './handlers/chat-handlers';
import { cleanupChatMessages } from './state/session-state';

let io: SocketServer;

// ── Socket Handler Registration ────────────────────────────────

function wrapHandler(
  eventName: string,
  socket: Socket,
  handler: (io: SocketServer, socket: Socket, data: any) => Promise<void>
) {
  socket.on(eventName, async (data: any) => {
    try {
      await handler(io, socket, data);
    } catch (err) {
      const userId = getUserIdFromSocket(socket);
      logger.error({ err, event: eventName, userId }, 'Socket handler error');
      socket.emit('error', { message: 'Something went wrong. Please try again.' });
    }
  });
}

export function initOrchestration(socketServer: SocketServer): void {
  io = socketServer;

  // Recover active sessions from DB
  recoverActiveSessions(io).catch(err =>
    logger.error({ err }, 'Failed to recover active sessions')
  );

  // Start heartbeat stale detection (FIX 5E)
  startHeartbeatStaleDetection(io);

  // TTL cleanup (every 5 minutes, remove sessions older than 4 hours)
  const MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      const lastActivity = session.timerEndsAt?.getTime() || now;
      if (now - lastActivity > MAX_SESSION_AGE_MS) {
        logger.warn({ sessionId }, 'Cleaning up stale session (TTL exceeded)');
        activeSessions.delete(sessionId);
        cleanupChatMessages(sessionId);
      }
    }
  }, 5 * 60 * 1000);

  io.on('connection', (socket: Socket) => {
    const userId = getUserIdFromSocket(socket);
    socket.join(`user:${userId}`);

    // ── Participant Events ──
    wrapHandler('session:join', socket, handleJoinSession);
    wrapHandler('session:leave', socket, handleLeaveSession);
    wrapHandler('rating:submit', socket, handleRatingSubmit);
    wrapHandler('participant:leave_conversation', socket, handleLeaveConversation);

    // Unguarded (read-only)
    socket.on('presence:heartbeat', (data) => {
      try { handleHeartbeat(socket, data); }
      catch (err) { logger.error({ err, userId }, 'Heartbeat handler error'); }
    });
    socket.on('presence:ready', async (data) => {
      try { await handleReady(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Ready handler error'); }
    });

    // ── Host Events ──
    wrapHandler('host:start_session', socket, handleHostStart);
    wrapHandler('host:start_round', socket, handleHostStartRound);
    wrapHandler('host:pause_session', socket, handleHostPause);
    wrapHandler('host:resume_session', socket, handleHostResume);
    wrapHandler('host:end_session', socket, handleHostEnd);
    wrapHandler('host:remove_participant', socket, handleHostRemoveParticipant);
    wrapHandler('host:reassign', socket, handleHostReassign);
    wrapHandler('host:remove_from_room', socket, handleHostRemoveFromRoom);
    wrapHandler('host:move_to_room', socket, handleHostMoveToRoom);
    wrapHandler('host:assign_cohost', socket, handleAssignCohost);
    wrapHandler('host:remove_cohost', socket, handleRemoveCohost);

    // Unguarded host events (no session state mutation)
    socket.on('host:broadcast_message', async (data) => {
      try { await handleHostBroadcast(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Broadcast handler error'); }
    });
    socket.on('host:mute_participant', async (data) => {
      try { await handleHostMuteParticipant(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Mute handler error'); }
    });
    socket.on('host:mute_all', async (data) => {
      try { await handleHostMuteAll(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Mute all handler error'); }
    });

    // ── Matching Events ──
    wrapHandler('host:generate_matches', socket, handleHostGenerateMatches);
    wrapHandler('host:confirm_round', socket, handleHostConfirmRound);
    wrapHandler('host:swap_match', socket, handleHostSwapMatch);
    wrapHandler('host:exclude_participant', socket, handleHostExcludeFromRound);
    wrapHandler('host:regenerate_matches', socket, handleHostRegenerateMatches);
    wrapHandler('host:cancel_preview', socket, handleHostCancelPreview);

    // ── Chat Events (unguarded) ──
    socket.on('chat:send', async (data) => {
      try { await handleChatSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat send handler error'); }
    });
    socket.on('chat:react', async (data) => {
      try { await handleChatReact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat react handler error'); }
    });
    socket.on('reaction:send', async (data) => {
      try { await handleReactionSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Reaction handler error'); }
    });

    // ── Disconnect ──
    socket.on('disconnect', async () => {
      try { await handleDisconnect(io, socket); }
      catch (err) { logger.error({ err, userId }, 'Disconnect handler error'); }
    });
  });
}

// ── Public API re-exports ──
export { startSession, pauseSession, resumeSession, endSession, broadcastMessage } from './handlers/host-actions';
export { getActiveSessionState } from './state/session-state';
export { notifyRatingSubmitted } from './handlers/participant-flow';
```

- [ ] **Step 3: Verify full server compiles**

```bash
cd server && npx tsc --noEmit 2>&1 | head -50
```

Fix any import/export issues until clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/orchestration/
git commit -m "refactor: rewrite orchestration entry point — all handlers wrapped in try-catch"
```

---

## Task 8: Server hardening — DB pool, health check, render.yaml

**Files:**
- Modify: `server/src/config/index.ts:18-19`
- Modify: `server/src/db/index.ts:6-12`
- Modify: `server/src/index.ts:186-193`
- Modify: `render.yaml:29-31`

- [ ] **Step 1: Update config defaults**

In `server/src/config/index.ts`, change:
```typescript
// Line 18-19: Update defaults
dbPoolMin: parseInt(process.env.DB_POOL_MIN || '5', 10),   // was '2'
dbPoolMax: parseInt(process.env.DB_POOL_MAX || '25', 10),   // was '10'
```

- [ ] **Step 2: Update connection timeout in db/index.ts**

In `server/src/db/index.ts`, change line 11:
```typescript
connectionTimeoutMillis: 10_000,  // was 5_000
```

- [ ] **Step 3: Upgrade health check in index.ts**

Replace the health check at lines 186-193:
```typescript
app.get('/health', async (_req, res) => {
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    const dbLatency = Date.now() - dbStart;

    const sessionCount = activeSessions ? activeSessions.size : 0;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: config.env,
      db: { connected: true, latencyMs: dbLatency },
      activeSessions: sessionCount,
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed — DB unreachable');
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      db: { connected: false },
    });
  }
});
```

Note: Import `activeSessions` from `./services/orchestration/state/session-state` (or use a getter if circular import). If circular, add a `getActiveSessionCount()` export to session-state.ts that returns `activeSessions.size`.

- [ ] **Step 4: Update render.yaml**

```yaml
# Line 29-31
- key: DB_POOL_MIN
  value: "5"
- key: DB_POOL_MAX
  value: "25"
```

- [ ] **Step 5: Commit**

```bash
git add server/src/config/index.ts server/src/db/index.ts server/src/index.ts render.yaml
git commit -m "fix: increase DB pool to 25, add deep health check, bump connection timeout"
```

---

## Task 9: Client — Fix useSessionSocket (stale closures + listener accumulation)

**Files:**
- Modify: `client/src/hooks/useSessionSocket.ts`

- [ ] **Step 1: Fix listener accumulation (FIX 4B)**

At the TOP of the main useEffect (line 64), before registering any listeners, remove all previous listeners:

```typescript
useEffect(() => {
  if (!sessionId) return;

  const socket = getSocket();
  if (!socket) return;

  // FIX 4B: Remove ALL previous listeners before registering new ones
  // This prevents accumulation on mount/unmount cycles
  SOCKET_EVENTS.forEach(ev => socket.off(ev));
  socket.off('connect');
  socket.io.off('reconnect');
  socket.io.off('reconnect_attempt');
  socket.io.off('reconnect_failed');

  // ... rest of setup
```

- [ ] **Step 2: Fix stale closures (FIX 4A)**

Audit every socket handler. Replace any reference to destructured store values with fresh `getState()` reads. The key handlers to fix:

**`session:status_changed` (line 138):**
```typescript
socket.on('session:status_changed', (data) => {
  const state = useSessionStore.getState(); // FRESH read
  // Replace all references to store.xxx with state.xxx
  // ...
});
```

**`session:round_ended` (line 200):**
```typescript
socket.on('session:round_ended', (data) => {
  const state = useSessionStore.getState();
  if (state.isByeRound) {
    // ...
  }
});
```

**`match:assigned` (line 243):**
```typescript
socket.on('match:assigned', (data) => {
  const state = useSessionStore.getState();
  if (state.leftCurrentRound) return; // Fresh check
  // ...
});
```

**`match:bye_round` (line 309):**
```typescript
socket.on('match:bye_round', (data) => {
  const state = useSessionStore.getState();
  // ...
});
```

**`rating:window_open` (line 329):**
```typescript
socket.on('rating:window_open', (data) => {
  const state = useSessionStore.getState();
  if (state.currentRound <= state.lastRatedRound) return; // Fresh check
  // ...
});
```

**`rating:window_closed` (line 369):**
```typescript
socket.on('rating:window_closed', (data) => {
  const state = useSessionStore.getState();
  // ...
});
```

Apply the same pattern to ALL handlers that read store state for conditional logic.

- [ ] **Step 3: Remove the direct store destructure at line 46**

The hook currently does:
```typescript
const store = useSessionStore();
```

This is used to call actions. Change to:
```typescript
// Only grab action functions (they're stable references, not state)
const actions = useSessionStore.getState();
// OR reference them inline: useSessionStore.getState().setPhase('matched')
```

Better approach: since actions are stable in Zustand, keep them as direct references but read state via `getState()` in event handlers.

- [ ] **Step 4: Verify client compiles**

```bash
cd client && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useSessionSocket.ts
git commit -m "fix: eliminate stale closures and socket listener accumulation in useSessionSocket"
```

---

## Task 10: Client — Zustand selectors for hot-path components

**Files:**
- Modify: `client/src/features/live/LiveSessionPage.tsx:24-25`
- Modify: `client/src/features/live/VideoRoom.tsx:311-312`
- Modify: `client/src/features/live/RatingPrompt.tsx:134`
- Modify: `client/src/features/live/HostControls.tsx:10`

Note: `Lobby.tsx` and `ChatPanel.tsx` already use selectors in several places. Focus on the components that destructure the full store.

- [ ] **Step 1: Fix LiveSessionPage.tsx**

Replace line 24-25:
```typescript
// BEFORE:
const { phase, broadcasts, error: sessionError, connectionStatus, transitionStatus,
        sessionStatus, currentRound, totalRounds, setError, setPhase, reset, chatOpen,
        setChatOpen, unreadChatCount, matchingOverlay, preparingMatches } = useSessionStore();

// AFTER:
const phase = useSessionStore(s => s.phase);
const broadcasts = useSessionStore(s => s.broadcasts);
const sessionError = useSessionStore(s => s.error);
const connectionStatus = useSessionStore(s => s.connectionStatus);
const transitionStatus = useSessionStore(s => s.transitionStatus);
const sessionStatus = useSessionStore(s => s.sessionStatus);
const currentRound = useSessionStore(s => s.currentRound);
const totalRounds = useSessionStore(s => s.totalRounds);
const chatOpen = useSessionStore(s => s.chatOpen);
const unreadChatCount = useSessionStore(s => s.unreadChatCount);
const matchingOverlay = useSessionStore(s => s.matchingOverlay);
const preparingMatches = useSessionStore(s => s.preparingMatches);
// Actions (stable references — fine to destructure)
const { setError, setPhase, reset, setChatOpen } = useSessionStore.getState();
```

- [ ] **Step 2: Fix VideoRoom.tsx**

Replace line 311:
```typescript
// BEFORE:
const { timerSeconds, currentRound, totalRounds, isByeRound, liveKitToken, livekitUrl,
        currentRoomId, transitionStatus, timerVisibility, partnerDisconnected } = useSessionStore();

// AFTER:
const timerSeconds = useSessionStore(s => s.timerSeconds);
const currentRound = useSessionStore(s => s.currentRound);
const totalRounds = useSessionStore(s => s.totalRounds);
const isByeRound = useSessionStore(s => s.isByeRound);
const liveKitToken = useSessionStore(s => s.liveKitToken);
const livekitUrl = useSessionStore(s => s.livekitUrl);
const currentRoomId = useSessionStore(s => s.currentRoomId);
const transitionStatus = useSessionStore(s => s.transitionStatus);
const timerVisibility = useSessionStore(s => s.timerVisibility);
const partnerDisconnected = useSessionStore(s => s.partnerDisconnected);
const setLiveKitToken = useSessionStore(s => s.setLiveKitToken);
```

- [ ] **Step 3: Fix RatingPrompt.tsx**

Replace line 134:
```typescript
// BEFORE:
const { currentMatch, currentMatchId, currentPartners, timerSeconds, setPhase,
        currentRound, totalRounds } = useSessionStore();

// AFTER:
const currentMatch = useSessionStore(s => s.currentMatch);
const currentMatchId = useSessionStore(s => s.currentMatchId);
const currentPartners = useSessionStore(s => s.currentPartners);
const timerSeconds = useSessionStore(s => s.timerSeconds);
const currentRound = useSessionStore(s => s.currentRound);
const totalRounds = useSessionStore(s => s.totalRounds);
const { setPhase } = useSessionStore.getState();
```

- [ ] **Step 4: Fix HostControls.tsx**

Replace line 10:
```typescript
// BEFORE:
const { participants, phase, currentRound, totalRounds, transitionStatus, sessionStatus,
        matchPreview, setMatchPreview, roundDashboard } = useSessionStore();

// AFTER:
const participants = useSessionStore(s => s.participants);
const phase = useSessionStore(s => s.phase);
const currentRound = useSessionStore(s => s.currentRound);
const totalRounds = useSessionStore(s => s.totalRounds);
const transitionStatus = useSessionStore(s => s.transitionStatus);
const sessionStatus = useSessionStore(s => s.sessionStatus);
const matchPreview = useSessionStore(s => s.matchPreview);
const roundDashboard = useSessionStore(s => s.roundDashboard);
const { setMatchPreview } = useSessionStore.getState();
```

- [ ] **Step 5: Verify client compiles**

```bash
cd client && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 6: Commit**

```bash
git add client/src/features/live/LiveSessionPage.tsx client/src/features/live/VideoRoom.tsx client/src/features/live/RatingPrompt.tsx client/src/features/live/HostControls.tsx
git commit -m "perf: use Zustand field selectors to eliminate unnecessary re-renders"
```

---

## Task 11: Client — Error boundaries + chat cap

**Files:**
- Modify: `client/src/components/ErrorBoundary.tsx`
- Modify: `client/src/features/live/LiveSessionPage.tsx`
- Modify: `client/src/stores/sessionStore.ts`

- [ ] **Step 1: Add SectionErrorBoundary to ErrorBoundary.tsx**

Add a lightweight variant below the existing ErrorBoundary class:

```typescript
// Add after existing ErrorBoundary (line ~56)

interface SectionErrorBoundaryProps {
  children: ReactNode;
  name: string; // e.g. "Video", "Chat", "Rating"
}

interface SectionErrorBoundaryState {
  hasError: boolean;
}

export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, SectionErrorBoundaryState> {
  state: SectionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[${this.props.name}] Error boundary caught:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-6 text-center">
          <p className="text-sm text-zinc-400 mb-2">Something went wrong in {this.props.name}</p>
          <button
            className="text-sm text-indigo-400 hover:text-indigo-300 underline"
            onClick={() => this.setState({ hasError: false })}
          >
            Click to retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Wrap components in LiveSessionPage.tsx**

Import `SectionErrorBoundary` and wrap the key children:

```typescript
import { SectionErrorBoundary } from '@/components/ErrorBoundary';

// In the render, wrap each section:
// Where <VideoRoom /> is rendered:
<SectionErrorBoundary name="Video">
  <VideoRoom />
</SectionErrorBoundary>

// Where <Lobby /> is rendered:
<SectionErrorBoundary name="Lobby">
  <Lobby />
</SectionErrorBoundary>

// Where <RatingPrompt /> is rendered:
<SectionErrorBoundary name="Rating">
  <RatingPrompt />
</SectionErrorBoundary>

// Where <ChatPanel /> is rendered:
<SectionErrorBoundary name="Chat">
  <ChatPanel />
</SectionErrorBoundary>
```

- [ ] **Step 3: Cap chat messages at 200 in sessionStore.ts (FIX 4E)**

In `sessionStore.ts`, modify `addChatMessage` (line 204):

```typescript
// BEFORE:
addChatMessage: (msg) => set((state) => ({
  chatMessages: [...state.chatMessages, msg],
  unreadChatCount: state.chatOpen ? state.unreadChatCount : state.unreadChatCount + 1,
})),

// AFTER:
addChatMessage: (msg) => set((state) => {
  const messages = [...state.chatMessages, msg];
  // FIX 4E: Cap at 200 messages
  if (messages.length > 200) {
    messages.splice(0, messages.length - 200);
  }
  return {
    chatMessages: messages,
    unreadChatCount: state.chatOpen ? state.unreadChatCount : state.unreadChatCount + 1,
  };
}),
```

- [ ] **Step 4: Verify client compiles**

```bash
cd client && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ErrorBoundary.tsx client/src/features/live/LiveSessionPage.tsx client/src/stores/sessionStore.ts
git commit -m "fix: add section error boundaries + cap chat at 200 messages"
```

---

## Task 12: Full build verification and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Full server build**

```bash
cd server && npm run build 2>&1 | tail -20
```

Expected: Clean build with no errors.

- [ ] **Step 2: Full client build**

```bash
cd client && npm run build 2>&1 | tail -20
```

Expected: Clean build with no errors.

- [ ] **Step 3: Run server lint**

```bash
cd server && npm run lint 2>&1 | tail -20
```

- [ ] **Step 4: Run client lint**

```bash
cd client && npm run lint 2>&1 | tail -20
```

- [ ] **Step 5: Verify all socket event names match between server and client**

Quick grep to ensure no event name mismatches introduced during split:

```bash
# Server-side emits
grep -rn "\.emit('" server/src/services/orchestration/ | grep -oP "emit\('\K[^']*" | sort -u

# Client-side listeners
grep -rn "socket\.on('" client/src/hooks/useSessionSocket.ts | grep -oP "on\('\K[^']*" | sort -u
```

Compare the two lists — every server emit should have a client listener and vice versa.

- [ ] **Step 6: Final commit with all fixes**

If any compilation issues were found and fixed:
```bash
git add -A
git commit -m "fix: resolve build issues from architecture split"
```

- [ ] **Step 7: Push to both branches**

```bash
git push origin staging && git push origin main
```
