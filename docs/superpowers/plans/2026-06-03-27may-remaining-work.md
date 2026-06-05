# 27th May — Remaining Work (continuation doc)

**Last updated:** 2026-06-05 ~18:10 UTC — **27-MAY REMAINING WORK: ALL ITEMS CLOSED** (autonomous run, 2026-06-05). Per-slice detail in progress.md.

| Slice | Item | Commit | Status |
|---|---|---|---|
| S1 | WS2 core "nobody waits alone" (no re-pair, 15s grace incl. Leave-event, rating reasons, slot-C, late-return, client self-eject killed) | `fcfa3e5`+`56e14b4` | ✅ prod-smoke full pass |
| S2 | Kick ends match, REMOVED re-entry ban, trio departed round-end ratings (migration 066) | `2c64e40` | ✅ prod-smoke full pass |
| S3 | Name-click eject → shared ProfileLink + build-failing pin | `cdbc861` | ✅ prod-smoke full pass |
| S4 | B2 timer:warning T-30/T-10 + chime; B3 final-stretch reveal from timerEndsAt | `39a502b` | ✅ prod-smoke full pass |
| S5 | G3/G4 one in-room exit + destructive top-bar Leave Event | `3eb34e8` | ✅ prod-smoke (real click) |
| S6 | F1 mobile chat | — | ✅ already fixed (Bug 9+50, May 21) — stale audit item |
| S7+S8 | E4 echo-cancel + publish policy; E5/E6 SID-keyed join prefs (remount re-mute killed) | `65bfa00` | ✅ shipped + pinned; audio-by-ear → Ali |
| S9 | H5 "didn't work" rating, excluded from every quality average (migration 067) | `1f95535` | ✅ shipped + AVG inventory pinned |
| S10 | D1–D3 lobby layout | — | ✅ already implemented (Bug 8/49 + Phase 8) — stale audit item |

New headed smokes in e2e/tests: ws2-smoke, ws2-kick-smoke, ws2-profile-link-smoke, ws3-timer-smoke (run vs prod from the RSN-fixloc harness). Full final regression (shipA/B/C + all new smokes) run at close of the 2026-06-05 session — see progress.md for results.
**Purpose:** a fresh Claude session told "start 27th may remaining work" reads THIS file and continues without re-discovery. It is the single up-to-date status; older triage/plan docs are historical.

---

## How to resume (read first)

- **Canonical repo:** `C:\Users\ARFA TECH\Desktop\RSN-dev` (github `rsnnetwork/rsn-pod-engine`). NEVER use `Desktop\RSN` (stale clone, broken .git — it caused the snapshot regression). Never snapshot-dump one clone over another; cherry-pick.
- **Ship cadence (agreed with Ali, per slice):** isolated worktree off `origin/main` (e.g. `Desktop\RSN-p1`) → `npm ci` → implement → typecheck `node ./node_modules/typescript/lib/tsc.js -p shared` / `--noEmit -p server` / `-b client` → FULL `npm run test --workspace=server` green → commit (identity auto-resolves `RSN Network <dev@rsn.network>`, NO AI attribution, secret-guard hook runs) → `git push --force-with-lease=staging:$(git rev-parse origin/staging) origin HEAD:staging` → `gh run watch` green → `git push origin HEAD:main` (plain FF; protection accepts it because CI passed on the SHA) → verify Render (`rsn-api`) + Vercel (`rsn-client`) deployed the SHA (gh api deployments) → clean up worktree/branch → give Ali numbered manual test steps → WAIT for Ali to test before the next slice.
- **Non-trivial slices:** EnterPlanMode → explore (read `origin/main` exactly) → AskUserQuestion for real ambiguities → plan file → ExitPlanMode approval → execute.
- **Gotcha:** the repo has many *source-introspection tests* (they grep source text). Any refactor (renames, moved blocks, added lines) can break them; re-point anchors / widen slice windows — keep their assertions, never delete them. Past examples: `match-generation-lock.test.ts`, `may23-live-test-host-fixes.test.ts`, `may24-presence-livekit-reconcile.test.ts`, `phase-may18-ship5-plan-recompute.test.ts`, `phase1-spa-navigation.test.ts`.
- **Pattern in force — presence gate:** "present in main room" = `getPresentUserIds(io, sessionId, activeSession)` (matching-flow.ts) = session sockets ∪ heartbeat presenceMap ∪ LiveKit lobby roster. All gates FAIL-OPEN (absent/empty/zero-overlap present-set → DB-status behaviour + warn; never match/show nobody).
- One known flaky test under full-suite parallel load: `routes/post-event-message.test.ts` (passes in isolation; unrelated).

## Shipped so far (don't redo)

| Slice | Commit | What |
|---|---|---|
| Recovery | `ce75e13`/`d8e0b3b` | Undid the `9a457c3` snapshot regression (febf7a2 tree + Arsam statemgmt). Old main tag deleted on purpose. |
| Phase 0 | `a0070bd` | Chat name opens profile in new tab (no eject); `match:reassigned` carries `partners[]` (trio rating). |
| Phase 1a | `b2c99a3` | Presence-gated matching eligibility + manual breakout (`PARTICIPANT_NOT_IN_MAIN_ROOM`); `presentUserIds` threaded through `getEligibleParticipants`/`generateSingleRound`/`repairFutureRounds`. |
| Phase 1a.2 | `58a9860` | Host/co-host surfaces gated: preview "Not matched" list, `/plan` bye-count, `eligibleMainRoomCount`. |
| Phase 1a.3 | `d6b964a` | Event Plan strip live: replan-after-generate against present set (replan was fail-open + only on preview edits); removed 5 hardcoded `totalPairs: 0`; strip headline derives from gated `/plan`; `/plan` refetches on roster events. |
| Canonical Ship C + ghost-engine fixes | `2bdaef6`..`4077f23` | **Token cutover (2026-06-04 overnight, autonomous):** legacy events are lifecycle-only (match:assigned/reassigned carry no token, 8 sites; lobby:token retired, 15 sites + shared type + client listener); single token rail = snapshot you.token (minted on location change) + session:resync replies (always minted; pulled on EVERY connect AND every status_changed — new) + REST fallback. Smoke-caught fixes shipped en route: `9a496c2` room-end canonical clears at ALL end paths (the 4-Jun ghost repro); `8db429d` per-session RMW serialization (lost-update race — heartbeat mirror clobbered placements, mis-routed room chat); `03a4702` resync self-heals first-join token race (synthetic main-room you); `5d07607` clears run BEFORE round-end broadcasts; `4077f23` **THE ghost engine**: shadowWriteCanonical overwrote the whole doc from stale roomParticipants on every persist — now a serialized merge (existing participants authoritative). VERIFIED headed vs prod: shipA + shipB + shipC smokes all green on `4077f23`, plus loadABC-20users (20 real browsers: 20/20 lobby video, 19/20 placement, 20/20 return, zero ghosts 60s). Ali to manually test in the morning, then Workstream 2 (Part B "nobody waits alone") next. |
| Canonical Ship B | `087ba44` | Read-path flips to canonical connState w/ fail-open `getCanonicalConnectedSet` (null = unavailable → presenceMap fallback, never empty-set): matching-flow dashboard block (names/isConnectedFor/byes/eligible-count), getPresentUserIds gains canonical as 4th union source, host-actions plan/isolated/bulk-mute, round-lifecycle no-show, `/plan` bye gate. Chat + reactions route canonical-location-first (legacy fallbacks intact). Correctness prereqs found in audit: `setPresence(null)` now mirrors guarded 'disconnected' to canonical (stale-heartbeat/kick ghosts), and `transitionParticipant` only upgrades to 'connected' when heartbeating (round-end resets no longer resurrect ghosts; presence owns connState, transitions own location). Boot restore: `warmParticipantStatesOnRestore` (DB lift + canonical overlay) in both recover paths. Phase-4: 15s LiveKit sweep `livekit-sweep.ts` (positive heal only — missed JOINs; missed LEFTs covered ≤90s by stale-heartbeat + the setPresence mirror; no negative heal to avoid flapping camera-denied main-room users), shared `healParticipantConnState` with webhook receiver. Deliberate presenceMap stays (documented in code): kick socketId lookup, chat host-present gates. Items 3+4 of Workstream 1 (sweep + matchId gap) closed by this slice. 26 new tests (canonical-100-shipB.test.ts); anchors re-pointed: t0-2-room-presence, livekit-webhook. |
| Canonical Ship A | `66f4892` | Snapshot v2: per-recipient `you{location,connState,role,token?}` + timer.endsAt; token minted only on location change/resync; client emits `session:resync` on reconnect + conservative snapshot healing (wrong-room swap, missed return-to-lobby w/ 10s guard); location semantics fixed (disconnect preserves location; setRoomAssignment writes canonical breakout w/ real matchId — previously location was never breakout). Dual-run: legacy token events untouched. Smoke-caught hotfixes: `2792557` (resync on EVERY connect — refresh creates a fresh socket so 'reconnect' never fires; + lobby→breakout heal) and `0faf12b` (status-hygiene transitions must not relocate a live-match user — the rejoin path stomped canonical location). VERIFIED by headed prod smoke e2e/tests/shipA-smoke.spec.ts (run with JWT_SECRET=$(cat e2e/.jwt_secret)): F5-mid-breakout returns to same room w/ video; 12s offline→online resyncs (session:resync asserted on the wire). |

Also verified live in prod: canonical room-state phases 1–4 + snapshot wire (`SNAPSHOT_EMIT_ENABLED=true`, `ROOM_EVICTION_ENABLED=true`); timer drift fixed; ghosts/count-flip/bounce clusters addressed.

## Remaining work, in priority order

### Workstream 1 — Canonical migration: ✅ COMPLETE AND HUMAN-VERIFIED
A `66f4892` + B `087ba44` + C `2bdaef6` all live (main = `69e5a77`); headed shipA/B/C smokes + 20-browser load run green on `4077f23`; **Ali manually tested the full flow 2026-06-04 morning (session 'bb' — rounds, round-end return, no ghost re-pull) and confirmed "it was good"**. His reported Ship A issue (pulled back into dead breakout after End Round) was root-caused to the shadow-projection overwrite and fixed (`4077f23`). Remaining nice-to-have (NOT blocking): flip the last misc in-memory reads (lobby/breakout roster surfaces) to canonical; maps as cache only, rebuilt on boot.

**Sentry context for next session:** client project has a pre-existing LiveKit video-UX cluster — `NegotiationError: negotiation timed out` (the 93-event spike on 2026-06-04 00:50-00:52 was the 20-browser load harness, NOT real users — safe to resolve) and `PublishTrackError: insufficient permissions` ×11 — both belong to the Workstream 3 E4/E5 audio/video items below.

**E2E harness (reuse, don't rebuild):** `Desktop\RSN-fixloc` worktree has e2e node_modules + `.jwt_secret` + `server/.env` ready; specs `e2e/tests/ship{A,B,C}-smoke.spec.ts` + `loadABC-20users.spec.ts` run headed vs prod (command in e2e/README.md). New slices still get their own fresh worktree off origin/main per cadence.

### >>> NEXT SESSION ENTRY POINT: Workstream 2, then Workstream 3 <<<

### Workstream 2 — Part B "nobody waits alone": CORE SHIPPED ✅ (2026-06-05, autonomous run)

**Shipped:** `fcfa3e5` (core) + `56e14b4` (cancelled rooms not ratable) + `eb2e252` (hardened prod smoke). All on main, CI green, Render+Vercel live, full server suite 164/164 (2014 tests), headed `e2e/tests/ws2-smoke.spec.ts` FULL PASS vs prod (waiting banner + no client self-eject; resume-within-grace → same room; expiry → survivor 'partner_no_return' form → main, NO re-pair; late-returner 'Rate your last conversation' on rejoin; deliberate leave → survivor form in 1s). checkhole green 15:55 UTC.

**Delivered:** no re-pairing anywhere (isolated-participants module deleted, deletion pinned); Back-to-Main + host pull-back = immediate room end (5s deferred flows removed); disconnect AND Leave-event share the 15s `scheduleMatchEndGrace` (leave-event used to orphan the partner); trio slot-C disconnect fix + trio-aware expiry demote; `rating:window_open.reason` + per-reason RatingPrompt copy; late-return replay on rejoin; `emitRatingWindowOnce` returns emission so survivors are never stranded; cancelled (<30s) rooms skip the rating form both sides; client PartnerLeftAutoReturn 5s self-eject → passive waiting banner; `match:participant_left` typed + listened (trio banner clear + toast).

**Smoke harness learnings (baked into the spec):** single 10-min round (helper default 60s round fired round-end machinery mid-phase), presence-settled preview regen, 6-headed-browser ceiling on the 8GB run machine, commit-level goto + retries for the fluctuating uplink.

**REMAINING from the WS2 spec (next slice, S2):** kick ends the active match (survivor rates, kicked user gets NO form) — kick currently orphans the match; `registerParticipant` must reject status='removed' (kicked users can currently re-register back in — confirmed hole); trio departed round-end ratings (migration `departed_user_ids UUID[]` on matches + demote append + endRound partner list includes departed).

#### Original agreed spec (for reference — implement exactly this)
- A matching breakout needs ≥2 people; a room dropping below 2 ENDS for whoever remains. **No re-pairing** — remove the `findIsolatedParticipants` re-pair path (participant-flow.ts ~1520 leave-conversation, ~1829 disconnect-timeout); survivor goes rating → main.
- **Trigger timing:** "Back to Main Room" button + host pull-back = **immediate** room end. Browser close / connection drop / **"Leave event"** = **15s grace** (partner sees "waiting for partner…"); return within 15s → room resumes; else room ends. ("Leave event" today sets LEFT immediately and orphans the partner's match — fix that.)
- **Symmetric rating + UI messages:** survivor's rating form shows *"Your partner didn't return — rate your conversation, returning you to the main room"*; a **late-returner** (back after 15s) gets the rating form on rejoin with *"Rate your last conversation"*, then → main. Add a `reason` field to `rating:window_open` (`partner_no_return | late_return | round_end | early_leave`) and render copy in `RatingPrompt.tsx`. Reuse `emitRatingWindowOnce` (ratings-table dedup makes it safe). Both sides always rate; one rating per match ever (3-layer dedup already exists and works — client `ratedMatchIds`, server `emitRatingWindowOnce`, round-end partner-edge dedup at round-lifecycle.ts ~629).
- **Kick** = removed from event + banned from re-entry (verify join path rejects REMOVED; add guard if not); match ends; **survivor** auto-rates → main; kicked person gets no form.
- **Trio:** one leaves → leaver rates their 2 partners → main; remaining 2 CONTINUE to normal round end (already works via `demoteParticipantFromMatch`), where they rate **each other + the departed**.
- **Bug to fix en route:** `handleDisconnect` match lookup only checks participant A/B, not C (participant-flow.ts ~1709) — trio slot-C disconnects are unhandled.
- Much already exists (early-end rating emits, dedup, trio demote, 15s disconnect grace w/ `reconnectedAt` guard) — the deltas are: no-re-pair, leave-event grace, late-returner form + reason copy, kick handling, slot-C fix.

### Workstream 3 — remaining 27-May UX items (re-confirm client items against current main first; earlier audit partly read pre-recovery code)
| Item | Fix |
|---|---|
| B2 abrupt round end | server `timer:warning` at T-30/T-10 + client banner + chime (no audio infra exists) |
| B3 "final stretch" sticks | drive visibility from `timerEndsAt`, not the possibly-frozen `timerSeconds` (VideoRoom.tsx ~704) |
| E4 echo / can't-be-heard | set `audioCaptureDefaults` (echoCancellation etc.); decide lobby publish policy — `Lobby.tsx` `audio={isHost}` means non-hosts are never heard in main room |
| E5/E6 pin force-mutes / auto-mute flip | pin swaps flex↔grid trees remounting `LobbyMediaControls`; per-instance `appliedRef` re-fires auto-mute + 500ms re-apply. Hoist controls/pin out of per-tile render; SID-keyed once-only auto-mute |
| F1 chat hides content (mobile) | bottom-sheet/overlay instead of `hidden sm:flex` (LiveSessionPage.tsx ~230) |
| G3/G4 leave buttons | distinct destructive "Leave Event" (LogOut icon) vs "Back to Main Room"; remove duplicate exit paths (VideoRoom.tsx ~660-686) |
| H5 rating clarity | "didn't work" option + `excluded_from_quality_stats` tagging; label optional |
| D1–D3 layout | auto-fit/minmax grid + real scroll container (`flex-1 min-h-0 overflow-y-auto`), drop `max-w-*` caps (Lobby.tsx LobbyMosaic) |

## State management summary (for context)
One authoritative Redis doc per session `rsn:canonical:{sessionId}` `{status, currentRound, seq, timer.endsAt, participants{role, connState, location, lastSeenAt}}`; `location` single-valued (dual-room unrepresentable), `connState` orthogonal. All mutations through the guarded FSM chokepoint; Redis write = commit point; downstream: LiveKit commands (eviction ON), async Postgres projection (never read on realtime paths), seq-versioned `state:snapshot` (client discards `seq ≤ applied`; 30s REST + reconnect resync as nets). LiveKit webhooks reconcile `connState`. Live presence signal = `getPresentUserIds` union, now gating all matching + host-facing stats (fail-open).
