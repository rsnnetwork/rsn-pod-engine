# SDD 03 — C3 snapshot storm + rate limiter + fanout consolidation (M10) + recap burst

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

All six designs were verified against the actual code on branch june9-punchlist @ 3cf1187 (read-only repo at C:/Users/ARFA TECH/Desktop/RSN-dev); every audit-cited line was re-checked and the audit's C3 claims held with two corrections folded into the designs: (1) the REST /state payload carries serverNow but NO seq today — the seq must be added server-side from the canonical doc (readCanonical(sessionId).seq, the same counter the seq-guarded socket rail uses), and the client guard must NOT share the socket rail's snapshotSeq counter wholesale (dropping a whole REST apply on a canonical-seq race would starve cohost/acting-host fields the socket snapshot never carries — hence the two-part guard: serverNow stamp for REST-vs-REST ordering, seq only for the participants-list cross-rail regression). (2) express-rate-limit installed is 7.5.1: keyGenerator and function-form limit exist, but the ipKeyGenerator helper does NOT (v8-only) — the IP fallback uses req.ip, which is exactly 7.5.1's default key, with trust proxy already set (index.ts:176). Auth middleware runs per-router, so the limiter key resolver verifies the JWT itself (signature-verified, never decode-only, or attackers mint unlimited buckets); this avoids restructuring 15 routers. /api/webhooks signature auth confirmed (livekit-server-sdk WebhookReceiver on raw body). Key load numbers re-derived from code: one /state build = fetchSockets + 4-6 queries + (pre-fix) buildHostParticipantsView; one resync mint = 3 queries (session.service.ts:736-767); the join path runs 2 extra queries (count + entity-fanout SELECT) per join. Recommended ship order: TRF-1 (server seq half, then client) -> TRF-2 -> TRF-3 -> TRF-4 -> TRF-5 -> TRF-6, one deploy each with headed prod smokes between (per-bug ship process). TRF-3 and TRF-1 touch the same builder file — land sequentially to avoid merge noise. TRF-6 touches handleResync, which the M2 fix (another cluster: 'left' must not be terminal in resync) also edits — coordinate merge order; TRF-6 deliberately does not move the eviction gate. Out-of-scope-but-adjacent: host-actions.ts roster:changed sites and fanout.ts emitPermissionsUpdated are source-pinned and intentionally untouched; socket-event rate limiting (audit medium) and the M1 join-serialization cliff belong to other clusters. The full local test suite must run before every push (standing rule) — several pins here are source-text pins that break on innocent-looking reformatting (notably the s26 'Ship C belt' 1500-char slice and the tier1-a6 `app.use('/api', apiLimiter)` literal).

---

## TRF-1 — Coalesce + jitter the client roster:changed -> GET /state refetch; stamp-guard applyFullState against stale REST responses

**Priority:** P0

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/hooks/useSessionSocket.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/stores/sessionStore.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/session/session-state-snapshot.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/session/session-state-snapshot.test.ts`

### Problem

useSessionSocket.ts:262-264 refetches GET /sessions/:id/state on EVERY roster:changed broadcast with no debounce. The server emits roster:changed per join (participant-flow.ts:714), per kick/cohost change (host-actions.ts:1036,2086,2168; sessions.ts:691; fanout.ts:294). At 50 participants a 50-join arrival window = 2,500 snapshot builds (~6-12k DB queries) against the pool (audit C3). Additionally applyFullState (sessionStore.ts:619) has no ordering guard: two in-flight /state responses can apply out of order and regress visible state right after reconnect (the socket state:snapshot rail IS seq-guarded via applyStateSnapshot at sessionStore.ts:608-614; the REST rail is not). Verified: the REST payload (SessionStateSnapshot) today carries serverNow but NO seq.

### Design

CLIENT COALESCER (useSessionSocket.ts). Replace the body of the roster:changed handler (lines 262-264) with a call to a new scheduler defined inside the same useEffect (next to the existing fetchSessionStateSnapshot const at ~line 1142; the handler closure resolves it at call time exactly like the current code does). Contract: (a) leading edge — if no roster-triggered fetch started within the last ROSTER_FETCH_WINDOW_MS (3000ms), schedule a fetch at random(0..300)ms (small jitter de-synchronizes the N clients that all received the same broadcast); (b) trailing edge — otherwise schedule ONE fetch at (window remaining)+random(0..1000)ms; further roster:changed events while a timer is pending coalesce into it (no reset — throttle-with-guaranteed-trailing, so continuous churn still fetches every ~3-4s and never starves); (c) one in-flight fetch max — if the timer fires while a fetch is in flight, set a pending flag; when the in-flight fetch settles (finally), re-schedule. Convergence guarantee (Bug 21, pinned): every roster:changed either starts a timer, lands during a pending timer, or sets the pending flag — in all three cases a /state fetch STARTS strictly after the last roster:changed arrival, so every client refetches after the LAST change. Clear the timer in the effect cleanup (alongside clearTimeout(initialSnapshotTimer)). Do NOT route permissions:updated (line 340-345) through the coalescer — it is per-user, rare, and its pin (phase4 test :144-148) expects an immediate fetch. SERVER SEQ (session-state-snapshot.service.ts): add field `seq: number | null` to the SessionStateSnapshot interface. In buildSessionStateSnapshot, FIRST thing after the session row loads, read `const canonical = await readCanonical(sessionId).catch(() => null)` (import readCanonical from '../orchestration/state/canonical-state' — same seq source the seq-guarded socket rail uses in state-snapshot.ts baseFromDoc) and compose `seq: canonical?.seq ?? null` into the return. Reading seq BEFORE the other reads makes the stamp conservative (never newer than the data). Backward compatible — pure additive field; the two socket call sites in participant-flow.ts (join unicast :744, scheduleParticipantListBroadcast :215) whitelist fields and are unaffected. CLIENT GUARD (sessionStore.ts applyFullState, line 619): two guards, minimal blast radius, do NOT touch snapshotSeq (the socket rail's counter) — (1) REST-vs-REST ordering: new store field `fullStateStamp: number` (default 0; add to reset() at :698). At the top of applyFullState: `const stamp = snapshot.serverNow ? Date.parse(snapshot.serverNow) : null; if (stamp !== null && stamp < s.fullStateStamp) return {};` and include `fullStateStamp: stamp ?? s.fullStateStamp` in the returned patch. Strictly-older dropped; equal allowed (idempotent re-apply). (2) REST-vs-socket participants regression: if `typeof (snapshot as any).seq === 'number' && (snapshot as any).seq < s.snapshotSeq`, OMIT the `participants` key from the returned patch (the socket rail applied a newer list); all other fields (cohosts, actingAsHostOverrides, hccParticipants, timer, etc.) still apply because the socket snapshot does not carry them. Edge cases: serverNow absent (older server during rolling deploy) -> stamp null -> apply unguarded (current behavior); SNAPSHOT_EMIT_ENABLED off -> snapshotSeq stays -1 -> guard (2) never fires; seq null (canonical doc absent for scheduled/completed sessions) -> guard (2) skipped.

### Code sketch

````
// useSessionSocket.ts — inside the useEffect, near the top:
const ROSTER_FETCH_WINDOW_MS = 3000;
let rosterTimer: ReturnType<typeof setTimeout> | null = null;
let rosterFetchInFlight = false;
let rosterPending = false;
let lastRosterFetchAt = 0;
const runRosterFetch = () => {
  if (rosterFetchInFlight) { rosterPending = true; return; }
  rosterFetchInFlight = true;
  lastRosterFetchAt = Date.now();
  fetchSessionStateSnapshot()
    .catch(() => { /* best-effort */ })
    .finally(() => {
      rosterFetchInFlight = false;
      if (rosterPending) { rosterPending = false; scheduleRosterFetch(); }
    });
};
const scheduleRosterFetch = () => {
  if (rosterTimer) return; // coalesce into the pending timer
  const elapsed = Date.now() - lastRosterFetchAt;
  const delay = elapsed >= ROSTER_FETCH_WINDOW_MS
    ? Math.random() * 300                                  // leading edge + de-sync jitter
    : (ROSTER_FETCH_WINDOW_MS - elapsed) + Math.random() * 1000; // trailing + jitter
  rosterTimer = setTimeout(() => { rosterTimer = null; runRosterFetch(); }, delay);
};
// handler (keeps the phase4 pin: 'socket.on(\'roster:changed\'' + fetchSessionStateSnapshot appears later in file):
socket.on('roster:changed', () => { scheduleRosterFetch(); });
// cleanup: if (rosterTimer) clearTimeout(rosterTimer);

// sessionStore.ts applyFullState:
applyFullState: (snapshot) => set((s) => {
  const stamp = snapshot.serverNow ? Date.parse(snapshot.serverNow) : null;
  if (stamp !== null && stamp < s.fullStateStamp) return {}; // stale REST response
  const restSeq = (snapshot as any).seq;
  const participantsPatch = (typeof restSeq === 'number' && restSeq < s.snapshotSeq)
    ? {} // socket rail applied a newer roster — don't regress it
    : { participants: snapshot.connectedParticipants.map(p => ({ userId: p.userId, displayName: p.displayName })) };
  return { ...participantsPatch, fullStateStamp: stamp ?? s.fullStateStamp, /* ...existing fields unchanged... */ };
}),

// session-state-snapshot.service.ts:
import { readCanonical } from '../orchestration/state/canonical-state';
// after `if (!session) return null;`:
const canonical = await readCanonical(sessionId).catch(() => null);
// in the composed return: seq: canonical?.seq ?? null,
````

### Tests to add

- Extend server/src/__tests__/services/session/session-state-snapshot.test.ts: buildSessionStateSnapshot returns seq from the canonical doc when present, and seq:null when readCanonical returns null (mock the canonical-state module the same way neighbouring tests mock activeSessions).
- New source-pin test server/src/__tests__/services/trf1-roster-fetch-coalesce.test.ts (repo convention: fs.readFileSync client source): (a) useSessionSocket.ts roster:changed handler calls the scheduler not fetchSessionStateSnapshot directly; (b) ROSTER_FETCH_WINDOW_MS = 3000 exists; (c) one-in-flight guard (rosterFetchInFlight) present; (d) sessionStore.ts applyFullState contains the fullStateStamp early-return and the restSeq < s.snapshotSeq participants guard; (e) snapshot service contains `seq: canonical?.seq ?? null`.
- Headed Playwright prod smoke: open 3 authenticated contexts on a live test event, then join 8 throwaway users within ~10s. Intercept network in the 3 established contexts: assert each performs at most ceil(burstSeconds/3)+2 GET /state calls during the burst, at least one GET /state STARTS after the last join completes, and all 3 contexts converge to the same participant count text (outcome assert, not visibility). Also refresh one context mid-burst and assert its final rendered roster equals the others (no stale-response regression).

### Acceptance criteria

- With N clients connected, a burst of K roster mutations within 3s produces at most 2 /state fetches per client (leading + trailing), each client's last fetch starting after the final mutation.
- Two overlapping /state responses can never apply out of order: the store's fullStateStamp is monotonic non-decreasing and a strictly-older serverNow response is a no-op.
- A REST /state response whose seq is lower than the applied socket snapshotSeq never overwrites the participants list.
- Full server test suite green, including phase-may19-realtime-migration-phase4.test.ts roster:changed pin (lines 134-138) unchanged.

### Pinned tests to update

- server/src/__tests__/services/phase-may19-realtime-migration-phase4.test.ts:134-138 — no change required, but verify it stays green (it pins socket.on('roster:changed') existing and fetchSessionStateSnapshot appearing later in the file).

### Risks

The phase4 pin asserts fetchSessionStateSnapshot appears in the file AFTER the index of socket.on('roster:changed') — the function definition at ~line 1142 satisfies it; do not move that definition above line 262. serverNow stamps from two overlapping Render instances during a deploy could theoretically skew by NTP-millis; the guard only drops strictly-older stamps and the 30s periodic resync self-heals, so worst case is one skipped apply. Coalescing delays roster convergence by up to ~4s; the debounced server session:state (300ms) still delivers participant lists fast, so visible lag is limited to cohost/acting-host derived state.

### Deploy notes

No migration, no env var. Ship server first (additive seq field), then client — old clients ignore seq; new clients tolerate missing seq/serverNow from an old server. Two deploys or same-day pair; no ordering hazard beyond server-first.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** Internal contradiction on scheduler placement: the design text says to define the scheduler 'next to the existing fetchSessionStateSnapshot const at ~line 1142', while the codeSketch header says 'inside the useEffect, near the top'. Both work at runtime (closure resolution), and the phase4 pins survive either way (the :344 permissions handler reference satisfies the after-index check even if the const moves), but a literal implementer is left guessing. Also, the new-test instruction says to mock canonical-state 'the same way neighbouring tests mock activeSessions' — session-state-snapshot.test.ts does NOT mock activeSessions, it imports the real Map and clears it (test line 25/58); canonical-state must be jest.mock'd, which is a different pattern.

*Required action:* Pick one placement (near the top is cleaner — the timer only fires after the effect body completes, so the late const is safe) and state it once; reword the test note to 'jest.mock ../orchestration/state/canonical-state (the db/session.service mocks in this file are the pattern to copy), since the file uses the real activeSessions Map'.

---

## TRF-2 — Key the /api rate limiter by authenticated userId (IP fallback for unauthenticated), mount /api/webhooks before the limiter, raise per-user budget

**Priority:** P0

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/middleware/rateLimit.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/index.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/config/index.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/render.yaml`

### Problem

index.ts:189 mounts apiLimiter on ALL of /api with windowMs=60s, max=100 (render.yaml:62-65), keyed by the default req.ip. 10+ attendees behind one venue NAT share one 100/min bucket: GET /state, POST /token (the only token rail), the 10s pre-lobby poll (Lobby.tsx:1440-1495: /state + possibly /token every 10s per user) and the recap burst (~10-13 calls/user in the final minute) collectively 429 — 'Joining room…' forever and 'Could not load your recap'. Worse, /api/webhooks is mounted at index.ts:337 AFTER the limiter, so LiveKit's signed webhooks (verified: webhooks.ts:30-33 uses livekit-server-sdk WebhookReceiver.receive on the raw body + Authorization signature) are shed exactly during round transitions when few LiveKit Cloud IPs emit 100+ events/min.

### Design

MIDDLEWARE ORDER: authenticate runs per-router (routes/sessions.ts etc.), so req.user is undefined when apiLimiter runs. Do NOT restructure all routers; instead add a tiny identity resolver that runs before the limiter and verifies the JWT itself. In middleware/rateLimit.ts export `resolveRateLimitIdentity(req,_res,next)`: if Authorization starts with 'Bearer ', `jwt.verify(token, config.jwtSecret)` (MUST verify the signature — an unverified decode would let an attacker mint unlimited fresh buckets or exhaust a victim's bucket) and set `(req as any).rateLimitUserId = payload.sub`; any verify error -> leave unset (IP bucket). HS256 verify is microseconds and authenticate re-verifies later — acceptable double cost, consistent with the existing isUserActive shared-cache pattern in middleware/auth.ts. LIMITER (express-rate-limit 7.5.1 — verified installed; keyGenerator: (req,res)=>string IS supported; `limit` accepts a function; the ipKeyGenerator helper does NOT exist in 7.5.1, only in v8 — do not reference it; the IP fallback `req.ip` matches 7.5.1's default keyGenerator behavior exactly, and trust proxy is already set at index.ts:176): modify the existing apiLimiter in place (keep the export name, keep `store: buildStore('api')` and the existing 429 handler body — both are pinned by tier1-a7): `keyGenerator: (req) => (req as any).rateLimitUserId ? `u:${(req as any).rateLimitUserId}` : `ip:${req.ip}`` and `limit: (req) => (req as any).rateLimitUserId ? config.rateLimitUserMaxRequests : config.rateLimitMaxRequests`. Add `rateLimitUserMaxRequests: parseInt(process.env.RATE_LIMIT_USER_MAX_REQUESTS || '300', 10)` to config/index.ts next to line 57. LIMITS RATIONALE (per-user, 60s window): worst legitimate minute measured from code — join storm: register(1)+initial /state(1)+roster-coalesced /state(<=20 with TRF-1, <=50 without)+/token retries(<=3)+session GET(2); pre-lobby poll: 6x(/state+/token)=12; round transition: /token+/state+ratings(<=6); recap burst: session(2)+people-met(2)+stats(1)+unrated(1)+cohosts/check(1)+feedback(1)~10-13. Peak ~60-70/min even WITHOUT TRF-1 shipped -> 300/min gives >4x headroom while still catching runaway loops. IP bucket keeps 100/min (RATE_LIMIT_MAX_REQUESTS unchanged) and now only covers unauthenticated traffic (magic-link landing, admin email-action tokens, invite accept) — all far below 100/min; authLimiter/inviteLimiter unchanged. INDEX.TS CHANGES: (1) move the line `app.use('/api/webhooks', webhooksRouter);` (currently :337) up to just before the limiter mount (~:183-189), with its existing comment — Express matches in mount order, so POST /api/webhooks/livekit short-circuits before the limiter; unmatched /api/webhooks/* paths fall through to the limiter+404 as today. The raw-body note in webhooks.ts:9-11 confirms position relative to express.json() is irrelevant. (2) Mount the resolver as its OWN line directly above the limiter: `app.use('/api', resolveRateLimitIdentity);` then the EXISTING line `app.use('/api', apiLimiter);` — keeping the exact pinned text `app.use('/api', apiLimiter)` (tier1-a6 pin, see below). RENDER.YAML: add `- key: RATE_LIMIT_USER_MAX_REQUESTS\n  value: "300"` beside the existing rate-limit keys (:62-65). Single-instance in-memory store: per-user counters bounded by active users; during Render's zero-downtime overlap each instance counts separately (transiently more permissive — fail-open direction, fine).

### Code sketch

````
// middleware/rateLimit.ts
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

export function resolveRateLimitIdentity(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), config.jwtSecret) as { sub?: string };
      if (payload?.sub) (req as any).rateLimitUserId = payload.sub;
    } catch { /* invalid/expired token -> IP bucket */ }
  }
  next();
}

export const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: (req) => (req as any).rateLimitUserId ? config.rateLimitUserMaxRequests : config.rateLimitMaxRequests,
  keyGenerator: (req) => (req as any).rateLimitUserId ? `u:${(req as any).rateLimitUserId}` : `ip:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('api'),            // pinned — keep
  handler: (_req, res) => { /* existing RATE_LIMIT_EXCEEDED body — keep */ },
});

// index.ts — replaces lines ~183-189 region:
// LiveKit webhooks are signature-authenticated (WebhookReceiver) and must
// never be shed by the API limiter: round transitions emit 100+ events/min
// from few LiveKit Cloud IPs. Mounted BEFORE the limiter on purpose.
app.use('/api/webhooks', webhooksRouter);
app.use('/api', resolveRateLimitIdentity);
app.use('/api', apiLimiter);
// ...and DELETE the old app.use('/api/webhooks', webhooksRouter) at :337.
````

### Tests to add

- New server/src/__tests__/middleware/rate-limit-user-key.test.ts (supertest on a minimal express app with resolveRateLimitIdentity + a rateLimit instance built with windowMs=1000, user limit 3, ip limit 2): (a) two users with valid Bearer tokens from the SAME IP each get an independent budget (4th request per user 429s, 3rd does not); (b) no/invalid Authorization falls to the IP bucket; (c) a JWT signed with the WRONG secret gets the IP bucket (signature verified, not decoded); (d) the 429 body is the existing { success:false, error:{ code:'RATE_LIMIT_EXCEEDED' } } shape.
- New source-pin test (same file or trf2-limiter-order.test.ts): read index.ts and assert indexOf("app.use('/api/webhooks'") is > -1 and LESS THAN indexOf("app.use('/api', apiLimiter)"); assert "app.use('/api', resolveRateLimitIdentity)" precedes the apiLimiter mount; read rateLimit.ts and assert keyGenerator contains rateLimitUserId and jwt.verify (not jwt.decode).
- Headed Playwright prod smoke: from ONE machine/IP, run 12 authenticated throwaway-user contexts against a live test event simultaneously polling the pre-lobby (10s converge) for 3 minutes; assert ZERO 429 responses on /state and /token across all contexts (network interception), then drive one scripted client to issue 320 rapid /state calls and assert it alone receives 429 while a second user on the same IP still gets 200s. Also assert a posted LiveKit-style webhook (or a real round transition) returns 200 during the burst.

### Acceptance criteria

- 10+ authenticated users behind one IP never see 429 under normal event traffic (join, pre-lobby poll, round transitions, recap).
- A single user exceeding 300 req/min is limited without affecting other users on the same IP.
- POST /api/webhooks/livekit is never rate-limited (200 even when the IP bucket is exhausted).
- Unauthenticated /api traffic remains limited at 100/min/IP; auth/invite limiters unchanged.
- Pinned tests tier1-a6-socket-transport.test.ts:54-57 and tier1-a7-redis-rate-limit.test.ts remain green without modification.

### Pinned tests to update

- server/src/__tests__/services/tier1-a6-socket-transport.test.ts:54-57 — keep green by preserving the exact `app.use('/api', apiLimiter)` line (no test edit needed).
- server/src/__tests__/services/tier1-a7-redis-rate-limit.test.ts — keep green by keeping `store: buildStore('api')` inside the apiLimiter options block (no test edit needed).

### Risks

tier1-a6 pin requires the literal `app.use('/api', apiLimiter)` — mount the resolver on a separate line, never inline as a second argument. jwt.verify in the hot path doubles HMAC work per request (microseconds; negligible vs the DB work per request). If RATE_LIMIT_STORE=redis is ever enabled, the per-user keys flow through RedisStore unchanged (prefix rsn:ratelimit:api:). A leaked-but-valid token still maps abuse to that user's bucket — same trust boundary as today. Behavior change: previously authenticated traffic shared the IP bucket; monitoring/alerting based on 429 rates will drop — expected.

### Deploy notes

Server-only deploy plus render.yaml env addition (RATE_LIMIT_USER_MAX_REQUESTS=300 — also set it in the Render dashboard since Blueprint autoSync is OFF per render.yaml:10-17). No migration, no client change, no ordering constraint. Safe during a live event: limiter counters reset on deploy (in-memory).

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** Two small inaccuracies: (1) the spec claims the 429 handler body is 'pinned by tier1-a7' — tier1-a7-redis-rate-limit.test.ts pins only `store: buildStore(...)` and buildStore internals plus the package.json dep; the handler body is unpinned (the preserve instruction is harmless but the justification is wrong). (2) Moving the /api/webhooks mount above the limiter (~index.ts:183) also moves it above the request-logging middleware (index.ts:192-233), so webhook requests lose x-request-id logging — the handler's own logger.info (webhooks.ts:39) partially covers this but the spec should note the observability change.

*Required action:* Correct the tier1-a7 claim and add a one-line note that webhooks skip the request logger after the move (acceptable since webhooks.ts logs received events itself).

---

## TRF-3 — Gate hccParticipants (emails + global roles) in GET /sessions/:id/state on host/cohost/acting-host/admin viewers

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/session/session-state-snapshot.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/routes/sessions.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/session/session-state-snapshot.test.ts`

### Problem

buildSessionStateSnapshot (session-state-snapshot.service.ts:420-433) unconditionally calls buildHostParticipantsView and returns hccParticipants — every attendee's email, globalRole, state, matchId — to ANY caller who passes canViewSession (routes/sessions.ts:153-175), i.e. every participant and pod member. Privacy leak (audit C3 'bonus') plus wasted work: the HCC view is built on every one of the thousands of /state calls in a join storm even though only hosts consume it.

### Design

Verified consumers of hccParticipants client-side: sessionStore.ts (field :69, applyFullState :680, reset :700) and HostControlCenter.tsx:236 (snapshotHccParticipants — drawer fallback list; the drawer itself only renders for hosts/cohosts and falls back further to the host:round_dashboard live feed). NO participant-side surface reads it -> safe to omit for non-hosts. The two socket call sites of buildSessionStateSnapshot (participant-flow.ts:744 join unicast and :215 scheduleParticipantListBroadcast) whitelist emitted fields and never forward hccParticipants, so omission also fixes their wasted buildHostParticipantsView work. SIGNATURE: extend to `buildSessionStateSnapshot(sessionId: string, io: SocketServer | null, viewer?: { userId: string; globalRole: UserRole | string })` — optional third param keeps every existing 2-arg call site and the existing unit tests compiling. LOGIC (replace lines 420-433): the builder already has session.hostUserId, cohosts (from :244-248) and actingAsHostOverrides (from :289-304) in scope before the hcc block. Compute `const viewerIsActingHost = !!viewer && (viewer.userId === session.hostUserId || cohosts.includes(viewer.userId) || actingAsHostOverrides[viewer.userId] === true || hasRoleAtLeast(viewer.globalRole as UserRole, UserRole.ADMIN));` (import hasRoleAtLeast/UserRole from '@rsn/shared' — already imported in routes/sessions.ts:17, add to the service imports). Only call buildHostParticipantsView when `activeSession && session.hostUserId && viewerIsActingHost`. EMAIL STRIP: after the call, if NOT `hasRoleAtLeast(viewer.globalRole, UserRole.ADMIN)`, map rows to `{ ...row, email: null }` — HostControlCenter.tsx:629 renders email only when truthy (`p.email && ...`), so a null email degrades gracefully for non-admin cohosts/directors. ROUTE (routes/sessions.ts:164): pass `{ userId: req.user!.userId, globalRole: req.user!.role }` as the third arg. When viewer is undefined (socket call sites, background callers) hccParticipants is always []. NOTE the role used is the JWT global role plus session-scoped host signals — matching how Phase P computes hostsRegisteredSet at :329-337; super_admin passes via hasRoleAtLeast. Keep the snapshot field present (empty array) rather than deleting the key, so applyFullState's `?? []` path is untouched.

### Code sketch

````
// session-state-snapshot.service.ts
import { UserRole, hasRoleAtLeast } from '@rsn/shared'; // extend existing import

export async function buildSessionStateSnapshot(
  sessionId: string,
  io: SocketServer | null,
  viewer?: { userId: string; globalRole: UserRole | string },
): Promise<SessionStateSnapshot | null> {
  // ... existing body unchanged through line ~419 ...
  let hccParticipants: any[] = [];
  const viewerIsAdmin = !!viewer && hasRoleAtLeast(viewer.globalRole as UserRole, UserRole.ADMIN);
  const viewerIsActingHost = !!viewer && (
    viewer.userId === session.hostUserId ||
    cohosts.includes(viewer.userId) ||
    actingAsHostOverrides[viewer.userId] === true ||
    viewerIsAdmin
  );
  if (activeSession && session.hostUserId && viewerIsActingHost) {
    try {
      const { buildHostParticipantsView } = await import('../orchestration/handlers/host-participants-view');
      hccParticipants = await buildHostParticipantsView({ sessionId, hostUserId: session.hostUserId, presenceMap: activeSession.presenceMap });
      if (!viewerIsAdmin) hccParticipants = hccParticipants.map(r => ({ ...r, email: null }));
    } catch { /* best-effort — live host:round_dashboard tick covers */ }
  }

// routes/sessions.ts:164
const snapshot = await buildSessionStateSnapshot(req.params.id, io, {
  userId: req.user!.userId,
  globalRole: req.user!.role,
});
````

### Tests to add

- Extend session-state-snapshot.test.ts (mocks for activeSessions/query already exist): (a) viewer=plain participant -> hccParticipants === [] and buildHostParticipantsView NOT called (mock the dynamic import via jest.mock of host-participants-view); (b) viewer=director -> populated with email:null; (c) viewer=cohost (row in session_cohosts mock) -> populated, email:null; (d) viewer with globalRole 'admin'/'super_admin' -> populated WITH emails; (e) viewer omitted (socket path) -> []; (f) actingAsHostOverrides[viewer]=true -> populated.
- Route-level pin: GET /state passes req.user identity as the third argument (source-pin on routes/sessions.ts: /buildSessionStateSnapshot\(req\.params\.id,\s*io,\s*\{/).
- Headed Playwright prod smoke: participant context fetches /state and asserts response JSON hccParticipants is an empty array and contains NO '@' substring anywhere outside the caller's own user object; director context asserts the HCC drawer still lists all participants (drawer row count equals participantCounts.registered+hosts) and a super_admin sees emails in the drawer while the director (non-admin global role) does not.

### Acceptance criteria

- GET /sessions/:id/state as a plain participant returns hccParticipants: [] (and no email/globalRole data of other users).
- Director and cohosts still get a populated HCC drawer on cold start (Bug 68 behavior preserved); admins/super_admins additionally see emails.
- buildHostParticipantsView no longer executes for non-host /state calls (observable: its canonical SELECT absent from query logs during a participant join storm).
- All existing tests in session-state-snapshot.test.ts pass unchanged (2-arg calls still compile and return hccParticipants:[]).

### Pinned tests to update

- server/src/__tests__/services/session/session-state-snapshot.test.ts — existing cases keep passing (optional param); ADD the viewer-gating cases listed above. No other pins reference hccParticipants (verified by grep across server/src/__tests__).

### Risks

If some host surface relied on hccParticipants while the viewer was neither director/cohost/acting-host/admin (e.g. a demoted-but-viewing user), the drawer falls back to the host:round_dashboard feed — which is already gated server-side, so no regression beyond what RBAC intends. Email strip for the non-admin director changes visible drawer content (emails disappear) — flag to Ali as an intended privacy tightening; if directors must keep emails, flip the strip condition to viewerIsActingHost-but-not-participant. Coordinate with TRF-1, which edits the same builder (compose seq + viewer changes cleanly; no logical overlap).

### Deploy notes

Server-only deploy; no migration, no env, no client change required (client already null-safe). Ship after TRF-1's server half if both are in flight to avoid merge noise in the same file; otherwise independent.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** The viewer gate grants hccParticipants WITH emails to all globalRole >= ADMIN, but the platform's converged RBAC says plain admins are ordinary participants with no host authority on others' events: getAllHostIds includes only director+cohosts+super_admins (host-actions.ts:166-188, '23 May: acting-as-host picker removed'), and verifyHost explicitly stopped auto-passing admins (host-actions.ts ~203-205, Phase I). Granting admins the full roster + emails via REST /state is still a strict improvement over today's everyone-leak, but it deviates from the 9-Jun Stefan rule (LiveSessionPage.tsx:95-101 comment) without flagging it.

*Required action:* Either align the gate with the existing policy (emails only for SUPER_ADMIN; hcc data for director/cohost/override/super_admin, matching getAllHostIds) or explicitly call out the admin grant as a deliberate widening for Ali to approve alongside the email-strip question already flagged.

---

## TRF-4 — M10 — consolidate per-join/leave fanout into one coalesced room-wide signal per change window

**Priority:** P1
**Depends on:** TRF-1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/participant-flow.ts`

### Problem

One join currently fans out FIVE ways (participant-flow.ts:699-733): participant:joined broadcast, roster:changed broadcast (-> all-N /state refetch), fanSessionRoomEntities (own SELECT of all participants + per-user entity emits, :41-53), participant:count (own getParticipantCount query, :727-728), and the debounced session:state (:733). The leave path repeats the pattern (:1186-1199). At a 50-person arrival window that is ~2,500 socket emits + 50 roster SELECTs + 50 count queries (audit M10), and every roster:changed multiplies into client REST refetches (C3).

### Design

Keep ONE coalesced room-wide signal per change window, reusing the existing scheduleParticipantListBroadcast debounce pattern (:198-228). ADD a sibling module-level coalescer `scheduleRosterFanout(io, sessionId, cause, opts?: { rosterChanged?: boolean })` with a 2s NON-RESETTING trailing window (throttle-with-guaranteed-trailing, mirroring maybeRepairFutureRounds' trailing-edge idea at :86-104): first call arms a timer; subsequent calls within the window only merge flags/cause; when it fires it (a) emits ONE `roster:changed { sessionId, cause }` IF any call in the window requested it, and (b) runs ONE fanSessionRoomEntities(io, sessionId, [E.session, E.sessionParticipants]). Trailing-edge property: the fire always happens after the last change in its window, so the Bug-21 convergence guarantee (every client refetches after the LAST change) is preserved end-to-end with TRF-1's client coalescer (total worst-case convergence ~2s server + ~4s client). timer.unref() like the existing debouncer. JOIN SITE (:699-733) becomes: (1) KEEP the `participant:joined` emit (:699-703) — cheap, no query; feeds the incremental store add in useSessionSocket.ts:185-188 and EventPlanStrip.tsx:84's refresh; (2) REPLACE the inline roster:changed emit (:714-717) with `scheduleRosterFanout(io, data.sessionId, 'participant_joined', { rosterChanged: true })`; (3) DELETE the per-join fanSessionRoomEntities call (:721-724) — covered by the coalescer; (4) DELETE getParticipantCount + the participant:count emit (:727-728) — the client handler is a no-op (useSessionSocket.ts:193) and the debounced session:state already carries participantCounts (:218); (5) KEEP scheduleParticipantListBroadcast (:733). LEAVE SITE (:1186-1199): KEEP participant:left (feeds removeParticipant + EventPlanStrip); DELETE getParticipantCount + participant:count (:1187-1188); KEEP scheduleParticipantListBroadcast; REPLACE the room-wide fanSessionRoomEntities (:1193-1196) with `scheduleRosterFanout(io, data.sessionId, 'participant_left', { rosterChanged: false })` — note leave does NOT emit roster:changed today; preserve that (rosterChanged:false) to avoid ADDING client refetch load; KEEP the targeted per-leaver emitEntities (:1197+) — it is one user, cheap, and flips their own UI. The other scheduleParticipantListBroadcast call sites (:1847, :1913, :1956 — disconnect/sweep paths) may optionally route their adjacent fanSessionRoomEntities through scheduleRosterFanout in the same way, but ONLY if they currently do room-wide entity fanout — check each before touching. OUT OF SCOPE (leave untouched): roster:changed emits in host-actions.ts:1036/2086/2168, routes/sessions.ts:691 (mutateSessionCohost — PINNED by s16-precohost-detail-page.test.ts:73), and fanout.ts:294 emitPermissionsUpdated (PINNED by phase-may19-realtime-migration-phase5.test.ts:166-167) — these are infrequent host actions, not the storm. CLIENT LISTENER INVENTORY (verified by grep client/src): participant:joined -> useSessionSocket.ts:185 (store.addParticipant + setHostInLobby), EventPlanStrip.tsx:84 (plan invalidate) — KEPT; participant:left -> useSessionSocket.ts:189, EventPlanStrip.tsx:85 — KEPT; participant:count -> useSessionSocket.ts:193 no-op ONLY — safe to stop emitting (keep the event TYPE in shared/src/types/events.ts; socket-events.test.ts:60 pins the type list, not emissions); roster:changed -> useSessionSocket.ts:262 (coalesced /state refetch), EventPlanStrip.tsx:86 (plan invalidate) — both fed by the coalesced emission ≤2s later; session:state -> useSessionSocket.ts:194 (participants/hostInLobby/counts) — unchanged cadence (300ms); entity tags -> React-Query invalidator (sessions lists, SessionDetailPage, EventPlanStrip meta) — fed once per 2s window.

### Code sketch

````
// participant-flow.ts — next to _participantBroadcastTimers (:198):
const _rosterFanoutTimers = new Map<string, NodeJS.Timeout>();
const _rosterFanoutState = new Map<string, { cause: string; rosterChanged: boolean }>();
const ROSTER_FANOUT_COALESCE_MS = 2_000;

function scheduleRosterFanout(
  io: SocketServer, sessionId: string, cause: string,
  opts: { rosterChanged?: boolean } = {},
): void {
  const prev = _rosterFanoutState.get(sessionId);
  _rosterFanoutState.set(sessionId, {
    cause,                                  // last cause wins (debug payload only)
    rosterChanged: (prev?.rosterChanged ?? false) || (opts.rosterChanged ?? false),
  });
  if (_rosterFanoutTimers.has(sessionId)) return; // non-resetting window -> guaranteed trailing fire
  const timer = setTimeout(() => {
    _rosterFanoutTimers.delete(sessionId);
    const st = _rosterFanoutState.get(sessionId);
    _rosterFanoutState.delete(sessionId);
    if (st?.rosterChanged) {
      io.to(sessionRoom(sessionId)).emit('roster:changed', { sessionId, cause: st.cause });
    }
    fanSessionRoomEntities(io, sessionId, [E.session(sessionId), E.sessionParticipants(sessionId)])
      .catch(() => {});
  }, ROSTER_FANOUT_COALESCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  _rosterFanoutTimers.set(sessionId, timer);
}

// JOIN site (was :714-733):
io.to(sessionRoom(data.sessionId)).emit('participant:joined', { userId, displayName, isHost }); // kept
scheduleRosterFanout(io, data.sessionId, 'participant_joined', { rosterChanged: true });
scheduleParticipantListBroadcast(io, data.sessionId); // kept; participant:count emit + count query DELETED

// LEAVE site (was :1186-1199):
io.to(sessionRoom(data.sessionId)).emit('participant:left', { userId, isHost }); // kept
scheduleParticipantListBroadcast(io, data.sessionId);
scheduleRosterFanout(io, data.sessionId, 'participant_left', { rosterChanged: false });
// targeted emitEntities to the leaver — kept
````

### Tests to add

- New unit test server/src/__tests__/services/orchestration/trf4-roster-fanout-coalesce.test.ts using jest fake timers + a stub io recording emits: (a) 5 scheduleRosterFanout calls within 2s -> exactly ONE roster:changed and ONE entity fanout after the window; (b) rosterChanged:false-only window emits NO roster:changed but still fans entities; (c) a call with rosterChanged:true anywhere in the window forces the emit; (d) a call at t=2.1s opens a second window (second fire) — trailing-edge convergence; (e) timers are unref'd (source pin).
- Source-pin: the join handler no longer contains `emit('participant:count'` or an inline `emit('roster:changed'` (regex on the handleSessionJoin region) and DOES contain scheduleRosterFanout; shared/src/types/events.ts still declares 'participant:count' (keeps socket-events.test.ts:60 green).
- Headed Playwright prod smoke: join 10 throwaway users within 5s on a live test event while 3 established contexts intercept socket frames; assert each established client receives <= 3 roster:changed frames and <= 10 participant:joined frames for the burst, the EventPlanStrip pair counts update within 5s of the last join, and final roster text converges on all contexts. Then have 2 users leave and assert the remaining clients' roster shrinks within 5s (debounced session:state path).

### Acceptance criteria

- A K-join burst inside 2s produces exactly one roster:changed, one entity fanout SELECT, zero participant:count queries, and one debounced session:state broadcast (plus K cheap participant:joined frames).
- Every roster mutation is still followed (<=2s) by a room-wide signal that triggers client convergence — no client can permanently miss a join/leave (Bug-21 guarantee intact through both coalescing layers).
- Host dashboard, EventPlanStrip, session lists and HCC continue to update after joins/leaves (fed via roster:changed/entities/session:state).
- phase-may19-realtime-migration-phase5.test.ts, s16-precohost-detail-page.test.ts and socket-events.test.ts pass unchanged.

### Pinned tests to update

- server/src/__tests__/services/socket-events.test.ts:60 — keep 'participant:count' in the shared TYPE list (do not remove the type when removing the emits).
- server/src/__tests__/services/phase-may19-realtime-migration-phase5.test.ts:166-167 and server/src/__tests__/routes/s16-precohost-detail-page.test.ts:73 — must stay green; they pin OTHER roster:changed sites (fanout.ts emitPermissionsUpdated, routes mutateSessionCohost) which this item must not modify.

### Risks

Coalescing delays plan-strip/list refresh by up to 2s after a join — acceptable (the 300ms session:state still updates the visible roster fast). In-memory timers are lost on deploy: at most one pending 2s window's roster:changed is dropped; the clients' 30s periodic resync and the next mutation self-heal (same exposure scheduleParticipantListBroadcast already has). Verify no test pins the join-site fanSessionRoomEntities text before deleting (grep server/src/__tests__ for fanSessionRoomEntities — none found at design time). Do NOT touch the cohost/kick roster:changed emit sites — two of them are source-pinned.

### Deploy notes

Server-only; no migration, no env. Ship AFTER TRF-1 (client coalescer) so the two layers compose and the headed smoke measures the final cadence; technically independent and safe alone. One deploy, headed smoke same day per per-bug ship process.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** Wrong function name in the test instruction: the spec's source-pin test says 'regex on the handleSessionJoin region'; the actual export is `handleJoinSession` (participant-flow.ts:430). A literal indexOf('handleSessionJoin') anchor returns -1, making the pin vacuous or failing.

*Required action:* Rename to handleJoinSession in the test description and anchor the slice on `export async function handleJoinSession`.

---

## TRF-5 — Recap burst diet — share people-met/stats between SessionComplete and RecapPage, stop terminal-session polling, no focus refetch on recap queries

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/SessionComplete.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/sessions/RecapPage.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/LiveSessionPage.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/hooks/useSessionSocket.ts`

### Problem

At event end every user produces ~10-13 API calls within a minute (audit C3/mediums): SessionComplete fetches /ratings/sessions/:id/people-met via raw axios (SessionComplete.tsx:141) and ['session',sessionId] via react-query; clicking Full Recap refetches people-met AGAIN plus /stats, /unrated, /cohosts/check (RecapPage.tsx:228-231,188-214); the global react-query default refetchOnWindowFocus:true (main.tsx:17) re-fires the session queries on tab focus; LiveSessionPage's session query keeps its 30s refetchInterval running on the recap screen (LiveSessionPage.tsx:86) and useSessionSocket's 30s periodic /state resync (useSessionSocket.ts:1167-1188) never stops in phase 'complete'. At 50 users this is a synchronized ~500-650-request burst against the same minute the rating writes land.

### Design

Pure client changes; no server cache (a people-met response is per-user, so a server-side per-session cache would not dedupe across users — the win is client-side sharing; skip the server cache as not-worth-the-blast-radius). (1) SHARED RECAP QUERIES: convert SessionComplete's fetchRecap and RecapPage's people-met/stats fetches to react-query with SHARED keys: ['people-met', sessionId] -> GET /ratings/sessions/:id/people-met, and ['session-stats', sessionId] -> GET /ratings/sessions/:id/stats (RecapPage only). Options for both: staleTime: 5*60_000, gcTime: 30*60_000, refetchOnWindowFocus: false, retry: 1. SessionComplete keeps deriving its local Stats from the people-met payload exactly as today (move the derivation into a useMemo over query.data); its Retry button calls query.refetch(). Navigating SessionComplete -> RecapPage then reuses the cached people-met (zero refetch within staleTime) — the double-fetch disappears. RecapPage's LateRatingForm onRated callback (currently refetchUnrated + fetchRecap) becomes queryClient.invalidateQueries({queryKey:['people-met',sessionId]}) + invalidate ['session-stats',sessionId] + refetchUnrated — late ratings still refresh the view. Keep RecapPage's Promise.allSettled error semantics by deriving fetchError from both queries' isError. (2) TERMINAL POLL STOPS: LiveSessionPage.tsx:86 — change refetchInterval to the v5 function form (verified: @tanstack/react-query ^5.60.0 supports `refetchInterval: (query) => number|false`): `refetchInterval: (query) => (query.state.data?.status === 'completed' || query.state.data?.status === 'cancelled') ? false : 30_000`. The host-only 8s poll (:146-150) already stops at completion — untouched. (3) useSessionSocket.ts periodic resync (:1168): first statement inside the setInterval callback: `const stNow0 = useSessionStore.getState(); if (stNow0.phase === 'complete' || stNow0.sessionStatus === 'completed') return;` — placed BEFORE fetchSessionStateSnapshot() and BEFORE the 'Ship C belt' comment block so the s26 pin slice (which starts at that comment and spans 1500 chars) is byte-identical. Do NOT touch the 15s heartbeat or the visibility listeners. (4) RecapPage's ['session',...] and ['session-cohost',...] queries get refetchOnWindowFocus: false (recap is terminal; entity-tag invalidation still works via meta). Leave the global main.tsx default alone — other pages rely on it.

### Code sketch

````
// SessionComplete.tsx — replace fetchRecap/useEffect with:
const peopleMetQuery = useQuery({
  queryKey: ['people-met', sessionId],
  queryFn: () => api.get(`/ratings/sessions/${sessionId}/people-met`).then(r => r.data.data),
  enabled: !!sessionId,
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: false,
});
const d = peopleMetQuery.data;
const stats = useMemo(() => d ? deriveStats(d) : null, [d]); // existing derivation, lifted
// loading = peopleMetQuery.isPending; fetchError = peopleMetQuery.isError; Retry -> peopleMetQuery.refetch()

// RecapPage.tsx — same ['people-met', sessionId] key (shares the cache entry), plus:
const statsQuery = useQuery({ queryKey: ['session-stats', sessionId], queryFn: () => api.get(`/ratings/sessions/${sessionId}/stats`).then(r => r.data.data), enabled: !!sessionId, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
// LateRatingForm onRated:
queryClient.invalidateQueries({ queryKey: ['people-met', sessionId] });
queryClient.invalidateQueries({ queryKey: ['session-stats', sessionId] });
refetchUnrated();

// LiveSessionPage.tsx:86
refetchInterval: (query) => {
  const st = (query.state.data as any)?.status;
  return st === 'completed' || st === 'cancelled' ? false : 30_000;
},

// useSessionSocket.ts — first lines of the periodicResyncInterval callback (BEFORE the 'Ship C belt' comment):
const stNow0 = useSessionStore.getState();
if (stNow0.phase === 'complete' || stNow0.sessionStatus === 'completed') return;
````

### Tests to add

- New source-pin test server/src/__tests__/services/trf5-recap-burst.test.ts (readClient pattern): (a) SessionComplete.tsx and RecapPage.tsx both contain queryKey: ['people-met', sessionId] and refetchOnWindowFocus: false on it and contain NO direct `api.get(`/ratings/sessions/${sessionId}/people-met`)` outside a queryFn; (b) LiveSessionPage.tsx refetchInterval is the function form gating on 'completed'; (c) useSessionSocket.ts periodic resync callback begins with the phase==='complete' guard AND the literal 'Ship C belt — sitting in the lobby without a token' comment still exists after it (protects the s26 pin).
- Headed Playwright prod smoke: run a 2-user throwaway event to completion; with network interception assert (a) per user, exactly ONE people-met request fires on the recap screen, (b) clicking Full Recap triggers ZERO additional people-met requests (cache hit) and one /stats, (c) blurring+refocusing the recap tab for 60s produces zero /state, zero /sessions/:id and zero people-met requests, (d) submitting a late rating on RecapPage refreshes the connections list (new row visible — outcome assert).

### Acceptance criteria

- End-of-event API volume per user drops to: 1x people-met + 1x stats (RecapPage only) + 1x unrated + 1x cohosts/check + the final session GET — no duplicate people-met, no post-completion /state or session polling, no focus-refetch bursts on recap surfaces.
- Recap content unchanged: same stats numbers, mutual matches, per-round grouping, late-rating flow still updates the page.
- s26-start-signal-resilience.test.ts pins (Lobby converge fn AND the 30s tokenless-lobby belt block in useSessionSocket.ts) pass byte-unchanged.
- Sessions still flip to recap within 30s on a missed socket event while ACTIVE (the interval only stops once data reports completed).

### Pinned tests to update

- server/src/__tests__/services/orchestration/s26-start-signal-resilience.test.ts — must remain green WITHOUT edits: insert the terminal guard BEFORE the 'Ship C belt' comment so the pinned 1500-char slice and the Lobby converge fn are untouched.

### Risks

The 30s periodic resync also serves as a drift safety net — gating on phase 'complete' means a client whose store wrongly entered complete would stop self-correcting; mitigated by also checking sessionStatus and by the fact that 'complete' is already a locked terminal phase client-side (kick terminality). React-query v5 function-form refetchInterval receives the query (not data) — use query.state.data, NOT the v4 (data, query) signature. Keep RecapPage's allSettled UX: show partial data if only one of people-met/stats fails.

### Deploy notes

Client-only Vercel deploy; no server change, no migration, no env. Verify the app.rsn.network bundle hash actually changed post-deploy (known Vercel dedup gotcha). Independent of all other items.

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** Missed pinned test that the prescribed refactor WILL break: server/src/__tests__/services/may23-round3-rematch-endevent-fixes.test.ts:225 pins the literal `setBonusRoundsAdded(d?.bonusRoundsAdded` in client/src/features/live/SessionComplete.tsx (currently at SessionComplete.tsx:148, inside fetchRecap). TRF-5's design replaces fetchRecap and its useState setters with a useQuery + useMemo derivation — the setter literal disappears and the full suite goes red. TRF-5's pinnedTestsToUpdate lists only s26, so an implementer discovers this only at the mandatory full-suite gate.

*Required action:* Add may23-round3-rematch-endevent-fixes.test.ts:223-229 to TRF-5's pinnedTestsToUpdate. Either keep a `const d = peopleMetQuery.data` plus the bonusRoundsAdded state fed from a useEffect that retains the `setBonusRoundsAdded(d?.bonusRoundsAdded || 0)` literal, or update the pin's regex in the same commit to match the derived form (e.g. /bonusRoundsAdded\s*=\s*d\?\.bonusRoundsAdded/). Also preserve `isBonusRound`, 'Bonus round' and 'original + ' which the same test pins.

**[IMPORTANT]** Design/test inconsistency on focus refetch: SessionComplete renders INSIDE LiveSessionPage (LiveSessionPage.tsx:497, phase==='complete'), where the shared ['session', sessionId] query (LiveSessionPage.tsx:79-89 and SessionComplete.tsx:119-124) keeps the global refetchOnWindowFocus:true default (main.tsx:17). Item (4) disables focus refetch only on RecapPage's queries. So on the post-event SessionComplete screen every tab refocus still fires GET /sessions/:id — the acceptance bullet 'no focus-refetch bursts on recap surfaces' is not met there, and the headed smoke (c) asserting 'zero /sessions/:id' fails if run on that screen rather than the standalone RecapPage route.

*Required action:* Either (a) also gate focus refetch on the session query once data.status==='completed' (refetchOnWindowFocus can be a function in v5: (query) => query.state.data?.status !== 'completed'), or (b) scope smoke (c) and the acceptance wording explicitly to the standalone RecapPage route and accept the single /sessions/:id focus refetch on SessionComplete.

**[IMPORTANT]** Several more unlisted source pins constrain the SessionComplete/RecapPage rewrite: rating/phase6-stats-parity.test.ts:46 pins `new Set(data.connections.map(c => c.userId)).size` in RecapPage.tsx — the variable name `data` (today a useState, RecapPage.tsx:217) is load-bearing; may24-presence-livekit-reconcile.test.ts:58-64 pins 'Manual rooms' + `c.isManual` in BOTH files; live-test-3-fixes.test.ts:32-45 pins `function InterestBadge` slices in both; phase-may18-bug24-recap-dedup.test.ts:48-56 pins `interface Connection {` + the 'Met {c.meetCount} times' badge in RecapPage; phase-x-may-13-live-bugs.test.ts:181+ and client/ws2-profile-link-safety.test.ts:57 pin message-link markup. All survive a CAREFUL conversion, but none are listed, and the spec itself warns that source pins break on innocent reformatting.

*Required action:* Extend TRF-5's pinnedTestsToUpdate with the five files above and an explicit constraint: keep the local binding named `data` for the people-met payload in RecapPage (e.g. `const data = peopleMetQuery.data ?? null`), and do not rename/move InterestBadge, the Connection interface, or the Manual-rooms render blocks.

**[NIT]** Misdescription of current behavior: the spec says RecapPage's LateRatingForm onRated callback is 'currently refetchUnrated + fetchRecap'; the actual code is `onRated={() => refetchUnrated()}` only (RecapPage.tsx:426) — fetchRecap is not called today. The prescribed invalidation of ['people-met']/['session-stats'] is therefore a behavior ADDITION (connections list now refreshes after a late rating), which the smoke (d) depends on. Self-consistent end state, but the parity framing is wrong and could confuse an implementer comparing against current code.

*Required action:* Correct the problem statement to 'currently refetchUnrated only' and note that the invalidation adds the connections-list refresh the smoke asserts.

---

## TRF-6 — Stop minting a LiveKit token on every resync — mint only when the client lacks a token for its canonical room

**Priority:** P2
**Depends on:** TRF-1, TRF-2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/state-snapshot.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/hooks/useSessionSocket.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/Lobby.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/shared/src/types/events.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/canonical-100-shipA.test.ts`

### Problem

handleResync (state-snapshot.ts:200) calls buildYou(..., mintToken=true) unconditionally, and the client emits session:resync on EVERY session:status_changed (useSessionSocket.ts:373), on connect (:175), reconnect (:1203), foreground return (:1248), the 30s belt (:1174) and the pre-lobby converge (Lobby.tsx:1457). Each mint = getSessionById + participant SELECT + display_name SELECT (session.service.ts:736-767) ≈ 3 queries — at 50 users a round-cycle's status flips trigger ~1,000 burst queries minting tokens clients already hold (audit medium: 'Round-transition token-mint amplification'). The co-emit path already has the right pattern: emitStateSnapshot mints ONLY on location change via the lastEmittedLocation map (state-snapshot.ts:64,136-146).

### Design

Align resync with the co-emit's location-change-only logic using client-declared ground truth. PROTOCOL: extend the session:resync payload (shared/src/types/events.ts:259) to `{ sessionId: string; haveSeq?: number; haveRoomId?: string | null }` — haveRoomId is the LiveKit room the client currently holds a USABLE token for (its lobbyRoomId when in the lobby with a lobbyToken, its currentRoomId when in a breakout with a liveKitToken), or null/omitted when it holds none. SERVER (handleResync, state-snapshot.ts:160-213): keep everything up to and including the June-11 removed/left eviction gate (:188-199 — PINNED ordering: gate must stay BEFORE buildYou, june11-kick-token-and-cohost.test.ts:52-60). Then compute the canonical target room WITHOUT minting: `const targetRoomId = p.location.type === 'breakout' ? p.location.roomId : (await sessionService.getSessionById(data.sessionId))?.lobbyRoomId` (note buildYou already does this lookup when minting — refactor buildYou to accept a precomputed roomId or duplicate the 1-query lookup; prefer refactoring buildYou(sessionId, userId, p, mintToken, knownRoomId?) so the lookup happens once). Mint decision: `const mint = !data.haveRoomId || data.haveRoomId !== targetRoomId;` — absent/null haveRoomId mints (back-compat with old clients AND the genuinely tokenless S27 zombie-socket case); matching room skips the mint and returns a token-less `you` (every client consumer guards on `you.token && you.livekitUrl` — verified at useSessionSocket.ts:291,318,322 — so a token-less reply is already handled). Keep recording lastEmittedLocation (:203-205) in both cases so the next co-emit stays cheap. Do NOT change the M2 'left'-is-terminal behavior here — that is another cluster's fix; this item only touches the mint condition. CLIENT: add haveRoomId to all six resync emit sites — useSessionSocket.ts:175 (connect), :373 (status change), :1174 (30s belt — the belt only fires when lobbyToken is ABSENT, so pass null explicitly), :1203 (reconnect), :1248 (foreground), Lobby.tsx:1457 (pre-lobby converge). Compute via one helper: `const haveRoomId = (st.phase === 'matched' && st.liveKitToken && st.currentRoomId) ? st.currentRoomId : (st.lobbyToken ? st.lobbyRoomId : null);` reading useSessionStore.getState() at emit time. RESULT: steady-state status changes (the all-N amplification) skip all 3 mint queries per user; genuine needs (fresh join, post-round return to a new lobby/breakout, refresh, zombie heal) still mint because the held room differs or no token is held. The s26 pin on the converge fn only requires the emit('session:resync' as any prefix — adding a field keeps it matching.

### Code sketch

````
// state-snapshot.ts handleResync — after the removed/left gate (:199):
const sessionService = await import('../../session/session.service');
const targetRoomId = p.location.type === 'breakout'
  ? p.location.roomId
  : (await sessionService.getSessionById(data.sessionId).catch(() => null))?.lobbyRoomId ?? null;
// Mint only when the client holds no token for its canonical room. Old
// clients omit haveRoomId -> always mint (pre-change behavior).
const mint = !data.haveRoomId || !targetRoomId || data.haveRoomId !== targetRoomId;
const you = await buildYou(data.sessionId, userId, p, mint, targetRoomId);
// buildYou signature change:
async function buildYou(sessionId, userId, p, mintToken, knownRoomId?: string | null) {
  const you: StateSnapshotYou = { location: p.location, connState: p.connState, role: p.role };
  if (!mintToken) return you;
  const roomId = knownRoomId ?? (p.location.type === 'breakout' ? p.location.roomId : (await ...getSessionById(sessionId))?.lobbyRoomId);
  // ...existing mint unchanged
}

// shared/src/types/events.ts:259
'session:resync': (data: { sessionId: string; haveSeq?: number; haveRoomId?: string | null }) => void;

// client helper (useSessionSocket.ts, inside the effect):
const currentHaveRoomId = () => {
  const st = useSessionStore.getState();
  if (st.phase === 'matched' && st.liveKitToken && st.currentRoomId) return st.currentRoomId;
  return st.lobbyToken ? st.lobbyRoomId : null;
};
socket.emit('session:resync', { sessionId, haveSeq: ..., haveRoomId: currentHaveRoomId() });
````

### Tests to add

- Extend server/src/__tests__/services/orchestration/canonical-100-shipA.test.ts: keep the existing resync test (no haveRoomId -> token minted, mintMock called with lobby room) but rename '(always)' to '(when the client lacks a token for its canonical room)'; ADD: (a) resync with haveRoomId === the canonical lobby room -> reply has you.location but NO you.token and mintMock NOT called; (b) haveRoomId for a STALE room while canonical says breakout r7 -> mint for r7; (c) haveRoomId: null -> mint (S27 zombie heal).
- Keep june11-kick-token-and-cohost.test.ts green: the removed/left eviction gate must still precede the buildYou call (the test asserts indexOf ordering — keep the gate block above the new targetRoomId code).
- New client source-pin (same trf file pattern): all six session:resync emit sites include haveRoomId, and the helper reads liveKitToken/lobbyToken before claiming a room.
- Headed Playwright prod smoke: 3-user throwaway event; run one full round cycle; intercept server logs / use a counter via Render logs or a temporary debug metric: assert the participants' status-change resyncs during ROUND_ACTIVE->ROUND_RATING->ROUND_TRANSITION do not produce 'state-snapshot: token mint' work for users already holding the right token (observable proxy: no POST /token fallbacks fire AND video reconnects are zero), while a hard refresh mid-round still lands the user back in their breakout with working video within 5s (mint path intact), and a kicked user's resync still gets session:evicted (no token).

### Acceptance criteria

- A session:status_changed broadcast no longer triggers a token mint (3 DB queries) per connected client when clients already hold the correct room token — round-cycle mint volume drops from O(N x statusChanges) to O(actual location changes).
- Refresh (F5) mid-round, zombie-socket lobby heal (haveRoomId null), and fresh joins still receive a minted token in the resync reply within one round trip.
- Kicked/removed users still receive session:evicted with no token from resync (june11 pin intact).
- Old clients (no haveRoomId field) get exactly the pre-change always-mint behavior.

### Pinned tests to update

- server/src/__tests__/services/orchestration/canonical-100-shipA.test.ts:87-100 — 'handleResync ... freshly minted token (always)': passes as-written (payload omits haveRoomId) but the NAME and intent must be updated to '(when the client lacks a token for its canonical room)' and the skip-mint sibling cases added.
- server/src/__tests__/services/june11-kick-token-and-cohost.test.ts:52-60 — ordering pin (eviction gate before buildYou) must remain satisfied; insert new code AFTER the gate.
- server/src/__tests__/services/orchestration/canonical-100-shipC.test.ts:59-64 — 'snapshot/resync/REST minting rails are untouched' pins that state-snapshot.ts still references generateLiveKitToken — keep the mint call in buildYou (we gate, not remove).

### Risks

If a client claims haveRoomId for a token that is actually expired (TTL min 30 min, max 4h — only plausible in marathon events), the server skips the mint and video fails until the client's REST /token fallback or next location change heals it; acceptable given event lengths, and the client only claims rooms for tokens it currently HOLDS in store (store is wiped on phase transitions). Interplay with M2 (false 'removed' on resync) — another cluster edits the same function's eviction gate; coordinate merge order, this item must not move or alter that gate. The shipA behavioral test name says '(always)' — update it or the intent reads wrong to the next auditor.

### Deploy notes

Server first (accepts the new optional field; behavior unchanged for old clients), then client (starts sending haveRoomId). Shared types change requires the usual build:shared in both builds. No migration, no env. Ship after TRF-1/TRF-2 (P0s) per priority; independent of TRF-4/5.

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** Missed pin on the resync payload SHAPE: canonical-100-shipC.test.ts:94-98 slices 1200 chars from socket.on('session:status_changed') in useSessionSocket.ts and requires /emit\(\s*'session:resync',\s*\{\s*sessionId,\s*haveSeq/ — i.e. sessionId must remain the first field and haveSeq the literal second token at the :373 emit. The spec's codeSketch happens to satisfy this (haveRoomId appended last), but TRF-6's pinnedTestsToUpdate lists only shipC:59-64, so an implementer who writes `{ sessionId, haveRoomId, haveSeq }` or builds the payload via a helper/spread breaks the suite with no warning.

*Required action:* Add canonical-100-shipC.test.ts:94-98 to TRF-6's pinnedTestsToUpdate with the explicit rule: at the session:status_changed emit site the payload must keep the literal prefix `{ sessionId, haveSeq: ...` and append haveRoomId after it.

**[NIT]** Stale load-bearing comments not scheduled for update: round-lifecycle.ts:814-817 and :847-849, host-actions.ts:317-319, participant-flow.ts:870-871, and useSessionSocket.ts:370-372 all document that 'handleResync always mints a token for the canonical location' — the design contract TRF-6 deliberately changes to conditional. None are test-pinned (verified by grep), but the M2 cluster edits the same function and its implementer will read these comments as current truth.

*Required action:* Add a step to update those four comment sites (and the state-snapshot.ts file header at :7-14) in the TRF-6 commit to say minting is now gated on the client-declared haveRoomId mismatch.

## Reviewer-verified facts (safe to rely on)

- express-rate-limit resolves to 7.5.1 (package-lock.json; server/package.json pins ^7.1.0). dist/index.d.ts confirms keyGenerator and `limit: number | ValueDeterminingMiddleware<number>` exist, and NO ipKeyGenerator export (no ERR_ERL_KEY_GEN_IPV6 validation either) — the spec's 7.5.1 claims all hold.
- JWTs carry userId in `sub` (server/src/services/identity/identity.service.ts:443; middleware/auth.ts:85 sets userId=payload.sub) and config.jwtSecret exists (server/src/config/index.ts:25) — TRF-2's resolver design is correct. trust proxy at index.ts:176, apiLimiter mount at index.ts:189, webhooks mounted AFTER the limiter at index.ts:337, and webhooks.ts:30-33 verifies LiveKit signatures on the raw body exactly as stated.
- SessionStateSnapshot carries serverNow (session-state-snapshot.service.ts:47) and NO seq field; applyFullState (client/src/stores/sessionStore.ts:619) has no ordering guard while applyStateSnapshot (:608-614) is seq-guarded; readCanonical exists (canonical-state.ts:48) with doc.seq (:34) — the same counter baseFromDoc uses (state-snapshot.ts:82). readCanonical returns null when Redis is absent (redis.client.ts getRedisClient returns null in jest), so existing session-state-snapshot.test.ts cases stay green after the new import.
- roster:changed emit inventory is exactly as the spec lists (participant-flow.ts:714; host-actions.ts:1036/2086/2168; routes/sessions.ts:691; fanout.ts:294) and client listeners are only useSessionSocket.ts:262 and EventPlanStrip.tsx:86. participant:count is emitted only at participant-flow.ts:728/1188 and its sole client listener is a no-op (useSessionSocket.ts:193); getParticipantCount remains referenced at routes/sessions.ts:127 so no dead-code fallout from TRF-4.
- All six session:resync emit sites confirmed (useSessionSocket.ts:175/373/1174/1203/1248, Lobby.tsx:1457), handler wired pass-through at orchestration.service.ts:276, payload type at shared/src/types/events.ts:259. handleResync calls buildYou(...,true) at state-snapshot.ts:200 with the june11 eviction gate at :188-199 before it, and emitStateSnapshot's location-change mint at :136-146 — all as described.
- Pinned tests the spec lists behave exactly as described: phase4:134-138/:144-148 (slice-based, satisfied by the :344 permissions handler reference), tier1-a6:54-57 (literal app.use('/api', apiLimiter), no app.use(apiLimiter)), tier1-a7 (pins store: buildStore only — no `max:` pin, so switching to function-form `limit` is safe), s16:73, phase5:166-167, socket-events:60 (type list only), shipA:87-100 (passes with haveRoomId omitted), june11:52-60 (indexOf ordering), shipC:59-64. Measured the s26 fixed-length slices: 462 chars of slack in the useSessionSocket 1500-char belt slice and 698 chars in the Lobby 3600-char slice — both survive the planned haveRoomId additions and a guard inserted before the 'Ship C belt' comment.
- @tanstack/react-query ^5.60.0 supports function-form refetchInterval receiving the query object; supertest ^7.2.2 is in devDependencies; jsonwebtoken 9.0.2 installed. The spec adds no locks (in-memory timers only), so no lock-ordering hazards exist; withMatchGenerationLock acquisition sites are untouched.
- Deploy-ordering claims verified: seq and haveRoomId are optional/additive in both directions; the two participant-flow socket call sites (:215, :744) whitelist fields so TRF-1/TRF-3 server changes can't leak through them; render.yaml:62-65 rate-limit keys and the autoSync-OFF note (:7-17) are as cited; hccParticipants client consumers are only sessionStore (:69/:399/:680/:700) and HostControlCenter.tsx:236, with the email render null-guarded at HostControlCenter.tsx:629.

