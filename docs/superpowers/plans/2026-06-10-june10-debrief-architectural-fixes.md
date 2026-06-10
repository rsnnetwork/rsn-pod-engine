# June-10 Debrief — Architectural Fixes for Friday's Big Event

Source: Google Doc "RSN 10062026" (June-10 live-event debrief). Deadline: **Friday's big test (≈12 Jun)**.
Mandate from Ali: proper **architectural** fixes, not patches; nothing else may break; "the event must feel controlled, not clever."

Each root cause below was confirmed by a parallel codebase assessment and the three highest-stakes claims were
hand-verified in source (kick eviction, rating denominator, bonus is_manual filter). Product forks resolved by interview
(2026-06-10) are folded in.

Governing rule: **one fix per deploy** → unit/integration test (red→green) → server typecheck → full server suite →
CI green → Render deploy → **headed prod smoke asserting the outcome** → `/checkhole` → next. No deploy during a live event.

---

## SHARED FOUNDATION (build first — three of the criticals depend on it)

### F1 — Host-configurable entry window ("doors open") + clean pre-start presence
Underpins #1 and #3. Additive, low risk, unlocks the rest.

- **Config:** add `entryWindowMinutes` (default 15) to session config (shared type + a nullable column / config JSON field;
  additive migration). Editable at event creation and in event settings. `0`/null ⇒ no time gate.
- **Authoritative gate helper** (single source of truth): `canEnterEvent(session, user, now)` →
  `{ allowed, reason, opensAt }`. Rules:
  - Host / co-host / super_admin → always allowed (set up early). Uses the canonical `getAllHostIds` host set so it
    can't drift from matching/role logic.
  - Everyone else → allowed only when `now >= scheduledAt - entryWindowMinutes` and event not completed/cancelled.
- **Enforce in both doors:** REST `registerParticipant` / join, AND the socket `session:join` handler — both call
  `canEnterEvent` and reject early arrivals with a typed `ENTRY_WINDOW_NOT_OPEN { opensAt }` (no presenceMap write).
- **Presence/no-show correctness (the "false left/disconnected before start" bug):** pre-start arrivals (hosts setting
  up) must never be written to a round/no-show status. No-show detection keys off **match-room participation within a
  round's grace window** (roomParticipants), not session-wide presence at/before start. A user who never had a round
  cannot be a no-show.
- **Tests:** unit on `canEnterEvent` (host bypass, window math, completed/cancelled); regression that a pre-start lobby
  user is never marked no_show/left.

---

## CRITICAL FIXES (must land before Friday)

### #1 — Invite lands on an event page first, not inside the room with cam/mic open
- **Root cause (verified):** invite-accept hardcodes `redirectTo = /session/:id/live` (invite.service.ts ~456), and the
  live page acquires camera+mic on mount (LiveSessionPage useEffect). No landing page exists.
- **Fix (architectural):**
  - New route `/event/:sessionId` (details/landing): title, host, time, participant count, **"Join Event"** button.
    No LiveKit, no `getUserMedia` here.
  - Invite-accept `computeRedirectTo` for session invites → the landing route (pod invites unchanged).
  - **Join button is gated by F1's `canEnterEvent`:** disabled with a live countdown ("Doors open in 6:12") until the
    host-chosen window; enabled inside it. Click → enter `/session/:id/live`, and only THEN acquire media.
  - Media acquisition moves behind the explicit Join (room mount stays, but is only reached post-Join).
- **Decision applied:** event-info + Join (no device-preview step); Join enablement = host-chosen window.
- **Blast radius:** invite redirect target + any test asserting `/live`; existing in-flight invite links now land on the
  new route (must ship route before redirect change, or same deploy).
- **Prod smoke:** accept an invite → land on `/event/:id` (no camera prompt) → Join disabled before window, enabled
  inside → entering acquires media.

### #2 — Live-event join requests: host approval gate + durable notification
- **Root cause (verified):** `handleJoinSession` auto-registers anyone mid-event; the only join-request infra is
  pre-event/admin; host gets no durable, refresh-surviving signal; late-joiner can sit unmatched.
- **Decision applied:** **host approves each** live join.
- **Fix (architectural):**
  - New durable state: `live_join_requests(session_id, user_id, status pending|approved|denied, requested_at,
    reviewed_by, reviewed_at)`, unique(session,user), partial index on pending. (Distinct from pre-event join_requests.)
  - Join flow: if session is live (ROUND_ACTIVE+ / past lobby), `session:join` creates a **pending** request instead of
    registering; the user gets a "waiting for host" state.
  - Real-time + durable host surface: emit `host:join_request` to all hosts AND write a notification row, so the host's
    **pending-requests inbox rebuilds on refresh/reconnect** (snapshot on host connect). Badge + list in Control Center.
  - Host actions `host:approve_join` / `host:deny_join` (atomic check-and-set on status). Approve →
    `registerParticipant` → `repairFutureRounds(currentRound+1)` so they're matched into upcoming rounds → notify user
    `join_approved` → they enter. Deny → `join_denied`, no entry.
  - Pre-event/lobby joins keep auto-admit (gate only applies once live).
- **Blast radius:** new migration + service + handlers + Control Center panel; the live `session:join` path changes
  behavior (gated) — must not affect pre-event joins or reconnects of already-approved participants (reconnect ≠ new
  request: keyed on existing participant status).
- **Prod smoke:** mid-event, a new user requests → host sees inbox item (and still sees it after host refresh) →
  approve → user enters and is matched next round; deny → user blocked.

### #3 — Entry timing (covered by Foundation F1)
Ships with F1. Headed prod smoke: a non-host can't enter before the window; a host can; an early host is never shown as
left/disconnected/no_show in event data.

### #4 — Kick/ban fully removes a participant everywhere + bars re-entry
- **Root cause (verified):** `handleHostRemoveParticipant` (host-actions.ts:857) updates DB status, presence, canonical
  location, and the active match — but makes **no `videoService.evictFromRoom` call**, so the kicked user stays live in
  the LiveKit SFU (audio/video still flowing). Canonical `connState` isn't set to `removed`; `roomParticipants` isn't
  cleared; re-entry relies on a DB check that a stale already-joined socket can skip.
- **Fix (architectural):** one atomic `removeParticipantFull(sessionId, userId, reason)` that fans out to **every**
  store:
  1. DB `session_participants.status = 'removed'` (durable ban marker — already done).
  2. In-memory **ejection set** `activeSession.ejectedUserIds` (+ persisted to Redis with session TTL).
  3. Canonical `connState = 'removed'`, location → main.
  4. Presence cleared + force `socket.leave(sessionRoom)`.
  5. `roomParticipants` entry deleted.
  6. Active match: demote + auto-settle survivors (existing logic).
  7. **LiveKit: `evictFromRoom` for lobby AND any active match room** (the missing piece) — kills their media.
  8. Broadcast `participant:removed`; emit eviction to the user.
  - **Re-entry bar:** `session:join` checks `ejectedUserIds` **before** `socket.join` (fast, in-memory, survives
    restart via Redis), with the DB `removed` status as the durable fallback.
- **Blast radius:** host-actions + participant-flow + session-state + canonical-state; `evictFromRoom` already exists
  (used elsewhere) — first use in the kick path. Extend `e2e/tests/ws2-kick-smoke.spec.ts` to assert SFU eviction.
- **Prod smoke:** host kicks a participant → they vanish from the room (no lingering media), can't rejoin via refresh or
  new tab, don't appear in matching or the host roster.

### #5 — Rating window can never wedge the event; host can force-close
- **Root cause (verified):** `endRound` correctly includes departed users in the rating set, but the completeness check
  (`participantsOf`, participant-flow.ts:1502) builds its denominator from current slots — an asymmetry that can wedge
  early-close logic; and there is **no** host force-close handler at all. The 90s backstop is the only escape and is
  passive.
- **Fix (architectural), three layers:**
  1. **Correct denominator:** completeness check includes `departedUserIds` (symmetry with `endRound`), so the
     "all rated" computation counts the right rater→partner edges.
  2. **Guaranteed hard backstop:** a dedicated rating-deadline timer that **always** fires `endRatingWindow` after the
     window regardless of early-close state and can't be cancelled by a wedged early-close.
  3. **Explicit host control:** `host:force_close_rating` (idempotent, host-only) + a "Skip ratings / Start next round"
     button visible during ROUND_RATING. Directly fulfils "host must be able to force-close and start the next round."
- **Blast radius:** participant-flow (denominator), round-lifecycle (timer), host-actions + orchestration wiring + host
  UI. Must stay idempotent with the existing C2/S18 completion guards (no double-advance).
- **Prod smoke:** trio where one departs without rating → event still advances (no wedge); and host clicking
  "Skip ratings" force-advances cleanly to the next round.

### #6 — Bonus round shows fresh pairs on the FIRST "Match People" click
- **Root cause (verified + your clarification):** manual breakout rooms are *correctly* independent of no-repeat
  (`is_manual = FALSE`, matching.service.ts:313 — leave as-is). A bonus round is a real algorithmic round (round 4, 5…)
  and already excludes prior algorithmic pairs. The actual problem: the fallback ladder can land repeats on the first
  generation even when some fresh pairs exist, and the host gets no fresh-vs-repeat signal — so they click "rematch"
  repeatedly hunting for fresh.
- **Decision applied:** manual rooms stay independent; bonus rounds participate in no-repeat against prior algorithmic
  rounds.
- **Fix (architectural):**
  - First "Match People" generation **maximizes fresh pairs greedily** (fresh-first fill), using repeats only for the
    mathematically forced remainder — never collapsing the whole round to repeats because one pair couldn't be fresh.
  - Surface **fresh-vs-repeat on the first preview**: each pairing tagged fresh / "met 1×" / "met 2×" so the host sees
    the truth on click one, no rematch needed to discover fresh.
  - "Rematch" still rotates among remaining viable pairings (existing behavior), with the same labels.
- **Blast radius:** matching.service generation path + host preview UI. Must not regress scheduled-round pre-planning,
  late-joiner repair, or `within_event`/`platform_wide` policies. Pin with `fresh-first-selection.test.ts` + a new
  bonus-round multi-round test.
- **Prod smoke:** 3-round event, run all rounds, host adds a bonus round → first "Match People" preview shows fresh
  pairs (labeled) without any rematch click; when fresh is exhausted, repeats appear labeled "met N×".

---

## UX IMPROVEMENTS (secondary — after the 6 criticals, if time before Friday)

- **UX1 — Compact top banner:** merge the stacked EventStateBanner + EventPlanStrip header into one ~36–40px responsive
  line; move connection/pause/broadcast alerts to toasts/chips. Reclaims 25–35% of mobile viewport for 50–200-person
  events. Layout-only; verify at 360/390/768/1024.
- **UX2 — Camera/mic indicator accuracy:** stop reading the cached `participant.isMicrophoneEnabled`; subscribe to the
  track publication `muted`/`unmuted` events (extract `useTrackMuteState` hook) so the icon always reflects real
  LiveKit track state. (Lobby.tsx ~331.)
- **UX3 — Messages open cleanly:** `window.open(url, '_blank', 'noopener,noreferrer')` for the Message action so the
  recap/room context is preserved (new tab). (SessionComplete.tsx ~24.)

---

## SEQUENCING TOWARD FRIDAY (by event-safety value × independence)

1. **F1 foundation** (entry window + presence/no-show correctness) — unblocks #1 & #3, low risk.
2. **#5 rating force-close + hard backstop + denominator** — highest "event can't get stuck" value, moderate size.
3. **#4 kick full removal + re-entry bar** — host control + safety, moderate size, has existing e2e to extend.
4. **#1 invite landing page** (consumes F1's Join gate) — moderate.
5. **#2 live-join approval gate** — biggest build (migration + service + UI); schedule the most time.
6. **#6 bonus fresh-first preview** — moderate, isolated to matching + preview UI.
7. **UX1–3** — light, only if time remains.

Realistic note: that's six architectural changes + UX in ~2 days. **#2 (approval gate) and #4 (atomic removal) are the
heavy ones.** If the clock gets tight, the non-negotiable event-protectors are **#5, #4, #3/F1, #2**; **#1 and #6** can
follow same-day if needed; **UX** can slip past Friday. Each ships independently with its own prod smoke, so partial
progress is always shippable and safe.

Out of scope here (tracked separately): the Render→AWS/GCP infra move for 150–500 users (from the 9-Jun doc) — that's a
capacity project, not an event-day blocker, and is in the deep-audit plan's scale phase.
