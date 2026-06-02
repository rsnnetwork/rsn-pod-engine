# Phase B1: Redis Persistence + Socket.IO Multi-Instance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis as a persistence/broadcast layer so active events survive server restarts and Socket.IO can broadcast across multiple instances. Keep in-memory Maps as primary for performance — Redis is write-through backup.

**Architecture:** In-memory Maps remain the fast read path (zero latency). Every write to activeSessions/chatMessages also writes to Redis (async, non-blocking). On server startup, restore from Redis instead of DB active_state column. Socket.IO Redis adapter enables cross-instance event broadcasting. This gives us crash recovery + horizontal scaling readiness with minimal code changes.

**Tech Stack:** ioredis, @socket.io/redis-adapter, Upstash Redis (serverless, EU)

**Revert point:** `d6f4480` — run `git reset --hard d6f4480 && git push --force` to restore pre-Redis state.

---

## Pre-Requisites (Manual)

Before starting any code:

1. **Create Upstash Redis instance:**
   - Go to https://console.upstash.com
   - Sign up with dev@rsn.network
   - Create database: Region = EU (Frankfurt), Name = "rsn-prod"
   - Copy the `REDIS_URL` (format: `rediss://default:xxx@eu1-xxx.upstash.io:6379`)

2. **Add to Render environment:**
   - Add `REDIS_URL` to Render secret file with the Upstash URL

3. **Add to local .env:**
   - Add `REDIS_URL=rediss://default:xxx@eu1-xxx.upstash.io:6379` to `server/.env`

---

### Task 1: Install Redis Packages

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install packages**

```bash
cd server && npm install ioredis @socket.io/redis-adapter @socket.io/redis-emitter
```

- [ ] **Step 2: Verify install succeeded**

Run: `cd server && npx tsc --noEmit`
Expected: Clean (no type errors from new packages)

- [ ] **Step 3: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "deps: add ioredis + socket.io redis adapter for Phase B1"
```

---

### Task 2: Create Redis Client Module

**Files:**
- Create: `server/src/services/redis/redis.client.ts`

- [ ] **Step 1: Create the Redis client with connection handling**

```typescript
// server/src/services/redis/redis.client.ts
import Redis from 'ioredis';
import config from '../../config';
import logger from '../../config/logger';

let redisClient: Redis | null = null;
let redisAvailable = false;

export function getRedisClient(): Redis | null {
  return redisAvailable ? redisClient : null;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export async function initRedis(): Promise<Redis | null> {
  if (!config.redisUrl || config.redisUrl === 'redis://localhost:6379') {
    logger.info('Redis URL not configured — running without Redis (in-memory only)');
    return null;
  }

  try {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) return null; // Stop retrying after 10 attempts
        return Math.min(times * 200, 5000);
      },
      lazyConnect: true,
    });

    redisClient.on('connect', () => {
      redisAvailable = true;
      logger.info('Redis connected');
    });

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis error — falling back to in-memory');
      redisAvailable = false;
    });

    redisClient.on('close', () => {
      redisAvailable = false;
      logger.warn('Redis connection closed');
    });

    await redisClient.connect();
    redisAvailable = true;
    logger.info('Redis initialized successfully');
    return redisClient;
  } catch (err) {
    logger.warn({ err }, 'Redis initialization failed — running without Redis');
    redisAvailable = false;
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    redisAvailable = false;
    logger.info('Redis connection closed');
  }
}
```

**Key design:** Redis is OPTIONAL. If connection fails, system runs in-memory only (current behavior). No crash, no downtime.

- [ ] **Step 2: Verify compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add server/src/services/redis/redis.client.ts
git commit -m "feat: Redis client module — optional, graceful fallback to in-memory"
```

---

### Task 3: Redis Session State Persistence (Write-Through)

**Files:**
- Modify: `server/src/services/orchestration/state/session-state.ts`

- [ ] **Step 1: Add Redis write-through to persistSessionState**

Import Redis client at the top of session-state.ts and add write-through logic to the `persistSessionState` function. Also add a `restoreFromRedis` function for startup recovery.

At the top of session-state.ts, add import:
```typescript
import { getRedisClient, isRedisAvailable } from '../../redis/redis.client';
```

Add two new functions:

```typescript
// ─── Redis Write-Through ─────────────────────────────────────────────────

const REDIS_SESSION_PREFIX = 'rsn:session:';
const REDIS_SESSION_TTL = 14400; // 4 hours — matches in-memory TTL

export async function persistToRedis(sessionId: string, session: ActiveSession): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const serialized = JSON.stringify({
      sessionId: session.sessionId,
      hostUserId: session.hostUserId,
      config: session.config,
      currentRound: session.currentRound,
      status: session.status,
      timerEndsAt: session.timerEndsAt?.toISOString() || null,
      isPaused: session.isPaused,
      pausedTimeRemaining: session.pausedTimeRemaining,
      pendingRoundNumber: session.pendingRoundNumber,
      presenceMap: Object.fromEntries(
        Array.from(session.presenceMap.entries()).map(([k, v]) => [k, {
          lastHeartbeat: v.lastHeartbeat.toISOString(),
          socketId: v.socketId,
          reconnectedAt: v.reconnectedAt?.toISOString() || null,
        }])
      ),
      manuallyLeftRound: Array.from(session.manuallyLeftRound),
    });
    await redis.setex(`${REDIS_SESSION_PREFIX}${sessionId}`, REDIS_SESSION_TTL, serialized);
  } catch (err) {
    // Non-fatal — in-memory state is the source of truth
    logger.warn({ err, sessionId }, 'Failed to persist session to Redis');
  }
}

export async function deleteFromRedis(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(`${REDIS_SESSION_PREFIX}${sessionId}`);
  } catch { /* non-fatal */ }
}

export async function restoreAllFromRedis(): Promise<Map<string, any>> {
  const redis = getRedisClient();
  if (!redis) return new Map();

  try {
    const keys = await redis.keys(`${REDIS_SESSION_PREFIX}*`);
    const sessions = new Map<string, any>();
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        sessions.set(parsed.sessionId, parsed);
      }
    }
    logger.info({ count: sessions.size }, 'Restored sessions from Redis');
    return sessions;
  } catch (err) {
    logger.warn({ err }, 'Failed to restore from Redis — falling back to DB');
    return new Map();
  }
}
```

- [ ] **Step 2: Hook write-through into existing persistSessionState**

In the existing `persistSessionState` function, add a Redis write after the DB persist:

```typescript
// At the end of persistSessionState, add:
persistToRedis(sessionId, activeSession).catch(() => {});
```

In the existing `clearPersistedState` function, add Redis cleanup:

```typescript
// At the end of clearPersistedState, add:
deleteFromRedis(sessionId).catch(() => {});
```

- [ ] **Step 3: Verify compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 266 tests pass (Redis is optional — tests run without it)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestration/state/session-state.ts
git commit -m "feat: Redis write-through for session state — non-blocking, optional"
```

---

### Task 4: Redis Chat Message Persistence

**Files:**
- Modify: `server/src/services/orchestration/state/session-state.ts`

- [ ] **Step 1: Add Redis write-through for chat messages**

Add to session-state.ts:

```typescript
const REDIS_CHAT_PREFIX = 'rsn:chat:';
const MAX_CHAT_MESSAGES = 50;

export async function persistChatToRedis(sessionId: string, messages: ChatMessage[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.setex(
      `${REDIS_CHAT_PREFIX}${sessionId}`,
      REDIS_SESSION_TTL,
      JSON.stringify(messages.slice(-MAX_CHAT_MESSAGES))
    );
  } catch { /* non-fatal */ }
}

export async function deleteChatFromRedis(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try { await redis.del(`${REDIS_CHAT_PREFIX}${sessionId}`); } catch { /* non-fatal */ }
}
```

- [ ] **Step 2: Hook into addSessionChat and cleanupChatMessages**

In `addSessionChat`, after pushing to the in-memory Map, add:
```typescript
persistChatToRedis(sessionId, messages).catch(() => {});
```

In `cleanupChatMessages`, add:
```typescript
deleteChatFromRedis(sessionId).catch(() => {});
```

- [ ] **Step 3: Verify + test + commit**

```bash
cd server && npx tsc --noEmit
npm test
git add server/src/services/orchestration/state/session-state.ts
git commit -m "feat: Redis write-through for chat messages"
```

---

### Task 5: Socket.IO Redis Adapter

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add Redis adapter to Socket.IO server**

In `server/src/index.ts`, after Socket.IO server creation, add the Redis adapter conditionally:

```typescript
import { createAdapter } from '@socket.io/redis-adapter';
import { initRedis, getRedisClient } from './services/redis/redis.client';

// In the startup function, after io is created:
const redis = await initRedis();
if (redis) {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.IO Redis adapter enabled — multi-instance broadcasting ready');
}
```

**Key:** If Redis isn't available, Socket.IO uses its default in-memory adapter (current behavior). Zero downtime risk.

- [ ] **Step 2: Initialize Redis before Socket.IO handlers**

Make sure `initRedis()` is called early in the startup sequence, before socket handlers are registered.

- [ ] **Step 3: Verify compiles + test**

Run: `cd server && npx tsc --noEmit && cd .. && npm test`
Expected: Clean, 266 tests pass

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: Socket.IO Redis adapter — enables multi-instance broadcasting"
```

---

### Task 6: Enhanced Session Recovery from Redis

**Files:**
- Modify: `server/src/services/orchestration/handlers/round-lifecycle.ts`

- [ ] **Step 1: Update recoverActiveSessions to try Redis first**

In the `recoverActiveSessions` function, try Redis restoration before falling back to DB:

```typescript
// At the start of recoverActiveSessions:
import { restoreAllFromRedis } from '../state/session-state';

// Try Redis first (faster, has more state including presenceMap)
const redisData = await restoreAllFromRedis();
if (redisData.size > 0) {
  for (const [sessionId, data] of redisData) {
    // Reconstruct ActiveSession from Redis data
    const session: ActiveSession = {
      sessionId: data.sessionId,
      hostUserId: data.hostUserId,
      config: data.config,
      currentRound: data.currentRound,
      status: data.status,
      timer: null,
      timerSyncInterval: null,
      timerEndsAt: data.timerEndsAt ? new Date(data.timerEndsAt) : null,
      isPaused: data.isPaused || false,
      pausedTimeRemaining: data.pausedTimeRemaining || null,
      pendingRoundNumber: data.pendingRoundNumber || null,
      presenceMap: new Map(
        Object.entries(data.presenceMap || {}).map(([k, v]: [string, any]) => [k, {
          lastHeartbeat: new Date(v.lastHeartbeat),
          socketId: v.socketId,
          reconnectedAt: v.reconnectedAt ? new Date(v.reconnectedAt) : undefined,
        }])
      ),
      manuallyLeftRound: new Set(data.manuallyLeftRound || []),
    };
    activeSessions.set(sessionId, session);

    // Restart timer if needed
    if (session.timerEndsAt && session.timerEndsAt.getTime() > Date.now() && !session.isPaused) {
      const remainingMs = session.timerEndsAt.getTime() - Date.now();
      // ... restart timer logic (same as existing DB recovery)
    }
  }
  logger.info({ count: redisData.size }, 'Sessions recovered from Redis');
  return;
}

// Fall through to existing DB recovery if Redis had nothing
```

- [ ] **Step 2: Verify + test + commit**

```bash
cd server && npx tsc --noEmit
npm test
git add server/src/services/orchestration/handlers/round-lifecycle.ts
git commit -m "feat: session recovery from Redis — faster restore with full state"
```

---

### Task 7: Integration Test + Deploy

- [ ] **Step 1: Full compile check**

```bash
cd server && npx tsc --noEmit
cd ../client && npx tsc --noEmit
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: 266 tests pass

- [ ] **Step 3: Push to staging**

```bash
git push origin staging
# Wait for CI
```

- [ ] **Step 4: Push to main after CI passes**

```bash
git push origin staging:main
```

- [ ] **Step 5: Verify deployment**

```bash
curl -s https://rsn-api-h04m.onrender.com/health
```
Expected: `{"status":"ok","db":{"connected":true}}`

- [ ] **Step 6: Check Sentry**

Both server and client — no new errors.

- [ ] **Step 7: Manual test**

Full event flow: create event → start → match → breakout rooms → rating → recap.
Verify everything works exactly as before.

- [ ] **Step 8: Verify Redis is receiving data**

After running a test event, check Upstash dashboard — should show keys like:
- `rsn:session:{sessionId}`
- `rsn:chat:{sessionId}`

---

## What This Gives Us

| Before | After Phase B1 |
|--------|---------------|
| Server restart = all active events lost | Events survive restart (restored from Redis) |
| Single instance only | Socket.IO broadcasts work across instances |
| presenceMap lost on crash | presenceMap persisted to Redis |
| Chat messages lost on crash | Chat messages persisted to Redis |
| No horizontal scaling | Ready for 2+ Render instances |

## What This Does NOT Change

- All reads still hit in-memory Maps (zero latency)
- 70 access points to activeSessions stay exactly as-is
- If Redis goes down, system runs in-memory only (current behavior)
- No new failure modes — Redis is strictly additive

## Future Phase B2 (Not In This Plan)

- Replace in-memory reads with Redis reads
- Remove in-memory Maps entirely
- Enable true stateless multi-instance scaling
- Only needed if we go beyond 2-3 server instances
