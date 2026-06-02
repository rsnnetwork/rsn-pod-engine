# RSN Realtime Architecture — Migration Plan

**For:** Claude Code
**Author:** Stefan (via Claude conversation)
**Status:** Ready to implement
**Stack:** Node.js (Express) + PostgreSQL (Neon) + Socket.IO + React + Vite + React Query (TanStack v5) + Redis. Render (server) + Vercel (client).

---

## 1. Context

RSN's product mandate: *every action by any user must be reflected on every other screen, every other user, every other device, instantly. No refresh ever needed.*

The current realtime layer keeps breaking. The pattern is:

1. Server mutates DB.
2. Server emits a bespoke socket event (e.g. `pod:membership_updated`) to user-scoped rooms.
3. A global `NotificationBell` component listens and calls `queryClient.invalidateQueries({ queryKey: [...] })` against a **hard-coded list of query keys**.
4. Affected React Query hooks refetch.

### Why it keeps breaking

- The hard-coded invalidation list in `NotificationBell` is implicit, not enforced anywhere.
- Every new page introduces new query keys (`pod-pending-invites`, `pod-member-counts`, `session-participant-counts`, etc.) that must be manually added to the bell. They get missed.
- The mapping between socket events and query keys lives in two places (the bell + each page) with nothing tying them together.
- Every new mutation requires the developer to remember (a) emit the right socket event, and (b) update the bell's invalidation list.
- Audit-on-bug-report is reactive and slow.

### What we want

A pattern that makes it **structurally impossible** to forget a fanout or an invalidation when adding a new feature. Compatible with the existing PERN + Socket.IO + React Query stack. No major rewrite. Works across inviter/invitee sides, multiple browser profiles, devices, mobile. Survives server restarts.

---

## 2. The decision

**Tag-based React Query invalidation, driven by a single generic `entity:changed` socket event.**

This is Option 1 + a thin layer of Option 4 from the systemic-fix shortlist. The other options were ruled out:

| Option | Reason ruled out |
|---|---|
| 2. Server-pushed payloads via `setQueryData` | Solves latency/bandwidth, not the structural problem. Can layer on later for hot paths. |
| 3. Convex / Replicache / Supabase Realtime | Correct long-term answer, but violates the "no multi-week rewrite" constraint. Revisit in 12 months. |
| 4. Generic event + config file (alone) | Config file still drifts. The point isn't where the mapping lives — it's whether it's enforced. |
| 5. Poll-as-safety-net | Violates "instant, no refresh" mandate. Polling is a fallback, not a correctness layer. |
| 6. Server-side query-key registry | Couples the server to React Query's key shape. Server should speak in domain entities, not UI keys. |

### Why this works

The structural shift: **queries declare what they depend on; the socket layer doesn't need to know they exist.**

- Server emits *what changed in the domain* (`pod:abc123:members`), not *what UI needs to update* (`pod:membership_updated`).
- Queries tag themselves with the entities they care about, inline, next to the data they fetch.
- The global handler is a dumb dispatcher with no knowledge of the app.

The "forgetting" failure mode disappears because:

- **Adding a query**: the developer declares entities inline. Can't forget — they're right next to the `queryFn`. No central list.
- **Adding a mutation**: the developer emits the entity that changed. They're already thinking in entity terms because they just mutated it.
- **The bell stops being a coupling point.**

---

## 3. The pattern

### 3.1 Entity naming convention

Entities are strings of the form `<type>:<id>` or `<type>:<id>:<sub-resource>`.

| Entity | Meaning |
|---|---|
| `pod:<podId>` | The pod itself (name, settings) |
| `pod:<podId>:members` | Membership list for a pod |
| `pod:<podId>:invites` | Pending invites for a pod |
| `user:<userId>:invites` | Invites received by a user |
| `user:<userId>:pods` | Pods a user belongs to |
| `session:<sessionId>` | A networking session |
| `session:<sessionId>:participants` | Participants in a session |

Keep names domain-shaped, not UI-shaped. If unsure, name it after the database row/relationship, not the screen.

A short `ENTITIES.md` file should live in the repo root and list every entity in use. Update it when adding new ones.

### 3.2 Server side — single event

Replace all bespoke fanout helpers (`notifyPodChanged`, etc.) with one helper:

```js
// server/realtime/emit.js
function emitEntities(io, userIds, entities) {
  for (const userId of userIds) {
    io.to(`user:${userId}`).emit('entity:changed', { entities });
  }
}
```

Usage in a route after a mutation:

```js
// Example: removing a user from a pod
await db.query('UPDATE pod_members SET status=$1 WHERE ...', ['removed']);

const affectedUsers = await db.query(
  'SELECT user_id FROM pod_members WHERE pod_id=$1 AND status=$2',
  [podId, 'active']
);

emitEntities(io, [...affectedUsers.rows.map(r => r.user_id), removedUserId], [
  `pod:${podId}`,
  `pod:${podId}:members`,
  `user:${removedUserId}:pods`,
]);
```

The developer thinks: *"what entities did I just change?"* — not *"what UI surfaces care?"*

### 3.3 Client side — meta tags on queries

Every query declares its entities via `meta.entities`:

```js
// client/hooks/usePodMembers.js
export function usePodMembers(podId) {
  return useQuery({
    queryKey: ['pod-members', podId],
    queryFn: () => api.getPodMembers(podId),
    meta: {
      entities: [`pod:${podId}`, `pod:${podId}:members`],
    },
  });
}
```

### 3.4 Client side — single global handler

Replaces the hard-coded invalidation list in `NotificationBell`:

```js
// client/realtime/useEntityChangedHandler.js
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { socket } from './socket';

export function useEntityChangedHandler() {
  const queryClient = useQueryClient();

  useEffect(() => {
    function handler({ entities }) {
      queryClient.invalidateQueries({
        predicate: (query) => {
          const tags = query.meta?.entities ?? [];
          return entities.some((e) => tags.includes(e));
        },
      });
    }

    socket.on('entity:changed', handler);
    return () => socket.off('entity:changed', handler);
  }, [queryClient]);
}
```

Mount once at the app root:

```jsx
// client/App.jsx
function App() {
  useEntityChangedHandler();
  return <Routes>...</Routes>;
}
```

That's the whole pattern. ~30 lines of client code, one shared event shape on the server.

---

## 4. Migration plan

**Do not big-bang this.** Production has real users. Each step below is independently shippable and reversible.

### Step 1 — Add the new layer alongside the old one
- [ ] Create `server/realtime/emit.js` with `emitEntities()`.
- [ ] Create `client/realtime/useEntityChangedHandler.js`.
- [ ] Mount `useEntityChangedHandler()` in `App.jsx` (or wherever `NotificationBell` is mounted).
- [ ] **Do not remove the existing bell or bespoke events yet.** Both run in parallel.

### Step 2 — Define entity conventions
- [ ] Create `ENTITIES.md` in repo root. List every entity type RSN currently uses (~10 expected).
- [ ] Document the naming rule: `<type>:<id>` or `<type>:<id>:<sub-resource>`, domain-shaped not UI-shaped.

### Step 3 — Dual-emit on the server
- [ ] For every place that currently calls a bespoke fanout (`notifyPodChanged`, etc.), **also** call `emitEntities()` with the corresponding entity strings.
- [ ] Keep the old call in place. Both events fire.
- [ ] This is safe: clients ignoring `entity:changed` still get the old events; clients consuming `entity:changed` get both but invalidation is idempotent.

### Step 4 — Migrate queries page by page
For each query in the app:
- [ ] Add `meta: { entities: [...] }` declaring what the query depends on.
- [ ] Remove the corresponding key from `NotificationBell`'s hard-coded invalidation list.
- [ ] Test the page in isolation (open two browser profiles, perform the mutation, verify the other profile updates).

Suggested order (highest-risk first, so bugs surface early):
1. Pod membership surfaces.
2. Invite surfaces (inviter + invitee).
3. Session participant surfaces.
4. Badges and counts (these are the ones that were silently breaking).
5. Everything else.

### Step 5 — Decommission the old layer
Once **all** queries have `meta.entities` and **all** bell entries have been removed:
- [ ] Delete the bell's `useEffect` invalidation logic.
- [ ] Remove the bespoke socket events from the server.
- [ ] Remove the old fanout helpers.

### Step 6 — Document
- [ ] Add a short section to the project README pointing at `ENTITIES.md` and the pattern.
- [ ] Add a code comment in `useEntityChangedHandler.js` explaining the contract.

---

## 5. Watch-outs and follow-ups

### Performance
`invalidateQueries({ predicate })` does a linear scan over the React Query cache. At RSN's projected scale (50–100 active query keys) this is a non-issue for years. Don't pre-optimize. If you ever hit 500+ active queries, switch to an indexed lookup (Map of entity → query keys, maintained on query mount/unmount).

### Redis
The pattern above is single-server. If RSN scales to multiple Render instances, add the Socket.IO Redis adapter (`@socket.io/redis-adapter`) so `entity:changed` events fan out across instances. Until then, single instance is fine.

### Server restarts
Socket.IO reconnection is built-in. On reconnect, React Query's `refetchOnReconnect: true` (default) handles the catch-up. No extra work needed.

### Bandwidth
The `entity:changed` payload is tiny (an array of short strings). Cheaper than the current bespoke events. No concern.

### When to revisit Option 3 (Convex/Replicache/Supabase Realtime)
- If active query count exceeds ~300.
- If multi-user collaborative editing becomes a core feature.
- If the team grows beyond 3 engineers and the invalidation discipline becomes a coordination cost.
- Until then, this pattern scales fine.

### Layering Option 2 later
For hot paths (e.g. a session in progress with 5 people), you can later piggyback the updated payload on the `entity:changed` event:

```js
io.to(`user:${userId}`).emit('entity:changed', {
  entities: [`session:${sessionId}:participants`],
  data: { 'session:abc:participants': updatedList } // optional
});
```

The client handler can opportunistically call `setQueryData` when `data` is present, falling back to invalidation otherwise. This is an optimization, not a requirement — only add it where measurable latency matters.

---

## 6. The deeper principle (for future reference)

The reason this kept breaking isn't React Query or Socket.IO. It's that the server was emitting **UI events** (`pod:membership_updated`) and the client was doing **UI-to-data mapping** (which query keys does this affect?).

Both sides should speak the same language: **domain entities**.

Once they do, the bell isn't holding a brittle map in its head — it's translating one well-defined vocabulary into cache operations. That translation is the only thing the bell knows. It cannot drift, because there is nothing to drift from.

This is the smallest change that turns "remember to wire up the bell" from a discipline problem into a structural one.

---

## 7. Acceptance criteria

The migration is complete when:

- [ ] `NotificationBell` contains zero hard-coded query keys.
- [ ] Every `useQuery` in the codebase has `meta.entities` declared.
- [ ] Every mutation route ends with a single `emitEntities()` call.
- [ ] `ENTITIES.md` exists and is up to date.
- [ ] Opening any two surfaces in different browser profiles and performing a mutation on one results in the other updating with no refresh, no exceptions.

When that's true, "every action instant" is structurally enforced, not per-bug patched.
