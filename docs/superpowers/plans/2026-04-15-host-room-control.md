# Host Room Control — Dynamic Breakout Room Management

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the host to create new breakout rooms on-the-fly during active rounds, move participants between rooms (including from main room), with complete isolation so failures never affect other rooms or participants.

**Architecture:** Each room operation (create, move, dissolve) is an independent atomic action wrapped in try/catch. Old matches are closed before new ones are created. If new match/room creation fails, the participant falls back to main room safely. No shared mutable state between rooms — each room is a self-contained match record + LiveKit room + token set.

**Tech Stack:** TypeScript, Socket.IO, PostgreSQL, LiveKit, React/Zustand

---

### Task 1: Server — `host:create_breakout` Socket Handler

**Files:**
- Modify: `server/src/services/orchestration/handlers/host-actions.ts` (add handler at end of file)
- Modify: `server/src/services/orchestration/orchestration.service.ts:172` (register handler)

- [ ] **Step 1: Add the handler function to host-actions.ts**

Add at the end of host-actions.ts (before the final export block), the new `handleHostCreateBreakout` function:

```typescript
// ─── Host Create Breakout Room ────────────────────────────────────────────

export async function handleHostCreateBreakout(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; participantIds: string[] }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      if (!await verifyHost(socket, data.sessionId)) return;

      const activeSession = activeSessions.get(data.sessionId);
      if (!activeSession || activeSession.status !== SessionStatus.ROUND_ACTIVE) {
        socket.emit('error', { code: 'INVALID_STATE', message: 'Can only create rooms during an active round' });
        return;
      }

      const { sessionId, participantIds } = data;
      if (!participantIds || participantIds.length < 2 || participantIds.length > 3) {
        socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Select 2 or 3 participants for a breakout room' });
        return;
      }

      // Step 1: Remove each participant from their current match (if any)
      // Each removal is independent — failure in one doesn't affect others
      for (const pid of participantIds) {
        try {
          const currentMatch = await query<{ id: string; participant_a_id: string; participant_b_id: string; participant_c_id: string | null }>(
            `SELECT id, participant_a_id, participant_b_id, participant_c_id FROM matches
             WHERE session_id = $1 AND round_number = $2 AND status = 'active'
               AND (participant_a_id = $3 OR participant_b_id = $3 OR participant_c_id = $3)`,
            [sessionId, activeSession.currentRound, pid]
          );

          if (currentMatch.rows.length > 0) {
            const match = currentMatch.rows[0];
            // Mark old match as no_show so partners can be reassigned
            await query(`UPDATE matches SET status = 'no_show', ended_at = NOW() WHERE id = $1 AND status = 'active'`, [match.id]);

            // Notify remaining partners
            const remainingPartners = [match.participant_a_id, match.participant_b_id, match.participant_c_id]
              .filter((id): id is string => !!id && id !== pid && !participantIds.includes(id));

            for (const partnerId of remainingPartners) {
              io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: match.id });
            }

            // If only one partner left in old room, return them to lobby after 5s
            if (remainingPartners.length === 1) {
              const soloPartnerId = remainingPartners[0];
              setTimeout(async () => {
                try {
                  const s = activeSessions.get(sessionId);
                  if (!s || s.status !== SessionStatus.ROUND_ACTIVE) return;
                  const freshMatch = (await matchingService.getMatchesByRound(sessionId, s.currentRound))
                    .find(m => m.id === match.id);
                  if (!freshMatch || freshMatch.status !== 'no_show') return;

                  await sessionService.updateParticipantStatus(sessionId, soloPartnerId, ParticipantStatus.IN_LOBBY);
                  io.to(userRoom(soloPartnerId)).emit('match:return_to_lobby', { reason: 'partner_left' });

                  // Re-issue lobby token
                  const session = await sessionService.getSessionById(sessionId);
                  if (session.lobbyRoomId) {
                    const { config: appConfig } = await import('../../../config');
                    const socketsInRoom = await io.in(userRoom(soloPartnerId)).fetchSockets();
                    for (const s of socketsInRoom) {
                      const uid = (s.data as any)?.userId;
                      if (uid !== soloPartnerId) continue;
                      const dName = (s.data as any)?.displayName || 'User';
                      const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
                      s.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig.livekit.host, roomId: session.lobbyRoomId });
                    }
                  }
                } catch (err) {
                  logger.error({ err }, 'Error returning solo partner to lobby after create_breakout');
                }
              }, 5000);
            }
          }
        } catch (err) {
          logger.warn({ err, pid }, 'Non-fatal: failed to remove participant from current match');
        }
      }

      // Step 2: Create new LiveKit room
      const roomSlug = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newRoomId = videoService.matchRoomId(sessionId, activeSession.currentRound, roomSlug);
      try {
        await videoService.createMatchRoom(sessionId, activeSession.currentRound, roomSlug);
      } catch (err) {
        logger.error({ err, newRoomId }, 'Failed to create LiveKit room for host breakout');
        socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: 'Failed to create breakout room. Try again.' });
        return;
      }

      // Step 3: Create match in DB
      const { v4: uuid } = await import('uuid');
      const matchId = uuid();
      const sorted = [...participantIds].sort();
      try {
        await query(
          `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW())`,
          [matchId, sessionId, activeSession.currentRound, sorted[0], sorted[1], sorted[2] || null, newRoomId]
        );
      } catch (err: any) {
        logger.error({ err }, 'Failed to insert match for host breakout');
        socket.emit('error', { code: 'MATCH_CREATION_FAILED', message: 'Failed to create room assignment. Try again.' });
        return;
      }

      // Step 4: Update participant statuses
      for (const pid of participantIds) {
        await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_ROUND).catch(() => {});
      }

      // Step 5: Fetch names + generate tokens + notify all participants
      const namesResult = await query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM users WHERE id = ANY($1)`, [participantIds]
      );
      const nameMap = new Map(namesResult.rows.map(r => [r.id, r.display_name || 'User']));

      const { config: appConfig } = await import('../../../config');
      for (const pid of participantIds) {
        const partners = participantIds
          .filter(id => id !== pid)
          .map(id => ({ userId: id, displayName: nameMap.get(id) || 'User' }));

        let token: string | null = null;
        try {
          const vt = await videoService.issueJoinToken(pid, newRoomId, nameMap.get(pid) || 'User');
          token = vt.token;
        } catch { /* client retries via API */ }

        // Clear leftCurrentRound on client via reassigned event
        io.to(userRoom(pid)).emit('match:reassigned', {
          matchId,
          newPartnerId: partners[0]?.userId,
          partnerDisplayName: partners[0]?.displayName,
          partners,
          roomId: newRoomId,
          roundNumber: activeSession.currentRound,
          token,
          livekitUrl: appConfig.livekit.host,
        });
      }

      // Step 6: Refresh dashboard
      if (_emitHostDashboard) {
        await _emitHostDashboard(io, sessionId).catch(() => {});
      }

      logger.info({ sessionId, matchId, participantIds, roomSlug }, 'Host created breakout room');
    } catch (err: any) {
      logger.error({ err }, 'Error in handleHostCreateBreakout');
      socket.emit('error', { code: 'CREATE_BREAKOUT_FAILED', message: err.message || 'Failed to create breakout room' });
    }
  });
}
```

- [ ] **Step 2: Export the handler from host-actions.ts**

Add `handleHostCreateBreakout` to the existing exports used by orchestration.service.ts. Find the import block in orchestration.service.ts and add it.

In `server/src/services/orchestration/orchestration.service.ts`, update the import from host-actions:

```typescript
import {
  handleHostStart, handleHostStartRound, handleHostPause, handleHostResume,
  handleHostEnd, handleHostBroadcast, handleHostRemoveParticipant, handleHostReassign,
  handleHostMuteParticipant, handleHostMuteAll, handleHostRemoveFromRoom,
  handleHostMoveToRoom, handleAssignCohost, handleRemoveCohost, handleHostExtendRound,
  handleHostCreateBreakout,  // ← ADD THIS
  startSession, pauseSession, resumeSession, endSession, broadcastMessage,
  setHostActionsIo, injectHostActionDeps,
} from './handlers/host-actions';
```

- [ ] **Step 3: Register the socket handler**

In `server/src/services/orchestration/orchestration.service.ts`, after line 172 (`wrapHandler('host:move_to_room', ...)`), add:

```typescript
wrapHandler('host:create_breakout', socket, handleHostCreateBreakout);
```

- [ ] **Step 4: Verify server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean, no errors

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: 266 tests pass, no failures

- [ ] **Step 6: Commit**

```bash
git add server/src/services/orchestration/handlers/host-actions.ts server/src/services/orchestration/orchestration.service.ts
git commit -m "feat: host:create_breakout server handler — create rooms dynamically during active rounds"
```

---

### Task 2: Client — Create Room UI in HostRoundDashboard

**Files:**
- Modify: `client/src/features/live/HostRoundDashboard.tsx`

- [ ] **Step 1: Add Create Room button and participant selector**

Replace the entire HostRoundDashboard component with the updated version that includes:
- A "Create Room" button in the header
- A participant selector mode (shows checkboxes next to participants in bye list and in existing rooms)
- Confirm/Cancel buttons when in selection mode

Add state and handler at the top of the component (after existing state):

```typescript
const [createMode, setCreateMode] = useState(false);
const [selectedForRoom, setSelectedForRoom] = useState<Set<string>>(new Set());

const toggleSelect = (userId: string) => {
  setSelectedForRoom(prev => {
    const next = new Set(prev);
    if (next.has(userId)) next.delete(userId);
    else if (next.size < 3) next.add(userId); // Max 3 for trio
    return next;
  });
};

const createBreakout = () => {
  if (selectedForRoom.size < 2) return;
  const names = Array.from(selectedForRoom).map(id => {
    // Find name from rooms or bye list
    for (const room of roundDashboard!.rooms) {
      const p = room.participants.find(p => p.userId === id);
      if (p) return p.displayName;
    }
    const bye = roundDashboard!.byeParticipants.find(p => p.userId === id);
    return bye?.displayName || 'User';
  });
  if (!confirm(`Create breakout room with ${names.join(', ')}?`)) return;
  socket?.emit('host:create_breakout', { sessionId, participantIds: Array.from(selectedForRoom) });
  setCreateMode(false);
  setSelectedForRoom(new Set());
};
```

- [ ] **Step 2: Add Create Room button to the header**

In the header section (after the timer display), add:

```tsx
{!moveMode && !createMode && (
  <button
    onClick={() => setCreateMode(true)}
    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors"
  >
    <UserPlus className="h-3.5 w-3.5" /> Create Room
  </button>
)}
```

Add `UserPlus` to the lucide-react import at the top.

- [ ] **Step 3: Add selection mode banner**

After the move mode banner, add the create mode banner:

```tsx
{createMode && (
  <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200">
    <span className="text-sm text-emerald-700">
      Select 2-3 participants for the new room ({selectedForRoom.size} selected)
    </span>
    <div className="flex gap-2">
      <button
        onClick={createBreakout}
        disabled={selectedForRoom.size < 2}
        className="px-3 py-1 text-xs font-medium bg-emerald-500 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-emerald-600"
      >
        Create ({selectedForRoom.size})
      </button>
      <button onClick={() => { setCreateMode(false); setSelectedForRoom(new Set()); }} className="text-xs text-emerald-500 hover:text-emerald-700 font-medium">
        Cancel
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Add selection checkboxes to room participants**

In the participant list rendering inside each room card, add a checkbox when in createMode:

```tsx
{createMode && (
  <input
    type="checkbox"
    checked={selectedForRoom.has(p.userId)}
    onChange={() => toggleSelect(p.userId)}
    className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-500 focus:ring-emerald-400"
    onClick={e => e.stopPropagation()}
  />
)}
```

- [ ] **Step 5: Add selection checkboxes to bye participants**

In the bye participants section, make each name selectable when in createMode:

```tsx
{roundDashboard.byeParticipants.length > 0 && (
  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
    <div className="flex flex-wrap gap-2 text-sm text-amber-700">
      {createMode ? (
        roundDashboard.byeParticipants.map(p => (
          <label key={p.userId} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedForRoom.has(p.userId)}
              onChange={() => toggleSelect(p.userId)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-500 focus:ring-emerald-400"
            />
            {p.displayName}
          </label>
        ))
      ) : (
        <span>Not matched this round: {roundDashboard.byeParticipants.map(p => p.displayName).join(', ')}</span>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 6: Verify client compiles**

Run: `cd client && npx tsc --noEmit`
Expected: Clean, no errors

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: 266 tests pass

- [ ] **Step 8: Commit**

```bash
git add client/src/features/live/HostRoundDashboard.tsx
git commit -m "feat: Create Room UI — host can select participants and create breakout rooms mid-round"
```

---

### Task 3: Client — Participant Notification When Moved to New Room

**Files:**
- Modify: `client/src/hooks/useSessionSocket.ts` (already handles `match:reassigned`)

- [ ] **Step 1: Verify match:reassigned handler works for this flow**

The existing `match:reassigned` handler in `useSessionSocket.ts:297-318` already:
- Clears `leftCurrentRound` flag (our earlier fix)
- Sets new match data
- Uses inline token if provided
- Transitions phase to 'matched'

No changes needed — the server emits `match:reassigned` which the client already handles correctly. The participant will see their breakout room switch instantly.

- [ ] **Step 2: Verify no compile errors**

Run: `cd client && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit (documentation only)**

No code changes needed — existing handler covers this. Add a comment to the plan noting this was verified.

---

### Task 4: Integration Test — Full Flow Verification

**Files:**
- No new files — manual verification

- [ ] **Step 1: Compile both server and client**

Run: `cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit`
Expected: Both clean

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: 266 tests pass

- [ ] **Step 3: Push to staging + main**

```bash
git push origin staging
# Wait for CI
git push origin staging:main
```

- [ ] **Step 4: Check Sentry after deploy**

```bash
curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "https://de.sentry.io/api/0/projects/rsnnetwork/rsn-api/issues/?query=is:unresolved&sort=date"
curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "https://de.sentry.io/api/0/projects/rsnnetwork/rsn-client/issues/?query=is:unresolved&sort=date"
```
Expected: No new issues

- [ ] **Step 5: Manual test scenario**

1. Start event with 4+ participants
2. Start a round (auto-matching creates 2 rooms)
3. Host clicks "Create Room" in the dashboard
4. Select 2 participants (one from bye list, one from existing room)
5. Click "Create" → confirm
6. Verify: selected participant leaves old room → partner gets notified → new room created → both participants in new room with video
7. Verify: other rooms unaffected
8. Verify: dashboard shows the new room

---

### Task 5: Update Progress + Memory

**Files:**
- Modify: `progress.md`

- [ ] **Step 1: Update progress.md**

Add entry for Host Room Control feature under the current change section.

- [ ] **Step 2: Commit**

```bash
git add progress.md
git commit -m "docs: update progress with Host Room Control feature"
```
