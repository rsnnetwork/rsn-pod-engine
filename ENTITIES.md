# RSN Realtime Entity Vocabulary

Every realtime-aware query in RSN declares which **domain entities** it
depends on via `meta.entities`. Every mutation route emits the entities
it just changed via `emitEntities()`. A single global handler matches
the two via predicate invalidation.

Naming format: `<type>:<id>` or `<type>:<id>:<sub-resource>`. Always
domain-shaped (name a database row / relationship), never UI-shaped.

**Add new entities here when you introduce them.** This file is the
single source of truth that both client query authors and server route
authors reference.

## Entities currently in use

| Entity | Triggers when | Used by (sample queries) |
|---|---|---|
| `pod:<podId>` | Pod itself mutates (rename, archive, delete, settings) | `pod`, `my-pods` |
| `pod:<podId>:members` | Member added/removed/role-changed/approved/rejected/left | `pod-members`, `pod-member-counts`, `pod-pending-members` |
| `pod:<podId>:invites` | Pod invite created/accepted/declined/revoked | `pod-pending-invites` |
| `pod:<podId>:sessions` | Session under this pod created/updated/deleted/status-changed | `pod-sessions`, `pod-session-count` |
| `user:<userId>` | User profile mutates | `user` |
| `user:<userId>:pods` | User's pod membership changes | `my-pods` (when scoped to a user) |
| `user:<userId>:invites` | User's received-invites list changes | `my-invites`, `received-invites` |
| `user:<userId>:sessions` | User's registered-session list changes | `my-sessions` |
| `user:<userId>:blocks` | User block-list mutates | `blocked-users`, `user-block-status`, `can-message` |
| `user:<userId>:dms` | User's DM conversation list changes | `dm-conversations`, `dm-groups`, `dm-unread-count` |
| `user:<userId>:notifications` | User's notification list / prefs changes | `notification-prefs` |
| `session:<sessionId>` | Session row mutates (title, time, config, status, host pin, tile demote, host visibility) | `session`, `session-detail`, `host-state`, `event-plan` |
| `session:<sessionId>:participants` | Participant joined/left/registered/removed/role-changed | `session-participants`, `session-participant-counts`, `session-cohost`, `unrated-partners` |
| `session:<sessionId>:invites` | Session invite created/accepted/declined/revoked | `session-pending-invites` |
| `session:<sessionId>:matches` | Round matched, preview generated, "Another Round" bumped | live event surfaces |
| `session:<sessionId>:plan` | Event plan computed / repaired | `event-plan` |
| `session:<sessionId>:chat` | Lobby chat message sent | live event chat |
| `session:<sessionId>:reactions` | Reaction sent | live event reactions |
| `match:<matchId>` | Match starts/ends, partner disconnects | live event matches |
| `match:<matchId>:chat` | In-room chat | live event chat |
| `dm-conversation:<convId>` | DM new message, read receipt, reaction | `dm-messages` |
| `support-ticket:<ticketId>` | Ticket reply / status change | `my-support-tickets` |
| `admin:pods` | Admin pod list mutates | `admin-pods` |
| `admin:sessions` | Admin session list mutates | `admin-sessions` |
| `admin:users` | Admin user list mutates | `admin-users` |
| `admin:join-requests` | Admin join-request queue | `admin-join-requests`, `admin-join-requests-pending` |
| `admin:violations` | Admin violations queue | `admin-violations` |
| `admin:support-tickets` | Admin ticket queue | `admin-support-tickets` |
| `admin:analytics` | Admin analytics dashboards | `admin-stats`, `admin-analytics-*`, `admin-recent-matches` |

## Rules

1. **Every realtime-relevant `useQuery` declares `meta.entities`.** No exceptions, no central registry. The list lives next to the query.
2. **Every mutation route ends with `emitEntities(io, affectedUserIds, [...])`.** Server speaks in entities, not UI events.
3. **Entity names are domain-shaped.** `pod:abc:members`, never `pod-page-data`.
4. **Use the centralised entity-string builders** in `server/src/realtime/entities.ts` and `client/src/realtime/entities.ts` to avoid typos. Both modules export the same builders so server and client agree.
5. **When introducing a new entity, add it here first**, then use it in code.

Reference: `docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md` for the full migration plan and rationale.
