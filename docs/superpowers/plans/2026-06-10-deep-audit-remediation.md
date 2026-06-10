# Deep-Audit Remediation Programme — 2026-06-10

Source: six-agent parallel audit of `RSN-dev` @ branch `june9-punchlist`, covering
security, chat, fields/schema, reliability, scalability, breaking-risk/accuracy.
Two top findings hand-verified in code; `completeSession` overclaim downgraded
after reading the existing C2/S18 guards.

## Governing rule
One bug per deploy. Each item: fix → local typecheck + targeted test → headed
Playwright smoke vs **production** asserting the OUTCOME (not visibility) → `/checkhole`
→ next. No batching unrelated fixes into one commit. No AI attribution in any commit/PR.

## Visibility classification (answer to "is it all backstage?")
- **A — invisible** (no behavior change): A1 completeSession finally guard, A2 JWT alg pin,
  A3 rating N+1 batch, A4 socket rate-limit (normal users unaffected), A5 enum/type
  reconciliation, A6 getUserByEmail field.
- **B — corrective** (visible by design; the fix IS a behavior change toward correct):
  B1 super_admin matching, B2 eligible-count display, B3 LEFT JOIN solo matches,
  B4 removed-participant chat gate, B5 delivery-rail recovery, B6 chat reconnect re-fetch.
- **C — NOT backstage, separate project, explicit go/no-go**: C1 HttpOnly-cookie auth migration.

---

## PHASE 1 — This branch (`june9-punchlist`), ship before merge

### 1.1 — super_admin re-enters matching on round repair  [Bucket B, CRITICAL, VERIFIED]
- File: `server/src/services/matching/matching.service.ts:941-970`
- Problem: `repairFutureRounds` hand-builds `allHostIds` (director + cohosts +
  acting_as_host) and never queries super_admins, so a late join/leave that triggers
  a repair makes a super_admin matchable and pairable into a breakout — violates the
  9-Jun "super_admin always host" policy that `getAllHostIds()` already encodes.
- Fix: replace the manual block (941-970) with `const allHostIds = await getAllHostIds(sessionId, session.hostUserId);`
  Confirm `getAllHostIds` already folds in cohosts + acting_as_host overrides (it does,
  per a20d70c) so no exclusion is lost.
- Test: unit — event with 1 super_admin + 2 participants, fire repair, assert super_admin
  NOT in any regenerated round. Prod smoke — see Phase 4 scenario S1.
- Risk: low. Single call-site swap to an already-tested function.

### 1.2 — host "Match People: N eligible" count inflated  [Bucket B, HIGH, agent-reported]
- File: `server/src/services/orchestration/handlers/matching-flow.ts:~1544`
- Problem: `eligibleMainRoomCount` query excludes only the director, not cohosts or
  super_admins, so the host-facing count is too high. Actual matching (line ~360 via
  `getAllHostIds`) is correct — display only.
- Fix: derive the count from the same `getAllHostIds()` set used by the real matching
  path; exclude `!= ALL($hostIds)`. Re-verify the exact line at implementation time.
- Test: count returned == participants minus all hosts. Prod smoke S1 asserts the label.
- Risk: low, read-only count.

---

## PHASE 2 — Next deploy (post-merge, off `main`)

### 2.1 — completeSession finally-block double-run  [Bucket A, MEDIUM, DOWNGRADED]
- File: `server/src/services/orchestration/handlers/round-lifecycle.ts:853-855, 868-888`
- Reality: C2 idempotency guard (875) + S18 synchronous in-memory COMPLETED flip exist.
  Double-complete is already refused. Residual: if `activeSession` was already deleted
  (null) the guard short-circuits and the `finally` (clearPersistedState /
  clearDashboardCoalesce / LiveKit close) can run a second time and race the first.
- Fix: capture an `alreadyCompleting` boolean keyed by sessionId before the first await;
  no-op the finally cleanup if a prior call owns it. Keep the existing guards.
- Test: invoke completeSession twice concurrently in a unit harness; assert one cleanup pass.
- Risk: low. Pure server-internal; no client contract.

### 2.2 — socket events have no rate limit  [Bucket A, HIGH, agent-reported, security+reliability]
- Files: `server/src/services/orchestration/handlers/chat-handlers.ts` (chat:send,
  chat:react, reaction:send), `dm-handlers.ts` (dm:send). HTTP limiter doesn't cover sockets.
- Fix: per-socket sliding-window token bucket (in `activeSession` for now; Redis-keyed
  when multi-instance lands). Ceilings: chat 10/10s, reactions 5/s, dm 10/10s. On exceed,
  silently drop + optional one-time `error` toast. **Thresholds tuned so a real fast typer
  never hits them** — verify against a human-paced send in the smoke.
- Test: emit-loop unit asserts drop after ceiling; manual-pace test asserts NO drop.
- Risk: medium — too-tight ceiling would throttle legit users. Mitigate with generous limit + smoke.

### 2.3 — delivery rails: match:assigned / rating:window_open / session:completed  [Bucket B, CRITICAL, agent-reported]
- Files: `round-lifecycle.ts:357-366` (match:assigned), `:510-530` (rating:window_open),
  `:736-737` (session:completed). All fire-and-forget; a buffered socket loses the event
  and the user is stuck (lobby / no rating form / frozen lobby) until manual refresh.
- Fix: add a recovery-on-poll path — the existing `session:state` / resync reply must
  carry current match assignment, open-rating-window state, and terminal status, so a
  reconnect or a periodic client resync self-heals without the one-shot event. Prefer
  extending resync payload over adding socket acks (acks don't survive refresh; the
  memory note "refresh-survivable client state" is the governing principle).
- Test: e2e — drop the socket mid-assign/mid-rating/at-complete, reconnect, assert the
  client recovers correct phase from the stream. This is the heaviest item; may split
  into three separate one-bug-per-deploy ships (2.3a/b/c).
- Risk: medium-high (touches the live event state path). Each sub-ship smoked independently.

---

## PHASE 3 — Soon (correctness + chat robustness)

### 3.1 — LEFT JOIN for solo matches  [Bucket B, CRITICAL-data, VERIFIED]
- File: `server/src/routes/admin.ts:746` (`JOIN users ub ON ub.id = m.participant_b_id`).
  Also re-check session-recap and rating queries flagged by the fields agent.
- Problem: migration 036 made `participant_b_id` nullable for odd-count solo/bye matches;
  the INNER JOIN silently drops those rows from admin "recent matches" (and any other view
  using the same pattern). Admin sees an incomplete picture.
- Fix: `LEFT JOIN users ub ...`; coalesce NULL b-fields in the SELECT/response shape so the
  client renders "solo" instead of crashing on null name. Grep the whole server for the
  same `JOIN users ub ON ub.id = m.participant_b_id` pattern and fix every hit together
  (this one is a single grep-able pattern, exception to one-bug-per-deploy).
- Test: insert a solo match fixture, assert it appears in each affected query.
- Risk: low; widening a join only adds rows.

### 3.2 — chat history not re-fetched on socket reconnect  [Bucket B, MEDIUM, agent-reported]
- Files: `client/src/features/live/ChatPanel.tsx:72-82`, `client/src/hooks/useSessionSocket.ts`
  reconnect handler.
- Problem: history fetch fires on mount only; a reconnect with the panel already open
  leaves a gap (messages sent during the blip never appear until full refresh).
- Fix: on socket `reconnect`, if chat panel open, re-emit `chat:request_history` for the
  current scope and merge-dedupe by message id.
- Test: e2e — open chat, drop socket, peer sends, reconnect, assert peer message appears.
- Risk: low, additive client fetch.

### 3.3 — removed participant can still send chat  [Bucket B, MEDIUM, security, agent-reported]
- File: `server/src/services/orchestration/handlers/chat-handlers.ts:59-69`
- Problem: send gate checks host presence, not the sender's participant status; a user
  removed mid-event with a still-open socket can keep broadcasting.
- Fix: before broadcast, verify `session_participants.status NOT IN ('removed','left','no_show')`
  for the sender. Reuse existing status lookup; cache in activeSession to avoid an N+1.
- Test: remove a participant, assert their subsequent chat:send is rejected.
- Risk: low.

### 3.4 — enum/type reconciliation  [Bucket A, MEDIUM, agent-reported]
- `shared/src/types/pod.ts`: add `REQUEST_TO_JOIN` to `PodVisibility` (DB has it since mig 017);
  decide `DECLINED`/`NO_RESPONSE` on `PodMemberStatus` — either add a migration or remove from TS.
- `server/src/services/identity/identity.service.ts:114-117`: add
  `onboarding_completed AS "onboardingCompleted"` to `getUserByEmail`.
- `shared/src/types/session.ts:145`: make `hostVisibilityMode` non-optional (DB is NOT NULL DEFAULT).
- Test: typecheck clean; no runtime behavior change expected — confirm with smoke that
  pod create/join and login still work.
- Risk: low, but the DB-enum-vs-TS direction needs a migration only if we keep the values.

---

## PHASE 4 — Scheduled hardening (lower urgency)

### 4.1 — JWT algorithm pin  [Bucket A, MEDIUM-security]
- `server/src/middleware/auth.ts:76`, `server/src/index.ts:113`: pass
  `{ algorithms: ['HS256'] }` to every `jwt.verify`. Defense-in-depth vs alg-confusion.
- Risk: low; verify existing tokens still validate.

### 4.2 — rating finalize N+1  [Bucket A, perf]
- `server/src/services/rating/rating.service.ts:591-596`: collapse the per-match
  `checkMutualMeetAgain` + `getRatingsByMatch` loop into one grouped query. Cuts end-of-event
  delay from ~seconds to ~constant at scale.
- Risk: medium (touches recap correctness) — pin with a fixture asserting identical output
  before/after.

### 4.3 — socket session:join access gate  [Bucket A, security]
- Add a `canViewSession`/`canJoinSession` check in the socket join handler to mirror the
  REST guard (currently relies on `registerParticipant`'s pod check alone).
- Risk: low-medium; must not block legitimate joins — smoke the normal join path.

### 4.4 — pagination on GET /sessions/:id/participants  [Bucket A, scale]
- `server/src/routes/sessions.ts:401`: add LIMIT/OFFSET + `{data,total,page,hasMore}`.
  Defer until participant counts actually approach hundreds; current events are small.

---

## PHASE C — Auth cookie migration (SEPARATE, NEEDS EXPLICIT GO/NO-GO)
### C1 — move tokens from URL/localStorage to Secure HttpOnly cookies
- NOT part of this sweep. Rewrites OAuth callback, client storage, every authed request.
  High blast radius (could break login for all users). Recommend: defer; if approved, plan
  as its own document with a staged rollout + rollback and a full prod-auth e2e. Until then,
  XSS-token-theft risk is mitigated by the existing React escaping (no chat XSS found).

---

## DEFERRED / NOT FIXING NOW (with reason)
- Memory-only chat + 50-msg cap (Redis backing): product-accepted ephemerality; revisit only
  if Stefan wants persistence. Document the "last 50" behavior.
- Cross-instance canonical RMW (Redis WATCH/Lua), Socket.IO Redis adapter as hard dep,
  in-memory state LRU eviction, matching heuristic >200: all single-instance Phase-1
  trade-offs; not triggered at current load. Track for the scale phase.
- Message-id UUID swap: collision probability negligible at current scale; low priority.

---

## PHASE 5 — Headed Playwright smoke vs PRODUCTION (after each ship, consolidated final pass)
Run headed (camera/LiveKit real) against the branch's Vercel preview or prod per the
established RSN pattern (JWT_SECRET from `e2e/.jwt_secret`, bypass via
`get_access_to_vercel_url`). Assert OUTCOMES, not element visibility. Clean up dummy users by id.

- **S1 (1.1+1.2):** event with a super_admin participant + 2 members; trigger a late-join
  repair; assert (a) super_admin never enters a breakout, (b) host count label reads correct N.
- **S2 (2.2):** human-paced chat send → all messages delivered (no false throttle); then
  emit-loop → throttled. Assert legit path unaffected.
- **S3 (2.3a/b/c):** mid-round socket drop + reconnect → recovers match; drop during rating →
  rating form recovers; drop at completion → recap state recovers.
- **S4 (3.1):** create an odd-count event producing a solo match; assert it appears in admin
  recent-matches and recap.
- **S5 (3.2+3.3):** chat reconnect re-fetch shows missed peer messages; removed participant's
  send is rejected server-side.
- **S6 (3.4/4.x):** regression — login, pod create/join, normal session start→match→rate→recap
  all still pass after enum/type and security changes.
- Finish with `/checkhole`: Sentry clean, Render deploy SHA == pushed, git in sync.

## Sequencing summary
Phase 1 (this branch) → merge → Phase 2 (3 ships) → Phase 3 (4 ships) → Phase 4 (4 ships,
lower urgency) → Phase 5 consolidated prod smoke. Phase C only on explicit approval.
Total: ~13 production ships + 1 deferred decision.
