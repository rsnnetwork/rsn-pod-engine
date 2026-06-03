# 27th May — Remaining Work (continuation doc)

**Last updated:** 2026-06-03 (main = `d6b964a`)
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

Also verified live in prod: canonical room-state phases 1–4 + snapshot wire (`SNAPSHOT_EMIT_ENABLED=true`, `ROOM_EVICTION_ENABLED=true`); timer drift fixed; ghosts/count-flip/bounce clusters addressed.

## Remaining work, in priority order

### Workstream 1 — Canonical migration to 100% (NEXT; Ali explicitly requested)
The migration is ~85% done. Finish:
1. **Phase 5 completion — fold tokens into the versioned snapshot; retire `match:assigned`/`lobby:token` as token carriers.** Biggest client-contract change; design at `docs/superpowers/specs/2026-05-25-canonical-room-state-design.md` §8 + `docs/superpowers/plans/2026-05-25-canonical-room-state-phase5.md`. Snapshot's `you.token` carries the single token for the client's canonical location; client reacts to location change by disconnect+reconnect with the new token; kills the dual-token/dual-room class. Client + server deploy together (same-deploy cutover) — plan a dual-run window where old events still fire, then remove. Touches `state-snapshot.ts`, `round-lifecycle.ts`, `participant-flow.ts`, `useSessionSocket.ts`, `sessionStore.ts`, `VideoRoom.tsx`, `Lobby.tsx`.
2. **Phase 3 completion — flip remaining legacy in-memory read paths to canonical** (today only host-participants-view reads canonical; lobby/breakout rosters + misc reads still hit in-memory maps/DB). In-memory maps become cache only, rebuilt from Redis on boot.
3. **Phase 4 hardening — periodic LiveKit sweep (~15s `listParticipants` vs canonical)** to heal missed webhooks (currently webhook-only).
4. Known small gap: `transitionParticipant` writes canonical location with `matchId: ''` (hardcoded) — fix while in there.

### Workstream 2 — Part B "nobody waits alone" (full spec agreed with Ali — implement exactly this)
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
