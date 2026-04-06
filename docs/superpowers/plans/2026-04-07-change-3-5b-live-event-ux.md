# Change 3.5B: Live Event UX Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 client-reported live event UX issues: stale messages, camera toggle, heart→handshake, trio layout, timer visibility, rating flow overhaul, closing lobby countdown.

**Architecture:** Targeted fixes across client components and one server-side rating timer extension. Rating flow gets per-partner timer scaling and a new late-rating endpoint. All changes are forward-compatible with Phase 2 (Redis) architecture.

**Tech Stack:** React 18, Zustand 5, Socket.IO, LiveKit, Express, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-04-07-change-3-5b-live-event-ux-design.md`

---

## File Map

### Modified Files
| File | Changes |
|------|---------|
| `client/src/features/live/Lobby.tsx` | Replace "Main Room"→"Lobby", "All Rounds Complete!"→"Event wrapping up", goodbye text, add closing countdown |
| `client/src/features/live/VideoRoom.tsx` | Replace "main room"→"lobby", fix trio grid, add "Last 30s!" overlay |
| `client/src/features/live/LiveSessionPage.tsx` | Replace "Main Room" in state config |
| `client/src/features/live/HostControls.tsx` | Replace "main room"→"lobby" |
| `client/src/features/live/RatingPrompt.tsx` | Heart→Handshake, pink→indigo, "main room"→"lobby" |
| `client/src/features/sessions/RecapPage.tsx` | Heart→Handshake everywhere, pink/rsn-red→indigo |
| `client/src/hooks/useSessionSocket.ts` | rating:window_closed 3s grace period |
| `client/src/stores/sessionStore.ts` | timerVisibility default: 'last_10s'→'always_visible' |
| `server/src/services/orchestration/handlers/round-lifecycle.ts` | Scale rating timer by partnerCount |
| `server/src/routes/ratings.ts` | New GET /ratings/unrated endpoint |
| `server/src/services/rating/rating.service.ts` | New getUnratedPartners() query |

---

## Task 1: Replace all "Main Room" / "main room" text

**Files:**
- Modify: `client/src/features/live/Lobby.tsx:407-408,462-466,675`
- Modify: `client/src/features/live/VideoRoom.tsx:299,448,453,455`
- Modify: `client/src/features/live/LiveSessionPage.tsx:264,267`
- Modify: `client/src/features/live/HostControls.tsx:339,347,363`
- Modify: `client/src/features/live/RatingPrompt.tsx:126`

- [ ] **Step 1: Fix Lobby.tsx**

In `Lobby.tsx`:
- Line 407: `"All Rounds Complete!"` → `"Event wrapping up"`
- Line 408: `"Take a moment to say your goodbyes. The host will end the event shortly."` → `"Say your goodbyes before the event ends."`
- Line 462: `"Main Room"` → `"Lobby"`
- Line 466: `"You're in the main room. The host will start matching shortly."` → `"The host will start matching shortly."`
- Line 675: `"you'll enter the main room"` → `"you'll enter the lobby"`

- [ ] **Step 2: Fix VideoRoom.tsx**

- Line 299: `"Returning to main room"` → `"Returning to lobby"`
- Line 448: `"Return to the main room?"` → `"Return to the lobby?"`
- Line 453: `"You can return to the main room at any time"` → `"You can return to the lobby at any time"`
- Line 455: `"Return to Main Room"` → `"Return to Lobby"`

- [ ] **Step 3: Fix LiveSessionPage.tsx**

- Line 264: `"Main Room — waiting for host to start round"` → `"Lobby — waiting for host to start round"`
- Line 267: `"Back in main room"` → `"Back in lobby"`

- [ ] **Step 4: Fix HostControls.tsx**

- Line 339: `"in main room"` → `"in lobby"`
- Line 347: `"in main room"` → `"in lobby"`
- Line 363: `"Main Room"` → `"Lobby"`

- [ ] **Step 5: Fix RatingPrompt.tsx**

- Line 126: `"Returning to main room..."` → `"Returning to lobby..."`

- [ ] **Step 6: Verify no remaining "main room" references**

```bash
grep -rn "main room\|Main Room\|main Room" client/src/ --include="*.tsx" --include="*.ts"
```

Expected: Zero results.

- [ ] **Step 7: Verify client compiles**

```bash
cd client && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 8: Commit**

```bash
git add client/src/features/live/Lobby.tsx client/src/features/live/VideoRoom.tsx client/src/features/live/LiveSessionPage.tsx client/src/features/live/HostControls.tsx client/src/features/live/RatingPrompt.tsx
git commit -m "fix: replace all 'Main Room' text with 'Lobby' — remove stale messages"
```

---

## Task 2: Heart → Handshake (Rating + Recap)

**Files:**
- Modify: `client/src/features/live/RatingPrompt.tsx:5,80-81,83,116-119`
- Modify: `client/src/features/sessions/RecapPage.tsx:8,46-47,215-217,232-234,250-254,272`

- [ ] **Step 1: Fix RatingPrompt.tsx imports and icons**

Replace import at line 5:
```typescript
// BEFORE:
import { Star, CheckCircle, Loader2, Clock, Heart } from 'lucide-react';
// AFTER:
import { Star, CheckCircle, Loader2, Clock, Handshake } from 'lucide-react';
```

Replace "Would you meet again?" button (lines 77-85):
```typescript
<button
  onClick={() => setMeetAgain(!meetAgain)}
  className={`flex items-center justify-center gap-2.5 w-full py-3 rounded-xl border-2 transition-all mb-5 text-base font-medium ${
    meetAgain ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400' : 'border-white/10 text-gray-400 hover:border-white/20'
  }`}
>
  <Handshake className={`h-5 w-5 ${meetAgain ? 'text-indigo-400' : ''}`} />
  {meetAgain ? 'Would meet again!' : 'Would you meet again?'}
</button>
```

Replace confirmation (lines 116-120):
```typescript
<div className="flex items-center justify-center gap-2 mt-2 px-4 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
  <Handshake className="h-4 w-4 text-indigo-400" />
  <p className="text-sm text-indigo-300">
    You want to meet again! We'll let you know if it's mutual.
  </p>
</div>
```

- [ ] **Step 2: Fix RecapPage.tsx imports**

Replace Heart with Handshake in import at line 8:
```typescript
// BEFORE:
import { CheckCircle, Users, Star, Heart, ArrowLeft, Calendar, Download, UserCheck, CircleDot } from 'lucide-react';
// AFTER:
import { CheckCircle, Users, Star, Handshake, ArrowLeft, Calendar, Download, UserCheck, CircleDot } from 'lucide-react';
```

- [ ] **Step 3: Fix RecapPage.tsx InterestBadge (line 46)**

```typescript
// BEFORE:
<Heart className="h-3 w-3 fill-rsn-red" />
// AFTER:
<Handshake className="h-3 w-3 text-indigo-500" />
```

- [ ] **Step 4: Fix RecapPage.tsx stat cards (lines 215-217, 232-234)**

Host stat card:
```typescript
// BEFORE:
<Heart className="h-5 w-5 text-rsn-red mx-auto mb-1" />
// AFTER:
<Handshake className="h-5 w-5 text-indigo-500 mx-auto mb-1" />
```

Participant stat card:
```typescript
// BEFORE:
<Heart className="h-5 w-5 text-rsn-red mx-auto mb-1" />
// AFTER:
<Handshake className="h-5 w-5 text-indigo-500 mx-auto mb-1" />
```

- [ ] **Step 5: Fix RecapPage.tsx mutual matches section header (lines 252-254)**

```typescript
// BEFORE:
<h3 className="text-sm font-semibold text-rsn-red uppercase tracking-wider mb-4 flex items-center gap-2">
  <Heart className="h-4 w-4 fill-rsn-red" />
  Mutual Matches — You both said "meet again"!
// AFTER:
<h3 className="text-sm font-semibold text-indigo-500 uppercase tracking-wider mb-4 flex items-center gap-2">
  <Handshake className="h-4 w-4 text-indigo-500" />
  Mutual Matches — You both said "meet again"!
```

- [ ] **Step 6: Fix RecapPage.tsx mutual connection card styling (lines 258, 272)**

Replace `rsn-red` color classes with `indigo-500`:
- Line 258: `bg-rsn-red/5 border border-rsn-red/20` → `bg-indigo-500/5 border border-indigo-500/20`
- Line 272: `<Heart className="h-4 w-4 text-rsn-red fill-rsn-red" />` → `<Handshake className="h-4 w-4 text-indigo-500" />`

- [ ] **Step 7: Verify no remaining Heart references in rating/recap**

```bash
grep -n "Heart" client/src/features/live/RatingPrompt.tsx client/src/features/sessions/RecapPage.tsx
```

Expected: Zero results.

- [ ] **Step 8: Verify client compiles + commit**

```bash
cd client && npx tsc --noEmit 2>&1 | head -20
git add client/src/features/live/RatingPrompt.tsx client/src/features/sessions/RecapPage.tsx
git commit -m "fix: replace heart icons with handshake — professional networking, not dating"
```

---

## Task 3: Camera toggle fix + Trio grid layout

**Files:**
- Modify: `client/src/features/live/VideoRoom.tsx:130,181-184`
- Modify: `client/src/features/live/Lobby.tsx:226-244`

- [ ] **Step 1: Fix trio grid layout in VideoRoom.tsx**

At line 130, change the trio grid class:
```typescript
// BEFORE:
<div className={`h-full grid gap-4 ${isTrio ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}>
// AFTER:
<div className={`h-full grid gap-4 ${isTrio ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'}`}>
```

- [ ] **Step 2: Fix VideoRoom.tsx camera toggle (lines 181-184)**

Replace the zero-error-handling toggle:
```typescript
// BEFORE:
const toggleCam = useCallback(async () => {
  await localParticipant.setCameraEnabled(!camEnabled);
  setCamEnabled(!camEnabled);
}, [localParticipant, camEnabled]);

// AFTER:
const toggleCam = useCallback(async () => {
  try {
    const target = !camEnabled;
    await localParticipant.setCameraEnabled(target);
    setCamEnabled(localParticipant.isCameraEnabled);
  } catch (err) {
    console.error('Camera toggle failed, retrying:', err);
    try {
      for (const pub of localParticipant.videoTrackPublications.values()) {
        if (pub.track) await localParticipant.unpublishTrack(pub.track);
      }
      if (!camEnabled) {
        await localParticipant.setCameraEnabled(true);
      }
    } catch { /* retry failed */ }
    setCamEnabled(localParticipant.isCameraEnabled);
  }
}, [localParticipant, camEnabled]);
```

- [ ] **Step 3: Fix Lobby.tsx camera toggle (lines 226-244)**

Replace the error handler's state revert with track-based sync:
```typescript
// In the catch block at line 244, replace:
} catch { setCamEnabled(camEnabled); }
// With:
} catch { setCamEnabled(localParticipant.isCameraEnabled); }
```

- [ ] **Step 4: Add camera state sync on mount in both components**

In both Lobby.tsx and VideoRoom.tsx, wherever `camEnabled` state is initialized, add a useEffect:
```typescript
useEffect(() => {
  if (localParticipant) {
    setCamEnabled(localParticipant.isCameraEnabled);
  }
}, [localParticipant]);
```

- [ ] **Step 5: Verify client compiles + commit**

```bash
cd client && npx tsc --noEmit 2>&1 | head -20
git add client/src/features/live/VideoRoom.tsx client/src/features/live/Lobby.tsx
git commit -m "fix: camera toggle syncs from LiveKit track, trio grid shows 3 columns"
```

---

## Task 4: Timer visibility default + "Last 30s!" overlay

**Files:**
- Modify: `client/src/stores/sessionStore.ts:159,247`
- Modify: `client/src/features/live/VideoRoom.tsx:473-499`

- [ ] **Step 1: Fix sessionStore.ts default**

Line 159 and 247, change both:
```typescript
// BEFORE:
timerVisibility: 'last_10s',
// AFTER:
timerVisibility: 'always_visible',
```

- [ ] **Step 2: Add "Last 30 seconds!" overlay in VideoRoom.tsx**

In the timer display section (around line 491), add a pulsing warning when timer crosses 30s. Find the timer display and add ABOVE it:
```typescript
{!isHost && timerSeconds > 0 && timerSeconds <= 30 && (
  <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-amber-500/90 text-white text-sm font-bold px-4 py-1.5 rounded-full animate-pulse z-10">
    Last {timerSeconds} seconds!
  </div>
)}
```

- [ ] **Step 3: Verify client compiles + commit**

```bash
cd client && npx tsc --noEmit 2>&1 | head -20
git add client/src/stores/sessionStore.ts client/src/features/live/VideoRoom.tsx
git commit -m "fix: timer visible by default, add 'Last 30 seconds!' pulse overlay"
```

---

## Task 5: Rating flow — extend timer for trios (server)

**Files:**
- Modify: `server/src/services/orchestration/handlers/round-lifecycle.ts:405-412`

- [ ] **Step 1: Scale rating duration by partner count**

In `round-lifecycle.ts`, find where `rating:window_open` is emitted (around line 405). Before the emit, calculate scaled duration:

```typescript
// Calculate partner count for this match
const partnerCount = partnersWithNames.length;
// Scale rating window: 30s per partner (instead of 30s total for all)
const scaledDuration = (activeSession.config.ratingWindowSeconds || 30) * Math.max(1, partnerCount);
```

Then in the emit, replace `durationSeconds`:
```typescript
io.to(userRoom(pid)).emit('rating:window_open', {
  matchId: match.id,
  partnerId: partnerIds[0],
  partnerDisplayName: ratingNameMap.get(partnerIds[0]) || 'Partner',
  partners: partnersWithNames,
  roundNumber,
  durationSeconds: scaledDuration,  // WAS: activeSession.config.ratingWindowSeconds
  partnerCount,
});
```

Also update the server-side rating timer in `endRound()` to use the maximum possible duration (trio duration) so the server-side window doesn't close before trio users finish. Find where the rating segment timer is started and scale it:

```typescript
// Find the startSegmentTimer call for rating window and change:
const maxPartnerCount = Math.max(...completedMatches.map((m: any) => 
  [m.participant_a_id, m.participant_b_id, m.participant_c_id].filter(Boolean).length - 1
), 1);
const ratingDuration = (activeSession.config.ratingWindowSeconds || 30) * maxPartnerCount;
startSegmentTimer(io, sessionId, ratingDuration, () => endRatingWindow(io, sessionId, roundNumber));
```

- [ ] **Step 2: Verify server compiles + commit**

```bash
cd server && npx tsc --noEmit 2>&1 | head -20
git add server/src/services/orchestration/handlers/round-lifecycle.ts
git commit -m "fix: scale rating timer by partner count — trios get 60s, duos get 30s"
```

---

## Task 6: Rating flow — grace period on window_closed (client)

**Files:**
- Modify: `client/src/hooks/useSessionSocket.ts:374-396`

- [ ] **Step 1: Replace rating:window_closed handler**

Replace the entire handler (lines 374-396) with the grace period version:

```typescript
socket.on('rating:window_closed', () => {
  clearTimer();
  clearRatingFallback();
  clearByeTimeout();
  const state = useSessionStore.getState();
  store.setLastRatedRound(state.currentRound);
  
  // 3-second grace period for in-flight rating submissions
  // Don't nuke match data immediately — let RatingPrompt finish
  setTimeout(() => {
    const current = useSessionStore.getState();
    if (current.phase === 'rating') {
      // Still in rating after grace — force return to lobby
      store.setLiveKitToken(null, null);
      store.setByeRound(false);
      store.setPartnerDisconnected(false);
      store.setMatch(null);
      store.setRoomId(null);
      const isLastRound = current.currentRound >= current.totalRounds && current.totalRounds > 0;
      store.setTransitionStatus(isLastRound ? 'session_ending' : null);
      store.setPhase('lobby');
    }
    // If phase already changed (user finished rating), do nothing — clean exit
  }, 3000);
});
```

Key changes from original:
- Removed immediate `store.setLiveKitToken(null, null)` (was line 378)
- Removed immediate `store.setByeRound(false)` (was line 379)  
- Removed immediate `store.setPartnerDisconnected(false)` (was line 380)
- Removed immediate `store.setPhase('lobby')` (was line 395)
- All cleanup moved INSIDE the 3s timeout
- Added guard: only clean up if still in `'rating'` phase

- [ ] **Step 2: Verify client compiles + commit**

```bash
cd client && npx tsc --noEmit 2>&1 | head -20
git add client/src/hooks/useSessionSocket.ts
git commit -m "fix: 3s grace period on rating:window_closed — no more mid-submission kicks"
```

---

## Task 7: Late rating in Recap page (server endpoint + client)

**Files:**
- Modify: `server/src/services/rating/rating.service.ts`
- Modify: `server/src/routes/ratings.ts`
- Modify: `client/src/features/sessions/RecapPage.tsx`

- [ ] **Step 1: Add getUnratedPartners query in rating.service.ts**

Add at the bottom of the file:
```typescript
/**
 * Get partners the user hasn't rated yet for a given session.
 * Only returns results for completed/closing_lobby sessions.
 */
export async function getUnratedPartners(sessionId: string, userId: string): Promise<{
  matchId: string;
  partnerId: string;
  partnerDisplayName: string;
  roundNumber: number;
}[]> {
  const result = await query<{
    match_id: string;
    partner_id: string;
    partner_display_name: string;
    round_number: number;
  }>(`
    SELECT
      m.id AS match_id,
      CASE
        WHEN m.participant_a_id = $2 THEN m.participant_b_id
        WHEN m.participant_b_id = $2 THEN m.participant_a_id
        ELSE m.participant_a_id
      END AS partner_id,
      u.display_name AS partner_display_name,
      m.round_number
    FROM matches m
    JOIN sessions s ON s.id = m.session_id
    JOIN users u ON u.id = CASE
      WHEN m.participant_a_id = $2 THEN m.participant_b_id
      WHEN m.participant_b_id = $2 THEN m.participant_a_id
      ELSE m.participant_a_id
    END
    WHERE m.session_id = $1
      AND (m.participant_a_id = $2 OR m.participant_b_id = $2 OR m.participant_c_id = $2)
      AND m.status IN ('completed', 'no_show')
      AND s.status IN ('completed', 'closing_lobby')
      AND NOT EXISTS (
        SELECT 1 FROM ratings r
        WHERE r.match_id = m.id
          AND r.from_user_id = $2
          AND r.to_user_id = CASE
            WHEN m.participant_a_id = $2 THEN m.participant_b_id
            WHEN m.participant_b_id = $2 THEN m.participant_a_id
            ELSE m.participant_a_id
          END
      )
    ORDER BY m.round_number
  `, [sessionId, userId]);

  return result.rows.map(r => ({
    matchId: r.match_id,
    partnerId: r.partner_id,
    partnerDisplayName: r.partner_display_name,
    roundNumber: r.round_number,
  }));
}
```

Note: This handles duo matches. For trio matches where a user has rated partner A but not partner B, we'd need a UNION for participant_c. Read the existing trio logic in the file and extend accordingly. The implementer should check if `participant_c_id` is used and add a second UNION branch if so.

- [ ] **Step 2: Add GET /ratings/unrated endpoint in ratings.ts**

Add after the existing endpoints:
```typescript
// GET /ratings/unrated?sessionId=X — get partners the user hasn't rated
router.get('/unrated', authenticate, async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });

    const userId = (req as any).user.id;
    const unrated = await ratingService.getUnratedPartners(sessionId, userId);
    res.json({ data: unrated });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Add late rating UI in RecapPage.tsx**

At the top of the recap content (after stats, before mutual matches), add:

```typescript
// Fetch unrated partners
const { data: unratedData } = useQuery({
  queryKey: ['unrated-partners', sessionId],
  queryFn: () => api.get(`/ratings/unrated?sessionId=${sessionId}`).then(r => r.data.data),
  enabled: !!sessionId,
});

// In the render, before the mutual matches section:
{unratedData && unratedData.length > 0 && (
  <Card className="border-amber-500/30 bg-amber-500/5">
    <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
      <Star className="h-4 w-4" />
      You have unrated conversations
    </h3>
    <div className="space-y-3">
      {unratedData.map((partner: any) => (
        <LateRatingForm
          key={`${partner.matchId}-${partner.partnerId}`}
          matchId={partner.matchId}
          partnerId={partner.partnerId}
          partnerName={partner.partnerDisplayName}
          roundNumber={partner.roundNumber}
          onRated={() => qc.invalidateQueries({ queryKey: ['unrated-partners', sessionId] })}
        />
      ))}
    </div>
  </Card>
)}
```

Add the `LateRatingForm` component inside RecapPage.tsx (or extract to a small component):
```typescript
function LateRatingForm({ matchId, partnerId, partnerName, roundNumber, onRated }: {
  matchId: string; partnerId: string; partnerName: string; roundNumber: number; onRated: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [meetAgain, setMeetAgain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const { addToast } = useToastStore();

  if (done) return null;

  const submit = async () => {
    if (rating === 0) return;
    setSubmitting(true);
    try {
      await api.post('/ratings', { matchId, qualityScore: rating, meetAgain, toUserId: partnerId });
      addToast(`Rated ${partnerName}!`, 'success');
      setDone(true);
      onRated();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Failed to submit', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-4 p-3 rounded-xl bg-[#292a2d]">
      <div className="flex-1">
        <p className="text-sm text-white font-medium">{partnerName}</p>
        <p className="text-xs text-gray-500">Round {roundNumber}</p>
      </div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onClick={() => setRating(n)}>
            <Star className={`h-5 w-5 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-600'}`} />
          </button>
        ))}
      </div>
      <button
        onClick={() => setMeetAgain(!meetAgain)}
        className={`p-2 rounded-lg border ${meetAgain ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/10'}`}
      >
        <Handshake className={`h-4 w-4 ${meetAgain ? 'text-indigo-400' : 'text-gray-500'}`} />
      </button>
      <Button size="sm" onClick={submit} isLoading={submitting} disabled={rating === 0}>
        Rate
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Verify both compile + commit**

```bash
cd server && npx tsc --noEmit 2>&1 | head -20
cd client && npx tsc --noEmit 2>&1 | head -20
git add server/src/services/rating/rating.service.ts server/src/routes/ratings.ts client/src/features/sessions/RecapPage.tsx
git commit -m "feat: late rating in Recap page — never lose unrated conversations"
```

---

## Task 8: Closing lobby countdown

**Files:**
- Modify: `client/src/features/live/Lobby.tsx:407-408`

- [ ] **Step 1: Add countdown to closing lobby section**

In Lobby.tsx, the closing lobby section (around line 407) already shows "Event wrapping up" (after Task 1). Add the timer:

```typescript
// Replace the closing_lobby section with:
{sessionStatus === 'closing_lobby' && (
  <>
    <Sparkles className="h-8 w-8 text-emerald-400" />
    <h2 className="text-xl font-bold text-[#1a1a2e]">Event wrapping up</h2>
    <p className="text-gray-400 text-sm max-w-xs">
      Say your goodbyes before the event ends.
    </p>
    {timerSeconds > 0 && (
      <p className="text-sm text-gray-500 mt-2">
        Ending in <span className="text-white font-mono">{timerSeconds}s</span>
      </p>
    )}
  </>
)}
```

Note: `timerSeconds` must be available in this component. Check if `LobbyStatusOverlay` already reads it from the store. If not, add a selector:
```typescript
const timerSeconds = useSessionStore(s => s.timerSeconds);
```

- [ ] **Step 2: Verify client compiles + commit**

```bash
cd client && npx tsc --noEmit 2>&1 | head -20
git add client/src/features/live/Lobby.tsx
git commit -m "fix: show countdown timer during closing lobby — no more abrupt endings"
```

---

## Task 9: Full build verification + push

**Files:** None (verification only)

- [ ] **Step 1: Full server build**

```bash
cd server && npm run build 2>&1 | tail -10
```

- [ ] **Step 2: Full client build**

```bash
cd client && npm run build 2>&1 | tail -10
```

- [ ] **Step 3: Verify zero "main room" / "Main Room" in client**

```bash
grep -rn "main room\|Main Room" client/src/ --include="*.tsx" --include="*.ts"
```

- [ ] **Step 4: Verify zero Heart imports in rating/recap**

```bash
grep -n "Heart" client/src/features/live/RatingPrompt.tsx client/src/features/sessions/RecapPage.tsx
```

- [ ] **Step 5: Push to both branches**

```bash
git push origin staging && git push origin main
```
