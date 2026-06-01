# RSN Component Map (QA — Phase 1)

**Living document.** Two-level map: every functional component, the specific testable actions/links inside it, and the code that owns each. This is the map testing logs against and the foundation for the Dependency Map and Issue Register.

- **Last updated:** 2026-05-30
- **Granularity:** component → key actions (per Lorin's note — each component broken into its specific links/controls/actions a tester would exercise).
- **Owning files** are grounded in a read-only audit of the current tree. Client paths are under `client/src/`, server under `server/src/`.
- **Flags** mark actions that are stubbed, unreachable from the UI, or otherwise notable for a tester.

Legend: `→` traces a user action to the API route / socket event / handler that serves it.

---

## A. Public account surfaces

### A1. Authentication & onboarding
Owners: `features/auth/{LoginPage,VerifyPage,RequestToJoinPage}.tsx`, `features/onboarding/OnboardingPage.tsx`, `stores/authStore.ts`, `lib/api.ts` · server `routes/auth.ts`, `routes/join-requests.ts`, `services/identity/identity.service.ts`

- Sign in via magic link — submit email (`authStore.login` → `POST /auth/magic-link`, rate-limited; dev shows `devLink`)
- Verify magic link — consume `?token=` (`authStore.verify` → `POST /auth/verify`, stores access/refresh)
- Sign in with Google (OAuth) — `GET /auth/google` → callback → `/auth/verify?accessToken&refreshToken` (returns 501 if `googleClientId` unset; surfaces `google_auth_failed`, `REGISTRATION_BLOCKED`)
- Request to join (invite-only signup) — form (name/email/LinkedIn/reason) → `POST /join-requests`
- Invite-code flow — `inviteCode` from URL carried through magic-link/Google, post-verify redirect to `/invite/:code`
- Logout — `authStore.logout` → `POST /auth/logout` (revokes current refresh token only; other tabs stay logged in)
- Session check / refresh — `GET /auth/session` on load; `POST /auth/refresh` (mutex + proactive ~2 min pre-expiry; 401 → refresh-then-retry)
- Cross-tab auth sync — `storage` events propagate login/logout across tabs
- Onboarding wizard (3 steps) — Step 1 About You, Step 2 Goals + meeting prefs, Step 3 reasons-to-connect + interests; per-step required-field validation → `PUT /users/me` then `POST /auth/onboarding/complete` (server re-validates)

> **Flag:** No password and no password-reset flow exists — the magic link *is* the verification. Don't test for them.

### A2. Profile
Owners: `features/profile/ProfilePage.tsx` (own, editable), `features/profile/PublicProfilePage.tsx` (others, read-only) · server `routes/users.ts`

- Edit & save profile — full form (name, bio, company, title, industry, location, timezone, phone, LinkedIn, free-text intent fields) → `PUT /users/me` (Save disabled until dirty)
- Tag editing — interests, reasons-to-connect, languages via TagInput chips → saved with profile
- Avatar upload — file picker (JPG/PNG/WebP ≤5MB), read as base64 → `PUT /users/me { avatarUrl }` (no dedicated upload endpoint; test type/size validation toasts)
- LinkedIn normalization — username or full URL accepted, normalized client-side before save
- Email read-only — displayed disabled, cannot change
- View another user's public profile — `GET /users/:id` (Message button here belongs to DM, see C3)

### A3. Home / dashboard
Owners: `features/home/HomePage.tsx` · server `routes/pods.ts`, `routes/sessions.ts`, `routes/invites.ts`

- Load dashboard — parallel `GET /pods`, `GET /sessions`, `GET /invites`, `GET /invites/received`
- Pending-invites banner — shows when received-invites non-empty → `/invites`
- Stat cards — My Pods → `/pods`, Invites Created → `/invites`, Upcoming Events → `/sessions` (Unlock Level is client-computed display, not a control)
- Quick actions — Create Pod → `/pods?create=true`; Send Invite → `/invites`; View Events → `/sessions`
- Getting-Started checklist — three nav buttons; checkmarks derived from user/pods/invites state

### A4. Billing
Owners: `features/billing/BillingPage.tsx` · server: none

> **Flag — STUBBED / NON-FUNCTIONAL.** Static Starter vs Pro cards. "Upgrade" has no handler/API; "Current Plan" disabled; explicit "billing not yet active, Stripe coming soon" notice. No server routes. Test only the disabled/no-op state and the notice.

### A5. Settings
Owners: `features/settings/SettingsPage.tsx` · server `routes/users.ts` (`PUT /users/me`), `routes/notification-prefs.ts`

- Account notification toggles (email, event reminders, match) — staged locally, persisted on "Save Settings" → `PUT /users/me`
- Privacy toggles (profile visibility, opt out of public event invites) — same Save → `PUT /users/me`
- Messaging notifications, per-channel (dm/poke/group/invite/report_resolved, each Bell + Email) — saves immediately on toggle → `PUT /notification-prefs` (loads via `GET /notification-prefs`; independent of the Save button)
- Account info (email, role) — read-only display
- Billing & Subscription section — same stubbed cards as A4

---

## B. Connection surfaces

### B1. Invites & join-requests
Owners (invites): `features/invites/{InvitesPage,CreateInviteModal,InviteAcceptPage}.tsx` · server `routes/invites.ts`, `services/invite/{invite.service,connected-users}.ts`
Owners (join-requests): `features/auth/RequestToJoinPage.tsx`, `features/admin/{AdminJoinRequestsPage,AdminJoinRequestActionPage}.tsx` · server `routes/join-requests.ts`, `routes/admin-actions.ts`, `services/join-request/*`

Invites:
- Create shareable link (multi-use, max uses) → `POST /api/invites`
- Send invite to email (single-use) → `POST /api/invites` (with `inviteeEmail`)
- Bulk-invite platform users (search connected users, Select All) → loops `POST /api/invites`; search `GET /api/users/connected?q=` (gated to people met in a prior event)
- Copy invite link — clipboard, builds `/invite/{code}`
- Revoke invite → `DELETE /api/invites/:id`
- Filter sent invites (all/pending/accepted/declined) — client-side over `GET /api/invites`
- View received invites → `GET /api/invites/received`
- Accept received invite → `POST /api/invites/:code/accept` (registers participant in same txn, returns `redirectTo`)
- Decline received invite → `POST /api/invites/:code/decline`
- Invite-link landing (logged-out → login redirect; logged-in → Accept) → `GET /api/invites/:code`
- Error states — expired / revoked / already-used / event-ended / invalid token (`InviteAcceptPage`)

> **Flag:** Host reminder routes `POST /api/invites/:id/remind` and `/remind-all/:sessionId` exist but have **no client caller** — unreachable from the invites UI today.

Join-requests:
- Submit request to join → `POST /api/join-requests`
- List/filter requests (pending/approved/declined/all, paginated) → `GET /api/join-requests?status=&page=`
- Approve / decline (single, with notes) → `PATCH /api/join-requests/:id/review`
- Bulk approve / decline → `POST /api/admin/join-requests/bulk-action`
- Poke (signup reminder, 24h cooldown) → `POST /api/join-requests/:id/poke`; bulk → `/bulk-poke`
- Send email message to applicant → `POST /api/join-requests/:id/message`
- Save internal admin note → `POST /api/join-requests/:id/note`
- Email one-click approve/reject (peek then confirm; expired/invalid/already-processed states) → `GET /api/admin/join-request-action/:token` then `POST /.../confirm`

### B2. Notifications
Owners: `components/ui/NotificationBell.tsx` (prefs UI inside `features/settings/SettingsPage.tsx`) · server `routes/notifications.ts`, `routes/notification-prefs.ts`

- Receive notification — real-time socket `notification:new`; 30s polling fallback `GET /api/notifications`
- Open bell / view list + unread badge → `GET /api/notifications` (returns list + `unreadCount`)
- Mark one read → `POST /api/notifications/:id/read`
- Mark all read → `POST /api/notifications/read-all`
- Click-through navigation (session/pod/link; pending-invite → invite)
- Inline Accept / Decline pending-invite notification → reuses `POST /api/invites/:code/accept|decline`
- Notification prefs toggles (per-channel Bell + Email) → `PUT /api/notification-prefs`

> **Flag:** `DELETE /api/notifications/` exists but has **no client caller** (no delete-notification control).

### B3. Direct messages (DM)
Owners: `features/messages/MessagesPage.tsx`, entry points `features/profile/PublicProfilePage.tsx` + `components/ui/ChatQuickAccess.tsx` · server `routes/dm.ts`, `services/dm/dm.service.ts`, socket handlers in `orchestration.service.ts`

- Open inbox / conversation list (recency-sorted, unread counts) → `GET /api/dm/conversations`
- Open thread → `GET /api/dm/conversations/:id/messages`
- Send message → `POST /api/dm/messages` (real-time `dm:message`)
- Start DM from profile (gated — unlocks only after sharing a room) → `GET /api/dm/can-message/:userId` then `POST /api/dm/messages` (button disabled when not allowed)
- Mark thread read / read receipts → socket `dm:read` (fallback `POST /api/dm/conversations/:id/read`); `dm:read_receipt`
- React / unreact (6-emoji) → socket `dm:react`/`dm:unreact` (REST equivalents exist)
- Emoji picker in composer — client-only
- Delete conversation (own-view only) → `DELETE /api/dm/conversations/:id`
- Unread count badge → `GET /api/dm/unread-count`

> **Flag:** User-to-user **Pokes are server-only** (`routes/pokes.ts`, `services/poke`) with no client wiring. The only "Poke" in the UI is the unrelated join-request signup reminder.

---

## C. Live-event core

> Phase router: `features/live/LiveSessionPage.tsx` renders Lobby → VideoRoom → RatingPrompt → SessionComplete by `sessionStore.phase`. Socket glue: `hooks/useSessionSocket.ts`. Server registrations: `services/orchestration/orchestration.service.ts` (`wrapHandler`/`socket.on`).

### C1. Main networking room / lobby
Owners: `features/live/Lobby.tsx` (`LobbyMosaic`, `LobbyMediaControls`, `LobbyStatusOverlay`), shell in `LiveSessionPage.tsx` · server `handlers/participant-flow.ts`, `handlers/host-actions.ts`, `video/livekit.provider.ts`

- Join event / waiting-room state → `session:join` (`handleJoinSession`); LiveKit token via `lobby:token`
- Mic toggle / camera toggle — local LiveKit (`setMicrophoneEnabled`/`setCameraEnabled`); non-hosts auto-muted on join, prefs in `sessionStorage` (no server event)
- Background / blur (presets + custom upload) — `hooks/useBackgroundEffects.ts`, gated by `bg.supported` (client-only)
- Layout density (compact / normal / spacious) — `sessionStore.lobbyDensity` (client render)
- Pin participant (spotlight) — participant: local `pinnedSid`; host: `host:set_pin` → fans out `pin:changed`
- See participant list / count — drawer `ParticipantList.tsx`; live count from LiveKit room (`LiveKitPresenceSync` → `useInRoomParticipants`)
- Host-only on tiles — mute one (`host:mute_participant`), mute all (`host:mute_all`), remove/kick (`host:remove_participant`), shrink/restore cohost tile (`host:set_tile_size`)
- Leave event → `session:leave` (`handleLeaveSession`) then `disconnectSocket()`
- Host visibility modes (big_speaker/producer/hidden) → `host:visibility_changed`

### C2. Matching & round flow
Owners: `features/live/MatchingOverlay.tsx`, host surface `HostControls.tsx` + `HostRoundDashboard.tsx`, transitions in `useSessionSocket.ts` · server `handlers/matching-flow.ts`, `handlers/round-lifecycle.ts`, `handlers/timer-manager.ts`, `services/matching/{matching.service,matching.engine}.ts`

- Start event → `host:start_session` (`handleHostStart`) → `session:status_changed` (lobby_open)
- Generate matches (preview) → `host:generate_matches` → host `host:match_preview`; participants `session:matching_preparing`/`_in_progress`
- Adjust preview — swap pair `host:swap_match`, exclude `host:exclude_participant`, regenerate `host:regenerate_matches`, cancel `host:cancel_preview`
- Confirm matches → `host:confirm_matches`/`host:confirm_round` → `session:matches_confirmed`; participants see "You've been matched!" overlay
- Start round → `host:start_round` (`round-lifecycle.ts`) → `session:round_started` + per-user `match:assigned` (phase `matched`)
- Round timer countdown / warning → server `timer:sync` (`timer-manager.ts`); rendered in `VideoRoom.tsx` (amber ≤30s, red pulse ≤10s); visibility thresholds honored
- Extend round (+120s) → `host:extend_round`
- Bye / sit-out round → `match:bye_round` → "Sitting this one out"
- Round end transition → timer expiry or end → `session:round_ended` then `rating:window_open` per user
- Another / bonus rounds → re-run confirm/start; `bonusRoundsAdded` shows a "Bonus" badge

### C3. Breakout / conversation room
Owners: `features/live/VideoRoom.tsx` (`VideoStage`, `VideoTile`, `MediaControls`, `PartnerLeftAutoReturn`, `ReconnectOnReturn`) · server `handlers/participant-flow.ts`, `handlers/breakout-bulk.ts`, `video/livekit.provider.ts`, token via `routes/sessions.ts` (`POST /sessions/:id/token`)

- Enter conversation → `match:assigned` (phase `matched`); on connect emits `presence:room_joined`
- See partner video / self PIP / trio grid — `VideoStage` (pair vs trio layouts)
- Waiting-for-partner state — `VideoTile isWaiting` ("Waiting for partner...") when no remote track yet
- Partner left → `match:partner_disconnected` → `PartnerLeftAutoReturn` 5s auto-return; reconnect `match:partner_reconnected`
- Mic / camera / background in breakout — `MediaControls` + `BackgroundPanel.tsx` (client/LiveKit only)
- Pin a tile in breakout — local `pinnedSid` (client-only here)
- Return to main room (keeps event) → `participant:leave_conversation` → `match:return_to_lobby` (phase `lobby`)
- Leave event entirely (from breakout) → `session:leave` + `disconnectSocket()`
- Tab-suspend recovery — `ReconnectOnReturn` forces LiveKit remount
- Host bulk breakout controls — create `host:create_breakout_bulk`, extend-all `host:extend_breakout_all`, end-all `host:end_breakout_all`, set duration `host:set_breakout_duration_all`, single-room `host:move_to_room`/`host:remove_from_room`/`host:reassign`

### C4. Rating
Owners: `features/live/RatingPrompt.tsx` (`PartnerRatingForm`, `RatingConfirmation`) · server `services/rating/rating.service.ts`, `routes/ratings.ts` (`POST /ratings`), socket `rating:submit`/`rating:skip`

- Enter rating → `rating:window_open` (or `session:round_ended`) sets phase `rating`
- Rate partner (1–5 stars) — required before submit
- "Would meet again" toggle — `meetAgain` flag
- Submit → `POST /ratings` over **REST** (409/already-rated treated as success)
- Multi-partner / group (trio) rating — `currentPartners` array, progress dots, per-partner advance
- Skip → emits `rating:skip` (suppresses re-prompt on replay) then advances
- De-dupe guards — `ratedMatchIds`/`lastRatedRound` suppress re-prompts during re-match churn
- After all rated → phase back to `lobby` (or `complete` if event ended)

> **Flag:** Rating submit is REST-only from the UI; the `rating:submit` socket handler is registered but unused by the form.

---

## D. Host + chat

### D1. In-event chat
Owners: `features/live/ChatPanel.tsx`, toggle/badge in `LiveSessionPage.tsx`, listeners in `useSessionSocket.ts` · server `handlers/chat-handlers.ts`

- Open chat (desktop panel) / open chat (mobile toggle + unread badge) — `LiveSessionPage.tsx`
- Send message → `chat:send {sessionId, message, scope}` (`handleChatSend`); scope auto-derived (`room` when matched, else `lobby`); max 500 chars
- Scope routing — lobby messages to lobby users; room messages only to same-LiveKit-room recipients; header shows "Room"/"Everyone" pill; room chat marked temporary
- React to a message (emoji) → `chat:react` (`handleChatReact`); 3 reaction types + emoji-picker insert
- Scroll / load history → `chat:request_history` reply on `chat:history`; live on `chat:message`
- Click a participant name — renders `<a href="/profile/{userId}">` (link only)
- Gating — in lobby, input disabled ("Chat available when host joins") unless host/co-host present (enforced client- AND server-side); input hidden when phase complete

### D2. Host control center
Owners: `features/live/HostControls.tsx` (bottom bar), `features/live/HostControlCenter.tsx` (drawer) · server `handlers/host-actions.ts`, `breakout-bulk.ts`, `host-participants-view.ts`, `matching-flow.ts`; REST `routes/host.ts`

Bottom bar:
- Start event → `host:start_session` (REST `POST /:id/host/start`)
- Match People → preview → Confirm → Start Round → `host:generate_matches`/`confirm_matches`/`confirm_round` (+ preview ops in C2); relabels "Another Round" after configured rounds
- Pause / resume timer → `host:pause_session`/`host:resume_session` (during active round)
- +2 min → `host:extend_round`; End round early → `host:end_session` (no endEvent); End event → `host:end_session {endEvent:true}`
- Create breakout rooms (unified modal, N≥1) → `host:create_breakout_bulk`; bulk extend/end/set-duration
- Broadcast / announcement → `host:broadcast_message`
- Invite people (copy link) — client-only

Per-row (HostControlCenter, fed by `host-participants-view.ts`):
- Re-match a person → `host:reassign`; Move to a room → `host:move_to_room`; Kick → `host:remove_participant`; Extend one room → `host:extend_breakout_room`
- Set host/co-host visibility (big_speaker/normal/producer/hidden) → REST `POST /:id/host/visibility`; set co-host tile size (director-only) → `host:set_tile_size`
- Join as host / Join as participant (self-toggle) → REST `POST /:id/host/acting-as-host` (director permanently host; endpoint refuses their self-toggle)
- Filter chips (All / In main room / In a room / Disconnected / Left) — client-side

> **Flag:** Mute participant / mute all (`host:mute_participant`/`host:mute_all`) have server handlers but **no client control** wiring them — unreachable from the host UI. Also `host:mute_*` and `host:broadcast_message` are registered raw (not via `wrapHandler`), so their role guard is inside the handler — worth a targeted permission test.

### D3. Co-host management
Owners: `features/live/HostControlCenter.tsx` (row actions), listeners in `useSessionSocket.ts` · server `handlers/host-actions.ts` (`handleAssignCohost`, `handleRemoveCohost`, `handlePromoteCohost`), `services/roles/effective-role.service.ts`

- Assign co-host (in-event) — "Make co-host" → `host:assign_cohost` (confirmed via `cohost:assigned`)
- Remove co-host → `host:remove_cohost` (`cohost:removed`)
- Promote co-host (hand off host) → `host:promote_cohost` (event wired; verify the trigger button)
- Host-initiated promote/demote of another user's acting-as-host → REST `POST /:id/host/acting-as-host-for/:userId`
- Co-host permissions — `effective-role.service.ts` (rank cohost=2; can run rounds/breakouts/broadcast, excluded from matching; cannot end session or change config). Plain `admin` is NOT auto-host — must be promoted or opt in.
- Gating — Make/Remove co-host + Kick disabled when target is admin/super_admin and caller isn't the director (mirrored server-side)

> **Flag:** Co-host management is **in-event only** — there is no pre-event co-host assignment route (`admin-actions.ts` has none; the live Control Center button is gated behind event-started). This is the root of the 27 May "can't make co-host before event" report.

---

## E. Internal / admin

> All admin endpoints gated by `requireRole(ADMIN)` unless noted; client gates render with `isAdmin(user?.role)`.

### E1. User management
Owners: `features/admin/AdminUsersPage.tsx` · server `routes/users.ts`, `routes/admin.ts`, `services/identity`

- List / search / filter users (Active/Removed/Banned tabs, role filter, paginated) → `GET /users` (admin-gated)
- Change role (per-row + bulk) → `PUT /users/:id/role` (assigning admin/super_admin is **super_admin only**)
- Suspend / ban / remove / reactivate → `PUT /users/:id/status`
- Permanently delete → `DELETE /users/:id` (**super_admin only**)
- Edit entitlements/limits (max pods, sessions/mo, invites/day, canHost, canCreatePods) → `GET`/`PUT /admin/users/:id/entitlements`
- Bulk action (suspend/ban/activate/change_role) → `POST /admin/users/bulk-action`

### E2. Event & session moderation
Owners: `features/admin/AdminSessionsPage.tsx` ("Manage Events") · server `routes/sessions.ts`

- List events (all/scheduled/completed/cancelled) → `GET /sessions?admin=true`
- Cancel event → `DELETE /sessions/:id` (authz enforced **inside** `sessionService.deleteSession` — host-or-admin; verify a non-host non-admin is rejected at the service layer)
- Permanently delete event (+ matches/ratings) → `DELETE /sessions/:id/permanent` (**super_admin only**)

> **Flag:** No create/edit-event control on the admin page (that's the host flow). "Moderate a live session / force-end" is **not** an admin-page action — live-room control is host-side.

### E3. Reports & blocks
Owners: `features/admin/AdminModerationPage.tsx` ("Moderation Queue") · server `routes/admin.ts`, `routes/reports.ts`, `services/report`, `services/block`

- List reports/violations (open/actioned/dismissed/all) → `GET /admin/violations`
- Resolve a report with action (dismiss/warn/suspend/ban + notes) → `POST /admin/violations/:id/resolve`
- Submit a violation/report (system/admin) → `POST /admin/violations/report`
- Block / unblock (self-service) → `POST /users/:id/block`, `DELETE /users/:id/block`, list `GET /users/blocked`

> **Flag:** Two report surfaces exist — the page uses `/admin/violations`, but a separate legacy `/reports/*` admin API also exists (`GET /reports/open`, `POST /reports/:id/resolve|dismiss`). Confirm which is canonical before testing. Block/unblock is **self-service** (user blocks user, no admin gate); there is no admin block-management view.

### E4. Join-request approval (admin side)
Owners: `features/admin/{AdminJoinRequestsPage,AdminJoinRequestActionPage}.tsx` · server `routes/join-requests.ts`, `routes/admin-actions.ts`, `services/join-request/*`

- List pending requests (pending/approved/declined/all, paginated) → `GET /join-requests`
- Approve / decline (review, single) → `PATCH /join-requests/:id/review`
- Bulk approve / decline → `POST /admin/join-requests/bulk-action`
- Poke / bulk-poke (24h cooldown) → `POST /join-requests/:id/poke`, `/bulk-poke`
- Message applicant → `POST /join-requests/:id/message`; save internal note → `/note`
- Email-link approve/reject (two-step token; no session) → peek `GET /admin/join-request-action/:token` (read-only, prefetch-safe) then `POST /.../confirm` (states: ready / already_processed / expired-24h / invalid)

> Other admin pages exist outside these four components: `AdminAnalyticsPage`, `AdminEmailPage`, `AdminSupportPage`, `AdminTemplatesPage`, `AdminPodsPage`, `AdminDashboardPage` — add to the map if they enter testing scope.

---

## Coverage summary

| Area | Components | Notable stubs / unreachable |
|---|---|---|
| Public account | Auth, Profile, Home, Billing, Settings | Billing stubbed; no password reset |
| Connection | Invites, Join-requests, Notifications, DM | Pokes server-only; invite-remind & notif-delete unwired |
| Live core | Lobby, Matching/round, Breakout, Rating | Rating submit REST-only; acting-as-host picker dead code |
| Host + chat | In-event chat, Host control center, Co-host | Host mute controls unwired; co-host pre-event missing |
| Admin | User mgmt, Event moderation, Reports/blocks, Join approval | Two report surfaces; no admin force-end / block view |
