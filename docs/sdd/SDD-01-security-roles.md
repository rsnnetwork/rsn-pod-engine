# SDD 01 — C1 privilege escalation + role-check cleanup

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

Cluster C1 — privilege escalation + role-check cleanup. All audit citations re-verified against the code on june9-punchlist: the un-gated endpoint is routes/host.ts:185-220 exactly as described; the escalation path is effective-role.service.ts:135-138 + 190-198 ('cohost' floor for acting_as_host=true on any participant row), consumed by verifyHost (host-actions.ts:191-215) for every socket host handler, plus REST gates at routes/sessions.ts:628-629, host-actions.ts:2368, and the s16 pre-cohost route. One audit claim needed correction: the client picker is not merely 'removed' — the banner/toggle markup still exists in LiveSessionPage.tsx and HostControlCenter.tsx but is dead code behind hardcoded `canToggleActingAsHost = false / showJoinAsBanner = false` (LiveSessionPage.tsx:106-108), and those constants are themselves PINNED by phase-m-acting-as-host.test.ts:237-243 and phase-p-acting-as-host-completeness.test.ts:100-107. So no client change is needed or wanted in this cluster.

Key design decision (recorded in SEC-1): the authorization rule implements the product spec verbatim — platform role admin/super_admin AND not director may toggle; director 403; participants AND formal co-hosts 403 (cohost power comes from session_cohosts, never this override). Defense in depth is two-layer: a runtime guard in getEffectiveRole (TRUE honoured only for platform admins, fail-closed on undefined role, FALSE/opt-out preserved for everyone but the director) plus an idempotent cleanup migration (068, no inner BEGIN/COMMIT per the migration-runner hardening rules) for rows already poisoned in prod. The runtime guard also covers the Render zero-downtime overlap window where the old instance can still accept un-gated writes after the migration has run.

Deliberate non-goal, flagged for product: once SEC-1 ships, a legit admin opt-in (API-only today) gets host UI via the resolver but is NOT excluded from matching — getAllHostIds and repairFutureRounds contain no override logic, and that ABSENCE is pinned three times as Stefan's 9-Jun policy (super-admin-host-policy.test.ts:33-47, phase-m:124-131, phase-p:234-241), while the snapshot host counts (session-state-snapshot.service.ts:329-341) and HCC badges DO apply overrides. The audit's adversarial verifier ruled this disagreement closed by fixing C1, and it stays unreachable from the shipped UI; if the join-as banner is ever re-enabled, matching-exclusion symmetry must be specced then, updating those pins explicitly.

Shipping order: SEC-1 (P0) first; SEC-2 (P1) after SEC-1 because widening remove-from-room to the verifyHost surface should only happen once the escalation hole into that surface is closed; SEC-3 (P2) independent. Each item is one deploy with headed prod smokes per the team's per-bug process, full server suite locally before every push. supertest is resolvable from the workspace root (pattern: __tests__/routes/livekit-webhook.test.ts with a require.resolve guard); db-mocked unit tests follow __tests__/services/session.service.test.ts. No new dependencies anywhere in the cluster; no client deploys; one migration total (SEC-1).

---

## SEC-1 — Gate POST /sessions/:id/host/acting-as-host to platform admins + defense-in-depth in getEffectiveRole + poisoned-row cleanup migration

**Priority:** P0

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/routes/host.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/roles/effective-role.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/db/migrations/068_acting_as_host_admin_only_cleanup.sql (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/routes/sec1-acting-as-host-gate.test.ts (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/roles/sec1-effective-role-hardening.test.ts (new)`

### Problem

Audit C1 (verified): POST /api/sessions/:id/host/acting-as-host (server/src/routes/host.ts:185-220) requires only `authenticate` and refuses only the event director. Any attendee can POST {value:true} for their own session_participants row; getEffectiveRole (effective-role.service.ts:135-138,190-198) then returns 'cohost' for acting_as_host=true on ANY participant row, so canActAsHost/verifyHost passes on every socket host handler (mute-all, kick, scramble rooms, pause, force-close ratings) and on the REST cohost-management gates (routes/sessions.ts:628-629, host-actions.ts:2368). The client picker is pinned OFF (LiveSessionPage.tsx:106-108 hardcodes canToggleActingAsHost=false), so the endpoint is a pure attack surface today. Rows already poisoned in prod keep granting host power until cleaned.

### Design

THREE layers, one deploy.

(A) Endpoint gate — routes/host.ts, inside the '/:id/host/acting-as-host' handler (currently lines 190-219). Authorization rule per product spec (Ali's acting-as-host rules, June-10): callers whose PLATFORM role (req.user!.role, JWT-derived by `authenticate`, see middleware/auth.ts:84-89) is UserRole.SUPER_ADMIN or UserRole.ADMIN may toggle, ONLY when they are not the event director; the director gets 403 (existing check, keep verbatim); everyone else (plain participants, formal co-hosts without a platform-admin role) gets 403. Insertion point: keep the existing director check (lines 199-205) EXACTLY as-is and FIRST (it is pinned — see pins), then add the platform-role gate immediately after it, before `sessionService.setActingAsHost(...)`. The gate applies to all values (true/false/null) — non-admins have no legitimate write here. Keep the new code compact (≤6 lines incl. one short comment): the phase-m pin asserts setActingAsHost appears within 1500 chars of the route-string literal. Everything else in the handler (setActingAsHost no-op-if-unregistered semantics, emitPermissionsUpdated to the caller, response shape) is unchanged.

Verified consumption of acting_as_host (the 'GET gate' question): there is NO GET endpoint for acting-as-host — only the two POSTs in routes/host.ts. Reads flow exclusively through the state snapshot (session-state-snapshot.service.ts exposes actingAsHostOverrides to all participants). That exposure is read-only UI data (header counts, badges — pinned by phase-m/phase-p tests) and grants nothing server-side; do NOT gate or remove it. The companion endpoint POST /:id/host/acting-as-host-for/:userId (routes/host.ts:230-278) is already gated by verifyHostOrSuperAdmin — leave it alone.

(B) Defense-in-depth in getEffectiveRole — effective-role.service.ts. Insert a neutralization right after the actingOverride/isDirector reads (after the second try-block ending line 104, BEFORE `if (isDirector)` at line 105): acting_as_host===true is honoured ONLY when globalUserRole is SUPER_ADMIN or ADMIN; otherwise set actingOverride = null (treat as poisoned data). This is fail-closed: an undefined globalUserRole also gets no escalation. acting_as_host===false (opt-out) stays honoured for everyone except the director (unchanged — it is a de-escalation and the cohost/super_admin opt-out path is pinned intent, phase-m test lines 73-96). Director short-circuit unchanged. Net effect: a poisoned TRUE row on a plain participant can never reach the `return 'cohost'` floor at line 196, so verifyHost (host-actions.ts:191-215), routes/sessions.ts:628 cohost-mgmt gate, host-actions.ts:2368, and the s16 pre-cohost route all deny it — covering rows written by the old un-gated endpoint AND any row poisoned through the old instance during the Render deploy overlap.

(C) Cleanup migration — new file server/src/db/migrations/068_acting_as_host_admin_only_cleanup.sql (067 is the current max; duplicate prefixes are tolerated by the runner but 068 is free). One idempotent UPDATE that nulls acting_as_host=TRUE rows whose users.role is not admin/super_admin. Per the deploy rule for this programme: NO inner BEGIN/COMMIT, idempotent by construction (re-run matches zero rows). Leave FALSE rows untouched (self-opt-outs are harmless de-escalations and the legit acting-as-host-for path also writes FALSE).

DELIBERATE NON-GOAL (record in code comment): legit admin opt-ins (now API-only since the client banner is pinned off) get host UI via the resolver but are NOT added to getAllHostIds/repairFutureRounds matching exclusion — that absence is pinned as Stefan's 9-Jun policy (super-admin-host-policy.test.ts:33-47, phase-m:124-131, phase-p:234-241). The audit's adversarial verifier ruled the three-subsystem disagreement closed by fixing C1. If product re-enables the banner, matching-exclusion symmetry is a separate spec with those pins updated.

### Code sketch

````
// routes/host.ts — inside the acting-as-host handler, AFTER the existing
// director check (keep its text verbatim) and BEFORE setActingAsHost:

      // SEC-1 (13 Jun audit C1) — only platform admins may toggle; cohost
      // power comes from session_cohosts, never from this override.
      const callerRole = req.user!.role;
      if (callerRole !== UserRole.SUPER_ADMIN && callerRole !== UserRole.ADMIN) {
        next(new ForbiddenError('Only platform admins can use the acting-as-host toggle'));
        return;
      }
      await sessionService.setActingAsHost(sessionId, userId, req.body.value); // unchanged

// effective-role.service.ts — insert after the two try-blocks (line ~104),
// before `if (isDirector)`:

  // SEC-1 (13 Jun audit C1) — the opt-in escalation is honoured only for
  // platform admins. TRUE on anyone else is poisoned data from the formerly
  // un-gated endpoint (or a mid-deploy-overlap write) and is treated as NULL.
  // FALSE (opt-out) stays honoured for everyone — de-escalation is safe.
  // Fail-closed: undefined globalUserRole gets no escalation.
  if (
    actingOverride === true &&
    globalUserRole !== UserRole.SUPER_ADMIN &&
    globalUserRole !== UserRole.ADMIN
  ) {
    actingOverride = null;
  }

-- 068_acting_as_host_admin_only_cleanup.sql (no BEGIN/COMMIT, idempotent)
-- SEC-1 (2026-06-13 audit C1): null poisoned opt-ins written via the
-- formerly un-gated endpoint. Opt-outs (FALSE) left untouched.
UPDATE session_participants sp
   SET acting_as_host = NULL
  FROM users u
 WHERE u.id = sp.user_id
   AND sp.acting_as_host = TRUE
   AND u.role NOT IN ('admin', 'super_admin');

// sec1-acting-as-host-gate.test.ts — supertest pattern from
// __tests__/routes/livekit-webhook.test.ts (require.resolve('supertest')
// guard; supertest resolves from root node_modules). Mock
// ../../middleware/auth (authenticate injects a configurable req.user),
// ../../middleware/audit (pass-through), ../../services/session/session.service
// (getSessionById -> {hostUserId:'director-1'}, setActingAsHost: jest.fn),
// ../../realtime/fanout (emitPermissionsUpdated: jest.fn),
// ../../services/orchestration/orchestration.service (stub). Mount
// app.use('/api/sessions', hostRouter) + the repo error handler (or a
// minimal one mapping ForbiddenError.statusCode -> 403). Cases in tests[].
````

### Tests to add

- NEW server/src/__tests__/routes/sec1-acting-as-host-gate.test.ts (supertest integration, mocked auth/session service): (1) role 'member' non-director POST {value:true} -> 403, setActingAsHost NOT called; (2) role 'member' who is also a formal cohost -> 403 (gate is platform-role based; cohost-ness irrelevant); (3) role 'admin' non-director {value:true} -> 200, setActingAsHost called with (sessionId, callerUserId, true), emitPermissionsUpdated called; (4) role 'super_admin' non-director -> 200; (5) role 'admin' whose userId === session.hostUserId (director) -> 403, setActingAsHost not called; (6) role 'admin' {value:null} -> 200 (clear allowed). Plus source pins on the new migration file: matches /UPDATE\s+session_participants/i, /acting_as_host\s*=\s*NULL/i, /NOT\s+IN\s*\('admin',\s*'super_admin'\)/i and does NOT match /BEGIN;|COMMIT;/.
- NEW server/src/__tests__/services/roles/sec1-effective-role-hardening.test.ts (unit, jest.mock('../../db') returning scripted rows — pattern exists in __tests__/services/session.service.test.ts): (1) POISONED ROW: participant row exists, acting_as_host=true, globalUserRole='member', not director, no cohost row, no pod role -> getEffectiveRole returns 'participant' and canActAsHost returns {allowed:false} (this is the 'poisoned row no longer grants verifyHost' regression test — verifyHost is a thin wrapper over canActAsHost, host-actions.ts:206); (2) admin + acting_as_host=true + participant row -> 'cohost', canActAsHost allowed:true; (3) undefined globalUserRole + acting_as_host=true -> 'participant' (fail-closed); (4) super_admin + acting_as_host=false, not director -> 'participant' (opt-out preserved); (5) director with acting_as_host=false -> 'event_host' (Phase P immunity preserved); (6) plain cohost (session_cohosts row, role 'member', acting_as_host NULL) -> 'cohost' (formal delegation unaffected).
- Headed Playwright prod smoke (per-bug ship process): create throwaway users (%rsn-e2e.invalid) — director + plain participant in a live event. From the participant's browser context, fire fetch POST /api/sessions/:id/host/acting-as-host {value:true} with their JWT -> assert 429-free 403 response body; then assert OUTCOME not visibility: participant emits a host socket action (e.g. host:mute_all via window socket or simply asserts host controls never render and a host:start_round attempt returns the FORBIDDEN error frame); director POSTs to the endpoint -> 403. If an admin test account is available, admin non-director -> 200 and host UI appears after the permissions:updated resync. Run the FULL server suite locally before push (standing rule).

### Acceptance criteria

- POST /api/sessions/:id/host/acting-as-host returns 403 (ForbiddenError envelope) for any authenticated caller whose users.role is not admin/super_admin, with no session_participants write (assert via setActingAsHost spy in tests; via DB query in smoke).
- Returns 403 for the director regardless of platform role (existing message preserved).
- Returns 200 and persists the value for a non-director admin/super_admin; the caller's snapshot resyncs via permissions:updated (existing rail).
- getEffectiveRole with a TRUE override on a non-admin returns at most 'participant'; canActAsHost.allowed === false; a socket host action from such a user is refused with the FORBIDDEN error frame.
- After deploy, SELECT count(*) FROM session_participants sp JOIN users u ON u.id=sp.user_id WHERE sp.acting_as_host AND u.role NOT IN ('admin','super_admin') returns 0 on prod.
- Full server test suite green locally before push, including all phase-m / phase-p / phase-i / phase-l / t1-5 / super-admin-host-policy files untouched-or-window-widened-only.

### Pinned tests to update

- server/src/__tests__/services/phase-m-acting-as-host.test.ts:143-154 — pins that `sessionService.setActingAsHost(sessionId, userId, req.body.value` and `userId = req.user!.userId` appear within 1500 chars of the route-string literal. The current block is ~1100 chars; the new gate must stay compact. If the window overflows, widen the slice to 2200 in the pin with a comment ('SEC-1 gate inserted before setActingAsHost') — that is the only permitted change; the assertions themselves stay.
- server/src/__tests__/services/phase-p-acting-as-host-completeness.test.ts:42-57 — pins director check (`session.hostUserId === userId`, ForbiddenError) BEFORE setActingAsHost in the same 1500-char window. Satisfied by keeping the director check first and verbatim; same window-widening caveat as above.
- server/src/__tests__/services/phase-m-acting-as-host.test.ts:70-107 — getEffectiveRole pins: override read before the literal 'Layer 1' comment (do not move/rename that comment); /actingOverride === false ... return 'participant'/ within 600 chars (the neutralization block mentions only `=== true`, so the first `=== false` occurrence remains line ~110 — passes); /actingOverride === true ... return 'cohost'/ within 600 chars (still satisfied by the unchanged `if (actingOverride === true) return 'cohost'` at line ~196). No edits expected; listed because the insertion sits between pinned anchors — run this file first after editing.

### Risks

Low blast radius: the client picker is pinned off, so no shipped UI path loses function; the only behavior removed is the exploit. Residual: legit admin opt-ins (API-only today) get host UI but are NOT excluded from matching (getAllHostIds has no override logic — pinned 9-Jun policy); acceptable while the banner is off, must be re-specced together if the banner returns. The resolver hardening trusts the JWT-carried role (same trust as Layer 1 SUPER_ADMIN check — consistent); socket paths use socket.data.role set from the JWT at index.ts:127. During the Render zero-downtime overlap the OLD instance still serves the un-gated endpoint for seconds after the migration ran on the new instance's boot — a row poisoned in that window survives the migration, which is exactly why layer (B) exists; it makes such rows inert. Migration cost: single UPDATE with index-friendly predicates, small table — no lock_timeout concerns (no DDL).

### Deploy notes

Server-only deploy (no client change, no env var, no render.yaml change). Includes migration 068 — auto-runs on boot; written WITHOUT inner BEGIN/COMMIT and idempotent per the migration-runner hardening rules (the runner cluster owns the runner itself). No ordering constraint with other clusters. Ship first in this cluster (P0). One bug per deploy + headed prod smoke per standing process.

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** The spec's core premise — 'the client picker is pinned OFF, so the endpoint is a pure attack surface today' and 'no shipped UI path loses function' — is false. Only LiveSessionPage's banner/blocker constants are pinned off (LiveSessionPage.tsx:106-109, and myActingAsHost is hardcoded undefined so its banners never render). HostControlCenter.tsx:502-520 still renders a LIVE 'Switch to participant / Switch back to host' toggle to every non-director acting host (HCC is reachable for formal co-hosts: baseIsHost = isOriginalHost || isCohost || isSuperAdmin at LiveSessionPage.tsx:104-105), and its onClick calls setMyActingAsHost(false|null) which POSTs to this exact endpoint (HostControlCenter.tsx:378-386 api.post, pinned by phase-m-acting-as-host.test.ts:255-272). Gating ALL values (true/false/null) on platform role 403s a member-role co-host using a shipped control. Worse, combined with the migration's deliberate retention of FALSE rows: a non-admin co-host already opted out keeps a resolver-honoured FALSE row ('participant' via effective-role.service.ts:110-116, host powers denied), sees the 'Switch back to host' label, and the revert POST (value:null) now returns 403 — a permanent self-service lockout only the director can undo via /acting-as-host-for. No test catches this: all the relevant pins are source-text pins that stay green. The spec is also internally inconsistent: layer (B) preserves opt-out 'for everyone' precisely because non-admin co-hosts legitimately use it, while layer (A) forbids those same users from ever writing or clearing it.

*Required action:* Restrict the new gate to escalation only: value === true requires platform admin/super_admin; allow value false/null (de-escalation and clear) for any caller — or at least for callers who are formal co-hosts/super_admin. Alternatively, include a client change in the cluster that hides the HCC toggle for non-admins and decide explicitly what happens to existing non-admin co-host FALSE rows (the migration currently leaves them, stranding those users). Update the 'pure attack surface' problem statement and the risks section accordingly.

**[IMPORTANT]** Missed pinned-test collision, and the remediation note targets the wrong test. phase-m-acting-as-host.test.ts:156-163 ('notifies the caller via permissions:updated') slices the SAME 1500-char window from the '/:id/host/acting-as-host' literal and requires /emitPermissionsUpdated\(/. Measured on the current file: routeIdx=6799, the emitPermissionsUpdated call sits at window offset 1244; the spec's own code sketch is exactly 383 chars, pushing it to ~1627 — outside the window, test fails. Meanwhile the pin the spec DOES list (phase-m:143-154) still passes after insertion (the setActingAsHost regex match ends at offset ~1357 < 1500), and the spec's instruction that widening the 143-154 window 'is the only permitted change' actively forbids the edit the implementer actually needs (widening the 156-163 window). An implementer following the spec literally ships a red full-suite run with no sanctioned fix.

*Required action:* Add phase-m-acting-as-host.test.ts:156-163 to pinnedTestsToUpdate with the same widen-to-2200 remedy and comment; correct the note on 143-154 to 'expected to pass unmodified (match ends ~1357/1500)'. Alternatively shrink the gate below ~250 inserted chars, but the sketch as written cannot satisfy the current window.

**[NIT]** The unit-test sketch says jest.mock('../../db') citing the pattern in __tests__/services/session.service.test.ts (line 7) — correct at that depth, but the new test is specified one level deeper at __tests__/services/roles/sec1-effective-role-hardening.test.ts, where the db module is three levels up ('../../../db'; compare t1-5-effective-role.test.ts:21 which uses '../../..' from the same directory). A literal copy fails with 'Cannot find module ../../db'.

*Required action:* Change the sketch to jest.mock('../../../db') for the roles/ test directory.

---

## SEC-2 — handleHostRemoveFromRoom: replace director-only in-memory gate with verifyHost (acting-host parity with every other room control)

**Priority:** P1
**Depends on:** SEC-1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/host-actions.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/sec2-remove-from-room-acting-host.test.ts (new)`

### Problem

Audit medium (verified): handleHostRemoveFromRoom (host-actions.ts:1416-1434) is the ONLY host socket handler in the file gating on `activeSession.hostUserId !== userId` (director-only, read from the in-memory activeSessions map) instead of `verifyHost`. All 19 sibling handlers — including the equivalent room controls handleHostMoveToRoom (1663), handleHostMuteParticipant (1199), handleHostCreateBreakout (2716) — accept the full acting-host set (director, formal co-hosts, super_admin, pod admin) via verifyHost -> canActAsHost. Result: a co-host can move people INTO rooms and mute them but cannot pull someone OUT of a broken room; during a 30-50-person event the director becomes the single point of intervention.

### Design

Consistent rule: remove-from-room uses the same authorization chokepoint as every other room control — `verifyHost(socket, sessionId)` (host-actions.ts:191-215), which delegates to canActAsHost/getEffectiveRole. With SEC-1 shipped, that resolver is hardened, so this widening cannot be reached via poisoned acting_as_host rows.

Exact change in handleHostRemoveFromRoom, inside the existing withSessionGuard wrapper: keep `const userId = getUserIdFromSocket(socket); if (!userId) return;` (line 1422-1423) and the `activeSessions.get` SESSION_NOT_FOUND check (1425-1429 — still wanted: the handler only makes sense on a live session; note the AUTH decision no longer depends on in-memory state, only this liveness check does). DELETE the block at 1431-1434 (`if (activeSession.hostUserId !== userId) { socket.emit('error', { code: 'NOT_HOST', ... }); return; }`) and REPLACE with `if (!await verifyHost(socket, data.sessionId)) return;`. verifyHost emits its own FORBIDDEN error frame; the NOT_HOST code is retired — verified unreferenced in client/src (no handler keys on it) and in tests (only a prose comment in phase-o-authoritative-mute-state.test.ts:8).

Do NOT add refuseIfAdminTarget here: parity target is handleHostMoveToRoom/handleHostMuteParticipant which do not call it (it protects kick/cohost-management, not room placement). Everything downstream (terminal-status heuristic, demoteParticipantFromMatch trio logic, canonical clears, emitRatingWindowOnce, endRoomEarlyForSurvivors, dashboard emit) is untouched.

### Code sketch

````
export async function handleHostRemoveFromRoom(io, socket, data): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) { socket.emit('error', { code: 'SESSION_NOT_FOUND', ... }); return; }

    // SEC-2 (13 Jun audit) — acting-host parity: same gate as move-to-room,
    // mute, create-breakout. Was: director-only via in-memory hostUserId,
    // the lone outlier among the host handlers.
    if (!await verifyHost(socket, data.sessionId)) return;

    try { /* ...rest of handler unchanged... */ }
  });
}
````

### Tests to add

- NEW server/src/__tests__/services/orchestration/sec2-remove-from-room-acting-host.test.ts (source-pin style, matching the file's sliceFn convention): (1) the handleHostRemoveFromRoom slice contains /await verifyHost\(socket,\s*data\.sessionId\)/ and the verifyHost call index is LESS THAN the demoteParticipantFromMatch call index; (2) the slice does NOT match /activeSession\.hostUserId\s*!==\s*userId/ and does NOT match /['"]NOT_HOST['"]/ (pin the removal so the director-only gate can't creep back); (3) the SESSION_NOT_FOUND liveness check is retained.
- Re-run (no changes expected, they pin deeper parts of the same function): phase3-trio-leave-keeps-active.test.ts, canonical-location-room-end.test.ts:183, dashboard-refresh-on-transition.test.ts:96, tier1-a3-timeout-guards.test.ts:29-42, ws2-room-ends-below-two.test.ts:75-82, phase8-host-action-receipts.test.ts, dr-arch-april-18-bugs.test.ts:247.
- Headed Playwright prod smoke: three throwaway users — director, co-host (formally assigned via the existing cohost flow), two participants matched into a breakout. From the CO-HOST browser, trigger host:remove_from_room for one room occupant. Assert outcomes: pulled user lands in the main room (canonical location via the lobby UI) AND receives the rating form (rating window visible with earlyLeave reason); for a trio, the remaining two stay in-room. Negative case: a PLAIN PARTICIPANT socket emitting host:remove_from_room receives the FORBIDDEN error frame and the room is unaffected.

### Acceptance criteria

- A formal co-host (and super_admin / pod admin) can remove a participant from a breakout room; the removed participant transitions to rating then main room exactly as when the director does it.
- A plain participant emitting host:remove_from_room gets the FORBIDDEN error frame and no state change (no match row mutation, no canonical-location change).
- verifyHost is the single authorization path for this handler; source pin enforces absence of the in-memory director-only comparison.
- Full server suite green; the seven pre-existing handleHostRemoveFromRoom pin files pass unmodified.

### Pinned tests to update

- None — grep confirms no test pins the NOT_HOST code or the `activeSession.hostUserId !== userId` comparison in this handler. The seven existing pin files listed in tests[] target later sections of the function and must stay green unmodified.

### Risks

Behavior widening, not narrowing — the new accepters are exactly the set every sibling room control already trusts. SEC-1 must ship first so the acting_as_host escalation hole is closed before remove-from-room joins the verifyHost surface (otherwise a poisoned row would gain one more capability in the gap). verifyHost adds 2-4 DB queries per invocation vs the old in-memory check — negligible (host action, human-rate). The retired NOT_HOST error code: confirmed no client or test references; co-hosts previously hitting it saw a generic error toast, nothing keyed on the code.

### Deploy notes

Server-only, no migration, no env, no client ordering. Ship AFTER SEC-1 (soft dependency: closes the escalation hole before widening this gate). Standard one-fix deploy + headed smoke.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** 'All 19 sibling handlers' is off by one: grep shows 18 `await verifyHost(socket, ...)` call sites in host-actions.ts. The substance of the claim (handleHostRemoveFromRoom is the lone director-only outlier among the host handlers) is verified correct.

*Required action:* Say '18 sibling verifyHost call sites' or 'every other host handler' to avoid the implementer hunting for a 19th.

---

## SEC-3 — handleHostReassign: host-not-matchable guard checks the full getAllHostIds set, and partner selection skips hosts

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/host-actions.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/sec3-reassign-host-set-guard.test.ts (new)`

### Problem

Audit minor (verified): handleHostReassign's Phase-R1 belt-and-braces guard (host-actions.ts:1106-1117) only refuses when targetId or the auto-picked partner equals `activeSession.hostUserId` — the director. A co-host or super_admin (all in the host set everywhere else: matching exclusion, eligible counts, mute-all) can still be reassigned INTO a match by a buggy/malicious host client, either as the explicit target or by being picked up from the isolatedParticipants scan. The repo already has the canonical host-set source — getAllHostIds(sessionId, hostUserId) at host-actions.ts:166-187 (director + session_cohosts + super_admin participants), used for exactly this purpose at lines 397, 504, 1349 and matching-flow.ts:333/849/1549.

### Design

Fold the guard into the getAllHostIds-based check, and make partner selection host-aware so a host sitting in the isolated list is SKIPPED (letting a legitimate reassign proceed) rather than aborting the whole action.

Exact change inside handleHostReassign (after verifyHost at 1073 and the ROUND_ACTIVE check, in the block currently at 1102-1117):
1. Resolve the host set once, before partner selection: `const allHostIds = new Set(await getAllHostIds(data.sessionId, activeSession.hostUserId));` (direct call — same file; mirror the .catch fallback used at matching-flow.ts:1549 if desired, falling back to a set containing only the director so the guard never throws the action into the generic REASSIGN_FAILED path).
2. Refuse the explicit target early: `if (allHostIds.has(targetId)) { socket.emit('error', { code: 'HOST_NOT_MATCHABLE', message: 'Hosts and co-hosts cannot be reassigned into a match' }); return; }` — keep the existing error code (no client/test pins on it; only a prose mention in disconnect-rejoin.test.ts:102) and keep the logger.error line, extending its fields with the host-set size for forensics.
3. Replace the partner pick `isolatedParticipants.find(id => id !== targetId)` (line 1104) with `isolatedParticipants.find(id => id !== targetId && !allHostIds.has(id))` — a host in the isolated list no longer blocks or contaminates the pairing; if no non-host partner remains, the existing NO_PARTNER branch fires.
4. Delete the old two-sided `=== activeSession.hostUserId` comparison block (1110-1117) — it is subsumed.

Contract: after this change it is impossible for a reassign INSERT to contain any member of getAllHostIds, matching the invariant the matcher itself enforces (matching.service.ts excludeUserIds path). The rest of the handler (LiveKit room create, match INSERT with ordered participant ids, setRoomAssignment, match:reassigned emits, entity fanout) is untouched.

### Code sketch

````
    // SEC-3 (13 Jun audit) — Phase R1 widened: NO member of the host set
    // (director + cohosts + super_admins — getAllHostIds, the same source
    // the matcher excludes) may land in a reassign INSERT.
    const allHostIds = new Set(
      await getAllHostIds(data.sessionId, activeSession.hostUserId)
        .catch(() => [activeSession.hostUserId]),
    );
    const targetId = data.participantId;
    if (allHostIds.has(targetId)) {
      logger.error({ sessionId: data.sessionId, targetId, hostSetSize: allHostIds.size },
        'SEC-3 — refused reassign that would place an acting host in a match');
      socket.emit('error', { code: 'HOST_NOT_MATCHABLE',
        message: 'Hosts and co-hosts cannot be reassigned into a match' });
      return;
    }
    const partner = isolatedParticipants.find(id => id !== targetId && !allHostIds.has(id));
    if (partner) { /* ...unchanged INSERT/emit path... */ } else { /* NO_PARTNER unchanged */ }
````

### Tests to add

- NEW server/src/__tests__/services/orchestration/sec3-reassign-host-set-guard.test.ts (source-pin style): slice handleHostReassign and assert (1) /getAllHostIds\(\s*data\.sessionId\s*,\s*activeSession\.hostUserId/ appears and its index is LESS THAN the `isolatedParticipants.find` index (host set resolved before partner pick — same ordering discipline super-admin-host-policy.test.ts:60-64 pins for the dashboard); (2) the partner find matches /id\s*!==\s*targetId\s*&&\s*!allHostIds\.has\(id\)/; (3) the guard matches /allHostIds\.has\(targetId\)/ followed within 400 chars by /HOST_NOT_MATCHABLE/; (4) the function no longer matches /===\s*activeSession\.hostUserId/ (old director-only comparison removed) while the matches INSERT block is still present.
- Headed Playwright prod smoke (combined with a round-lifecycle smoke since the precondition is a no_show/reassigned match): director + co-host + 3 participants; force a no-show (one participant never joins their room) so isolatedParticipants is non-empty; (a) director attempts reassign with the CO-HOST as participantId -> HOST_NOT_MATCHABLE error frame, no matches row created (assert via dashboard room list unchanged); (b) director reassigns a real isolated participant while the co-host is also idle in the main room -> pairing succeeds with the OTHER participant (co-host skipped), both reassigned users land in the new room.

### Acceptance criteria

- A reassign targeting any member of getAllHostIds (director, formal co-host, super_admin participant) is refused with HOST_NOT_MATCHABLE and writes no matches row.
- A reassign whose isolated-partner scan contains a host id skips that id and pairs with the next eligible participant (or returns NO_PARTNER) instead of refusing or pairing the host.
- No reassign-created matches row can ever contain a host-set member (assertable in integration by inspecting the INSERT arguments / DB).
- Full server suite green; new source pins pass.

### Pinned tests to update

- None — HOST_NOT_MATCHABLE and the Phase R1 block are not pinned anywhere (grep: only a prose comment in disconnect-rejoin.test.ts:102). super-admin-host-policy.test.ts pins getAllHostIds' internals, which are not modified here.

### Risks

Minimal: adds two read queries (cohosts + super_admin participants) per reassign — a rare, human-initiated action. The .catch fallback degrades to the old director-only behavior rather than failing the action if the host-set lookup errors (fail-open on availability, fail-closed on the director — consistent with matching-flow.ts:1549's pattern). Behavior change is strictly a wider refusal set plus smarter partner skipping; no client change (HOST_NOT_MATCHABLE already handled as a generic error toast).

### Deploy notes

Server-only, no migration, no env, no ordering constraint with client. Independent of SEC-1/SEC-2 (uses the existing getAllHostIds; no acting_as_host semantics involved). Ship last per priority.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** The spec twice claims HOST_NOT_MATCHABLE has 'a prose mention in disconnect-rejoin.test.ts:102' — repo-wide grep finds the literal only at host-actions.ts:1115; disconnect-rejoin.test.ts:101-105 references Phase R1 in prose but never the error code. The load-bearing conclusion (zero pins, code can be kept/renamed freely) still holds.

*Required action:* Drop or correct the disconnect-rejoin.test.ts:102 citation so an implementer doing the verification grep doesn't stall on a phantom reference.

## Reviewer-verified facts (safe to rely on)

- SEC-1 symbol reality: POST /:id/host/acting-as-host handler is at server/src/routes/host.ts:185-220 with the director check at 199-205 and setActingAsHost at 206, exactly as the spec describes; UserRole (line 14) and ForbiddenError (line 13) are already imported, so the code sketch compiles as-is.
- SEC-1 resolver reality: effective-role.service.ts matches all cited anchors — actingOverride/isDirector reads end at line 104, `if (isDirector)` at 105, opt-out return at 110-116, opt-in floor `if (actingOverride === true) return 'cohost'` at 196; the proposed insertion point exists and the phase-m getEffectiveRole regex pins (70-107) still pass after insertion (the 'cohost' pin is satisfied by line 196 within its 600-char window, the 'participant' pin by lines 110-115).
- UserRole enum (shared/src/types/user.ts:3-11) defines SUPER_ADMIN='super_admin' and ADMIN='admin', so the migration's u.role NOT IN ('admin','super_admin') predicate and the TS comparisons are value-correct.
- Migration reality: server/src/db/migrations max prefix is 067 (068 free); the runner (server/src/db/migrate.ts:31-57) sorts lexically, tracks by filename (the existing duplicate 060 pair confirms duplicates are tolerated), wraps each file in its own BEGIN/COMMIT (so 'no inner BEGIN/COMMIT' is correct guidance), and runs on boot via index.ts:359.
- verifyHost is at host-actions.ts:191-215 and emits the FORBIDDEN error frame (line 210); getAllHostIds at 166-187; its call sites at host-actions.ts:397/504/1349 and matching-flow.ts:333/849/1549 (with the .catch fallback at 1549) all verified — note matching-flow.ts lives at server/src/services/orchestration/handlers/matching-flow.ts.
- SEC-2 target verified: handleHostRemoveFromRoom (host-actions.ts:1416-1434) is the lone director-only gate (`activeSession.hostUserId !== userId` + NOT_HOST at 1431-1434); NOT_HOST has zero client/src references and only a prose comment at phase-o-authoritative-mute-state.test.ts:8; all seven listed pin files exist at the cited lines and none pin the gate text being removed, so SEC-2's 'None' pinnedTestsToUpdate claim is correct.
- SEC-3 target verified: handleHostReassign has verifyHost at 1073, partner find at 1104, and the Phase R1 director-only guard at 1110-1117; HOST_NOT_MATCHABLE appears nowhere except host-actions.ts:1115 (no test or client pins), and super-admin-host-policy.test.ts pins only getAllHostIds internals/repairFutureRounds/dashboard ordering, none of which SEC-3 touches.
- Test-infra claims verified: supertest resolves from root node_modules; livekit-webhook.test.ts uses the require.resolve('supertest') guard (line 48); session.service.test.ts uses jest.mock('../../db') (line 7); the s16 pre-cohost gate and REST cohost-management gate exist at routes/sessions.ts:628-629 via canActAsHost; host-actions.ts:~2368 (setHostVisibility) also gates via canActAsHost; socket role comes from JWT at index.ts:127; req.user.role from JWT at middleware/auth.ts:84-89.
- Library reality: no new library APIs are relied on (plain express middleware, zod, pg UPDATE, jest source pins, existing socket.io auth middleware); none of the orchestrator's flagged APIs (livekit-client adaptiveStream, express-rate-limit keyGenerator, pg advisory locks) are actually used by this spec, and the migration runner uses a plain per-file transaction, no advisory lock.
- Lock/race review: no new locks are introduced; SEC-2's verifyHost-inside-withSessionGuard pattern already exists at host-actions.ts:1071-1073 (handleHostReassign), so no new nesting order is created; the Render deploy-overlap race the spec names is real and genuinely covered by layer (B).
- Pinned-test sweep: t1-5-effective-role.test.ts, phase-i-narrow-admin-host.test.ts, and phase-l-control-center-role-consistency.test.ts are all source pins scoped to the Layer 1-Layer 2 slice or to hasRoleAtLeast forms, so the SEC-1(B) insertion (which mentions UserRole.ADMIN before Layer 1) does not trip them; phase-r-s-toasts-and-host-demote.test.ts windows anchor on the acting-as-host-for literal, which sits after the insertion point and is unaffected.

