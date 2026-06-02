# DM Chat Polish — Phase A + B + C

**Date:** 2026-05-03
**Author:** RSN
**Scope:** `client/src/features/messages/MessagesPage.tsx` + DM server reactions API
**Why:** Stefan reported the new DM chat feels crap on mobile. Desktop screenshot (5/3) confirms the visual polish gap (date repeated on every bubble, no message grouping, no avatars in thread, no emojis, no reactions).
**NOT in scope:** in-event `ChatPanel.tsx` (already polished), group chats UI, typing indicators, attachments, edit/delete messages.

---

## Phase A — Mobile + visual polish (UI only, no server)

**Files:** `client/src/features/messages/MessagesPage.tsx`

1. Textarea: `text-sm` → `text-base sm:text-sm` (kills iOS auto-zoom — same fix as in-event chat)
2. Composer: add `pb-[max(env(safe-area-inset-bottom),0.5rem)]` (clears iPhone home indicator)
3. Send button: `w-11 h-11 sm:w-9 sm:h-9` (44pt mobile target, smaller desktop)
4. Auto-scroll to bottom when textarea focuses
5. **Date separators** — render "Today" / "Yesterday" / "Mon May 1" between messages on day boundary
6. **Message grouping** — consecutive messages from same sender within 60s collapse vertically: no avatar/name on subsequent bubbles, smaller gap
7. **Avatar on incoming messages** — first bubble of each cluster gets avatar (already in inbox, missing from thread)
8. **Time format** — replace `formatRelative(createdAt)` per-message with `3:45 PM` (only show timestamp on the LAST message of a cluster, or on hover/tap)

**Verification:** type-check, build, manual browser test in Chrome DevTools mobile emulation.

---

## Phase B — Emoji input (UI only, no server)

**Files:** `client/src/features/messages/MessagesPage.tsx`

1. Add `<Smile />` button to the left of textarea
2. Toggle picker (20-emoji curated grid, same set as in-event chat for consistency)
3. Click emoji → `setDraft(draft + emoji)`, refocus textarea
4. `grid-cols-6 sm:grid-cols-10` so mobile gets bigger tap targets

**Verification:** type-check, build, browser test (open picker, click emoji, verify it lands in draft).

---

## Phase C — Message reactions (server + client)

### Server

**Migration `056_dm_message_reactions.sql`** (additive, reversible)
```sql
CREATE TABLE dm_message_reactions (
  message_id UUID NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_dm_reactions_message ON dm_message_reactions(message_id);
```

**Service additions** (`dm.service.ts`)
- `addReaction(messageId, userId, emoji)` — INSERT ON CONFLICT DO NOTHING (idempotent), authorize via conversation participation
- `removeReaction(messageId, userId, emoji)` — DELETE
- Allow-list of emojis: `['heart','clap','thumbs_up','laugh','fire','wow']` mapped to `❤️ 👏 👍 😂 🔥 😮`. Reject anything else.
- `listMessages` — extend query with `LEFT JOIN LATERAL` to aggregate reactions as `jsonb` per message, returned as `reactions: { emoji_type: [userId, ...] }`

**Routes** (`routes/dm.ts`)
- `POST /dm/messages/:id/reactions` body `{ emoji: 'heart'|'clap'|... }`
- `DELETE /dm/messages/:id/reactions/:emoji`

**Socket events** (`dm-handlers.ts` extend; broadcast on REST success too)
- `dm:reaction_added` { messageId, userId, emoji, conversationId }
- `dm:reaction_removed` { messageId, userId, emoji, conversationId }
- Fan-out to both participants of conversation

**Tests** (`__tests__/services/dm/phaseE-dm-reactions.test.ts`)
- Add reaction → row exists
- Same user same emoji twice → idempotent (no error, no duplicate)
- Same user different emoji → both rows
- Different users same emoji → both rows
- Non-participant cannot add → AUTH_FORBIDDEN
- Invalid emoji rejected → VALIDATION_ERROR
- Remove reaction → row gone
- Cascade: delete message → reactions gone (FK ON DELETE CASCADE)

### Client

**`MessagesPage.tsx`**
- DmMessage interface adds `reactions?: Record<string, string[]>`
- Hover on desktop / long-press on mobile → 6-emoji picker (❤️ 👏 👍 😂 🔥 😮)
- Reaction count pills under each bubble; tap own to toggle off, tap others' to add yours
- Listen to `dm:reaction_added` / `dm:reaction_removed` → invalidate `['dm-messages', activeId]` query

### Migration apply
Migration is additive only (CREATE TABLE + index). Apply via the project's migration runner (or direct on Neon if no runner). Will verify mechanism in-flight.

---

## Phase ordering

A → push → verify CI → B → push → verify CI → C → push → verify CI → final report.

Each phase is independently revertable. Phase A and B touch only `MessagesPage.tsx`. Phase C adds server surface but doesn't modify any existing endpoint.

## Forward-architecture compatibility

- Reactions table is normalised, indexed, no hot-path implications.
- Survives Phase 2 (Redis), Phase 3 (state machine), Phase 4 (100K) — purely persistent state, no in-memory.
- No N+1: `LEFT JOIN LATERAL` aggregates reactions in a single round-trip.
- Auth on every endpoint via existing `authenticate` middleware + conversation-participant check.
- Input validation: emoji allow-list rejects arbitrary strings.
