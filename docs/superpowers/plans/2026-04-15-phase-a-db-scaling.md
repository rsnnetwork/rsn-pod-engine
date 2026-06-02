# Phase A: Quick DB Scaling Wins

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double concurrent user capacity from ~30 to ~70 users with zero architecture changes — pool size increase, Neon pooler endpoint, and N+1 query fixes.

**Architecture:** No new infrastructure. Three surgical changes: (1) increase DB_POOL_MAX from 10 to 40 on Render, (2) switch DATABASE_URL to Neon's connection pooler endpoint, (3) batch 2 N+1 query patterns that execute individual queries in loops. All changes are backward-compatible and independently deployable.

**Tech Stack:** PostgreSQL (Neon), pg-pool, Node.js

---

### Task 1: Increase DB Pool Max + Switch to Neon Pooler Endpoint

**Files:**
- Modify: `server/src/db/index.ts:13` (increase min connections)
- Modify: `server/.env.example:11-12` (update documented defaults)
- Modify: Render secret file (DATABASE_URL + DB_POOL_MAX)

- [ ] **Step 1: Update .env.example with new pool defaults**

In `server/.env.example`, change:

```
DB_POOL_MIN=2
DB_POOL_MAX=10
```

to:

```
DB_POOL_MIN=3
DB_POOL_MAX=40
```

- [ ] **Step 2: Update db/index.ts min connections**

In `server/src/db/index.ts`, change line 13:

```typescript
min: 1,             // Keep 1 connection warm — prevents Neon cold-start on first request
```

to:

```typescript
min: config.dbPoolMin,  // Keep connections warm — prevents Neon cold-start under load
```

This makes min connections configurable via `DB_POOL_MIN` env var (already in config).

- [ ] **Step 3: Verify server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean, no errors

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 266 tests pass

- [ ] **Step 5: Commit code changes**

```bash
git add server/src/db/index.ts server/.env.example
git commit -m "feat: configurable DB pool min + increase defaults for 50-100 user scaling"
```

- [ ] **Step 6: Update Render environment variables**

On Render dashboard (rsn-api service → Environment):

1. Change `DB_POOL_MAX` from `10` to `40`
2. Change `DB_POOL_MIN` from `2` to `3`
3. Change `DATABASE_URL` — replace the hostname:
   - FROM: `ep-dawn-darkness-aldhykh3.c-3.eu-central-1.aws.neon.tech`
   - TO: `ep-dawn-darkness-aldhykh3-pooler.c-3.eu-central-1.aws.neon.tech`
   (Add `-pooler` before `.c-3`)
4. Click "Save Changes" — Render will auto-restart

**Why pooler endpoint:** Neon's pooler uses PgBouncer internally, supports 10,000+ logical connections mapped to ~100 physical connections. Direct endpoint is limited to 100 concurrent connections total.

- [ ] **Step 7: Verify deployment works**

After Render restarts, check:
1. Health endpoint: `curl https://rsn-api-h04m.onrender.com/health`
2. Check Sentry for errors
3. Test a login + session creation on app.rsn.network

---

### Task 2: Fix N+1 — Batch Force Match Cancellations

**Files:**
- Modify: `server/src/services/orchestration/handlers/matching-flow.ts:362-365`

- [ ] **Step 1: Replace individual UPDATE loop with batch query**

In `server/src/services/orchestration/handlers/matching-flow.ts`, find lines 362-366:

```typescript
    if (existing.rows.length > 0) {
      for (const row of existing.rows) {
        await query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [row.id]);
      }
    }
```

Replace with:

```typescript
    if (existing.rows.length > 0) {
      const ids = existing.rows.map(r => r.id);
      await query(`UPDATE matches SET status = 'cancelled' WHERE id = ANY($1)`, [ids]);
    }
```

This turns N individual UPDATE queries into 1 batched query.

- [ ] **Step 2: Verify server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 266 tests pass

- [ ] **Step 4: Commit**

```bash
git add server/src/services/orchestration/handlers/matching-flow.ts
git commit -m "perf: batch force-match cancellations — N queries → 1 query"
```

---

### Task 3: Fix N+1 — Batch Match Inserts in persistMatches

**Files:**
- Modify: `server/src/services/matching/matching.service.ts:353-380`

- [ ] **Step 1: Replace individual INSERT loop with multi-row INSERT**

In `server/src/services/matching/matching.service.ts`, find lines 353-380 (the `persistMatches` function):

```typescript
async function persistMatches(sessionId: string, rounds: RoundAssignment[]): Promise<void> {
  await transaction(async (client) => {
    for (const round of rounds) {
      await client.query(
        `DELETE FROM matches
         WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled')`,
        [sessionId, round.roundNumber]
      );

      for (const pair of round.pairs) {
        await client.query(
          `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, score, reason_tags, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')`,
          [
            sessionId,
            round.roundNumber,
            pair.participantAId < pair.participantBId ? pair.participantAId : pair.participantBId,
            pair.participantAId < pair.participantBId ? pair.participantBId : pair.participantAId,
            pair.participantCId || null,
            pair.score,
            pair.reasonTags,
          ]
        );
      }
    }
  });
```

Replace with:

```typescript
async function persistMatches(sessionId: string, rounds: RoundAssignment[]): Promise<void> {
  await transaction(async (client) => {
    for (const round of rounds) {
      await client.query(
        `DELETE FROM matches
         WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled')`,
        [sessionId, round.roundNumber]
      );

      // Batch insert all matches for this round in one query
      if (round.pairs.length > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let paramIdx = 1;

        for (const pair of round.pairs) {
          const pA = pair.participantAId < pair.participantBId ? pair.participantAId : pair.participantBId;
          const pB = pair.participantAId < pair.participantBId ? pair.participantBId : pair.participantAId;
          placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, 'scheduled')`);
          values.push(sessionId, round.roundNumber, pA, pB, pair.participantCId || null, pair.score, pair.reasonTags);
          paramIdx += 7;
        }

        await client.query(
          `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, score, reason_tags, status)
           VALUES ${placeholders.join(', ')}`,
          values
        );
      }
    }
  });
```

This turns N individual INSERT statements (one per match) into 1 multi-row INSERT per round. For 50 matches, that's 50 queries → 1 query. Transaction holds locks for milliseconds instead of seconds.

- [ ] **Step 2: Verify server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 266 tests pass

- [ ] **Step 4: Commit**

```bash
git add server/src/services/matching/matching.service.ts
git commit -m "perf: batch match inserts — N individual INSERTs → 1 multi-row INSERT per round"
```

---

### Task 4: Push, Deploy, Verify

- [ ] **Step 1: Push to staging + main**

```bash
git push origin staging
# Wait for CI
git push origin staging:main
```

- [ ] **Step 2: Check Sentry after deploy**

```bash
curl -s -H "Authorization: Bearer $SENTRY_TOKEN" \
  "https://de.sentry.io/api/0/projects/rsnnetwork/rsn-api/issues/?query=is:unresolved&sort=date"
curl -s -H "Authorization: Bearer $SENTRY_TOKEN" \
  "https://de.sentry.io/api/0/projects/rsnnetwork/rsn-client/issues/?query=is:unresolved&sort=date"
```
Expected: No new issues

- [ ] **Step 3: Verify production is working**

1. Open app.rsn.network
2. Login, create a pod + event, register participants
3. Start event, run a round, verify matching works
4. Check Render logs for any pool exhaustion errors

- [ ] **Step 4: Update progress.md**

Add entry for Phase A DB scaling under the current change section.
