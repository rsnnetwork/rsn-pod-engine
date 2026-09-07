# Stefan's REASON test review, 7 Sept 2026 — assessment and plan

Source: `Desktop/RSN/assets/RSN_Review-7thSept.docx` (13 items). Workspace `RSN-loop`,
branch `overhaul-truthful-loop`, main = staging = HEAD = `f596582` at assessment time.
Evidence below comes from the prod DB (read-only queries), Render request logs for
12:10–12:56 UTC, Sentry (0 unresolved issues in 24h on both projects), five read-only
code audits, and one headed Playwright reproduction against production.

## What actually happened during Stefan's test (evidence)

Stefan's account was reset before his run, so his Mac still held an access + refresh
pair from a session older than 7 days. Timeline (UTC):

| Time | Event | Evidence |
|---|---|---|
| 12:10:42 | Opens app: `GET /auth/session` 401 Token expired, `POST /auth/refresh` 401 "Invalid refresh token" | Render log |
| 12:11:20 | Admin approves join request, 7-day one-click link minted | `magic_links` |
| 12:11:50 | Clicks it: token consumed, user + refresh token created, but lands on `/login` | `magic_links.used_at`, `refresh_tokens`, log 401s at 12:11:50 |
| 12:12:04 → 12:12:21 | Requests a fresh link, logs in (session 2) | `magic_links` |
| 12:14:41 | Onboarding confirm creates 3 agents (1 active + 2 paused) | `matching_agents` |
| 12:24:50, 12:25:21 | Proactive refresh timers fire exactly 2 min before expiry, all 401 "Invalid refresh token" | Render log (3 calls = 3 tabs) |
| 12:27:21 | Access token expires. From here every call 401s but the UI stays up | log: `/notifications` 401, `/dm/conversations` 401 at 12:29 |
| 12:29:02–13 | Ali accepts Stefan's request and sends "hii"; bell row created for Stefan | `notifications` (is_read = true) |
| 12:31:50 → 12:32:03 | Stefan logs in again (session 3), same failure pattern | `magic_links`, `refresh_tokens` never rotate |
| 12:34:55 | Stefan confirms a meeting with Ali, "Wed 9 Sep, afternoon" | `notifications` |
| 12:47–12:49 | Session 3 dies the same way; 4th login at 12:49:33 | log, `magic_links` |
| 12:49:38 → 14:30 | 4th session rotates every 13 min normally (only one tab open) | `refresh_tokens` chain |
| after 12:35 | Ali's test account `alihammza143@gmail.com` deleted; the Ali↔Stefan conversation, messages and confirmed meeting went with it | user row gone, no audit row, `notifications` still point at conversation `bb05f873` |

Same signature seen for Gill at 08:33 today (pair never rotated, re-login at 10:37).

### Headed reproduction (prod, throwaway user, 14:43 UTC)

Stale expired pair seeded in localStorage, tab A on `/login`, tab B opens a real magic
link. Server issues access `9772…` + refresh `e9c2…`. Afterwards BOTH tabs hold
access `9772…` (new) and refresh `f4db…` (the STALE one). Every refresh call sends the
stale token, gets 401, and both tabs end on `/login`. Deterministic on the first run.
Script: `e2e/tmp-auth-repro.mjs` (becomes the new spec).

## Root causes

### R1. Cross-tab login pickup writes the old refresh token back (bugs: sign-in link, logout)

`authStore.ts:218-223` (storage listener) and `LoginPage.tsx:45-63` react to the
`rsn_access` storage event by reading `rsn_refresh` and calling `setTokens(access, refresh)`,
which WRITES both keys back. `verify()` writes `rsn_access` (line 89) before `rsn_refresh`
(line 90). The other tab observes the access write before the refresh write is visible,
reads the stale refresh, and writes it over the fresh one. `refreshAccessToken` reads
localStorage first (`:149`), so every tab, including the one that logged in, now refreshes
with a dead token → 401 "Invalid refresh token" (jwt expired, thrown before the DB lookup,
which is why `refresh_tokens` rows never rotate).

Amplifiers:
- `App.tsx:87` boot `checkSession()` runs concurrently with `VerifyPage.verify()`; its
  failure path (`authStore.ts:128`) nulls `user` after verify succeeded → `ProtectedRoute`
  bounces to `/welcome` → `/login`. This is the "first click did not work".
- One failed refresh = hard logout, no retry, no distinction between "network" and "rejected".
- `identity.service.ts:566` inserts the refresh-token row fire-and-forget.
- `VerifyPage.tsx:52` flattens every failure into "Invalid or expired link".
- Two minters (`identity.service.ts:318`, `join-request.service.ts:468`) each burn every
  other outstanding login link for the email.
- `render.yaml` `trust proxy 1` behind Cloudflare → logs and rate-limit keys see Cloudflare
  edge IPs (`162.158.x`, `172.70.x`), so `authLimiter` (50 / 15 min) is a shared bucket.

### R2. "Ali's message never arrived"

It did: the DB has the bell row and Stefan read it. His session had silently died at
12:27:21 (R1), so `/dm/conversations` and `/notifications` were 401 while the page looked
alive. After re-login he saw the thread and confirmed a meeting in it. Independent real
delivery gaps found in the audit, to fix in the same workstream:
- `meeting-windows.service.ts:203` `confirmWindow` persists the "📅 Meeting confirmed"
  message with NO fan-out (no `dm:message`, no `entity:changed`, no bell, no email).
- `poke.service.ts:336-411` `acceptPoke` seeds the intro message with raw SQL and never
  emits `E.userDms` / `E.dmConversation` to either side.
- `dm.service.ts:264-275` clears the SENDER's soft-delete instead of the recipient's,
  contradicting the contract in the same file; a recipient who once trashed the thread
  never sees it again (and `phaseC-dm-service.test.ts:144` pins the wrong behaviour).
- `MeetingScheduler.tsx:118` invalidates `['dmMessages']`; the real key is `['dm-messages', id]`.
- `scripts/check-realtime-entities.js:120` skips every file using `useQuery<T>(` (8 files).
- Sidebar "Messages" has no unread badge; mobile bottom bar has no Messages entry at all.
- Deleting a member hard-deletes the partner's conversation history (what happened to
  Stefan's Ali thread + confirmed meeting).

### R3. Wrong agents, lost criteria

Stefan said "people who run manufacturing and service businesses with more than 20
employees". The extractor captured it well (`desiredPeople`, `desiredIndustries`
= manufacturing/service, `desiredDesignations` = founder/owner, tags incl. "20+ employees").
Then:
- `routes/onboarding.ts:505` hands the seeder only `desiredPeople + desiredRoles`; industries,
  seniority, stage, designations, restrictions, tags, company size are dropped.
- `first-agent.service.ts:104-109`: with ≥2 buckets, `want_text` becomes the bare taxonomy
  label ("business owners"); the single-bucket branch keeps the sentence. More detail → more loss.
- `matching_agents.intent` and `matching_tags` (columns exist since migration 085) are never
  written and never read.
- `MAX_FIRST_AGENTS` slice (`:106`) runs before the already-held dedupe (`:120`).
- `whyText` discarded whenever `whoText` is non-empty.
- `recomputeAgentsForUser` has no caller; no rescore on profile edits, no cron.
Stefan's DB rows today: "Specialists and analysts" (active, from a stray word), "Founders"
(paused), "Business owners" (paused); he then hand-made "manufacturing and sevice businesses"
whose `want_text` is literally "Professional networking". Commits `ecc258f`/`8d0fedd`
(shipped 13:20 UTC, after his run) fixed which bucket wins, not the criteria loss.

### R4. Keyword-only matching and search

`termOverlap` = exact token or substring containment; tokens < 3 chars dropped (`ai`, `hr`,
`vc`, `ux`); STOP list removes `business`, `company`, `service(s)`, `run`, `own`.
`offerSources` ignores `industry`, `bio`, `matching_notes`, `goals`, `reasons_to_connect`
and the whole `user_intent_profiles` row (`embedding_text` is generated and never read).
Threshold 0.45 needs a designation hit or ≥2 surviving tokens. `/users/find` is one literal
`%substring%` over 3 columns (pg_trgm installed by 088 but `similarity()` never used).
No embedding provider, no pgvector, no synonym layer exists.

### R5. UI findings (exact locations)

- About too small: `ProfileCard.tsx:90` `line-clamp-2 text-xs`; onboarding confirm row is a
  single-line `<input>` (`ChatbotOnboarding.tsx:1078`, `ConfirmRow` `:120`); `/profile` bio
  `rows={3} resize-none` (`ProfilePage.tsx:331`); onboarding side card About same size as
  every row (`:208/:235`). `/profile/:id` itself is already fixed (13 Aug).
- "Ready": no such string in the client. The host's silent `<<READY>>` token leaks when the
  model emits a variant (`READY`, `<READY>`) — `chatbot.service.ts:98` strips only the exact
  literal, and the rewrite instruction at `:127` says "keep the ready token" without the
  literal. Also the post-confirm copy is "Welcome to Reason! Your X agent is searching now."
  and lands on `/agents`; nothing tells the member REASON now understands them.
- Agent order: `agent.repo.ts:109` `ORDER BY a.created_at ASC`.
- Connection context: `notifications` rows carry no actor id (`poke.service.ts:193`); bell
  title is plain text (`NotificationBell.tsx:432`); `MeetingRequests.tsx:98` renders the
  sender name unlinked though `senderId` is on the wire; `/messages?poke=<id>` is never read.
- Conversation state: exact string is "Select a conversation to start chatting."
  (`MessagesPage.tsx:762-767`); pending requests live in a separate band; the inbox empty
  copy still says "Once you meet someone in an event…".
- Scheduling: stored payload is a daypart string only; no time, duration, timezone or
  link; `windowLabel()` formats in UTC, client `labelFor()` in local; `users.timezone` is
  never read here; the confirmation is a plain bubble.
- Calendar: hand-rolled ICS exists (`calendar.service.ts`) and Resend supports attachments,
  used only for event invites; no `ATTENDEE` lines; Google OAuth scope is login only.
- POD: a pod today is an event container; `dm_conversations` already is the relationship
  home (chat + scheduler + pinned meeting). Only "Meet" is missing. LiveKit rooms are
  session-scoped (`lobby-`/`match-` names); `RoomType.ONE_TO_ONE` caps at 2.

## Plan — workstreams in ship order (one deploy each, headed prod smoke each)

### W1 · Auth: sessions survive (P0, today)
Client
1. `authStore.ts`: write `rsn_refresh` before `rsn_access`; store the pair under one key
   (`rsn_tokens` JSON) with a legacy read path so a snapshot is always consistent.
2. Cross-tab pickup (`authStore.ts:213-245`, `LoginPage.tsx:45-63`) updates in-memory state
   only, never writes back to localStorage.
3. `refreshAccessToken`: try localStorage token, then the in-memory token if different; treat
   401 from a token older than the one we hold as "rotated elsewhere", not "dead".
4. Verify epoch: `checkSession` ignores its own failure if a `verify`/`setTokens` completed
   after it started; boot `checkSession` skipped on `/auth/verify`.
5. Refresh failure: retry with backoff on network/5xx; only a definitive 401 on the newest
   token clears the session; `ProtectedRoute` never bounces while tokens exist and no
   definitive rejection happened. `visibilitychange` triggers a refresh check on return.
6. `VerifyPage`: show `AUTH_MAGIC_LINK_USED` / `EXPIRED` / `RATE_LIMIT_EXCEEDED` distinctly
   with a "Send me a new link" button.
Server
7. `identity.service.ts:566` await the refresh-token INSERT; distinguish
   `AUTH_REFRESH_EXPIRED` / `AUTH_REFRESH_INVALID` / `AUTH_REFRESH_REVOKED` in the error
   (same 401); 30 s rotation grace returning the current pair for a just-revoked token.
8. Stop cross-invalidating login links: keep the 3 most recent live per email.
9. `trust proxy` for Cloudflare + Render (2 hops, or `CF-Connecting-IP`) so logs and
   limiters key on the real client.
Tests: unit (rotation, concurrent refresh, missing row, expired vs invalid, two minters);
new e2e `magic-link-two-tabs.spec.ts` = today's repro (stale pair, two tabs, must land on
`/`, localStorage refresh == server-issued, 20 s access token refreshes without logout).
Acceptance: Stefan-shaped run (stale tokens, two tabs, link click) lands in the app first
time and stays signed in across a forced expiry.

### W2 · Messaging delivery (P0, today)
1. `confirmWindow` and `acceptPoke` go through `broadcastDmMessage` / emit `E.userDms` +
   `E.dmConversation` to both sides.
2. `insertDirectMessage` clears the RECIPIENT's soft-delete (copy `acceptPoke`'s both-sides
   pattern); invert the pinned test.
3. `MeetingScheduler` query key + `meta.entities`; widen the realtime guard regex.
4. Unread badge on sidebar "Messages"; add Messages to the mobile bottom bar (5 → swap
   Invite into the menu or make it 5 with Messages; decide in W7 naming).
5. Member deletion: soft-delete / anonymise instead of cascading partners' history
   (reset script and admin delete both). Ali's account reset mid-test is what erased
   Stefan's thread; the product must not do that to real members.
Tests: `phaseD-dm-realtime` cases for confirm/accept fan-out; `intro-scheduling.spec` gains
a live partner browser asserting the bubble appears without reload.

### W3 · Agents that carry the whole request (P1)
1. `routes/onboarding.ts:505` passes the full extracted intent to `createFirstAgents`.
2. `first-agent.service.ts`: `want_text` = the member's sentence plus qualifiers
   (industries, stage, seniority, company size); label = human summary ("Owners of
   manufacturing & service businesses, 20+ employees"); write the structured slice into
   `matching_agents.intent` and tags into `matching_tags`; cap after dedupe; keep `whyText`.
3. Extractor prompt rules for `desiredIndustries` / `desiredSeniority` / `desiredStage` and
   a new `desiredCompanySize` / `desiredCompanyTypes`.
4. Agent list newest first (`agent.repo.ts:109`, active first then newest).
5. Wire `recomputeAgentsForUser` on profile save; nightly rescore sweep.
6. Re-seed Stefan's agents from his stored intent (script, exact user id).
Tests: `first-agent.test.ts` with Stefan's sentence as the fixture; `want-precision` stays
green; e2e `first-agent.spec` asserts the qualifiers survive.

### W4 · Matching recall (P1)
1. `offerSources` adds `industry`, `bio`/`matching_notes`, `location`, `goals`,
   `reasons_to_connect`, `user_intent_profiles.matching_tags` + `embedding_text`.
2. Tokeniser: 2-char allowlist (`ai hr vc ux pm ml`), bigram pass so "service business"
   survives STOP; threshold re-tuned against the precision fixtures.
3. Synonym expansion at agent-write time: one Haiku call turns the agent criteria into a
   canonical `ALSO_MATCHES` list stored in `matching_tags` (cost per agent created, not per
   score), with a static synonym map as the no-credit fallback. Scoring stays pure JS.
4. `/users/find`: split on whitespace, AND per token across name/title/company/industry/
   bio, plus `similarity()` OR-branch using the existing trigram indexes.
5. Route 2 (Voyage embeddings + pgvector on `embedding_text`) only if recall is still short
   after 1–4; needs a new key and migration. Decision item.
Tests: recall fixtures (Stefan → the 22 owner/founder/manufacturing members that should
match); `search.spec` word-order + multi-word cases.

### W5 · UI batch from the review (P1)
1. About: `ProfileCard` no clamp / `text-sm`; confirm row → textarea; `/profile` bio rows 6,
   resizable; onboarding side card gives About its own block.
2. Onboarding end: tolerant READY detection + global strip + client sanitiser; rewrite
   instruction interpolates the literal; new end state copy "REASON now understands you.
   We're already searching for {who}." on the confirm card, toast and `/agents` landing.
3. Connection context (Ali 7 Sep: must-have): a meeting request SHOWS the sender's profile
   card. `notifications.actor_user_id` (migration 092) populated for poke / poke_accepted /
   direct_message; the bell entry renders the sender's name as a link to `/profile/:id` and
   expands to a compact card (avatar, role, company, reason) using the existing
   `ProfileCard`; `MeetingRequests` band shows the same card with name + avatar linked;
   `/messages?poke=` scrolls to and highlights that request. The recipient can read who the
   person is from the bell, from the request, and by clicking the name, before accepting.
4. Conversation state: right pane shows the pending request ("Accept to start chatting") or
   "waiting for X to accept"; inbox empty copy rewritten; sender gets an "awaiting reply"
   row (new `GET /pokes/sent`).
Tests: `profile-card`, `onboarding-journey` (no READY in any bubble), `meeting-request-bell`
(title anchors kept), `match-accept-ui`, `matching-agents` ordering.

### W6 · Scheduling with real time, timezone, duration, calendar (P2)
1. Migration: `dm_conversations.meeting_start_at timestamptz`, `meeting_duration_min`,
   `meeting_join_url`; `meeting_availability` gains optional exact slots; capture each
   member's browser timezone at login into `users.timezone`.
2. Flow: pick overlapping daypart → choose a concrete start (30/45/60 min) → confirm.
3. System message (distinct style) rendered in EACH viewer's local time with tz label, plus a
   "Add to calendar" row; bell links to the conversation.
4. Email to both with ICS attachment (extend `calendar.service` with `ATTENDEE` lines +
   `METHOD:REQUEST`) and an "Add to Google Calendar" template link (no OAuth). Full Google
   Calendar OAuth is a decision item.
Tests: `meeting-windows.test` for tz rendering; `event-schedule-timezone` pattern;
`intro-scheduling.spec` end-to-end incl. email row.

### W7 · POD: the relationship home + Meet Now — PARKED (Ali 7 Sep: "needs to be discussed")
No relabel, no data-model change, no Meet Now until Ali and Stefan have talked it through.
The assessment stays here so that conversation starts from the facts:
1. `dm_conversations` already IS the relationship home (chat + scheduler + pinned meeting).
   Relabel `/messages` → "PODs" would force renaming `/pods` ("Groups"); routes unchanged.
2. `POST /api/dm/conversations/:id/call-token`: participant + block checks, room
   `dm-<conversationId>`, `RoomType.ONE_TO_ONE`, LiveKit empty-timeout cleanup; outside
   the webhook regex by design; no `ROOM_EVICTION_ENABLED` involvement.
3. `PodCallRoom` (~120 lines) copied from `VideoRoom.tsx:652-679` without the 14 session
   store selectors, `useParams`, timer, presence; audio-only toggle; "Meet Now" next to
   "Find a time to meet" and in the mobile "More actions" menu; system message on call start;
   confirmed meetings get "Join call" pointing at the same room (feeds W6 `meeting_join_url`).
4. Later, only if PODs must grow past two people: real `pods` rows per connection, with the
   `effective-role.service.ts` pod_admin exclusion budgeted properly.
Tests: token endpoint unit (403 non-participant, blocked), headed two-browser call smoke
at 390px and 1280px, `ux-1` live-event regression untouched.

### Hygiene found on the way (fold into the nearest workstream)
- `refresh_tokens` / `magic_links` never pruned (W1 cleanup job).
- E2E never drives the real login (W1 spec fixes that).
- `authLimiter` keyed by IP only (W1 item 9).
- `check-realtime-entities.js` regex hole (W2).

## Order and timing
Today: W1 → W2 (each: fix, unit, headed prod smoke, ship via staging CI → main, /checkhole).
Then W5 (profile card on requests, agent order, READY strip, About sizes) with W3. Then W4,
then W6. W7 waits for the Ali/Stefan discussion.
Stefan's next run should happen after W1+W2+W3+W5 are live.

## Out of scope / deferred
Vector embeddings (W4 route 2) unless recall still fails; real `pods` rows per
connection; Google Calendar OAuth; group PODs; Meet Now / POD relabel (W7, parked).

## Decisions (Ali, 7 Sep 2026)
1. The `alihammza143@gmail.com` reset after 12:34 UTC was Ali's own (test hygiene). No
   product deletion path was involved; the soft-delete-members item stays in W2.
2. W4: structured criteria + Haiku expansion at agent creation. No new vendor. Embeddings
   only if recall is still short afterwards.
3. W7: not now. POD naming and Meet Now need a discussion first. What IS required now: a
   meeting request shows the sender's profile card, and the profile is reachable from the
   notification bell and by clicking the name (moved into W5 item 3 as a must-have).
4. W6: ICS email with attendees + "Add to Google Calendar" link. No OAuth.
