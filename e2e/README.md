# RSN E2E Test Suite

Playwright + Socket.IO end-to-end tests against live `app.rsn.network`.

## Setup

```bash
cd e2e
npm install
npx playwright install chromium
```

## Run

```bash
# JWT_SECRET from Render env vars (JWT_SECRET key on rsn-api service)
export JWT_SECRET=$(cat .jwt_secret)
export DATABASE_URL=$(grep DATABASE_URL ../server/.env | cut -d= -f2-)
npx playwright test
```

## Test users

Users created via `helpers/auth.ts:createTestUser()` — directly in DB with email pattern `e2etest-*-{timestamp}@example.com`.

`cleanupTestData()` runs after each test suite — deletes:
- Test users (matched by email pattern)
- Sessions hosted by those users (cascades matches/ratings/participants)
- Pods owned by those users
- audit_log, refresh_tokens, notifications, encounter_history, invites tied to those users

## What's tested

- **manual-rooms.spec.ts** — ghost room disappears after match completes, bulk create works
- **shipA-smoke.spec.ts** — canonical Ship A (HEADED, vs prod): F5 mid-breakout returns to the
  same room with video; 12s offline→online re-syncs (`session:resync` asserted on the wire when
  the socket.io connection actually dropped — LiveKit sockets are excluded from that check)
- **shipB-smoke.spec.ts** — canonical Ship B + room-end fixes (HEADED, vs prod): full algorithm
  round cycle with REAL rating-form clicks, 75s ghost-re-pull watch after End Round, manual
  breakout with UI-driven room-scope chat assertion (roommate sees it, host doesn't), end-all +
  voluntary-leave ghost watches. Native confirm() dialogs are auto-accepted.
- **shipC-smoke.spec.ts** — canonical Ship C token cutover (HEADED, vs prod): lobby + breakout
  video work with ZERO legacy token frames (no lobby:token ever; match:assigned carries no
  token) — everything rides the snapshot rail (resync replies + you.token) + REST fallback.
- **loadABC-20users.spec.ts** — 20 REAL browser contexts vs prod: sequential joins, lobby video,
  full 10-pair round, all 20 return to main, 60s ghost watch across every page. Video counts are
  local-CPU-tolerant (20 publishers × 19 subscriptions saturate one machine); state placement
  and final convergence are strict.
- **load-gate-40.spec.ts** — the Wave-0 SDD load gate at the PROTOCOL layer (socket.io + the real
  per-user HTTP request pattern), so it scales to 40–50 on an 8-core box where 40 video browsers
  can't. Asserts the gate's three things: burst-join latency (p95), ZERO 429s for legitimate
  per-user traffic (the at-scale proof of TRF-2's `u:<sub>` bucket keying; also reports peak
  req/60s vs the 100 limit), and round transitions under churn (refresh + background-tab +
  disconnect/rejoin → roster reconverges, breakout reached, all return, zero ghosts). Faithful
  presence (`presence:ready` + heartbeat) and `reconnection:true` mirror the SPA. Tunables:
  `LOAD_N` (default 40), `LOBBY_TICKS`, `GHOST_WATCH_MS`, `JOIN_LATENCY_BUDGET_MS`. The 20-browser
  run above remains the real video-fanout proof. Run (prod — pick an off-event window):
  ```bash
  cd e2e
  $env:JWT_SECRET = (Get-Content .jwt_secret -Raw).Trim()
  $env:LOAD_N = "40"   # 50 for the upper bound
  npx playwright test tests/load-gate-40.spec.ts --reporter=line
  ```

Run any of them headed against prod:
```bash
cd e2e
$env:JWT_SECRET = (Get-Content .jwt_secret -Raw).Trim()
$env:DATABASE_URL = ((Get-Content "..\server\.env" | Select-String "^DATABASE_URL=") -replace "^DATABASE_URL=","")
npx playwright test tests/shipA-smoke.spec.ts tests/shipB-smoke.spec.ts tests/shipC-smoke.spec.ts --reporter=line
```

## Adding tests

1. Use `createTestUser` to spin up users with valid JWT tokens
2. Use `helpers/api.ts` for REST calls
3. Use `socket.io-client` for live event flows (host:create_breakout_bulk, participant:leave_conversation, etc.)
4. Always end with cleanup — afterAll hook
