# RSN — May 20 Live Test Post-Mortem & Fix Plan

**Date:** 2026-05-20
**Test environment:** 8 participants + 1 host (Stefan as director), 1 chrome + 1 mobile per human, Stefan extra browser
**Production SHA at test time:** `10fa4a9`
**Live session record:** `3f8166f4-b62e-4807-8c63-c8ee41d95dc4`, pod `ce121e72-aae0-4b10-bc1b-0b64a4e48d23`, 3 rounds, completed 14:48 UTC

---

## TL;DR

**One root-cause bug cascaded into four user-visible bugs.** Fixing the one source eliminates the cascade. Plus one latent bug we got lucky with today.

The fix is small (≤30 lines), the test plan to verify zero regression is the May 20 doc itself + 4 new targeted scenarios.

---

## Bug catalogue

### 🟥 P0 — Bug R1: Director (event host) is being matched into breakouts

**Symptom Ali observed**
- Round 2 of today's test: host Stefan ended up in a breakout room with another participant.
- Host had to refresh; refresh pushed host + partner to the rating screen mid-event.
- Previous event's recap showed the host with 1 mutual + 1 people match — same bug, not a regression.

**Hard evidence (DB)**
- `sessions.host_user_id` for today = `4164c7ed-409f-4ce0-a5e8-887b91d416cc` (Stefan, role=`super_admin`)
- Row in `matches` table: `R2  a=4164c7ed  b=83ed07d1  status=completed  is_manual=false  match_reason=''  room=session-...-round-2-auto-reassign-1779288030344`
- `created_at = 2026-05-20T14:40:31.073Z`, exactly **2m16s AFTER** the legitimate R2 was generated (14:37:14)
- Same round-2 also has the legitimate pair `(3cf493e9, 83ed07d1)` — so `83ed07d1` was matched **twice** in R2 (extra duplicate row).

**Root cause**
`server/src/services/matching/isolated-participants.ts` — `findIsolatedParticipants()` query:

```sql
SELECT user_id FROM session_participants
WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
```

This query is used by **all three** mid-round reassign paths (voluntary leave, disconnect, host-driven reassign) to find candidates to pair with a leftover-solo participant. It filters by status only — **no host / cohost / acting-as-host exclusion**. So the function happily returns the event director as a "candidate to be paired".

The host **IS** in `session_participants` (joined as a regular row at 14:39:24) — the comment in `host-participants-view.ts:90` claiming "the host is NOT a session_participants row" is incorrect. Even when the host doesn't actively click "Join as participant", they get a row in `session_participants` for presence tracking.

**What happened in your Round 2 today, step by step**

| Time UTC | Event |
|---|---|
| 14:37:14 | R2 generated normally — 4 pairs, host correctly excluded by the matching service |
| 14:39:55 | R2 went active, everyone in breakouts |
| ~14:40:15 | Participant `3cf493e9` disconnected (refresh/network blip). Match `(3cf493e9, 83ed07d1)` downgraded to `completed`. `83ed07d1` becomes solo. |
| 14:40:31 | 15-second disconnect timer fires → `findIsolatedParticipants()` returns `[83ed07d1, host, ...]` (host fits all criteria: present + unmatched + not removed/left). Loop pairs `partnerId=83ed07d1` with first non-self candidate → ends up pairing with `host` → INSERT into `matches` as `auto-reassign-<timestamp>` room |
| → | Host is now in an active match. UI puts host into the breakout. When host eventually refreshed, match closed → rating window opened for both. |

**Same bug exists in 2 other paths**
1. `participant-flow.ts:1323` — voluntary-leave reassign (`leave-reassign-*` rooms)
2. `participant-flow.ts:1629` — disconnect-timeout reassign (`auto-reassign-*` rooms) ← **today**
3. `host-actions.ts:795` — manual reassign by host

**Fix (≤30 lines)**

Update `server/src/services/matching/isolated-participants.ts`:

```typescript
export async function findIsolatedParticipants(
  sessionId: string,
  roundNumber: number,
  presenceMap: PresenceMap,
  excludeUserId?: string,
): Promise<string[]> {
  // Phase R1 (20 May): exclude host + cohosts + admins acting-as-host.
  // Mid-round reassign must NEVER pull a host into a match.
  const sessionRes = await query<{ host_user_id: string }>(
    `SELECT host_user_id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const hostUserId = sessionRes.rows[0]?.host_user_id;

  const cohostsRes = await query<{ user_id: string }>(
    `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
    [sessionId],
  );
  const cohostIds = new Set(cohostsRes.rows.map(r => r.user_id));

  const actingHostRes = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants
     WHERE session_id = $1 AND acting_as_host = TRUE`,
    [sessionId],
  );
  const actingHostIds = new Set(actingHostRes.rows.map(r => r.user_id));

  // ... existing participants + activeMatches queries unchanged ...

  const isolated: string[] = [];
  for (const row of participantsRes.rows) {
    if (row.user_id === excludeUserId) continue;
    if (hostUserId && row.user_id === hostUserId) continue;     // NEW
    if (cohostIds.has(row.user_id)) continue;                   // NEW
    if (actingHostIds.has(row.user_id)) continue;               // NEW
    if (busyIds.has(row.user_id)) continue;
    if (!presenceMap.has(row.user_id)) continue;
    isolated.push(row.user_id);
  }
  return isolated;
}
```

**Defense in depth (belt + braces)**

At the INSERT site in `participant-flow.ts:1652` (and the other 2 sites), add a pre-INSERT assertion:

```typescript
// Hard guarantee: hosts MUST NOT be inserted into a match row.
if (normA === activeSession.hostUserId || normB === activeSession.hostUserId) {
  logger.error({ sessionId, normA, normB, hostUserId: activeSession.hostUserId },
    'Phase R1 — refused to auto-reassign host into a match');
  continue; // Skip this candidate, try next.
}
```

Plus a DB-level safety check: `migration 058` to add a CHECK / trigger preventing INSERT where the participant is the session's `host_user_id`. This is the last line of defense; it should never fire in practice but will catch any future code path that bypasses the eligibility filter.

---

### 🟥 P0 — Bug R2: Participant count desync per-client

**Symptom Ali observed**
- After Round 3, different clients showed different participant counts:
  - Ali: 7 participants
  - Klas: 3 participants
  - One account: "0 participants and no host"
  - Real state: 8 participants + 1 host all in main room
- Affected: main-room counter, participants list counter, host's round-planning UI
- Symptom drifted over time — "sometimes 5, sometimes 4, sometimes 8"

**Root cause**
Two-layer issue:

1. **Client-side derivation drift.** Each client computes participant count from its local Zustand `participants` array (`HostControls.tsx:98`: `participants.filter(p => !hostsSet.has(p.userId)).length`). The Zustand state is updated via per-event socket broadcasts (`participant:joined`, `participant:left`, `match:started`, `match:reassigned`). If any client misses an emit (network blip, mid-flight reconnect, late realtime-migration fanout), its count diverges from the canonical server count.

2. **Phantom match aggravation.** The Bug R1 phantom match made `83ed07d1` simultaneously "in main room" (from one client's perspective if they missed the `match:reassigned` emit) **and** "in active breakout" (from another client's perspective if they got the emit). Server's view: `83ed07d1` is in an active match → excluded from main room. Some clients agreed, others didn't.

**Fix**

The Phase 5/6 realtime migration introduced `emitEntities(io, userIds, [E.sessionParticipants(sessionId)])` as the canonical fanout. Verify the following emit sites all include `E.sessionParticipants` in their tag list:

- `match:reassigned` in `participant-flow.ts:1692-1709` ✓ (already includes `E.sessionParticipants(sessionId)`)
- `auto-reassign INSERT` at line 1654 — need to confirm tag fanout fires immediately after INSERT, not buffered
- `participant:left` / `participant:joined` paths — audit

Plus: in `host-participants-view.ts` and `matching-flow.ts:1244-1273`, surface `eligibleMainRoomCount` and `presentMainRoomCount` to **participants too**, not just hosts. Today these only ride the `host:round_dashboard` payload which only fans to host IDs (line 1315). Participants compute their own count client-side from `participants.length`. If the server canonical count rode every session-room broadcast as part of the entity-tag payload, every client would converge on the same value within ~1s.

**Verification protocol for next test**
- Open browser devtools → Application → Local Storage / IndexedDB → inspect Zustand store snapshot on every refresh during the test.
- Server emits `host:round_dashboard` every 5s + on every transition. Log the timestamps client-side.
- If any client's `participants.length` differs from any other for >2 consecutive seconds, capture the diff.

---

### 🟧 P1 — Bug R3: Ghost participant — physically in main room but not matched in R3

**Symptom Ali observed**
- In Round 3, one account that was physically in the main room was not generated a match.
- "Seems like that account was actually not present in the main room still the person is actually in the main room but maybe some reason this state is not in the main room"

**Root cause hypothesis**
Almost certainly the same `83ed07d1` from Bug R1: they had 2 completed R2 matches (legitimate + phantom). When R3 generation runs `excludedPairs` for "within-event no-repeat" (`matching.service.ts:262-274`), `83ed07d1` was excluded from being paired with EVERYONE they had ever been in a match with — and because they had 2 matches in R2, the exclusion set was larger than for any other participant. In an 8-person event with R3 fallback-ladder eligibility, that participant has the worst options.

OR — secondary hypothesis — `session_participants.status` for that user was `'disconnected'` at the moment R3 ran (because they had been mid-flight reconnecting after the phantom match auto-completed) → `getEligibleParticipants` excludes `'disconnected'` (line 490: `AND sp.status NOT IN ('removed', 'left', 'no_show', 'disconnected')`).

**Verification**
- Check `session_participants.status` history for `83ed07d1` around 14:42 UTC (when R3 generated).
- Once R1 is fixed, this bug should disappear automatically because the phantom match cascade stops.

**Fix**
None directly — fixing R1 eliminates the trigger. Add a TEST in the next-test plan to verify this regression doesn't reappear.

---

### 🟧 P1 — Bug R4: Premature rating screen on host refresh

**Symptom Ali observed**
- During the test, host refreshed (because of count issues + not being matched showing weird).
- Host + 1 participant landed on the rating screen mid-event, when they shouldn't have.

**Root cause**
Direct downstream of R1. The phantom auto-reassign match created with `status='active'`. When host refreshed:
1. Host's socket disconnected
2. 15s disconnect timer fired (yes, recursively)
3. The phantom match got marked `completed` (partner disconnect handling)
4. `emitRatingWindowOnce` fired for both participants of the (phantom) completed match
5. Both saw the rating screen

**Fix**
None directly — fixing R1 eliminates the phantom match, so no rating prompt triggers. As a defense, add a check in `emitRatingWindowOnce` to NEVER emit a rating window to a user_id that equals the session's `host_user_id`:

```typescript
// session-state.ts emitRatingWindowOnce
if (userId === session.hostUserId) {
  logger.warn({ sessionId, userId, matchId },
    'Phase R4 — refused to open rating window for the event host');
  return;
}
```

---

### 🟨 P2 — Bug R5: Initial connection flicker — "not connected" then suddenly shows correctly

**Symptom Ali observed**
- At the start of the test, 1-2 accounts showed as "not connected" briefly.
- Self-resolved within seconds, eventually showed 8 participants + 1 host correctly.

**Root cause**
Likely a presenceMap initialization race: socket connects → server hasn't yet processed `session:join` → client renders participant list from `session_participants` table where status='registered'/'in_lobby' (`null` presence) → some clients render "not connected" briefly. Once the server processes the `session:join` and emits the participant entity-tag, clients catch up.

**Fix**
Lower priority — visible for <5 seconds, doesn't affect functionality. Defer to next sprint unless Stefan flags it again. The cleaner fix is to mark `session_participants.status` as `'connecting'` (a new status enum value) the moment the user's `session:join` arrives, distinct from `'registered'` (pre-arrival). Client renders 'connecting' as a faint dot/spinner not "disconnected".

---

### 🟨 P3 — Bug R6 (latent, not user-visible today): Cohost exclusion silently broken

**Discovered while auditing**
- `matching.service.ts:828` queries `session_participants WHERE role = 'co_host'`
- But `session_participants` has **no `role` column** in prod (verified via `information_schema`)
- The query is wrapped in `try/catch` and silently returns `[]`

So the matching service NEVER excludes cohosts via `session_participants.role`. The actual cohost data lives in `session_cohosts` (separate table, was empty for today's test, hence no harm). But any future event with cohosts will hit this — cohosts will get matched as regular participants.

**Fix**
Replace the dead query at `matching.service.ts:828` with a query against `session_cohosts` directly:

```typescript
try {
  const cohostsRes = await query<{ user_id: string }>(
    `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
    [sessionId],
  );
  for (const r of cohostsRes.rows) allHostIds.push(r.user_id);
} catch (err) {
  logger.warn({ err, sessionId }, 'Failed to fetch session_cohosts');
}
```

---

## Acceptance criteria for the next test

Before scheduling the next live test, ALL of the following must pass locally + on staging:

### Code-level (server)
- [ ] `findIsolatedParticipants` excludes host_user_id, all `session_cohosts`, and `session_participants.acting_as_host=TRUE`
- [ ] All three call-sites (`participant-flow.ts:1323`, `:1629`, `host-actions.ts:795`) have a belt-and-braces assertion: `if (normA === hostUserId || normB === hostUserId) continue;`
- [ ] `matching.service.ts:828` queries `session_cohosts` not `session_participants.role`
- [ ] `emitRatingWindowOnce` refuses to open rating window for the host_user_id
- [ ] DB migration adding CHECK / trigger: `matches.participant_a_id != sessions.host_user_id AND matches.participant_b_id != sessions.host_user_id AND matches.participant_c_id != sessions.host_user_id`

### Test coverage
- [ ] New test: `auto-reassign skips host_user_id even when host is in session_participants` — fails on current code, passes after fix.
- [ ] New test: `auto-reassign skips session_cohosts row` — empty case for today, but covers future events.
- [ ] New test: `auto-reassign skips acting_as_host=TRUE row` — Phase M admins.
- [ ] New test: `participants count in client matches eligibleMainRoomCount within 2s of any participant transition`
- [ ] Run full suite locally before push (per [[feedback_full_test_suite_before_push]] memory rule).

### Manual smoke (recreate today's scenario)
- [ ] 8 participants + 1 host, do R1+R2+R3 with a deliberate refresh-the-host event in R2.
- [ ] Verify host's user_id appears in 0 rows of `matches` table.
- [ ] Verify no client ever shows "0 participants and no host".
- [ ] Verify rating screen NEVER appears for the host's account at any point during the event.

### Live-test protocol (against next test)
- [ ] `/liveloop` cron running before test starts → continuous check-hole monitoring.
- [ ] Every tester hard-refreshes before joining (Ctrl/Cmd+Shift+R).
- [ ] Each role uses the May 20 doc Part-by-Part walkthrough — sequential, not ad-hoc.
- [ ] Capture per-failure: which browser/role, exact URL, what they did, expected vs got, did F5 fix it.

---

## Test plan for next test — additions on top of May 20 doc

The May 20 doc (Parts 1-10) stays the canonical walkthrough. ADD these targeted scenarios specifically to verify today's bugs are gone:

### Scenario R1-A: Host disconnect during round 2
- Pre: 8 participants + host. R1 ran clean. R2 active.
- Host's browser: Ctrl-W or kill the tab during R2 (not refresh — actual disconnect, simulates network drop).
- Wait 30 seconds for the 15s timer to fire + buffer.
- Expected: NO row in `matches` table involving host_user_id for R2. Phantom match never created.
- Verification: query DB `SELECT * FROM matches WHERE session_id = '<sid>' AND (participant_a_id = '<host>' OR participant_b_id = '<host>' OR participant_c_id = '<host>')` → 0 rows.

### Scenario R1-B: Participant disconnect, normal auto-reassign
- Pre: 8 participants + host. R2 active. All partners paired.
- One participant (e.g., Klas's account) closes their browser.
- Their partner becomes solo.
- Wait 30s.
- Expected: Server auto-pairs the leftover partner with another isolated participant — but that participant is NEVER the host. Phantom match exists in `matches` BUT both participants are non-host users.

### Scenario R2-A: Count consistency across clients
- Pre: 8 participants + host all in main room, R0 (no round started yet).
- Tester actions: one participant joins, one leaves, one disconnects, one reconnects — in rapid succession.
- Expected: within 2 seconds of every transition, every client shows the same `participants.length` and the same eligible-count. No client diverges.

### Scenario R5-A: Initial connection
- Cold-load: clear all caches, hard-refresh, all 9 humans join within 30 seconds.
- Expected: at no point should any client display "0 participants and no host" or "1-2 not connected" beyond 5 seconds.

---

## Out of scope for THIS spec (acknowledged, deferred)

- Bug R5 (initial connection flicker) — visible <5s, no functional impact. Fix in next sprint.
- General entity-tag emit audit (server-side) — separate spec, low priority once R1 + R2 are fixed.

---

## Fix order (recommended)

1. Implement Bug R1 fix in `isolated-participants.ts` (highest priority — eliminates 3 cascading bugs).
2. Add 4 new tests in `__tests__/services/matching/isolated-participants.test.ts`.
3. Belt-and-braces assertions at the 3 call sites.
4. Bug R6 fix in `matching.service.ts` (cohost exclusion).
5. Bug R4 defense (rating window for host).
6. DB migration 058 (CHECK / trigger).
7. Verify entity-tag fanout for `E.sessionParticipants` at every relevant emit site (Bug R2).
8. Full local test suite + staging deploy + smoke test (per [[feedback_full_test_suite_before_push]]).
9. **STOP and ask Ali** before deploying to main (per RajaSkill Phase 4.2 + memory rule on production-during-events).

---

## Memory cross-refs

- [[feedback_work_mode]] — RajaSkill always, max effort, deep audit before edit
- [[feedback_no_truncate_join_requests]] — DB destructive ops require ask-first
- [[feedback_full_test_suite_before_push]] — full suite locally before push
- [[reference_neon_cli]] — Neon branch recovery if anything goes wrong
- [[project_rsn_acting_as_host_rules]] — Phase M acting-as-host rules; director cannot opt out
