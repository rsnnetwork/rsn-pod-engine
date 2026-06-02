# RSN Realtime Architecture Migration — Entity-Tag Pattern

**Status:** Ready to start
**Owner:** Ali (with Claude)
**Started:** 2026-05-19
**Mandate:** every user action, on every screen, every user, every device, instantly. Whole RSN — in-event and out-of-event. No exceptions.

---

## 1. Context

RSN's current realtime layer uses bespoke socket events (`pod:membership_updated`, `session:list_changed`, etc.) and a hard-coded list of React Query keys in `NotificationBell.tsx` that gets invalidated when each event arrives. Every new query or new mutation requires the developer to remember to update the bell. The list drifts. Bugs surface as "I clicked X and the other screen didn't update."

This migration replaces that with a single generic event + per-query entity tags + predicate-based invalidation. Inspired by the synthesis of three independent architectural opinions (Claude web, ChatGPT, Gemini) collected 2026-05-19; primary blueprint is Claude web's plan with hierarchical-key guideline borrowed from Gemini and LISTEN/NOTIFY safety-net deferred.

---

## 2. The pattern (one-page summary)

### Server side

One helper replaces all `notifyPodChanged` / `notifySessionListChanged` / `notifyPermissionsUpdated`:

```ts
// server/src/services/orchestration/realtime-entities.ts
export async function emitEntities(
  io: SocketServer,
  userIds: string[],
  entities: string[],
): Promise<void> {
  for (const userId of userIds) {
    io.to(`user:${userId}`).emit('entity:changed', { entities });
  }
}
```

Each mutation route ends with one `emitEntities()` call describing which **domain entities** changed — not which UI surfaces care.

### Client side

Each `useQuery` declares its entities inline via `meta.entities`:

```ts
useQuery({
  queryKey: ['pod-members', podId],
  queryFn: () => api.getPodMembers(podId),
  meta: { entities: [`pod:${podId}`, `pod:${podId}:members`] },
});
```

One global handler dispatches by predicate:

```ts
// client/src/realtime/useEntityChangedHandler.ts
socket.on('entity:changed', ({ entities }) => {
  qc.invalidateQueries({
    predicate: (q) => {
      const tags = (q.meta?.entities as string[]) ?? [];
      return entities.some((e) => tags.includes(e));
    },
  });
});
```

`NotificationBell.tsx` keeps only its notification-list responsibilities. Zero query-key knowledge.

---

## 3. Entity vocabulary

Domain-shaped names, never UI-shaped. Format: `<type>:<id>` or `<type>:<id>:<sub-resource>`.

| Entity | Triggers when |
|---|---|
| `pod:<podId>` | Pod itself mutates (rename, archive, delete, settings) |
| `pod:<podId>:members` | Member added/removed/role-changed/approved/rejected/left |
| `pod:<podId>:invites` | Pod invite created/accepted/declined/revoked |
| `pod:<podId>:sessions` | Session under this pod created/updated/deleted/status-changed |
| `user:<userId>` | User profile mutates |
| `user:<userId>:pods` | User's pod membership changes (joined / left / removed) |
| `user:<userId>:invites` | User's received-invites list changes |
| `user:<userId>:sessions` | User's registered-session list changes |
| `user:<userId>:blocks` | User block-list mutates |
| `user:<userId>:dms` | User's DM conversation list changes |
| `user:<userId>:notifications` | User's notification list changes |
| `session:<sessionId>` | Session row mutates (title, time, config, status) |
| `session:<sessionId>:participants` | Participant joined/left/registered/removed |
| `session:<sessionId>:invites` | Session invite created/accepted/declined/revoked |
| `session:<sessionId>:matches` | Round matched, preview generated, "Another Round" bumped |
| `session:<sessionId>:plan` | Event plan computed / repaired |
| `session:<sessionId>:chat` | Lobby chat message sent |
| `session:<sessionId>:reactions` | Reaction sent |
| `match:<matchId>` | Match starts/ends, partner disconnects |
| `match:<matchId>:chat` | In-room chat |
| `dm-conversation:<convId>` | DM conversation has new message, read receipt, reaction |
| `support-ticket:<ticketId>` | Ticket reply / status change |
| `admin:pods` | Admin pod list (super_admin scope) |
| `admin:sessions` | Admin session list |
| `admin:users` | Admin user list |
| `admin:join-requests` | Admin join-request queue |
| `admin:violations` | Admin violations queue |
| `admin:support-tickets` | Admin ticket queue |
| `admin:analytics` | Admin analytics dashboards |

A live `ENTITIES.md` in the repo root will mirror this table and be kept in sync.

---

## 4. Phased migration

**Each phase is independently shippable, reversible, and behaviour-preserving until phase 5.**

### Phase 1 — Scaffolding (1 commit)

- [ ] `server/src/services/orchestration/realtime-entities.ts` — `emitEntities(io, userIds, entities)` helper.
- [ ] `client/src/realtime/useEntityChangedHandler.ts` — predicate-based global invalidator.
- [ ] `client/src/realtime/useEntityChangedHandler.ts` mounted once in `App.tsx`.
- [ ] `shared/src/types/events.ts` — add `'entity:changed': (data: { entities: string[] }) => void` to `ServerToClientEvents`.
- [ ] `ENTITIES.md` at repo root with the table from §3.
- [ ] Tests: pin the helper exists, pin the handler subscribes to `entity:changed`, pin the predicate invalidates queries with matching `meta.entities`.

**Behaviour change:** none — nothing emits or consumes `entity:changed` yet.

### Phase 2 — Server dual-emit

For every existing fanout call, **add** an `emitEntities()` call alongside it. Old events keep firing. Both pathways coexist.

Mapping (one entry per existing fanout call):

| Existing call | New `emitEntities` args |
|---|---|
| `notifyPodChanged(podId, 'member_added')` | `[pod:${podId}, pod:${podId}:members]` |
| `notifyPodChanged(podId, 'member_removed')` | `[pod:${podId}, pod:${podId}:members, user:${removedUserId}:pods]` |
| `notifyPodChanged(podId, 'role_changed')` | `[pod:${podId}, pod:${podId}:members]` |
| `notifyPodChanged(podId, 'member_joined')` | `[pod:${podId}, pod:${podId}:members]` |
| `notifyPodChanged(podId, 'member_approved')` | `[pod:${podId}, pod:${podId}:members]` |
| `notifyPodChanged(podId, 'member_rejected')` | `[pod:${podId}, pod:${podId}:members]` |
| `notifyPodChanged(podId, 'invite_sent')` | `[pod:${podId}:invites, user:${inviteeUserId}:invites]` |
| `notifyPodChanged(podId, 'invite_accepted')` | `[pod:${podId}, pod:${podId}:members, pod:${podId}:invites, user:${userId}:invites, user:${userId}:pods]` |
| `notifyPodChanged(podId, 'invite_declined')` | `[pod:${podId}:invites, user:${userId}:invites]` |
| `notifyPodChanged(podId, 'invite_revoked')` | `[pod:${podId}:invites, user:${userId}:invites]` |
| `notifyPodChanged(podId, 'invite_bulk_sent')` | `[pod:${podId}:invites, session:${sessionId}:invites]` |
| `notifyPodChanged(podId, 'invite_force_accepted')` | `[pod:${podId}, pod:${podId}:members, pod:${podId}:invites]` |
| `notifyPodChanged(podId, 'pod_updated')` | `[pod:${podId}]` |
| `notifyPodChanged(podId, 'pod_deleted')` | `[pod:${podId}]` + `user:${each-member}:pods` |
| `notifySessionListChanged(podId, sessionId, 'session_created')` | `[session:${sessionId}, pod:${podId}:sessions]` |
| `notifySessionListChanged(podId, sessionId, 'session_updated')` | `[session:${sessionId}, pod:${podId}:sessions]` |
| `notifySessionListChanged(podId, sessionId, 'session_deleted')` | `[session:${sessionId}, pod:${podId}:sessions]` |
| `notifySessionListChanged(podId, sessionId, 'invite_*')` | `[session:${sessionId}:invites]` |
| `notifyPermissionsUpdated(sessionId, userId, role)` | `[session:${sessionId}:participants]` + `user:${userId}` |

Also covers in-event fanouts (not visible in pod/session routes but live in orchestration handlers):
- match assigned / reassigned / ended / partner_disconnected / partner_reconnected → `[session:${sessionId}:participants, match:${matchId}]`
- rating window open / closed → `[session:${sessionId}:participants, match:${matchId}]`
- chat message → `[session:${sessionId}:chat]` or `[match:${matchId}:chat]`
- reaction → `[session:${sessionId}:reactions]`
- host pin → `[session:${sessionId}]` (already broadcasts globally, just gets a new entity tag)
- tile demote (Bug 26) → `[session:${sessionId}]`
- "Another Round" bump → `[session:${sessionId}, session:${sessionId}:plan]`
- event plan repaired → `[session:${sessionId}:plan]`

**Tests:** for each fanout site, pin BOTH the old call AND the new `emitEntities()` call. Removing the old call is Phase 5; until then both must coexist.

**Behaviour change:** none from a user perspective — old handlers still fire. New event arrives at clients but is ignored (no queries have `meta.entities` yet).

### Phase 3 — Client query migration (the bulk of the work)

For every `useQuery` in `client/src`, add `meta.entities`. ~50 query keys mapped to the entity vocabulary above. Migrate in this order — highest realtime-criticality first so bugs surface early:

#### 3a — Pod surfaces (PodDetailPage, PodsPage, HomePage)
- [ ] `['pod', podId]` → `[pod:${podId}]`
- [ ] `['pod-members', podId]` → `[pod:${podId}:members]`
- [ ] `['pod-member-counts', podId]` → `[pod:${podId}:members]`
- [ ] `['pod-pending-invites', podId]` → `[pod:${podId}:invites]`
- [ ] `['pod-pending-members', podId]` → `[pod:${podId}:members]`
- [ ] `['pod-session-count', podId]` → `[pod:${podId}:sessions]`
- [ ] `['pod-sessions', podId]` → `[pod:${podId}:sessions]`
- [ ] `['pod-members-for-invite', podId, sessionId]` → `[pod:${podId}:members]`
- [ ] `['my-pods']` and `['my-pods', filter]` → `[user:${currentUserId}:pods]`

#### 3b — Session surfaces (SessionDetailPage, RecapPage, HostDashboardPage, HostControls)
- [ ] `['session', sessionId]` → `[session:${sessionId}]`
- [ ] `['session-detail', ...]` → `[session:${sessionId}]`
- [ ] `['session-participants', sessionId]` → `[session:${sessionId}:participants]`
- [ ] `['session-participant-counts', sessionId]` → `[session:${sessionId}:participants]`
- [ ] `['session-pending-invites', sessionId]` → `[session:${sessionId}:invites]`
- [ ] `['session-cohost', sessionId, userId]` → `[session:${sessionId}:participants]`
- [ ] `['my-sessions']` → `[user:${currentUserId}:sessions]`
- [ ] `['event-plan', sessionId]` → `[session:${sessionId}:plan]`
- [ ] `['host-state', sessionId]` → `[session:${sessionId}]`
- [ ] `['unrated-partners', sessionId]` → `[session:${sessionId}:participants, user:${currentUserId}]`

#### 3c — Invite surfaces (InvitesPage, InviteAcceptPage, HomePage)
- [ ] `['my-invites']` → `[user:${currentUserId}:invites]` (sender-side scope)
- [ ] `['received-invites']` → `[user:${currentUserId}:invites]`

#### 3d — DM surfaces
- [ ] `['dm-conversations']` → `[user:${currentUserId}:dms]`
- [ ] `['dm-groups']` → `[user:${currentUserId}:dms]`
- [ ] `['dm-messages', convId]` → `[dm-conversation:${convId}]`
- [ ] `['dm-unread-count']` → `[user:${currentUserId}:dms]`
- [ ] `['can-message', otherUserId]` → `[user:${currentUserId}:blocks, user:${otherUserId}:blocks]`

#### 3e — User / block / encounter surfaces
- [ ] `['user', userId]` → `[user:${userId}]`
- [ ] `['blocked-users']` → `[user:${currentUserId}:blocks]`
- [ ] `['user-block-status', userId]` → `[user:${currentUserId}:blocks]`
- [ ] `['encounters', filter]` → `[user:${currentUserId}]`
- [ ] `['connected-user-search', q]` → no entity (search results, don't subscribe)

#### 3f — Notification / support surfaces
- [ ] `['notification-prefs']` → `[user:${currentUserId}:notifications]`
- [ ] `['my-support-tickets']` → `[user:${currentUserId}]`

#### 3g — Admin surfaces (super_admin only — emit on every admin action)
- [ ] `['admin-pods', filter]` → `[admin:pods]`
- [ ] `['admin-sessions', filter]` → `[admin:sessions]`
- [ ] `['admin-users', filter]` → `[admin:users]`
- [ ] `['admin-join-requests']` → `[admin:join-requests]`
- [ ] `['admin-join-requests-pending']` → `[admin:join-requests]`
- [ ] `['admin-violations']` → `[admin:violations]`
- [ ] `['admin-support-tickets']` → `[admin:support-tickets]`
- [ ] `['admin-stats']` → `[admin:analytics]`
- [ ] `['admin-analytics-overview' | -users | -events | -connections]` → `[admin:analytics]`
- [ ] `['admin-recent-matches']` → `[admin:analytics]`
- [ ] `['admin-email-config']` → no entity (config, manual refresh OK)
- [ ] `['admin-health']` → no entity (polled live separately)
- [ ] `['admin-templates']` and `['matching-templates']` → no entity (rarely mutates)

**Verification per page:** open two browser profiles, perform a mutation on one, confirm the other updates without refresh. Pre-merge checklist. Mobile + desktop both verified per phase.

**Behaviour change:** affected page becomes live. Bell still fires for unmigrated pages too. No regressions.

### Phase 4 — Page-level socket subscriptions removed

Some live-event pages have their own `useSessionSocket` listening to specific events. Where those events are now superseded by `entity:changed`, prune the per-page listener. Keep only listeners that do something other than cache invalidation (e.g., updating Zustand state directly, showing a toast, playing a sound).

Examples to prune:
- `roster:changed` → covered by `session:${sessionId}:participants` entity.
- `host:visibility_changed` → covered by `session:${sessionId}:participants`.
- `permissions:updated` → covered by `user:${userId}` + `session:${sessionId}:participants`.

Keep:
- `match:assigned`, `match:reassigned` — these trigger navigation, not just cache state.
- `rating:window_open`, `rating:window_closed` — UI state machine triggers.
- `chat:message`, `chat:history`, `chat:reaction_update` — direct chat append (not cache-shaped).
- `tile:size_changed` and `pin:changed` — direct state-store updates, no React Query involved.
- `notification:new` — direct list update + toast.

### Phase 5 — Decommission the old layer

When every query has `meta.entities` and every page has been verified:
- [ ] Delete `notifyPodChanged`, `notifySessionListChanged`, `notifyPermissionsUpdated` server-side helpers.
- [ ] Remove the bespoke `pod:membership_updated`, `session:list_changed`, etc. emits from each route.
- [ ] Remove the hard-coded invalidation list from `NotificationBell.tsx`. Bell keeps only its notification-list + bell-counter responsibility.
- [ ] Remove the corresponding event types from `shared/src/types/events.ts`.

**Behaviour change:** none (the new layer has been carrying the load alongside since Phase 2). Old events disappear silently.

### Phase 6 — Lint / type-level enforcement (preventive)

To make future regressions structurally impossible:
- [ ] ESLint rule (custom or via `eslint-plugin-query`) that flags any `useQuery` without `meta.entities` (warn first, then error after the migration is complete).
- [ ] TypeScript helper `defineQuery({ entities: [...], ...rest })` that makes the `entities` field required at type level. Optional but recommended.
- [ ] Pre-commit hook scans for new `useQuery(` calls without `meta.entities` and refuses commit.

### Phase 7 — Future hardening (deferred, only if needed)

- **Multi-instance Redis pub/sub:** add `@socket.io/redis-adapter` when RSN scales past one Render instance. Until then unnecessary.
- **Postgres LISTEN/NOTIFY safety net:** triggers on `pod_members`, `session_participants`, etc. that fire `pg_notify('entity_changed', ...)`. Server's `pg` client subscribes and emits to Socket.IO. Only worth it if we ever discover routes bypassing `emitEntities()`.
- **Payload-on-event optimization:** for hot paths, server can include the new query response in the `entity:changed` event so the client uses `setQueryData` directly without a network round-trip. Add only where measurable latency matters.

---

## 5. Per-route fanout inventory

For Phase 2, every route that mutates state must emit. Inventory of mutation routes that currently do NOT emit (gaps to close during the migration):

### Server routes — gaps
- [ ] `PUT /users/me` (profile edit) → `[user:${userId}]`
- [ ] `POST /blocks` / `DELETE /blocks/:id` → `[user:${blockerId}:blocks, user:${blockedId}:blocks]`
- [ ] `POST /dm/messages` → `[user:${recipientId}:dms, dm-conversation:${convId}]`
- [ ] `POST /dm/messages/read` → `[dm-conversation:${convId}]`
- [ ] `POST /notifications/:id/read` and `/read-all` → `[user:${userId}:notifications]`
- [ ] `PUT /notification-prefs` → `[user:${userId}:notifications]`
- [ ] `POST /pokes` → `[user:${recipientId}]`
- [ ] `POST /reports` → `[admin:violations]`
- [ ] `POST /support-tickets` and replies → `[user:${userId}, admin:support-tickets]`
- [ ] `POST /preferred-people` → `[user:${userId}]`
- [ ] `POST /feedback` → `[session:${sessionId}]`
- [ ] Every admin-route action → emit the corresponding `admin:*` entity
- [ ] In-event handlers in `participant-flow.ts` / `matching-flow.ts` / `round-lifecycle.ts` / `chat-handlers.ts` — already emit, just need to add the new `emitEntities()` calls alongside

This inventory will be filled in as Phase 2 progresses; the list above is the starting checklist, not exhaustive.

---

## 6. Acceptance criteria

The migration is **complete** when:

- [ ] `client/src` has zero hard-coded invalidation lists keyed by socket events.
- [ ] Every `useQuery` in `client/src` declares `meta.entities` (verified by ESLint rule + grep).
- [ ] Every mutation route in `server/src/routes/**` and every mutation handler in `server/src/services/orchestration/handlers/**` ends with an `emitEntities()` call (verified by grep + test pin).
- [ ] `notifyPodChanged`, `notifySessionListChanged`, `notifyPermissionsUpdated` no longer exist in the codebase.
- [ ] The bespoke socket event types (`pod:membership_updated`, `session:list_changed`, `permissions:updated`, etc.) have been removed from `shared/src/types/events.ts`.
- [ ] `ENTITIES.md` exists at repo root and matches every entity used in code.
- [ ] **Two-profile end-to-end test passes for every mutation surface** — open two browser profiles (or one desktop + one mobile), mutate on one, verify the other updates within 2 seconds with no refresh. Coverage: pods, sessions, invites (sent + received + declined + revoked + bulk + accepted), pod-member changes, role changes, profile edits, blocks, DMs, notifications, pokes, reactions, support tickets, admin actions, in-event flows (joining, leaving, matching, "Another Round", chat, pin, tile demote, ending event), recap data.

---

## 7. Risks + watch-outs

- **Predicate invalidation perf** — `invalidateQueries({ predicate })` is a linear scan over the cache. At ~50 keys it's a non-issue. At ~500+ it would be; build an entity→key index then. Don't pre-optimize.
- **Forgotten `meta.entities` on new queries** — caught by ESLint rule (Phase 6). Until that rule lands, every new `useQuery` requires manual review.
- **Forgotten `emitEntities()` on new mutation routes** — caught by code review until a server-side lint or pre-commit check is added.
- **Entity-name typos** — `pod:${podId}` vs `pods:${podId}` would silently no-op. Mitigation: centralise entity-string builders in `client/src/realtime/entities.ts` and `server/src/realtime/entities.ts` so both sides import from the same module.
- **Two-profile testing time cost** — Phase 3 requires manual verification per page. Tedious but mandatory. No shortcut.
- **Phase 5 (decommissioning) is irreversible per-event** — only delete after the new layer has carried that surface in production for at least one full test pass.

---

## 8. Execution sequence

| Phase | Estimated effort | Ship target |
|---|---|---|
| 1. Scaffolding | 30 min | Same day, 1 commit |
| 2. Server dual-emit | 2 hours | Same day, 1–2 commits per route group |
| 3a–g. Client query migration | 4–8 hours | One commit per sub-phase, verify per page |
| 4. Prune redundant page socket listeners | 1 hour | 1 commit |
| 5. Decommission old layer | 30 min | 1 commit |
| 6. ESLint rule + helper | 1 hour | 1 commit |
| 7. Future hardening | Deferred | When triggered |

Total: roughly 1–2 working days of focused effort. Each phase is shippable independently.

---

## 9. Provenance

Synthesis of three architecture opinions collected 2026-05-19:

- **Claude web** — phased migration plan, `entity:changed` event, `meta.entities`, predicate invalidation. Primary blueprint.
- **ChatGPT** — `realtimeTags` (same idea, different name), refetch-by-default rule, Redis pub/sub mention for multi-instance.
- **Gemini** — hierarchical key shape (`['pod', podId, 'invites', 'pending']`), Postgres LISTEN/NOTIFY safety net, ORM-middleware enforcement.

Adopted Claude web as primary; borrowed hierarchical-key shape as a guideline for new code (Phase 6); deferred LISTEN/NOTIFY to Phase 7. Rejected ORM middleware (RSN uses raw SQL via `pg`, not Prisma/Drizzle).
