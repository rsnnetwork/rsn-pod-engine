# Rating Resilience & Event Lifecycle Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 production bugs: rating submission failures, BG panel off-screen, confusing post-event messaging, missing dynamic round extension.

**Architecture:** Make the rating system tolerant of session state transitions (accept ratings as long as match data exists in DB), protect client-side match data during rating phase, flip BG panel direction, add role-aware post-event messaging, and enable host to add rounds dynamically from closing_lobby state.

**Tech Stack:** TypeScript, React, Socket.IO, PostgreSQL, LiveKit

---

### Task 1: Fix Rating Submission — Server-Side Match Status

**Files:**
- Modify: `server/src/services/rating/rating.service.ts:61-63`

- [ ] **Step 1: Expand ratable match statuses**

The current check rejects ratings when match status isn't `completed`, `active`, or `no_show`. Add `scheduled` and `reassigned` to cover edge cases where rounds end before matches fully activate.

In `server/src/services/rating/rating.service.ts`, replace line 62:
```typescript
if (!['completed', 'active', 'no_show'].includes(match.status)) {
```
with:
```typescript
if (!['completed', 'active', 'no_show', 'scheduled', 'reassigned'].includes(match.status)) {
```

- [ ] **Step 2: Verify the change compiles**

Run: `cd server && npx tsc --noEmit`

---

### Task 2: Fix Rating Submission — Client-Side Match Data Protection

**Files:**
- Modify: `client/src/hooks/useSessionSocket.ts:147-158`

- [ ] **Step 1: Protect match data during rating phase**

The `closing_lobby` handler at line 147 calls `setMatch(null)` immediately, which destroys the matchId that RatingPrompt needs. Fix: check if user is currently in rating phase — if so, DON'T nuke match data. Let RatingPrompt finish naturally.

In `client/src/hooks/useSessionSocket.ts`, replace lines 147-158:
```typescript
      if (data.status === 'closing_lobby') {
        // Closing lobby: clear match data, return to lobby with closing overlay
        store.setLiveKitToken(null, null);
        store.setMatch(null);
        store.setRoomId(null);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setTransitionStatus('session_ending');
        store.setPhase('lobby');
      }
```
with:
```typescript
      if (data.status === 'closing_lobby') {
        const currentState = useSessionStore.getState();
        store.setLiveKitToken(null, null);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setTransitionStatus('session_ending');
        // If user is mid-rating, preserve match data so RatingPrompt can finish.
        // Match data will be cleared when rating completes or window_closed fires.
        if (currentState.phase !== 'rating') {
          store.setMatch(null);
          store.setRoomId(null);
          store.setPhase('lobby');
        }
        // If in rating phase, DON'T change phase — let RatingPrompt finish naturally.
        // The rating:window_closed handler or RatingPrompt's own allDone logic
        // will transition to lobby when rating is complete.
      }
```

- [ ] **Step 2: Same protection for round_transition**

The `round_transition` handler at line 176 also clears match data after 500ms. If user is still rating, that 500ms nuke destroys their data.

In `client/src/hooks/useSessionSocket.ts`, replace lines 176-187:
```typescript
      if (data.status === 'round_transition') {
        clearTimer();
        store.setLiveKitToken(null, null);
        setTimeout(() => { store.setMatch(null); store.setRoomId(null); }, 500);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setTransitionStatus(null);
        store.setHostInLobby(true); // Host triggered the transition — they're back in lobby
        store.setPhase('lobby');
      }
```
with:
```typescript
      if (data.status === 'round_transition') {
        clearTimer();
        store.setLiveKitToken(null, null);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setHostInLobby(true);
        const currentState = useSessionStore.getState();
        if (currentState.phase === 'rating') {
          // User is still rating — don't nuke match data or change phase.
          // rating:window_closed or RatingPrompt allDone will handle cleanup.
          store.setTransitionStatus(null);
        } else {
          setTimeout(() => { store.setMatch(null); store.setRoomId(null); }, 500);
          store.setTransitionStatus(null);
          store.setPhase('lobby');
        }
      }
```

- [ ] **Step 3: Verify the change compiles**

Run: `cd client && npx tsc --noEmit`

---

### Task 3: Fix Rating Submission — Early Exit Race Condition

**Files:**
- Modify: `server/src/services/orchestration/handlers/participant-flow.ts:544-556`

- [ ] **Step 1: Add safety buffer to early exit**

The early exit fires the moment `totalRatings >= expectedRatings`. But there's a timing issue: if the DB count reaches the threshold because match 1's participants all rated, but match 2's participants are mid-submission, the window closes on everyone. Add a 3-second debounce so rapid-fire ratings don't trigger premature closure.

In `server/src/services/orchestration/handlers/participant-flow.ts`, replace lines 544-556:
```typescript
    if (totalRatings >= expectedRatings && expectedRatings > 0) {
      logger.info({ sessionId, roundNumber, totalRatings, expectedRatings }, 'All ratings submitted — ending rating window early');

      // Cancel the existing timer
      if (activeSession.timer) {
        clearTimeout(activeSession.timer);
        activeSession.timer = null;
        activeSession.timerEndsAt = null;
      }

      // Advance immediately
      endRatingWindow(sessionId, roundNumber);
    }
```
with:
```typescript
    if (totalRatings >= expectedRatings && expectedRatings > 0) {
      logger.info({ sessionId, roundNumber, totalRatings, expectedRatings }, 'All ratings submitted — ending rating window early');

      // Cancel the existing round timer
      if (activeSession.timer) {
        clearTimeout(activeSession.timer);
        activeSession.timer = null;
        activeSession.timerEndsAt = null;
      }

      // 3-second grace period: allow in-flight rating submissions to land
      // before advancing. This prevents race conditions where the last
      // rating triggers early-exit while another user is mid-submission.
      activeSession.timer = setTimeout(() => {
        activeSession.timer = null;
        endRatingWindow(sessionId, roundNumber);
      }, 3000);
    }
```

- [ ] **Step 2: Verify the change compiles**

Run: `cd server && npx tsc --noEmit`

---

### Task 4: Fix BG Panel — Open Downward Instead of Upward

**Files:**
- Modify: `client/src/features/live/VideoRoom.tsx:300`
- Modify: `client/src/features/live/Lobby.tsx:312`

- [ ] **Step 1: Fix VideoRoom BG panel direction**

In `client/src/features/live/VideoRoom.tsx`, replace line 300:
```tsx
        <div className="absolute bottom-full left-0 mb-2 bg-white rounded-xl shadow-xl border border-gray-200 p-3 w-72 z-50">
```
with:
```tsx
        <div className="absolute top-full left-0 mt-2 bg-white rounded-xl shadow-xl border border-gray-200 p-3 w-72 z-50">
```

- [ ] **Step 2: Fix Lobby BG panel direction**

In `client/src/features/live/Lobby.tsx`, replace line 312:
```tsx
          <div className="absolute bottom-full right-0 mb-2 bg-white rounded-xl shadow-xl border border-gray-200 p-2 w-56 z-50">
```
with:
```tsx
          <div className="absolute top-full right-0 mt-2 bg-white rounded-xl shadow-xl border border-gray-200 p-2 w-56 z-50">
```

- [ ] **Step 3: Verify the change compiles**

Run: `cd client && npx tsc --noEmit`

---

### Task 5: Fix Post-Event Messaging — Role-Aware "Ending" Text

**Files:**
- Modify: `client/src/features/live/Lobby.tsx:421-433`

- [ ] **Step 1: Replace confusing timer with clear messaging**

In `client/src/features/live/Lobby.tsx`, replace lines 421-433:
```tsx
      {sessionStatus === 'closing_lobby' ? (
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-500/20 text-emerald-400">
            <Sparkles className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Event finished</h2>
          <p className="text-gray-400 text-sm max-w-xs">Preparing your recap...</p>
          {timerSeconds > 0 && (
            <p className="text-sm text-gray-500 mt-2">
              Ending in <span className="text-white font-mono">{timerSeconds}s</span>
            </p>
          )}
        </div>
```
with:
```tsx
      {sessionStatus === 'closing_lobby' ? (
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-500/20 text-emerald-400">
            <Sparkles className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e]">All rounds complete</h2>
          <p className="text-gray-400 text-sm max-w-xs">
            {isHost
              ? 'You can start another round or end the event below.'
              : 'The host will wrap up shortly. Feel free to chat!'}
          </p>
        </div>
```

- [ ] **Step 2: Verify the change compiles**

Run: `cd client && npx tsc --noEmit`

---

### Task 6: Add Dynamic "Start Another Round" — Server-Side

**Files:**
- Modify: `server/src/services/orchestration/handlers/host-actions.ts:210-220` and `245-247`

- [ ] **Step 1: Allow starting round from CLOSING_LOBBY**

In `server/src/services/orchestration/handlers/host-actions.ts`, replace lines 210-220:
```typescript
    // Allow starting round from lobby or transition states
    if (
      activeSession.status !== SessionStatus.LOBBY_OPEN &&
      activeSession.status !== SessionStatus.ROUND_TRANSITION
    ) {
      socket.emit('error', {
        code: 'INVALID_STATE',
        message: 'Can only start a round from the lobby or transition phase',
      });
      return;
    }
```
with:
```typescript
    // Allow starting round from lobby, transition, or closing_lobby (dynamic round extension)
    if (
      activeSession.status !== SessionStatus.LOBBY_OPEN &&
      activeSession.status !== SessionStatus.ROUND_TRANSITION &&
      activeSession.status !== SessionStatus.CLOSING_LOBBY
    ) {
      socket.emit('error', {
        code: 'INVALID_STATE',
        message: 'Can only start a round from the lobby, transition, or closing phase',
      });
      return;
    }
```

- [ ] **Step 2: Fix round number calculation for CLOSING_LOBBY**

In `server/src/services/orchestration/handlers/host-actions.ts`, replace lines 245-247:
```typescript
    const nextRound = activeSession.status === SessionStatus.LOBBY_OPEN
      ? 1
      : activeSession.currentRound + 1;
```
with:
```typescript
    const nextRound = activeSession.status === SessionStatus.LOBBY_OPEN
      ? 1
      : activeSession.currentRound + 1;

    // If starting a round beyond the original plan, extend the total
    if (nextRound > activeSession.config.numberOfRounds) {
      activeSession.config.numberOfRounds = nextRound;
      logger.info({ sessionId: data.sessionId, newTotal: nextRound }, 'Host extended total rounds dynamically');
    }
```

- [ ] **Step 3: Verify the change compiles**

Run: `cd server && npx tsc --noEmit`

---

### Task 7: Add Dynamic "Start Another Round" — Client-Side

**Files:**
- Modify: `client/src/features/live/HostControls.tsx:132-175`

- [ ] **Step 1: Add "Start Another Round" button alongside End Event**

In `client/src/features/live/HostControls.tsx`, replace lines 132-175:
```tsx
  if (isSessionEnding) {
    return (
      <div className="border-t border-gray-200 bg-white">
        {/* Announcement input — available in wrapping-up state */}
        {showBroadcast && (
          <div className="border-b border-gray-200 bg-amber-500/10 px-4 py-3">
            <p className="text-xs font-semibold text-amber-400 mb-2 max-w-4xl mx-auto">Announcement — visible as a banner to all participants</p>
            <div className="max-w-4xl mx-auto flex gap-2">
              <input
                type="text"
                value={broadcastMsg}
                onChange={e => setBroadcastMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendBroadcast()}
                placeholder="Type an announcement..."
                style={{ color: '#000000' }}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                autoFocus
              />
              <Button size="sm" onClick={sendBroadcast} disabled={!broadcastMsg.trim()}>Send</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        <div className="p-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <p className="text-sm text-gray-700 font-medium">All rounds complete — end the event when ready</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send announcement to all">
                <MessageSquare className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="danger" onClick={() => socket?.emit('host:end_session', { sessionId })}>
                <Square className="h-4 w-4 mr-1" /> End Event
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
```
with:
```tsx
  if (isSessionEnding) {
    return (
      <div className="border-t border-gray-200 bg-white">
        {/* Announcement input — available in wrapping-up state */}
        {showBroadcast && (
          <div className="border-b border-gray-200 bg-amber-500/10 px-4 py-3">
            <p className="text-xs font-semibold text-amber-400 mb-2 max-w-4xl mx-auto">Announcement — visible as a banner to all participants</p>
            <div className="max-w-4xl mx-auto flex gap-2">
              <input
                type="text"
                value={broadcastMsg}
                onChange={e => setBroadcastMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendBroadcast()}
                placeholder="Type an announcement..."
                style={{ color: '#000000' }}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                autoFocus
              />
              <Button size="sm" onClick={sendBroadcast} disabled={!broadcastMsg.trim()}>Send</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        <div className="p-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <p className="text-sm text-gray-700 font-medium">All rounds complete</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send announcement to all">
                <MessageSquare className="h-4 w-4" />
              </Button>
              <Button size="sm" onClick={() => {
                if (eligibleCount < 2) {
                  alert(`Need at least 2 participants to start a round (currently ${eligibleCount})`);
                  return;
                }
                socket?.emit('host:start_round', { sessionId });
              }}>
                <Play className="h-4 w-4 mr-1" /> Another Round
              </Button>
              <Button size="sm" variant="danger" onClick={() => socket?.emit('host:end_session', { sessionId })}>
                <Square className="h-4 w-4 mr-1" /> End Event
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
```

- [ ] **Step 2: Verify the change compiles**

Run: `cd client && npx tsc --noEmit`

---

### Task 8: Commit

- [ ] **Step 1: Stage and commit all changes**

```bash
git add server/src/services/rating/rating.service.ts \
       server/src/services/orchestration/handlers/participant-flow.ts \
       server/src/services/orchestration/handlers/host-actions.ts \
       client/src/hooks/useSessionSocket.ts \
       client/src/features/live/VideoRoom.tsx \
       client/src/features/live/Lobby.tsx \
       client/src/features/live/HostControls.tsx
git commit -m "fix: rating resilience + BG panel + post-event UX + dynamic rounds

- Rating: accept ratings in any match status (scheduled, reassigned)
- Rating: protect client match data during rating phase (closing_lobby/round_transition no longer nuke matchId)
- Rating: 3s grace period on early-exit to prevent race condition
- BG panel: flip to open downward (top-full) so it stays in viewport
- Post-event: role-aware messaging (participants see 'host will wrap up', not a broken timer)
- Dynamic rounds: host can start another round after all planned rounds, server extends total dynamically

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Push to staging and main**
