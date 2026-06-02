# RSN Dependency Map (QA — Phase 2)

**Living document.** How the components in the [Component Map](./component-map.md) depend on each other. For any observed symptom this lets a tester (a) trace **upstream** to the true cause and (b) check **downstream** for knock-on effects the symptom may have caused elsewhere — including in places a user never sees (back-end records, logs, other clients).

- **Last updated:** 2026-05-30
- **Bidirectional by design** (per Lorin's note): every chain is read both ways. A symptom is rarely an isolated UI bug; it usually has a cause behind it *and* collateral effects ahead of it.
- **Chains can be more than two steps** (per Lorin's note): the maps below are multi-hop.

Legend: `→` data/control flows in this direction. Read **left-to-right** to find downstream knock-on effects; read **right-to-left** to find the upstream root cause.

---

## 1. The platform's primary data-flow spine

```
Auth / identity
   → Socket connection (Socket.IO)
      → Presence heartbeat  ──────────────┐
      → LiveKit room connection            │
   → Session/event state (in-memory + Redis cache + Postgres)
      → Matching eligibility ──────────────┤
         → Match assignment                │
            → LiveKit breakout room (token)│
               → In-room video/audio       │
            → Round timer (server endsAt)  │
               → Round end → Rating window │
      → Host/admin controls ───────────────┘
         (mutate session state, fan out to all clients)
```

Almost every live-event symptom traces back to one of three hubs on this spine: **Socket connection**, **Presence**, or **Session state**. Treat those as the usual suspects when a symptom appears far downstream.

---

## 2. Component dependency table

For each component: what it **depends on** (upstream — look here for the cause) and what **depends on it** (downstream — look here for knock-on effects).

| Component | Depends on (upstream — cause lives here) | Depended on by (downstream — knock-on effects land here) |
|---|---|---|
| Auth / identity | — | Socket connection, every authenticated route, role resolution |
| Socket connection | Auth (token) | Presence, chat, DM, notifications, all host actions, all live state sync |
| Presence / heartbeat | Socket connection | Participant count, host participant view, matching eligibility, no-show detection |
| Session / event state | Auth, DB, Redis cache | Matching, timer, host controls, participant list, lobby/room routing |
| Matching & round flow | Session state, **presence eligibility**, roles (co-hosts excluded) | Match assignment, breakout rooms, rating targets |
| Match assignment | Matching, presence | Breakout room (LiveKit token), waiting-for-partner UI, rating list |
| LiveKit room (lobby + breakout) | Socket (token issue), match assignment | Video/audio tiles, participant count (live source), pin/mute |
| Round timer | Session state, round-lifecycle | Round-end transition, rating window, "final stretch" reveal |
| Rating | Round end, match assignment (partner list) | Rating analytics / data quality |
| In-event chat | Socket, presence (host-present gate), room membership | Chat delivery scope; **navigation away from event** if a name link full-page-navigates |
| Host control center | Socket, roles, session state | Matching, timer, breakout rooms, participant mutations (every host action fans out to all clients) |
| Co-host management | Roles, session state | Matching eligibility (co-hosts excluded), host-action permissions |
| Invites & join-requests | Auth, identity | Event registration → who appears in the session roster → matching eligibility |
| Notifications | Socket, notification-prefs, source events (invite/dm/etc.) | Click-through navigation |
| DM | Socket, "shared a room" gate (depends on prior event participation) | — |
| Admin (user/event/reports) | Auth, roles | User status → login eligibility; event cancel → session state; role change → host/co-host resolution |

---

## 3. Worked dependency chains (the ones that bite)

Each chain shows the **upstream cause path** and, separately, the **downstream knock-on effects** — including back-end/other-client effects a single-screen tester would miss.

### 3.1 Participant count / presence
```
UI shows wrong participant count
  ⟵ upstream:  ParticipantList delta count  ⟵  socket joined/left deltas  ⟵  presence map  ⟵  socket connection (transport)
  ⟶ downstream knock-on:
       → matching eligibility computed from a roster that disagrees with reality
          → people matched with absent users / left alone in a room
       → host participant view shows a different set than participants see
       → back-end: session_participants rows + presence map diverge (recorded state ≠ live state)
       → "25 registered, 13 visible" is the same divergence seen from the registration side
```
Tester takeaway: a wrong count on screen is never *just* a display bug — check the matching roster and the back-end participant records for the same divergence.

### 3.2 Matching ↔ presence
```
Matched with someone not in the room  /  alone in a breakout
  ⟵ upstream:  match assignment  ⟵  matching eligibility (DB status incl. 'registered')  ⟵  presence NOT intersected
  ⟶ downstream knock-on:
       → breakout room created with a phantom partner → "waiting for partner" never clears
       → rating step has a partner who never appeared → skewed/empty rating data
       → host view shows a "full" room that is actually half-empty
```

### 3.3 Round timer
```
Timer frozen / different value per user  /  "final stretch" stuck
  ⟵ upstream:  client tick interval  ⟵  timer:sync stream  ⟵  socket connection (sync starvation on one client)
  ⟶ downstream knock-on:
       → round-end transition never fires for that client → stuck in breakout while others move on
       → rating window never opens for them → missing ratings for that round
       → "final stretch" reveal is gated on timerSeconds, so a frozen timer also freezes the label
```

### 3.4 Chat name-click
```
Clicking a name in chat ejects the user from the event
  ⟵ upstream:  ChatPanel renders name as <a href=/profile/:id> → full-page navigation → LiveSessionPage unmounts
  ⟶ downstream knock-on:
       → socket disconnects → presence map drops the user → participant count falls for everyone
       → if mid-round, their match is now half-empty → partner left alone (feeds 3.2)
       → back-end may record a leave/disconnect → no-show / left status written
```
Tester takeaway: this UI bug cascades into presence, count, and matching — a vivid example of why downstream tracing matters.

### 3.5 Pin ↔ mute
```
Pinning a participant mutes them
  ⟵ upstream:  pin changes layout tree  →  LobbyMediaControls remounts  →  mount effect re-fires auto-mute
  ⟶ downstream knock-on:
       → user appears muted to others mid-conversation → "is my mic working?" confusion (audio component)
       → repeated unmute attempts re-muted → audio reliability complaints logged against the wrong component
```

### 3.6 Co-host / roles
```
Can't make a co-host before the event
  ⟵ upstream:  Control Center button gated behind event-started; no pre-event co-host route exists
  ⟶ downstream knock-on:
       → co-host not set → matching may not exclude them correctly (matching reads co-host source)
       → host-action permissions for that user resolve wrong (effective-role)
```

### 3.7 Admin actions with live effects
```
Admin changes a user's role / status, or cancels an event
  ⟶ downstream knock-on:
       → role change → effective-role re-resolves → host/co-host capability changes mid-event
       → status = banned/suspended → login eligibility revoked → socket auth fails next connect
       → event cancel → session state torn down → participants in that event affected
```

---

## 4. How to use this map during testing

1. **Log the symptom against its component** (from the Component Map).
2. **Trace upstream** along the chain to the most likely true cause — the bug usually lives a hop or two back, not where it's seen.
3. **Trace downstream** to every place the symptom could have caused collateral damage — *including back-end records, logs, and what other clients saw*. Log those as linked observations, not separate unexplained bugs.
4. **Record the chain** in the Issue Register so the same symptom isn't re-investigated from scratch next time.

> The three hubs — **socket connection, presence, session state** — sit upstream of most live-event symptoms. When a symptom seems isolated, check whether one of these three is the real source before filing it against the surface where it appeared.
