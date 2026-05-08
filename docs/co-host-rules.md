# Co-host rules

Written 2026-05-09 (Phase 8D). Source of truth for what a co-host can and cannot do during a live RSN event.

## Roles

| Role | Notation in code | Source of truth |
|---|---|---|
| **Original host** | `sessions.host_user_id` | The user who created the event. Cannot be removed from inside the event. |
| **Co-host** | row in `session_cohosts` | Promoted from a participant by the original host. Can be demoted at any time. |
| **Participant** | row in `session_participants`, no row in `session_cohosts` | Default role for everyone else. |
| **Admin** | `users.role IN ('admin', 'super_admin')` | Platform-level role. Outside the event scope. |

## Limits

- Exactly **1 original host** per event.
- Up to **8 co-hosts** per event. (Subject to change — no server-side enforcement yet; the rules doc is the contract.)

## Co-host capabilities

A co-host CAN:
- Open the Host Control Center
- See every participant's state (in main room / in a room / disconnected / left)
- Generate matches → confirm matches → start a round
- Pause / resume rounds
- Add 2 minutes to the active round
- End a round early
- Create manual breakout rooms
- Move a participant between rooms
- Re-match a participant out of their current room
- Broadcast announcements to everyone in the event
- Make a participant a co-host (only the original host can — see below)

A co-host CANNOT:
- **Promote another participant to co-host** — only the original host can. The server enforces this in `handleAssignCohost` (host-actions.ts) by checking `session.hostUserId === actingUserId`.
- **Demote another co-host to participant** — same reason, only the original host can.
- **Transfer event ownership** — the original host can pass the baton (`host:promote_cohost`); a co-host cannot.
- **End the event** — the original host or platform admin only.
- **Change session config** — name, scheduled time, total rounds, etc. are owned by the original host.

## Matching defaults

By default, both **original host and every co-host are excluded from matchmaking**. They run the event; they don't pair up with attendees.

Mid-event promotion or demotion now triggers a plan repair (Phase 8A.5):
- Promote → upcoming rounds re-shape WITHOUT the new co-host.
- Demote → upcoming rounds re-shape WITH the demoted user re-included as a participant.

## Real-time UI state

When the original host clicks Make co-host:
1. Server inserts a row in `session_cohosts`.
2. Server emits `cohost:assigned` to the whole session room → every connected client updates the cohorts Set.
3. Server emits `permissions:updated` to the newly-promoted user's userRoom → their UI re-fetches the authoritative state snapshot, which flips their effective role + capabilities atomically.
4. Server triggers plan repair → upcoming rounds re-shape.

The whole loop completes in < 1 second under normal conditions. No refresh required.

## What's not yet implemented

- Server-side enforcement of the 8-cohost limit (rules doc is the contract for now).
- Per-co-host capability tuning (today every co-host has the same capability list).
- Co-host audit log (who promoted whom, when, why) — `audit_log` rows are written but no UI surface yet.
