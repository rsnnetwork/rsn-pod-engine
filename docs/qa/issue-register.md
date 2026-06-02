# RSN Issue Register (QA — Phase 3)

**Living document.** The single place every test observation is logged, keyed to a component from the [Component Map](./component-map.md) and traced through the [Dependency Map](./dependency-map.md). One row per distinct issue; duplicates get a **tally**, not a new row.

- **Last updated:** 2026-05-30
- **Seeded with:** the 27 May live-test results (the most recent test session), mapped to components. This is tracking only — it is **not** a fix commitment or an agreed schedule.
- This markdown version is the working source of truth and is version-controlled. It can be mirrored to a shared sheet/board for non-engineers without losing the link back to code.

## Columns

| Column | Meaning |
|---|---|
| ID | Stable issue id (`RSN-NNN`) |
| Component | From the Component Map (e.g. `C2 Matching`) |
| Action / surface | The specific action or sub-surface where it shows |
| Symptom | What the user/tester observed |
| Sev | Severity: P0 blocker · P1 major · P2 minor · P3 polish |
| Status | `open` · `investigating` · `fix-in-progress` · `fixed` · `verified` · `wontfix` |
| Tally | How many independent reports of the same issue |
| Owning module | The code that owns the cause (file/area) |
| Upstream cause | Likely true cause (Dependency Map, read right-to-left) |
| Downstream knock-on | Other places this issue affects (read left-to-right) |
| Verification | How a fix is confirmed (test/flow) |

> **Confidence note:** entries below are from a read-only code audit of the 27 May reports. Status is `open` for all (nothing fixed yet). Two are marked `(likely)` where a live repro is still needed.

---

## Register — seeded from 27 May live test

| ID | Component | Action / surface | Symptom | Sev | Status | Tally | Owning module | Upstream cause | Downstream knock-on | Verification |
|---|---|---|---|---|---|---|---|---|---|---|
| RSN-001 | C2 Matching | Match assignment | Matched with users who were not actually present | P0 | open | 3 | `services/matching/matching.service.ts` | Eligibility query includes `status='registered'`; presence not intersected | Phantom partners → RSN-004; skewed ratings (C4) | Run a round with registered-but-absent users; confirm they are not matched |
| RSN-002 | C2 Matching | Late join | Late joiners thrown straight into a meeting, no grace | P1 | open | 1 | `handlers/participant-flow.ts`, `matching.service.ts` | No readiness/grace gate before eligibility | Joiner dropped into in-progress round | Join after round start; confirm grace/lobby buffer |
| RSN-003 | C1 Lobby — presence | Participant list/count | Count inconsistent (8 → 12 → 13) | P0 | open | 2 | `useSessionSocket.ts`, `session-state-snapshot.service.ts` | Three count sources (deltas / snapshot / presenceMap) disagree | Matching roster wrong (RSN-001); host view differs | One authoritative count rendered everywhere; counts agree across clients |
| RSN-004 | C3 Breakout | Waiting-for-partner | Alone in room / "waiting for partner" never clears | P0 | open | 3 | `handlers/round-lifecycle.ts`, `VideoRoom.tsx` | No both-parties-joined check before match goes active | Empty rating; host sees "full" half-empty room | Assign a match with one absent party; confirm abort/reassign + overlay clears |
| RSN-005 | C1 Lobby — presence | Reconnect / transport | 25 registered but ~13 visible (ghosts) | P0 | open | 1 | `lib/socket.ts` vs `server/src/index.ts` | Client requests `websocket,polling`; server allows `websocket` only → polling clients never connect | Under-count; matching roster wrong | Align transports; force a polling client; confirm it connects and appears |
| RSN-006 | C2 Matching — timer | Round countdown | Timer frozen / out of sync (27s vs 6s) | P1 | open (likely) | 2 | `handlers/timer-manager.ts`, `sessionStore.ts` | Client tick depends on `timer:sync`; starves for one client | Round-end never fires for that client → stuck; missing rating | Drop sync to one client; confirm it re-arms and stays in sync |
| RSN-007 | C2 Matching — round | Round end | Rounds end with no countdown / sound / warning | P1 | open | 2 | `handlers/round-lifecycle.ts`, `useSessionSocket.ts` | No pre-end warning event; jumps straight to rating | Users surprised mid-conversation | Add `timer:warning`; confirm visible countdown + transition before rating |
| RSN-008 | C2 Matching — round | Final stretch | "Final stretch" shows but transition never happens | P2 | open | 1 | `VideoRoom.tsx`, `sessionStore.ts` | Reveal gated on `timerSeconds`; frozen timer (RSN-006) freezes label | Misleading UI | Decouple reveal from timerSeconds; fix RSN-006 |
| RSN-009 | D3 Co-host | Assign co-host | Cannot make co-host before event starts | P1 | open | 1 | `HostControls.tsx`, `host-actions.ts` | Control Center gated behind event-started; no pre-event route | Matching co-host exclusion / permissions wrong | Open Control Center pre-event; assign co-host successfully |
| RSN-010 | C1 Lobby — video | Layout: spacious | Spacious mode clips people, no scroll at 13 | P1 | open | 1 | `Lobby.tsx` (LobbyMosaic) | Fixed `max-w`/cols + clipped scroll container | Can't see all participants | At 13 participants, confirm all are reachable by scroll |
| RSN-011 | C1 Lobby — video | Layout: all modes | Tiny boxes / wasted space, doesn't scale | P2 | open | 1 | `Lobby.tsx` (LobbyMosaic) | Fixed widths, no responsive grid | Poor use of screen | Resize viewport; confirm tiles scale |
| RSN-012 | C1/E pin+audio | Pin participant | Pinning a participant mutes them | P0 | open | 2 | `Lobby.tsx` (LobbyMediaControls) | Pin changes layout tree → controls remount → auto-mute re-fires | "Is my mic working?"; re-mute loop (RSN-013) | Pin a participant; confirm mic state unchanged |
| RSN-013 | C1 audio | Mic toggle | Unmute reverts / auto-remute unstable | P1 | open | 1 | `Lobby.tsx` | Same remount auto-mute + 500ms re-apply | Audio reliability complaints | Unmute repeatedly across layout changes; confirm it sticks |
| RSN-014 | C1 audio | Mic / audio | Echo; can't tell if mic works | P2 | open (likely) | 1 | LiveKit capture config; `Lobby.tsx audio={isHost}` | No explicit echoCancellation; non-host not publishing in lobby | Confusing audio state | Set echoCancellation; add publish/level indicator; confirm |
| RSN-015 | D1 In-event chat | Click name | Clicking a name in chat ejects user from event | P0 | open | 1 | `ChatPanel.tsx` | `<a href>` full-page nav unmounts LiveSessionPage | Disconnect → count drop (RSN-003) → partner alone (RSN-004) | Click a chat name; confirm stays in event (router nav/modal) |
| RSN-016 | D1 In-event chat | Find chat | Chat hard to find on mobile / hidden on desktop | P2 | open | 1 | `LiveSessionPage.tsx` | Desktop side panel; mobile only via floating toggle | Low chat usage | Confirm chat discoverable on all breakpoints |
| RSN-017 | C3 Breakout — nav | Leave buttons | Two indistinguishable "Leave" actions → accidental full exit | P1 | open | 1 | `VideoRoom.tsx` | "Main Room" and "Leave" same style/icon, adjacent | Accidental event exits (feeds RSN-003/004) | Confirm distinct styling + confirmation for leave-event |
| RSN-018 | C3 Breakout — nav | Navigation | Navigation too complicated (3+ leave paths) | P2 | open | 1 | `LiveSessionPage.tsx`, `VideoRoom.tsx` | Multiple overlapping leave affordances | User confusion | Consolidate to one leave-event + one back-to-main |
| RSN-019 | C4 Rating | Group room | Trio room offers only ONE rating target | P1 | open | 1 | `useSessionSocket.ts` (`match:reassigned`) | Handler drops `partners[]`, passes one partner to `setMatch` | Missing ratings for other participants | In a trio, confirm one rating per other participant |
| RSN-020 | C4 Rating | Rating prompt | Rating flow unclear / data-skew worry | P2 | open | 1 | `RatingPrompt.tsx`, `rating.service.ts` | No "optional" labeling; no broken-session path; server accepts all | Skewed analytics | Add optionality + "session broken" reason; tag for analytics |

**P0 count:** 6 (RSN-001, 003, 004, 005, 012, 015) — these cluster around the three dependency hubs (presence, matching, socket) and are the highest-leverage to fix first.

---

## How to add a new issue

1. Reproduce and write the **symptom** in plain terms.
2. Assign the **component** (Component Map) and the **action/surface**.
3. Trace **upstream** (cause) and **downstream** (knock-on) via the Dependency Map; fill both columns.
4. If the same symptom already has a row, **increment Tally** instead of adding a row.
5. Set **Sev** and leave **Status = open** until someone picks it up.
6. On fix: move to `fix-in-progress` → `fixed`, then `verified` only after the **Verification** step passes.

> Keep this lightweight. If maintaining it ever feels heavier than the bugs it catches, simplify the columns — a register that falls into disuse is worse than a smaller one that's actually kept current.
