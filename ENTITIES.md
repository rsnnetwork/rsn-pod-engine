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
| `pod:<podId>:wall` | A pod's wall (its discussion) changes: a post is made, deleted or pinned, a comment or reply is added or deleted, or a reaction is set or cleared, so the counts on the feed move. Sent to the pod's ACTIVE members only, from `pod-wall.service.ts` through `fanoutPodWall`: invited, pending, left and removed rows cannot read the wall and are not told | the pod wall's feed (`GET /api/pods/:podId/wall/posts`); preview branch (`reason-m1`) screens only |
| `pod-wall-post:<postId>` | One post's thread on a pod's wall changes: a comment or reply is added or deleted, a comment is liked or unliked, a reaction is set or cleared, or the post is deleted or pinned. Same audience as `pod:<podId>:wall`, sent with it, except a like on a comment, which only a thread shows and is sent on its own | the post's comments (`GET /api/pods/:podId/wall/posts/:postId/comments`) and the single post behind a `?post=` link (`GET /api/pods/:podId/wall/posts/:postId`); preview branch (`reason-m1`) screens only |
| `user:<userId>` | User profile mutates, including the empty profile company that creating or joining an entity as its founder or an employee fills in (that member, through `fanoutProfileChange`, which also refreshes their pods' member lists as a saved profile does). Also, for REASON: the member saves or passes on a person, or undoes it (that member only); the member records what happened after a meeting (that member only); a meeting request is sent (both the sender's and the recipient's `user:<id>` and `user:<id>:invites`, whatever the recipient's bell setting), or accepted or declined (both members' `user:<id>`, `user:<id>:invites` and `user:<id>:notifications`, from `routes/pokes.ts` through `fanoutUserEntity`, which always adds the member's own `user:<id>`), or answered by asking back: asking someone who has already asked you accepts their request (both members' `user:<id>`, `user:<id>:invites` and `user:<id>:notifications`, from `poke.service.ts`) | `user`, `user-settings` |
| `user:<userId>:pods` | User's pod membership changes, including creating a pod (its creator, with the new pod's `pod:<podId>`, `:members` and `:invites`, from `routes/pods.ts` through `fanoutPodEntities`). Also an event is created, renamed, rescheduled, cancelled or deleted (sent to the event's participants, its pod's members and its host, each told only their own tags, from `routes/sessions.ts` through `fanoutSessionListEntities`): the pods list counts each pod's events, and the preview branch's For You next-event panel (`reason-m1`, not on main) follows the member's pods | `my-pods` (when scoped to a user); on the preview branch (`reason-m1`) only, the For You next-event panel |
| `user:<userId>:invites` | User's received-invites list changes. Also, for meeting requests: one is sent (both the sender's and the recipient's `user:<id>:invites`, whatever the recipient's bell setting), or one is accepted or declined, or answered by asking back (both members) | `my-invites`, `received-invites` |
| `user:<userId>:sessions` | User's registered-session list changes. Also an event is created, renamed, rescheduled, cancelled or deleted: the same audience as `user:<id>:pods` above, so Home and Sessions redraw at once. A member outside the pod who sees a public or invite-only pod's event in their lists is not told, and catches up on focus | `my-sessions`, `platformMatches` (the Matches page's next event) |
| `user:<userId>:blocks` | User block-list mutates | `blocked-users`, `user-block-status`, `can-message` |
| `user:<userId>:dms` | User's DM conversation list changes | `dm-conversations`, `dm-groups`, `dm-unread-count` |
| `user:<userId>:notifications` | User's notification list / prefs changes. Also, for meeting requests: one is accepted, declined or answered by asking back (both members: the recipient's bell row for it is marked read and now reads Accepted or Declined, and an accept rings the sender). A save that books an agreed time rings the partner, as Confirm does (`meeting-windows.service.ts`). A cancelled meeting rings the other member (`meeting.service.ts`), and a reminder rings both, 10 minutes before the start (`meeting-reminder.worker.ts`) | `notification-prefs` |
| `user:<userId>:entities` | The entities (organisations, see `entity:<entityId>`) a member is linked to change: they create one, join one, change their role in one or leave one, or one of theirs is edited or archived (each person told is sent their own tag, from `routes/entities.ts` through `fanoutEntityChange`). When a member's own link changes, everyone told about it is also sent that member's tag, so a profile listing that member's entities redraws for the people who share the entity | the Entities list (`GET /api/entities`); a person's entities (`GET /api/users/:id/entities`, and the person brief's `entities`); preview branch (`reason-m1`) screens only |
| `session:<sessionId>` | Session row mutates (title, time, config, status, host pin, tile demote, host visibility). Also a "message everyone" send for the event starts, moves on (after every batch of 25 people) or finishes: the sender and the people running the event (host, co-hosts, the pod's active director or host) are told, so the panel's "Sending… x of y" and the 3-a-day limit redraw without polling | `session`, `session-detail`, `host-state`, `event-plan`, `post-event-message` |
| `session:<sessionId>:participants` | Participant joined/left/registered/removed/role-changed | `session-participants`, `session-participant-counts`, `session-cohost`, `unrated-partners` |
| `session:<sessionId>:invites` | Session invite created/accepted/declined/revoked | `session-pending-invites` |
| `session:<sessionId>:matches` | Round matched, preview generated, "Another Round" bumped | live event surfaces |
| `session:<sessionId>:plan` | Event plan computed / repaired | `event-plan` |
| `session:<sessionId>:chat` | Lobby chat message sent | live event chat |
| `session:<sessionId>:reactions` | Reaction sent | live event reactions |
| `match:<matchId>` | Match starts/ends, partner disconnects | live event matches |
| `match:<matchId>:chat` | In-room chat | live event chat |
| `dm-conversation:<convId>` | DM new message, read receipt, reaction. Also a meeting is booked, moved or cancelled: its card lands in the thread and the conversation's meeting changes (both members) | `dm-messages` |
| `user:<userId>:meetings` | The member's confirmed 1:1 meetings change: one is booked (Confirm, or a save that agrees a time) or moved (`meeting-windows.service.ts`), cancelled (`meeting.service.ts`), attended for the first time inside its window (`meeting-call.service.ts`), or reminded 10 minutes before (`meeting-reminder.worker.ts`). Both members, each sent their own tag, through `emitMeetingChanged` (`services/meetings/meeting-tags.ts`) | the Events meetings list (`GET /api/meetings`) and the Events count (`GET /api/meetings/summary`); preview branch (`reason-m1`) screens only |
| `meeting:<meetingId>` | That meeting changes, on the same occasions as `user:<id>:meetings`, sent to both its members with it | the meeting's page (`GET /api/meetings/:id`); preview branch (`reason-m1`) screens only |
| `support-ticket:<ticketId>` | Ticket reply / status change | `my-support-tickets` |
| `entity:<entityId>` | An entity (an organisation members create, such as a company or a fund; not a realtime tag) is created, edited or archived, or someone joins it, changes their role in it or leaves it. Sent to its people as they are after the write (an archive keeps them), the member who acted, and the member whose link changed, from `routes/entities.ts` through `fanoutEntityChange`. Someone outside the entity with its page open is not told, and catches up on focus | an entity's page (`GET /api/entities/:id`); preview branch (`reason-m1`) screens only |
| `admin:pods` | Admin pod list mutates, including a new pod (every admin, from `routes/pods.ts` through `fanoutAdminEntities`) | `admin-pods` |
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
