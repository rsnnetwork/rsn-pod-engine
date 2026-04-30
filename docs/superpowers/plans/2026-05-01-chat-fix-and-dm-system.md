# Plan — In-Room Chat Fix + Person-to-Person Messaging System (1 May 2026)

**Spec source:** Stefan's screenshot (issues 1-3) + user's clarification: in-room chat is broken; person-to-person DMs need to be built as a real architectural feature, not a patch.

**User's product decisions** (made on user's behalf since Stefan didn't reply, "best fit for RSN"):

1. Who can DM: only users who share at least one row in `encounter_history` (i.e. they've been matched in the same room at least once).
2. Real time via existing socket. Read receipts (boolean). Skip typing indicators.
3. Bell icon when online; one debounced email per sender per hour when recipient offline >10 min.
4. Block list — yes, shared between DMs and matching engine (matching spec says blocked never match).
5. One to one only. No group DMs.
6. New `/messages` page in main nav. Profile pages get a "Message" button. Bell badge counts unread DMs.
7. Keep messages forever. Users can delete their own conversations.

---

## Audit findings (relevant)

**In-room chat bug** lives in `server/src/services/orchestration/handlers/chat-handlers.ts:106-133`:
- The server queries for the user's active match using `WHERE status='active' AND (participant_a_id=$2 OR ...)`. If the match exists but status is not `'active'` at query time (e.g. during a state transition, or for completed/reassigned matches), the query returns 0 rows.
- The handler's fallback when no match is found: `socket.emit('chat:message', chatMsg)` — emit ONLY to self. Other room participants never receive the message. This is the silent-failure path.
- Possible secondary cause: `roomId` field on the broadcasted message is null, so client-side filter `m.roomId === currentRoomId` never matches.

**Existing chat persistence:** in-memory `chatMessages` Map + Redis snapshot (4 hour TTL). Max 50 messages per session. No Postgres persistence. This is fine for in-room chat (Stefan said in-room chat vanishes after the room ends). For DMs we need a real Postgres data model.

**No DM tables, no user_blocks tables exist.** Both are greenfield.

**Notifications** table exists at migration 025 with type enum `('event_invite', 'pod_invite')`. We extend with `'direct_message'`.

---

## Architecture

### Chat scopes (clarified)

- **In-room chat** — ephemeral, room scoped, vanishes when round ends. In-memory + Redis. NOT in Postgres. No retroactive history beyond Redis TTL. (current design, just needs the bug fix)
- **Lobby chat** — ephemeral, session scoped, vanishes when session ends. In-memory + Redis. NOT in Postgres. (current design, working)
- **DMs** — persistent, person to person, lives forever. Postgres backed. Independent of any session/round/event. (new feature)

### DM data model (new migrations)

```sql
-- migration 043_user_blocks.sql
CREATE TABLE user_blocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(blocker_id, blocked_id),
  CHECK(blocker_id != blocked_id)
);
CREATE INDEX idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX idx_user_blocks_blocked ON user_blocks(blocked_id);

-- migration 044_dm_conversations.sql
CREATE TABLE dm_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- normalize so user_a_id < user_b_id always; unique constraint enforces
  -- one conversation per pair
  user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ,
  -- soft-delete tracking per user (so each user can delete their own copy
  -- without nuking the conversation for the other party)
  user_a_deleted_at TIMESTAMPTZ,
  user_b_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_a_id, user_b_id),
  CHECK(user_a_id < user_b_id)
);
CREATE INDEX idx_dm_conv_user_a ON dm_conversations(user_a_id, last_message_at DESC);
CREATE INDEX idx_dm_conv_user_b ON dm_conversations(user_b_id, last_message_at DESC);

-- migration 045_direct_messages.sql
CREATE TABLE direct_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,  -- NULL until recipient marks as read
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_dm_messages_conv ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX idx_dm_messages_unread ON direct_messages(conversation_id, read_at) WHERE read_at IS NULL;

-- migration 046_notifications_dm_type.sql
ALTER TYPE notification_type ADD VALUE 'direct_message';
```

### Authorization rules (enforced server-side)

- **Can A DM B?** True if and only if:
  - A and B are not the same user, AND
  - There is an encounter_history row where `(user_a_id = LEAST(A,B) AND user_b_id = GREATEST(A,B))`, AND
  - Neither A blocks B nor B blocks A
- **Can A see conversation X?** True if A is one of conversation_a_id or conversation_b_id.
- **Can A send to conversation X?** Same as above + Can-DM check still passes (so blocking takes effect retroactively).

### Socket events

| Event | From | To | Payload | Persistence |
|---|---|---|---|---|
| `dm:send` | client | server | `{ toUserId, content }` | server writes to Postgres |
| `dm:message` | server | both users (in their userRoom) | `{ messageId, conversationId, fromUserId, content, createdAt }` | already persisted |
| `dm:read` | client | server | `{ conversationId, upToMessageId? }` | server updates `read_at` |
| `dm:read_receipt` | server | sender (in their userRoom) | `{ conversationId, readBy, readAt }` | already persisted |
| `dm:conversation_updated` | server | both users | `{ conversationId, lastMessageAt, unreadCount }` | for inbox sort updates |
| `notification:new` | server | recipient | (existing event, type='direct_message') | already persisted |

### REST endpoints

```
GET    /api/dm/conversations                — list my conversations (paginated, sorted by last_message_at DESC)
GET    /api/dm/conversations/:id/messages    — list messages in a conversation (paginated)
POST   /api/dm/messages                       — send (alternative to socket; idempotent for retries)
POST   /api/dm/conversations/:id/read         — mark as read
DELETE /api/dm/conversations/:id              — soft delete (sets user_a_deleted_at or user_b_deleted_at)
GET    /api/dm/can-message/:userId            — check if I can DM a specific user (used by profile Message button)

POST   /api/users/:id/block                   — block user
DELETE /api/users/:id/block                   — unblock user
GET    /api/users/blocked                     — list users I've blocked
```

### Email notification (debounced)

- When `dm:send` fires and recipient is not connected to any socket OR has been idle >10 min:
- Look up the most recent `email_sent_at` for this (sender, recipient) pair in a small in-memory or Redis-backed dedup map.
- If >1 hour since last email or no entry, send via Resend; record timestamp.
- Email subject: "{senderName} sent you a message on RSN"
- Email body: short snippet (first 200 chars) + link to `/messages/{conversationId}`.

---

## Phase plan

Each phase ships independently. Tests + builds + push to staging then main per the workflow memory. `check whole` after the last phase.

### Phase A — Fix the in-room chat bug
- Root cause investigation: confirm which of the 4 candidate failure modes is firing (match status not active, roomId null, participant lookup fails, socket not in user room). Most likely match status timing.
- Fix: rework the chat-handlers query to use the user's CURRENT room (from the active session's roomParticipants map or session_participants.current_room_id), not from a fresh DB query that races with status transitions.
- Add fallback: if the user is in a known breakout room, scope the message there even if the match status check fails. In-memory state is the source of truth for "what room am I in right now".
- Tests: pin the new scope-resolution logic. Pin that emit goes to the right userRoom set, not just `socket.emit` (which only goes to self).

### Phase B — User block infrastructure
- Migration: `user_blocks` table.
- Service: `blockService.block(blockerId, blockedId)`, `blockService.unblock(...)`, `blockService.areBlocked(userA, userB)` (returns true if EITHER direction is blocked).
- REST routes: `POST /api/users/:id/block`, `DELETE /api/users/:id/block`, `GET /api/users/blocked`.
- Wire into matching engine: `getEligibleParticipants` excludes pairs where either side has blocked the other. Add to the matching engine's hard constraints array.
- UI: Block button on the public profile page (`PublicProfilePage.tsx`). Block list management in Settings.
- Tests: matching engine never returns blocked pairs; DM service rejects blocked pairs (this gets used in Phase C).

### Phase C — DM data model + service + REST
- Migrations 044, 045, 046 (conversations, direct_messages, notification type).
- Service: `dmService` with these methods:
  - `canMessage(userA, userB)`: encounter_history check + block check
  - `sendMessage(fromUserId, toUserId, content)`: validates, ensures conversation exists (creates if first message), inserts row, updates `last_message_at`, returns the message
  - `listConversations(userId, page, pageSize)`: my conversations sorted by last_message_at, with unread count + last message snippet + other-user display
  - `listMessages(conversationId, userId, page, pageSize)`: messages in this conversation, requires user is in it and hasn't soft-deleted
  - `markRead(conversationId, userId, upToMessageId?)`: sets `read_at`, returns updated read_at timestamps
  - `deleteConversation(conversationId, userId)`: sets the user's soft-delete timestamp
- REST routes per the table above.
- Tests: encounter gate, block gate, idempotent conversation creation, soft-delete semantics, read state.

### Phase D — DM real time delivery + notifications
- Socket handlers: `dm:send`, `dm:read`. Server emits `dm:message`, `dm:read_receipt`, `dm:conversation_updated`.
- Notification on send: insert a `notifications` row with `type='direct_message'`, `link='/messages/{conversationId}'`. Push via existing `notification:new` socket event so the bell updates instantly.
- Email notification: when recipient has no active socket and has been idle >10 min. Debounced with a Redis-backed `dm:email-debounce:{from}:{to}` key with 1 hour TTL.
- Tests: socket message delivery, bell update, email debounce.

### Phase E — DM UI
- New `/messages` page (`client/src/features/messages/MessagesPage.tsx`). Two pane layout: conversation list on the left, active thread on the right. Mobile responsive (single pane).
- New `MessageButton` component: shows on the public profile page if `canMessage` returns true, otherwise shows a tooltip "You haven't met yet — DMs unlock after you share a room".
- Bell icon: fetch unread DM count alongside notifications, badge shows combined unread.
- Top nav: add a Messages link with a badge for unread DMs.
- Real time updates: page subscribes to `dm:message`, `dm:read_receipt`, `dm:conversation_updated` and updates React Query cache.
- Tests: basic render tests, can-message gating, message send flow.

### Phase F — Final verification + progress.md
- Full server test suite.
- `check whole`.
- Update progress.md with all 5 phase summaries.
- End-to-end manual test of the messaging flow on production.

---

## Behavior preservation

- Existing in-room chat: same UX, just delivers properly now.
- Existing lobby chat: untouched.
- Existing notifications: extended with new type, old types unchanged.
- Existing matching engine: now also excludes blocked pairs as an additional hard constraint. The default behavior for users who haven't blocked anyone is unchanged.
- All existing socket events and REST routes preserved.
- All 739 existing tests stay green.

## Rollback

Each phase is its own commit. `git revert <sha>` to roll back. The 4 new migrations are additive (new tables + a new enum value). No destructive schema changes. To revert the schema cleanly we'd need to write down-migrations, but in practice for an additive change we just leave the tables in place.

## Out of scope (deferred)

- Group DMs (architecture explicitly chose 1:1 only)
- Typing indicators
- Message reactions on DMs (in-room chat has reactions; DMs don't need them v1)
- DM attachments (text only v1)
- Auto-purge of old conversations
- DM-level mute (block is the only escape hatch v1)
- Search across messages (UI scroll back is enough v1)
- Migrating in-room chat to Postgres (intentionally left ephemeral per Stefan)

## Estimated effort

Phase A: 1 to 2 hours (it's a bug fix with a clear root cause).
Phase B: 3 to 4 hours (small migration + service + UI).
Phase C: 4 to 6 hours (data model + service + REST + tests).
Phase D: 3 to 4 hours (sockets + notifications + email).
Phase E: 4 to 6 hours (UI is the biggest piece).
Phase F: 1 hour (verify + doc).

Total: roughly 16 to 23 hours of focused work. Could be split across 2-3 days of execution depending on review checkpoints.
