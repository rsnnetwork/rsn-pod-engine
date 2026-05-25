# Canonical Room-State — Phase 4 (Server-Side LiveKit Eviction + Webhook Reconcile) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development. Steps use `- [ ]`.

**Goal:** Close **G1** (a participant physically present in the main room AND a breakout room) by having the server **evict** a participant from their old LiveKit room on every room transition, instead of trusting the client to leave. Add a **LiveKit webhook receiver** that reconciles canonical `connState` from real join/leave events.

**SAFETY — dark launch:** All eviction behavior is gated behind a new env flag **`ROOM_EVICTION_ENABLED` (default `false`)**. Because eviction manipulates live video membership (a bug = participants kicked from video mid-event, which no unit test catches), it ships to main INERT. It is enabled only by setting the env var, ideally after a live test. The webhook receiver is also inert until LiveKit Cloud is configured to call it.

**Ship target:** main, flag OFF (dark). Then: enable the flag on a test event to validate before turning on in prod.

**Tech Stack:** TypeScript, Jest, `livekit-server-sdk` (already a dep — `WebhookReceiver`). `npm test` (server). Spec: §3 Pillar 3, §9.

---

## File Structure (Phase 4)

- **Modify** `server/src/config/index.ts` — add `roomEvictionEnabled: process.env.ROOM_EVICTION_ENABLED === 'true'`.
- **Modify** `server/src/services/video/video.service.ts` — add `evictFromRoom(userId, roomId)` (best-effort wrapper over the provider's `removeParticipant`; the provider already calls it inside `moveParticipant`).
- **Modify** `server/src/services/video/video.interface.ts` + `livekit.provider.ts` + `mock.provider.ts` — expose `removeParticipant(roomId, userId)` directly (currently only reachable via `moveParticipant`).
- **Modify** `server/src/services/orchestration/handlers/round-lifecycle.ts` — at round start, evict matched users from the lobby room (flag-gated); `endRatingWindow` already re-issues lobby tokens — evict from the breakout there (flag-gated).
- **Create** `server/src/routes/webhooks.ts` — `POST /api/webhooks/livekit`, verify signature, update canonical `connState`.
- **Modify** `server/src/index.ts` (or the route registrar) — mount the webhooks router (raw-body for signature verification).
- **Test** `server/src/__tests__/services/orchestration/phase4-eviction.test.ts`, `server/src/__tests__/routes/livekit-webhook.test.ts`

---

## Task 1: Config flag + `removeParticipant` on the video provider

**Files:** `config/index.ts`, `video/video.interface.ts`, `video/livekit.provider.ts`, `video/mock.provider.ts`, `video/video.service.ts`; test `phase4-eviction.test.ts`.

- [ ] **Step 1: Failing test**

```typescript
// server/src/__tests__/services/orchestration/phase4-eviction.test.ts
import { setVideoProvider, evictFromRoom } from '../../../services/video/video.service';

describe('Phase 4 — evictFromRoom', () => {
  const calls: Array<[string,string]> = [];
  beforeEach(() => {
    calls.length = 0;
    setVideoProvider({
      createRoom: async()=>({} as any), closeRoom: async()=>{},
      issueJoinToken: async()=>({ token:'t', livekitUrl:'u', roomId:'r' } as any),
      moveParticipant: async()=>{}, listParticipants: async()=>[], roomExists: async()=>true,
      setParticipantCanPublishAudio: async()=>{},
      removeParticipant: async(roomId:string, userId:string)=>{ calls.push([roomId,userId]); },
    } as any);
  });

  it('calls provider.removeParticipant(roomId, userId)', async () => {
    await evictFromRoom('u1', 'lobby-s1');
    expect(calls).toEqual([['lobby-s1','u1']]);
  });

  it('swallows provider errors (best-effort)', async () => {
    setVideoProvider({ removeParticipant: async()=>{ throw new Error('gone'); } } as any);
    await expect(evictFromRoom('u1','r1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL** (`evictFromRoom`/`removeParticipant` undefined).

- [ ] **Step 3: Implement.**

`config/index.ts` — add inside the config object (near LiveKit):
```typescript
  // Phase 4 — server-side room eviction (G1). Dark by default; enable per env.
  roomEvictionEnabled: process.env.ROOM_EVICTION_ENABLED === 'true',
```

`video/video.interface.ts` — add to `IVideoProvider`:
```typescript
  removeParticipant(roomId: string, userId: string): Promise<void>;
```

`livekit.provider.ts` — add the method (the SDK `roomService.removeParticipant` already exists; it's used inside `moveParticipant`):
```typescript
  async removeParticipant(roomId: string, userId: string): Promise<void> {
    await this.roomService.removeParticipant(roomId, userId);
  }
```

`mock.provider.ts` — add:
```typescript
  async removeParticipant(_roomId: string, _userId: string): Promise<void> { /* no-op */ }
```

`video.service.ts` — add:
```typescript
/** Best-effort eviction of a participant from a LiveKit room (Phase 4, G1).
 *  Never throws — a participant who already left the room is the common case. */
export async function evictFromRoom(userId: string, roomId: string): Promise<void> {
  try {
    await getVideoProvider().removeParticipant(roomId, userId);
  } catch (err) {
    logger.warn({ err, userId, roomId }, 'evictFromRoom failed (non-fatal)');
  }
}
```

- [ ] **Step 4: Run — PASS (2).** **Step 5: Commit** `feat(video): removeParticipant on provider + evictFromRoom helper (phase 4)`

---

## Task 2: Evict from old room on round transitions (flag-gated)

**Files:** `round-lifecycle.ts`; test `phase4-eviction.test.ts`.

- [ ] **Step 1: Failing test** — with `config.roomEvictionEnabled` forced true (mock `../../../config`), drive the round-start eviction path (or test a small extracted helper `evictMatchedFromLobby(sessionId, userIds)` that loops `evictFromRoom(uid, lobbyRoomId(sessionId))` only when the flag is on). Assert: flag ON → evicts each matched user from `lobby-{sessionId}`; flag OFF → no eviction calls.

```typescript
import { evictMatchedFromLobby } from '../../../services/orchestration/handlers/round-lifecycle';
// mock config.roomEvictionEnabled true/false per case; mock video.service.evictFromRoom to record calls
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `round-lifecycle.ts` add a small exported helper and call it at round start (after the `match:assigned` emit loop) and the symmetric breakout-eviction in `endRatingWindow` (where lobby tokens are re-issued, ~line 751):

```typescript
import { config } from '../../../config';
import { evictFromRoom, lobbyRoomId } from '../../video/video.service';

/** Phase 4 (G1, flag-gated) — sever matched users' lobby presence at round
 *  start so they cannot be in the main room AND a breakout simultaneously. */
export async function evictMatchedFromLobby(sessionId: string, userIds: string[]): Promise<void> {
  if (!config.roomEvictionEnabled) return;
  const lobby = lobbyRoomId(sessionId);
  await Promise.all(userIds.map(uid => evictFromRoom(uid, lobby)));
}
```

Round start — after the participants have been emitted `match:assigned` (end of the Step-6 loop), add:
```typescript
    // Phase 4 (G1) — server-side eviction from the lobby room (dark unless ROOM_EVICTION_ENABLED).
    await evictMatchedFromLobby(sessionId, Array.from(matchedUserIds));
```

`endRatingWindow` — inside the `socketsInRoom` loop where each user gets a lobby token, after `s.emit('lobby:token', …)` add (flag-gated, evict from their breakout room recorded in `roomParticipants`):
```typescript
            if (config.roomEvictionEnabled) {
              const rp = activeSession.roomParticipants?.get(uid);
              if (rp?.roomId) await evictFromRoom(uid, rp.roomId);
            }
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(state): server-side lobby/breakout eviction on round transitions (phase 4, G1, flag-gated)`

---

## Task 3: LiveKit webhook receiver (reconcile canonical connState)

**Files:** Create `server/src/routes/webhooks.ts`; modify route registrar; test `livekit-webhook.test.ts`.

LiveKit Cloud will POST signed events. Verify with `WebhookReceiver(apiKey, apiSecret)`. On `participant_left` mark canonical `connState:'disconnected'`; on `participant_joined` mark `connState:'connected'`. Inert until LiveKit Cloud is configured to call this URL.

- [ ] **Step 1: Failing test** — POST a crafted body to the handler with a stubbed `WebhookReceiver.receive` returning `{ event:'participant_left', room:{name:'lobby-s1'}, participant:{identity:'u1'} }`; assert it calls `updateCanonicalParticipant('s1','u1',{connState:'disconnected'})`. (Room→sessionId: parse `lobby-{sessionId}` / `match-{sessionId}-...`.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `routes/webhooks.ts`:

```typescript
import { Router, raw } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../config';
import logger from '../config/logger';
import { updateCanonicalParticipant } from '../services/orchestration/state/canonical-state';

const receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);

function sessionIdFromRoom(room: string): string | null {
  const m = room.match(/^lobby-(.+)$/) || room.match(/^match-(.+?)-r\d+-/);
  return m ? m[1] : null;
}

export const webhooksRouter = Router();

// LiveKit posts JSON with a signature in the Authorization header; we need the
// RAW body to verify. Mount with express.raw at the registrar.
webhooksRouter.post('/livekit', raw({ type: 'application/webhook+json' }), async (req, res) => {
  try {
    const event = await receiver.receive(req.body.toString(), req.get('Authorization'));
    const room = event.room?.name;
    const identity = event.participant?.identity;
    if (room && identity) {
      const sessionId = sessionIdFromRoom(room);
      if (sessionId) {
        if (event.event === 'participant_left') {
          await updateCanonicalParticipant(sessionId, identity, { connState: 'disconnected' });
        } else if (event.event === 'participant_joined') {
          await updateCanonicalParticipant(sessionId, identity, { connState: 'connected' });
        }
      }
    }
    res.status(200).end();
  } catch (err) {
    logger.warn({ err }, 'LiveKit webhook receive failed');
    res.status(200).end(); // ack anyway — never make LiveKit retry-storm
  }
});
```

Mount it where other routers are registered (e.g. `index.ts`): `app.use('/api/webhooks', webhooksRouter);` — ensure it is mounted BEFORE any global `express.json()` strips the raw body, or rely on the per-route `raw(...)`.

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(api): LiveKit webhook receiver reconciles canonical connState (phase 4)`

---

## Task 4: Full-suite gate + typecheck

- [ ] `npm test` — all green. With the flag default OFF and the webhook unconfigured, NOTHING changes at runtime; existing tests must be unchanged.
- [ ] `cd server && npx tsc --noEmit` — clean.
- [ ] Commit any fixups.

---

## Activation steps (hand to Ali — NOT done by the implementer)

1. **Webhook:** In LiveKit Cloud → project settings → Webhooks, add `https://api.rsn.network/api/webhooks/livekit` (content type `application/webhook+json`). Uses the existing LiveKit API key/secret for signing.
2. **Eviction flag:** set `ROOM_EVICTION_ENABLED=true` in Render env (and in `render.yaml`) — ideally validate on a test event first (watch that breakout transitions don't drop anyone's video).

## Self-Review

- **G1:** server evicts from the old room on transition (Task 2) — but **flag-gated OFF**, so it's dark on main until enabled. **Reconcile:** webhook receiver (Task 3), inert until LiveKit Cloud configured.
- **Safety:** every eviction is best-effort (never throws); both mechanisms are no-ops by default, so shipping to main changes nothing observable until explicitly enabled. The webhook always acks 200 to avoid LiveKit retry storms.
- **Deferred:** the periodic `listParticipants` sweep (spec §9) — the transition-eviction + webhook cover G1; the sweep is a later hardening.
