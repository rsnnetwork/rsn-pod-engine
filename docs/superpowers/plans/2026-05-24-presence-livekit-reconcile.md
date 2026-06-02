# Presence reconcile via LiveKit roster — pre-event hardening (24 May 2026)

## Problem (live, recurring)
N participants visibly in the main room, but the matcher pairs fewer of them
(e.g. 7 present → one trio + one pair = 5 matched, 2 dropped). Root cause: the
matcher's eligibility reads DB `session_participants.status`, which is driven by
the 15s socket heartbeat. A backgrounded tab / phone call / locked screen / app
switch throttles or suspends that heartbeat (OS-level, unavoidable), so a still-
present participant gets flagged `disconnected` and excluded — even though their
**LiveKit video** (a separate connection) is alive and their tile still shows.

## Ground truth
`videoService.listParticipants(mainRoomId)` queries LiveKit's own servers for the
room roster — exactly the set of video tiles the host sees. LiveKit identity ==
userId (livekit.provider issueJoinToken `identity: userId`). This signal survives
a backgrounded/laggy control socket. Main room id = `session.lobbyRoomId`.

## Acceptance criteria
- 10–11 participants present in the main room → all 10–11 are matchable, in round
  1 and after rounds 2/3/4, regardless of backgrounding/tab-switch/phone-call.
- Backgrounding (minimize, tab switch, phone call, app switch) never marks a user
  unavailable; only an explicit leave / host kick / event end does.
- A user returning from the background becomes matchable again with no manual
  action in the common case; a reconnect button is only a rare last resort.
- Fail-open: any LiveKit API error falls back to today's behavior — never blocks
  or delays matching.

## Changes

### 1. Server — LiveKit-roster reconcile at match time (the core fix)
File: `server/src/services/orchestration/handlers/matching-flow.ts`,
`handleHostGenerateMatches` reconcile block (currently sockets + presenceMap).
Add the LiveKit main-room roster to the `presentUserIds` set before clearing
stale `disconnected`:
- Fetch `session.lobbyRoomId` (dynamic import sessionService).
- `videoService.listParticipants(lobbyRoomId)` wrapped in `Promise.race` with a
  ~4s timeout, in its OWN inner try/catch (a LiveKit failure must NOT abort the
  existing socket/heartbeat reconcile).
- Add every roster `userId` to `presentUserIds`. The existing stale-clear query
  then flips them to IN_MAIN_ROOM → matchable.

### 2. Client — auto re-sync on return (so they can be commanded again)
File: `client/src/hooks/useSessionSocket.ts`.
On `visibilitychange`→visible, window `focus`, and `online`, re-emit
`session:join` + `presence:ready` (the event that triggers the server's stuck-
status reset) and ensure the socket is connected. Debounced so rapid
focus/visibility flips fire once. Cleaned up on unmount.

### Out of scope for tonight (lower value / higher risk)
- Periodic background LiveKit-roster poll loop (match-time reconcile already
  covers the matching outcome; a new always-on timer adds load + risk).
- A new always-visible reconnect button. The existing reconnect/refresh paths +
  the two changes above cover the common case. (Revisit post-event if needed.)

## Tests
- Source-pattern pins: matching-flow reconcile references `listParticipants` +
  `lobbyRoomId` + fail-open; client has visibilitychange/focus/online → presence
  re-emit.
- Full server suite green; client typecheck clean.

## Risk / safety
- Match-time only (not a hot path); single LiveKit call, timed-out, fail-open.
- Additive: if LiveKit is unreachable the matcher behaves exactly as today.
- No DB schema change, no migration, no change to how pairs are computed.

## Ship
Commit → staging CI → main → Render → verify → checkhole. Night before event —
extra care, full suite before push.
