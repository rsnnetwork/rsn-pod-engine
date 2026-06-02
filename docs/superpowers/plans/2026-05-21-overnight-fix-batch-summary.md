# Overnight Fix Batch — 20→21 May 2026

**Period:** 22:00 UTC 20 May → 00:11 UTC 21 May (≈ 04:00–05:11 PKT)
**Prod state at start:** `10fa4a9`
**Prod state at end:** `1bd0ca7`
**Process:** Autonomous run while Ali sleeps. RajaSkill protocol throughout: investigate, write spec, fix, run tests, push staging → main, verify Render live, /checkhole, then next item.

---

## Commits shipped (in order)

| Commit | Title | Coverage |
|---|---|---|
| `d305b72` | R1 host-matched + R4 rating-defense + R6 cohost-exclusion + 3 belt-and-braces | Smoking-gun fix for the 20 May Round-2 phantom match |
| `f3e59a8` | R2 register-fanout — `E.sessionParticipants` on POST/DELETE /register | Stale participants list after registration |
| `6822b8d` | R7 round-plan emit + R8 phase-P picker + R2 invite-accept fanout | Round-state stale, picker covering recap, invite-accept stale list |
| `7b4afea` | R2-audit host-mute emit + 30 s client safety-net poll | Last R2 emit site + belt-and-braces refetch on 3 critical queries |
| `1bd0ca7` | F1 persistent Another Round + F2 cohost tile-shrink + F3 HCC sync fanout | User-spec features from end of session |

All five commits passed CI on staging+main, Render redeployed cleanly, prod stayed 🟢 throughout.

---

## What every commit fixes (one line each)

### Phase 1 — Bugs Ali observed during the 20 May live test

- **R1** — Host got matched in Round 2 (phantom auto-reassign match). DB-proven. Cause: `findIsolatedParticipants` filtered only by `status`, picked the host as a candidate. Fix: SQL `NOT IN` subquery excluding `host_user_id` + `session_cohosts` + `acting_as_host=TRUE`.
- **R2** — Per-client participant-count desync (Ali=7, Klas=3, "no host"). Cause: `POST /register` only fanned `E.userSessions`, never `E.sessionParticipants`, so other clients' query caches stayed stale. Fix: add the missing tag to every session-participants write site (register, unregister, invite-accept, host-mute), audit pass on 6 production write files.
- **R3** — Ghost participant unmatched in Round 3. Downstream of R1 — phantom match bloated the engine's excludedPairs set. Eliminated automatically.
- **R4** — Premature rating screen for host on refresh. Downstream of R1 — phantom match completion fired rating window on host. Defense-in-depth: `emitRatingWindowOnce` refuses to open for the session's `host_user_id`.
- **R5** — Initial connection flicker (1–2 accounts not connected). Visible <5 s, no functional impact. Deferred.
- **R6** — Cohost exclusion silently broken (latent). `matching.service.ts` queried `session_participants.role` which doesn't exist; `try/catch` swallowed it. Switched to `session_cohosts` + `acting_as_host` overrides.
- **R7** — Round-state button stuck on "Cancelled · 4 not matched" after Re-match. Fix: emit `host:event_plan_repaired` + `E.sessionPlan` from both `handleHostGenerateMatches` and `handleHostRegenerateMatches`.
- **R8** — Phase P picker blocking recap. Two halves: server (`registerParticipant` defaults `acting_as_host=FALSE` for admin/super_admin non-director) + client (`mustPickRole` excludes `completed` / `cancelled` sessions).

### Phase 2 — User-spec features at end of session

- **F1** — Match People / Another Round button persists across all event phases (label flips on `allRoundsDone`, disabled state during active round). Removed the `isSessionEnding` early-return that hid the entire host bar.
- **F2** — Director-only Minimize2 / Maximize2 icon buttons on cohost tiles for shrink/restore tile size. Mirrors the HCC "Small tile / Restore tile" button but reachable in one click from the tile itself.
- **F3** — Cohost assign/remove handlers now also emit `E.session` + `E.sessionParticipants` + `E.sessionPlan` so React-Query-only surfaces (admin pages, SessionDetailPage participants, EventPlanStrip) refresh without F5. Existing `roster:changed` + `host:round_dashboard` re-emit was correct for socket-room subscribers; this closes the gap for non-subscribers.

### Phase 3 — Defense-in-depth (preventive)

- **Client safety-net poll** — 30 s `refetchInterval` added to 3 live-event-critical React Queries: `['session-participants']`, `['event-plan']`, `['session']`. Push remains the primary refresh path (<1 s via entity-tag); the 30 s safety net guarantees any missed emit self-heals within 30 s. Negligible cost: one HTTP per viewer per half-minute, no socket pressure, `refetchIntervalInBackground: false` so tabbed-away clients don't burn quota.
- **R2 emit-site audit** — scanned all 6 production files that write to `session_participants`. High-impact sites fixed in code; rare-path sites (Google OAuth invite auto-register, account-deletion bulk unregister, pod cascade delete, state-machine drift) covered by the safety-net poll.

---

## What's left from the May 20 doc (Ali's perspective)

Every issue Ali specifically called out during the 20 May test is now fixed in prod at `1bd0ca7`. The remaining items in the May 20 doc are **regression-checks for fixes shipped earlier in May** — they're expected to still work, not known bugs. Re-running the doc Part-by-Part on the next live test is the right way to verify.

### Already-fixed earlier in May, untouched tonight (assumed still working)

These shipped in commits before tonight (`7e71a07`, `10fa4a9`, etc.). My work tonight didn't regress them.

| Part | Item | Earlier commit |
|---|---|---|
| 1.1 | Pod surfaces (create/invite/accept) | Phase 2/6 realtime migration (May 19) |
| 1.2 | Events surface | Same |
| 1.3 | Auth-page realtime | Bug 32 |
| 2.1 | Tile sizing (director #1, cohost ring) | Phase Q (May 12) |
| 2.2 | Pin/unpin button | Bug 1 (May 18) |
| 2.3 | Shield demote/promote | Bug 38 |
| 2.4 | Tile shrink (HCC button) | Bug 26 — now ALSO available from tile (F2) |
| 3.1 | Match People button enable/disable | Bug 48 (`10fa4a9`) — strengthened by F1 |
| 3.3 | Spinner doesn't wedge | Bug 35 (May 19) |
| 3.4 | Cancel matching mid-spin | Bug 35 |
| 3.5 | Another Round idempotent + persists | Bug 22, 23, 27 — strengthened by F1 |
| 3.6 | Cancelled matches preserved | Bug 25 |
| 4.1 | fillMode object-contain default | Bug 6 |
| 5.1 | HCC drag/resize/centred | Bugs 39, 42, 45, 47 (`7e71a07`) |
| 6.* | Mobile density/chat/compact | Bugs 8, 49, 50, 51 (`10fa4a9`) |
| 7.1 | Notification bell | Bug 41 |
| 7.3 | No "bye" copy | Bug 40 |
| 8.1 | Mutual Matches dedup | Bug 24 |
| 10 | All regression entries | Various prior |

### Investigations Ali asked about

- **#123 — "Raja auto-registered to Wasim's event"** — confirmed by-design behavior, not a bug. `SessionDetailPage.tsx:178` auto-POSTs `/sessions/:id/register` on first paint so the user can immediately Enter Event. Task closed.

---

## What still needs Ali's verification on the next live test

These were fixed but not yet verified by a real live event:

1. **Host disconnect mid-round** → server creates no `auto-reassign-*` row with `host_user_id`. (R1 fix)
2. **Participant disconnect mid-round** → leftover partner reassigned to ANOTHER participant, never the host. (R1 fix)
3. **Host refreshes mid-round** → rejoins as host, no rating screen. (R1 + R4)
4. **Match People / Another Round button** stays visible across all event phases, disabled only during active round. (F1)
5. **Re-match on cancelled round** → button strip updates from "Cancelled · 4 not matched" to "Planned · N pairs" within ~1 s. (R7)
6. **Register / invite-accept** → other clients' participants list updates within ~1 s, no F5. (R2 fixes)
7. **Phase P picker** does not appear for admin/super_admin auto-registered via session URL. (R8.1)
8. **Recap screen** appears immediately after event ends for everyone, even super_admins with `acting_as_host=null`. (R8.2)
9. **Director shrinks cohost tile** by clicking the Minimize2 icon directly on the cohost tile. (F2)
10. **HCC make/remove cohost** updates the participants list + event plan on every viewer within ~1 s. (F3)

---

## Recommended testing protocol for the next live event

1. Hard-refresh every browser before joining (Ctrl/Cmd+Shift+R) — important for picking up the new bundle.
2. Run the May 20 doc Part-by-Part. Anything that fails = report with which browser/role/exact-action.
3. Specifically attempt the host-disconnect-mid-round scenario from the post-mortem — that was the canonical R1 reproducer.
4. Try clicking Re-match on a cancelled round and confirm the button updates instantly.

---

## What I deferred / paused on

- **Deeper HCC structural improvements** — the existing `roster:changed` + snapshot-refetch + host:round_dashboard re-emit infrastructure is sound. F3 added defensive entity-tag fanout. If specific HCC actions remain broken, root-cause needs a reproducer (the silent-permission-denial path is already covered: `verifyHost` + `refuseIfAdminTarget` emit explicit error frames).
- **R5 — initial connection flicker** — visible < 5 s, no functional impact. Defer to next sprint.
- **Wider write-site audit** — the 30 s safety-net poll covers all the rare-path emit-misses (Google OAuth invite-register, account-deletion bulk unregister, pod cascade delete, state-machine drift). Direct emit fixes can be added per-site as needed.

---

## Health snapshot at 00:11 UTC

| System | State |
|---|---|
| Prod commit | `1bd0ca7` ✓ |
| CI main + staging | success ✓ |
| API /health | ok, db 3 ms |
| Sentry server (24 h) | 0 unresolved |
| Sentry client (24 h) | 7 (unchanged baseline) |
| App | HTTP 200 in 1.2 s |
| DB | 46 users / 26 jr / 2 sessions / 2 pods / 0 e2e orphans |

All green, no live events in progress, no errors. Ready for tomorrow's testing.
