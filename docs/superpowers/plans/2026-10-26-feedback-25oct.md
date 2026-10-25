# 25 Oct Product Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver all 25 items of the 25 Oct spec (onboarding, booking, pod/event formats, live video, post-event continuity) — server live on production release by release, screens on the preview — so Stefan can run Scripts A–D end to end.

**Architecture:** Server changes go to `main` as additive releases (production client keeps working), one per task S1–S9, each smoked headed on production. Screens go to `reason-m1` (preview) as tasks C1–C12 after `main` is merged in. Three small LIVE-CLIENT tasks (L1–L3) patch production's own client where Stefan saw the fault there.

**Tech Stack:** Express 4 + Socket.IO 4 + raw SQL (`pg`) + Redis, Zod, Jest; React 18 + Vite 5 + React Query + Zustand + LiveKit; Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-26-feedback-25oct-design.md` (decisions), with the evidence and audits in `workspace/audits/2026-10-26-feedback-25oct/` (`spec-25oct-transcription.md`, `walkthrough-evidence.md`, `01-…06-*.md`). Every task names the audit section that holds its file:line detail; read it before coding.

## Global Constraints

- Ledger: `.superpowers/sdd/2026-10-26-feedback-25oct/` — `global-constraints.md` there is binding for every implementer (workspace, commit kinds, never touch production, local stack, tests, report format).
- Server tasks branch from `origin/main`; client tasks branch from `reason-m1` after the controller has merged `main` in; LIVE-CLIENT tasks branch from `origin/main`.
- Additive server only: new columns with defaults, new endpoints, new optional fields. Production's client (`origin/main` `client/`) must work unchanged after every server release. `shared/` changes additive (main's client must still compile).
- Migrations: exactly the numbers in the design §5 (108–116); no `BEGIN`/`COMMIT`; idempotent (`IF NOT EXISTS`, guarded `DO` blocks); never drop a column/table; only 108 touches `notifications_type_check`.
- CLAUDE.md rules: Zod on every route; `AppError` subclasses; parameterised SQL; `transaction()` for multi-table writes; rate limit on every new route; every mutation emits entity tags (new tags in `ENTITIES.md` + both `entities.ts`); every `useQuery`/`useInfiniteQuery` declares `meta.entities`; React Query owns server data; no `console.log`, no `any` without a comment, no `@ts-ignore`.
- Words: the product is **REASON**; "event", never "session", in anything a person reads; copy given in this plan is verbatim; error toasts are human sentences.
- Responsive: 360, 390, 414, 768, 1024, 1280, 1440 widths; no horizontal scroll; tap targets ≥44px and never under a fixed bar; `env(safe-area-inset-*)` on fixed/sticky bars; loading, empty and error states on every new surface.
- Commits: one plain-English sentence saying what now happens; made as RSN Network; **never** any AI attribution.

## Review Focus

1. **Time zones and clock changes** — a meeting booked across zones and on a DST day (25 Oct 2026 was one) shows the same instant to both people, in each person's zone, in the app, the bell and the email; slots never duplicate or vanish on clock-change days. Tests: S1 (auto-confirm on 2026-10-25), S3 (email/bell wording names the zone), C3 (slot generation across both clock changes).
2. **Double and simultaneous actions** — double-click Accept/Confirm/Send/Cancel, two people saving the same slot at once, two organisers sending "message everyone", the same invitee twice in one batch: one outcome, no duplicates, the second caller told plainly. Tests: S1, S3, S6, S7, C5.
3. **Production's old client against the new server** — the old bell, scheduler, event form (posts `config.eventType`, no `format`), v1 onboarding bodies and the old message-participants call keep working. Tests: a "legacy request still accepted" case in S1, S2, S4, S6, S7.
4. **Speed networking unchanged** — an event with no or an unknown format, and a live event recovered from Redis without a format, behave exactly as today. Tests: S4 resolver + guard tests; the speed-networking e2e set in F2.
5. **Blocked, removed and closed accounts on every new read surface** — event chat history, pod wall, group chats, invite candidates, message-everyone recipients, meetings list: blocked pairs never see each other, removed members lose access, closed accounts read "Former member". Tests: S5, S6, S7, S8, S9.

---

## Phase S — server releases (branch from `origin/main`, one release each)

### Task S1: Request state is true everywhere, and agreeing a time books it (CON-02, CON-03 server) + migration 108

Audit: `02-requests-booking.md` §CON-02.2, §CON-03.2 and §CON-03.6 (server S1–S3).

**Files:**
- Create: `server/src/db/migrations/108_notification_types_oct25.sql`
- Modify: `server/src/routes/notifications.ts` (GET joins `user_pokes` for `poke` rows)
- Modify: `server/src/services/poke/poke.service.ts` (claim accept/decline, reverse close, mutual send, mark read, block/inactive checks, `listReceivedPokes` filter)
- Modify: `server/src/routes/pokes.ts` (409 mapping; emit `user:<id>:notifications` to both)
- Modify: `shared/src/types/api.ts` (`ErrorCodes.MEETING_REQUEST_ALREADY_ANSWERED`)
- Modify: `server/src/services/dm/meeting-windows.service.ts` (extract `confirmInTx`; auto-confirm; ISO in proposal text; 409 with scheduling)
- Modify: `server/src/routes/meeting.ts` (availability body: optional `durationMin` 5–240, `type` 'audio'|'video')
- Test: `server/src/__tests__/services/poke/poke.service.test.ts`, new `server/src/__tests__/routes/notifications-request-state.test.ts`, `server/src/__tests__/services/dm/meeting-windows.test.ts`, new `server/src/__tests__/db/migration-108.test.ts`
- E2E (update): `e2e/tests/meeting-request-bell.spec.ts` (close and reopen the bell), `meeting-loop.spec.ts`, `scheduler-viewport-fit.spec.ts`, `intro-scheduling.spec.ts`, `w6-exact-meeting.spec.ts`, `truthful-loop.spec.ts`, `meeting-call.spec.ts`, `meeting-call.layout.spec.ts` (single-slot setups now auto-confirm; keep a two-slot variant where the spec tests the confirm card)

**Interfaces:**
- Produces: `GET /api/notifications` rows gain `pokeStatus: 'accepted'|'declined'|null` and `requestState: { status: 'pending'|'accepted'|'declined'; conversationId: string|null } | null` (poke rows only).
- Produces: `confirmInTx(client: PoolClient, conversationId: string, actorId: string, opts: { window: string; startAt: string; durationMin: number; type: 'audio'|'video' }): Promise<ConfirmResult>` exported from `meeting-windows.service.ts` — S3 extends it to write the `meetings` row.
- Produces: `PUT …/scheduling/availability` response unchanged in shape; when it auto-confirms, the returned scheduling has `confirmed` set.

- [ ] **Step 1: Migration 108 test (fails)** — `migration-108.test.ts`: reads the file; asserts it contains `DROP CONSTRAINT IF EXISTS notifications_type_check`, every one of the 16 existing types from `099_dm_system_messages.sql:52-57`, and `meeting_reminder`, `meeting_cancelled`, `pod_post`, `pod_comment`, `pod_reply`, `pod_reaction`, `group_message`; asserts no `BEGIN;`/`COMMIT;`. Also passes `migrations-transaction-control.test.ts`.
- [ ] **Step 2: Write migration 108** (restate the full list in one `ADD CONSTRAINT … CHECK (type IN (…))`). Run the test: PASS.
- [ ] **Step 3: Claim tests (fail)** in `poke.service.test.ts`:
  - `acceptPoke twice returns 200 with the same conversationId and creates one conversation` → second call resolves `{ status: 'accepted', conversationId: <same> }`, one INSERT into `dm_conversations`.
  - `acceptPoke after decline throws ConflictError code MEETING_REQUEST_ALREADY_ANSWERED with details.status 'declined'`.
  - `declinePoke after accept throws 409 with details.status 'accepted'`.
  - `a concurrent decline whose conditional UPDATE matches no row never overwrites an accept`.
  - `accept closes the reverse pending request with no second intro or bell`.
  - `sendPoke when the recipient already asked me returns { status: 'accepted', conversationId }` (mutual = match).
  - `accept refuses when either side blocked (403) or the sender is inactive (404)`.
  - `resolving a request marks the recipient's poke notification read` (UPDATE … `link = '/messages?poke=' || $id`).
  - Keep "declinePoke still notifies nobody": the sender gets no bell or emit; the recipient's own `user:<id>:notifications` emit is allowed.
- [ ] **Step 4: Implement** claims as `UPDATE user_pokes SET status=$s, responded_at=NOW() WHERE id=$id AND recipient_id=$me AND status='pending' RETURNING *` inside `transaction()`; on no row, load and compare (same → 200 current state; opposite → `ConflictError('MEETING_REQUEST_ALREADY_ANSWERED', 'You already {accepted|declined} this request.', { status })`); side effects only when the claim won. Run: `cd server && npx jest poke` → PASS.
- [ ] **Step 5: Notifications route test (fails)** `notifications-request-state.test.ts`: a `poke` notification with link `/messages?poke=<uuid>` returns `pokeStatus` and `requestState` from `user_pokes`; a malformed link returns nulls; non-poke rows unchanged; pins the link format `^/messages\?poke=[0-9a-fA-F-]{36}$`.
- [ ] **Step 6: Implement** the LEFT JOIN in `routes/notifications.ts`. PASS.
- [ ] **Step 7: Scheduler tests (fail)** in `meeting-windows.test.ts`:
  - `a save that creates exactly one shared future slot confirms it` → `meeting_confirmed_*` set, a `meeting_confirmed` system card (not a proposal card), the partner's `meeting_confirmed` bell, two emails; default `durationMin` 30 and `type` 'video'; body `durationMin`/`type` honoured when sent.
  - `two shared slots still post one proposal card and confirm nothing` (rewrite of the existing 340-357 case to two slots).
  - `auto-confirm on 2026-10-25 (EU clock change) stores 2026-10-25T12:00:00Z` (Review Focus 1).
  - `the proposal text carries ISO instants` (no bare "12:00 UTC").
  - `confirm on a slot no longer shared throws ConflictError with the current scheduling in details`.
  - `a legacy availability body { windows } with no durationMin/type is accepted` (Review Focus 3).
- [ ] **Step 8: Implement** `confirmInTx` (extracted from `confirmWindow` 538-587), the auto-confirm branch in `setAvailability` (339-432) under the existing row lock, ISO instants in the proposal text (402), the 409 at 480-482, the optional body fields in `routes/meeting.ts` (`availabilityBodySchema`). PASS.
- [ ] **Step 9: Full checks** — `npm run build:shared`; `cd server && npx tsc --noEmit && npx jest --silent`; `cd client && npx tsc --noEmit`; `node scripts/check-realtime-entities.js`. All green.
- [ ] **Step 10: Update the e2e specs listed above** so single-slot setups expect a confirmed meeting after Save; add to `meeting-request-bell.spec.ts`: accept on the Messages card, then open the bell → "Accepted", zero Accept buttons; close/reopen after decline → "Declined".
- [ ] **Step 11: Commit** (SERVER: migration + server + shared; E2E: specs) — e.g. "A meeting request's bell entry shows whether it was accepted or declined, answering twice is safe, and a time both people pick books the meeting".

### Task S2: Onboarding server — select all, employees, LinkedIn suggestions, quieter seeding (ONB-01/02/03 server) + migration 109

Audit: `01-onboarding.md` §ONB-01.3 (server 1–6), §ONB-02.3 (option table), §ONB-03.3 (1–2, 4), §Question 5; `06-onboarding-reconciliation.md` (c) 3 (emails).

**Files:**
- Create: `server/src/db/migrations/109_onboarding_select_all.sql` — `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_looking_to_meet_max, users_self_kinds_max, users_hoping_to_find_max`; add `cardinality(...) <= 20` ceilings in guarded `DO` blocks.
- Create: `shared/src/onboarding/example-people.ts` — `EXAMPLE_PEOPLE` (used by C2 and L1).
- Modify: `shared/src/onboarding/options-v2.ts` (delete `meetMax`/`findMax`/`selfMax`; hints "Select all that apply."; new keys + labels; relabel), `shared/src/index.ts` (named re-exports)
- Modify: `server/src/services/onboarding/answers-v2.schema.ts` (`atMost` → `uniqueKeys`), `answers.schema.ts` (drop v1 max refines), `answers-v2.map.ts` (no carry caps)
- Modify: `server/src/services/matching/option-signals.ts` (new key translations; `SELF_GUESS_BY_BUCKET` remap; `selfGuessesFromText`)
- Modify: `server/src/services/onboarding/linkedin-v2.ts` (`selfGuesses`, stated roles only, `linkedin.chosen` in v2 state)
- Modify: `server/src/services/matching/first-agent.service.ts` (score first search in-request, the rest after the response, then `fanoutUserEntity`), `server/src/services/matching/platform-match.service.ts` (one newcomer bell per member)
- Modify: `server/src/services/email/email.service.ts` (lines ~663, ~712 wording; file is CRLF — keep CRLF)
- Test: `server/src/__tests__/db/migration-109.test.ts` (new), `services/onboarding/options-v2.test.ts`, `answers-v2.schema.test.ts`, `answers-v2.map.test.ts`, `services/matching/option-signals-v2.test.ts`, `services/onboarding/linkedin-v2.test.ts`, `routes/onboarding-answers.test.ts` (invert "rejects more than three"), `first-agent-v2.test.ts`, platform-match newcomer bell test

**Interfaces:**
- Produces (shared): new `MeetV2Key` values `meet_managers_leaders`, `meet_hiring`; `FindV2Key` `find_new_role`, `find_advice_learning`, `find_hire`, `find_partners`; `OfferV2Key` `offer_knowledge`, `offer_referrals`; `SelfV2Key` `self_employee` (shown 2nd), `self_manager_leader` (3rd). `ONBOARDING_V2_LIMITS` loses its maxima (keeps `min: 1`, `ceiling: 20`).
- Produces (shared): `OnboardingV2LinkedinPrefill.selfGuesses: SelfV2Key[]` (keep `selfGuess = selfGuesses[0] ?? null`); v2 state `linkedin.chosen: 'linkedin'|'email'|null`.
- Produces (shared): `EXAMPLE_PEOPLE: ReadonlyArray<{ name: string; role: string }>` = Emma Clarke (Product manager), James Hughes (Founder), Olivia Bennett (Investor), Daniel Walsh (Head of sales), Hannah Moore (Freelance designer), Thomas Reid (Engineering lead). Before commit, run a READ-ONLY lookup through the controller (not yourself) that none matches a real member's display name; the controller supplies the result in your dispatch.

- [ ] **Step 1: Failing tests** — migration-109 pin (drops the three constraints, ceilings 20, no BEGIN/COMMIT); schema: `accepts every meet/find/self option at once` (v2 draft and confirm), `still refuses duplicate keys`, `refuses 21 keys`; v1 `accepts four people to meet` (inverted case) and `still accepts the old single-intent body` (Review Focus 3); options-v2: every new label verbatim (copy below), hints `"Select all that apply."` for meet/find/self; signals: each new key's translation hits the buckets in the audit table, the found-by pairs `managers↔manager`, selfGuess `manager→self_manager_leader`, `employee|product_manager|hr|sales→self_employee`; `selfGuessesFromText('Founder & CEO | Angel investor', null)` → `['self_founder_owner','self_investor']` (use the real key names from options-v2.ts), `'Helping founders raise capital'` as headline → `[]`, inferred role ignored; map: v1 carry not cut to 3/2; first-agent: one search scored in-request, the rest scheduled; platform-match: three searches matching one newcomer → one bell.
- [ ] **Step 2: Implement** to the tests. New labels (verbatim; match the existing sentence form in `options-v2.ts`):
  - meet: "I would like to meet managers and leaders in companies and organisations." / "I would like to meet people who are hiring."
  - find: "I am looking for a new job or my next career step." / "I am looking for advice, mentoring or to learn from others." / "I am looking for people to hire." / "I am looking for partners or collaborators."
  - offer: "I can share what I know from my work." / "I can help people find jobs or refer them where I work."
  - self: "I work for a company or organisation." / "I lead a team or part of an organisation."; relabel `self_advisor_experienced` → "I am an advisor or mentor."
  - email phrase "founders, leaders, and company owners" → "professionals of every kind, from founders to employees, investors and advisors".
- [ ] **Step 3: Full checks** (build:shared, server tsc + full jest, client tsc on this branch, realtime check). Green.
- [ ] **Step 4: Commit** (SERVER).

### Task S3: Meetings become real (CON-04/05 server) + migration 110

Audit: `02-requests-booking.md` §CON-04/05.4 (design of (c): schema, writes, API, tags, notifications, reminders, email), §CON-03.3 (MeetPage token), §Risks (CallEndWatcher noted for C3).

**Files:**
- Create: `server/src/db/migrations/110_meetings.sql` (schema + backfill exactly as audit §4, **without** the notifications constraint — 108 has it)
- Create: `server/src/services/meetings/meeting.service.ts` (list, summary, get, cancel, attendance stamp), `server/src/services/meetings/meeting-reminder.worker.ts`, `server/src/routes/meetings.ts` (mounted at `/api/meetings`), `shared/src/types/meeting.ts`
- Modify: `server/src/services/dm/meeting-windows.service.ts` (`confirmInTx` and move write `meetings` + `current_meeting_id`), `server/src/services/dm/meeting-call.service.ts` (attendance on `meetings`; token refusal only when calls locked AND no unended scheduled meeting; never refuse early joins), `server/src/services/calendar/calendar.service.ts` (UID `meeting-<id>@rsn.network`, SEQUENCE, METHOD:CANCEL), `server/src/routes/meeting.ts` (in-app .ics passes the UID), `server/src/services/email/email.service.ts` (subject with time and zone; "See it in Events" link; cancellation email), `server/src/index.ts` (mount route; start the worker every 60 s beside `processPendingJobs`), `server/src/realtime/entities.ts` + `client/src/realtime/entities.ts` + `ENTITIES.md` (`E.userMeetings`, `E.meeting`)
- Test: `services/dm/meeting-windows.test.ts` (meetings row on confirm/move), new `services/meetings/meeting.service.test.ts`, new `services/meetings/meeting-reminder.worker.test.ts`, new `routes/meetings.test.ts`, `calendar.service.test.ts`, `meeting-ics-says-reason.test.ts`, `meeting-call.service.test.ts`, new `db/migration-110.test.ts`, `client/realtime-entity-tags.test.ts`

**Interfaces:**
- Produces: `GET /api/meetings?scope=upcoming|past|cancelled&limit=1..50&before=<ISO>` → `{ items: Meeting[], nextBefore: string|null }`; `GET /api/meetings/summary` → `MeetingSummary = { upcomingCount: number; liveNow: boolean; next: { id: string; startAt: string; partnerName: string } | null }`; `GET /api/meetings/:id` → `Meeting` (404 for non-participants); `POST /api/meetings/:id/cancel` → `Meeting` (already cancelled → 200; ended → 409 `MEETING_ALREADY_ENDED`).
- Produces (shared): `Meeting = { id; conversationId; partner: { userId; displayName; avatarUrl: string|null }; startAt: string; durationMin: number; kind: 'audio'|'video'; status: 'scheduled'|'cancelled'; phase: 'upcoming'|'joinable'|'live'|'ended'|'cancelled'; context: string|null; joinPath: string; attended: { me: boolean; them: boolean } }`. Phase rule: joinable from start−5 min, live from start to end, ended after end+30 min.
- Produces: tags `E.userMeetings(u)` = `user:${u}:meetings`, `E.meeting(id)` = `meeting:${id}`, emitted to both people on confirm, move, cancel, attendance, reminder.
- Consumes: `confirmInTx` (S1).

- [ ] **Step 1: Failing tests** — migration 110 pin + backfill shape; confirm writes one `meetings` row (context = accepted request's message, `request_id`) and `current_meeting_id`, in the same transaction as `meeting_*`; move updates the same row (`moved_from`, `calendar_sequence + 1`), same UID; cancel: claim (`status='scheduled'` only), clears `dm_conversations.meeting_*`, posts "Meeting cancelled" system card, `meeting_cancelled` bell to the other person ("{name} cancelled your meeting on {when}"), METHOD:CANCEL .ics to both, cancel twice → 200 (Review Focus 2); list/summary scoped to participants, phases computed; reminder worker claims with `FOR UPDATE SKIP LOCKED` once, bells both "Your meeting with {name} starts in 10 minutes", email gated by `notify_email`; email subject `Meeting confirmed: {partner} on {Sun 25 Oct, 13:00} ({zone})` in the recipient's `users.timezone` else UTC named (Review Focus 1); token: refused only when calls locked and no unended meeting; early mint allowed; attendance stamped on `meetings` and `dm_conversations`.
- [ ] **Step 2: Implement** to the tests; rate limits: reads under `apiLimiter`, cancel under a per-user write limiter (10/hour).
- [ ] **Step 3: Full checks.** Green.
- [ ] **Step 4: Commit** (SERVER).

### Task S4: Event formats and the meeting runtime (POD-01/03/05 server, VID server guards) + migration 111

Audit: `03-pods-events-config.md` §POD-05.2 (definitions/rules), §POD-03.2–3 (column, API, O1, orchestrator branches 1–10), §POD-01.3 (server), §0.3 (POST /pods emits nothing), §8 (definition sheet values); `04-live-video.md` §5.4 server 1–4, §4.2 side finding (DELETE guard), §0.1.

**Files:**
- Create: `shared/src/events/definitions.ts`, `shared/src/events/rules.ts`; Modify `shared/src/index.ts` (explicit named re-exports — the Rollup CJS pattern at `shared/src/index.ts:14-24`), `shared/src/types/session.ts` (`Session.format?: EventFormat`; `SessionConfig.durationMinutes?: number`), `shared/src/types/api.ts` (`EVENT_FORMAT_NOT_ALLOWED`, `NOT_A_ROUNDS_EVENT`)
- Create: `server/src/db/migrations/111_event_format.sql` (`event_format TEXT NOT NULL DEFAULT 'speed_networking' CHECK (… 5 values)`, index)
- Modify: `server/src/services/session/session.service.ts` (`SESSION_COLUMNS` + list columns add `event_format AS "format"`; create/update resolve, assert, normalise; mirror `config.eventType = format`; one duration helper for the LiveKit TTL; DELETE refuses live statuses unless super_admin), `server/src/routes/sessions.ts` (optional top-level `format` zod enum on POST/PUT; empty plan for meetings), `server/src/services/orchestration/handlers/host-actions.ts` (plan only for rounds; `handleHostStartRound` + breakout creates refuse for meetings), `server/src/services/orchestration/handlers/matching-flow.ts` (the seven handlers refuse for meetings via one helper), `server/src/services/orchestration/handlers/breakout-bulk.ts`, `server/src/services/orchestration/handlers/participant-flow.ts` (`maybeRepairFutureRounds` returns early for meetings), `server/src/services/orchestration/handlers/round-lifecycle.ts` (recap emails only for ratings formats; `ActiveSession.format` restored in recovery), `server/src/services/orchestration/state/session-state.ts` (`ActiveSession.format`), `server/src/services/session/session-state-snapshot.service.ts` (`format`, `live`, `durationMinutes`, `scheduledEndAt`; `totalRounds: 0` for meetings), `server/src/services/calendar/calendar.service.ts`, `server/src/services/invite/invite.service.ts`, `server/src/routes/invites.ts` (durations via `eventDurationMinutes`), `server/src/services/pod/pod.service.ts` + `server/src/routes/pods.ts` (type-derived orchestration default when omitted; `POST /pods` emits `user:<me>:pods` + `admin:pods`)
- Test: new `services/event-definitions.test.ts` (consistency), new `services/event-rules.test.ts`, new `services/orchestration/meeting-server-guards.test.ts`, new `services/session/event-format.test.ts`, new `db/migration-111.test.ts`, update `phase4-matching-policy.test.ts` only if touched, keep green: `routes.test.ts` POST/PUT sessions, `session-registration-confirmation.test.ts`, the `handleHostStart` pins (`phase-2-5-pre-event-planning`, `phase-7a…`, `phase-8a…`, `s26-start-signal-resilience` — wrap the plan block **in place**), `s19-director-only-end-event`, `pod.service.test.ts` (query count)

**Interfaces (Produces, used by L3, C7, C8):**
- `type EventFormat = 'speed_networking'|'video_meeting'|'voice_meeting'|'webinar'|'physical_event'`; `type LiveKind = 'rounds'|'meeting'|'none'`.
- `EVENT_FORMATS: Record<EventFormat, { label: string; summary: string; live: LiveKind; available: boolean; recap: 'ratings'|'attendance'; breakouts: boolean; matchingEngineId: string|null; fields: Record<string, { default?: unknown; min?: number; max?: number; adminOnly?: boolean }> }>` — values from audit 03 §8 (speed_networking: rounds 5 [1–20], roundMinutes 8 [1–60], timerVisibility 'last_10s', matchingPolicy 'within_event', matchingTemplateId adminOnly, maxParticipants 500 [2–10000]; video_meeting: durationMinutes 60 [15–240], maxParticipants 25 [2–100]; the other three `available: false`).
- `POD_TYPES: Record<PodType, { label; summary; orchestration: { default: OrchestrationMode; allowed: OrchestrationMode[] }; events: { default: EventFormat; allowed: EventFormat[] }; communication: CommunicationMode; sizeHint: number|null }>` — rows from audit 03 §8 (reason: free_form [free_form, moderated], video_meeting [video_meeting, speed_networking], video, 12; …).
- `rules.ts`: `formatRule(f: EventFormat)`, `podTypeRule(t: PodType)`, `effectiveOrchestration(pod: { podType; orchestrationMode }): OrchestrationMode`, `eventFormatsForPod(t: PodType): EventFormat[]` (available only), `defaultEventFormat(t: PodType): EventFormat`, `fieldsFor(f): string[]`, `defaultsFor(f): Record<string, unknown>`, `defaultTitle(f: EventFormat, podName: string): string` (`"{label} · {podName}"`, e.g. "Video meeting · Test"), `checkEventInput(f, input): { field: string; message: string }[]`, `normaliseConfig(f, config)`, `eventDurationMinutes(f, config): number` (equals `computeSessionDurationMinutes` for speed networking), `applyTypeChange(prev, nextType, touched: Set<string>): { values; notices: string[] }`, `applyFormatChange(prev, nextFormat, touched): { values; notices: string[]; needsConfirm: boolean }`, `resolveEventFormat(s: { format?: unknown; config?: { eventType?: unknown } | null }): EventFormat` (column, then an available `config.eventType`, else `speed_networking`; unknown → `speed_networking`), `liveKindOf(f): LiveKind`.
- API: `POST/PUT /api/sessions` accept optional `format`; `GET /api/sessions/:id` returns `format`; round actions on a meeting answer socket `error { code: 'NOT_A_ROUNDS_EVENT', message: 'This is a video meeting, so there are no rounds. Everyone stays in the main room.' }`.

- [ ] **Step 1: Failing tests** — definitions consistency (every default in its allowed list; no unavailable format as a default; every field has a default and limits; labels non-empty); rules (`resolveEventFormat({})`→speed_networking, `{config:{eventType:'video_meeting'}}`→video_meeting, `{config:{eventType:'webinar'}}`→speed_networking (not available), `{format:'video_meeting', config:{eventType:'speed_networking'}}`→video_meeting, `'nonsense'`→speed_networking; `applyTypeChange` keeps a touched still-allowed value, replaces a disallowed one with notice "Changed to Freeform: Reason pods don't use timed rounds."; `defaultTitle('video_meeting','Test')`→"Video meeting · Test"); session service (explicit `format` not allowed for the pod type → 400 `EVENT_FORMAT_NOT_ALLOWED`; omitted `format` with legacy `config.eventType:'video_meeting'` → stored `video_meeting` with no pod check (O1, Review Focus 3); speed networking defaults untouched); guards (meeting: Start skips `generateSessionSchedule`, repair returns early, each round handler emits `NOT_A_ROUNDS_EVENT`, end/complete works, no recap email; speed networking: all unchanged; recovered session without `format` → speed networking — Review Focus 4); TTL for a 90-min meeting ≥ 90 min; DELETE of a `lobby_open` event by an `admin` → 409, by super_admin allowed; `POST /pods` with `podType:'reason'` and no orchestration stores `free_form` and emits `user:<me>:pods`.
- [ ] **Step 2: Implement** to the tests. Before shipping, the controller runs a READ-ONLY count of scheduled/live sessions by `config->>'eventType'` (not you).
- [ ] **Step 3: Full checks.** Green.
- [ ] **Step 4: Commit** (SERVER).

### Task S5: Event chat is kept, and completion tells every open page (COM-02, COM-05 server) + migration 112

Audit: `05-post-event-comms.md` §2.2 (schema, write path, read paths, authorisation, retention, blocks, closed accounts, realtime), §2.3 tests, §6.3 server (`fanoutSessionCompleted`), §7 X3/X7.

**Files:**
- Create: `server/src/db/migrations/112_event_chat.sql` (tables + indexes as audit §2.2), `server/src/services/event-chat/event-chat.service.ts` (`persistEventChatMessage`, `listEventChat`, `canReadEventChat`, `toggleEventChatReaction`), `server/src/routes/event-chat.ts` (mounted at `/api/sessions`, `GET /:id/chat`, optional `DELETE /:id/chat/:messageId`), `shared/src/types/event-chat.ts`
- Modify: `server/src/services/orchestration/handlers/chat-handlers.ts` (persist before each of the 3 emits; live-only sends; per-user 10 msgs/10 s; optional `clientId` + ack; reactions in DB; `chat:request_history` membership check + DB read), `server/src/services/orchestration/handlers/participant-flow.ts` (join history from DB), `server/src/services/orchestration/state/session-state.ts` + `orchestration.service.ts` + `round-lifecycle.ts` (delete the in-memory chat Map and dead Redis chat helpers; call `fanoutSessionCompleted`), `server/src/realtime/fanout.ts` (`fanoutSessionCompleted(sessionId)` — audience includes people who already left), `CLAUDE.md` §1/§9 + `ENTITIES.md` (chat is Postgres, not Redis; `session:<id>:chat` now emitted at completion and on deletes)
- Test: new `services/event-chat/event-chat.service.test.ts`, new `routes/event-chat.test.ts`, new `db/migration-112.test.ts`, new fanout test; update `canonical-100-shipB.test.ts:235-276` (mock the insert), rewrite `phase-4-and-5-atomic-and-errors.test.ts:85-110` (pin the membership check + DB read), keep `phase0-room-assignment-server-canonical`, `phaseA-chat-room-scope` green (resolution stays in place), remove mocks in `phase4-eviction-lobby.test.ts:55-59`

**Interfaces:**
- Produces: `GET /api/sessions/:id/chat?cursor=<epochMs>_<uuid>&limit=1..100` → `EventChatPage = { messages: EventChatMessage[] /* oldest→newest within page */; nextCursor: string|null }`; `EventChatMessage = { id; senderId: string|null; senderName: string /* "Former member" when not active */; senderIsHost: boolean; scope: 'lobby'|'room'; content: string; createdAt: string; reactions: Record<string, number> }`; 403 copy "Only people who took part in this event can read its chat."
- Produces: `fanoutSessionCompleted(sessionId: string): Promise<void>` emitting `E.session`, `E.sessionParticipants`, `E.sessionChat`, `E.podSessions(podId)` and each recipient's `E.userSessions`.
- Socket payloads (`chat:message`, `chat:history`) keep their shape; `id` becomes the row UUID.

- [ ] **Step 1: Failing tests** — persist-then-emit at lobby/room/sender-only sites; insert failure → sender gets `CHAT_FAILED`, nothing broadcast; send after completion refused; 11th message in 10 s refused; `clientId` idempotent; history request from a socket not in the room and not allowed → refused (X3); REST: took part (incl. left early) reads lobby + own-audience room rows, host/co-host same, admin lobby only, registered-never-joined 403, removed 403, blocked authors filtered both ways, closed account "Former member" (Review Focus 5), keyset paging stable; a server restart mid-event loses nothing (history read from DB); `fanoutSessionCompleted` includes users already `left`.
- [ ] **Step 2: Implement.** **Step 3: Full checks.** **Step 4: Commit** (SERVER).

### Task S6: "Message all participants" v2 (COM-03 server) + migration 113

Audit: `05-post-event-comms.md` §3.1–3.6, §7 X4/X5.

**Files:**
- Create: `server/src/db/migrations/113_post_event_message_body.sql` (as audit §3.4)
- Modify: `server/src/services/post-event-message/broadcast-eligibility.ts` (v2 rule), `post-event-message.service.ts` (v2 recipients; body; no "already sent" filter for v2), `classify.ts` (no-matches → presence buckets), `post-event-message.worker.ts` (use `job.body`; skip blocked/inactive as `skipped`; emit `E.session` to the creator per batch and at finalise), `server/src/routes/post-event-message.ts` (`?v=2`; body 1–2000; status authorised to organisers/admins; limiter 10 POSTs/hour/user), `server/src/services/orchestration/handlers/dm-handlers.ts` (`broadcastDmMessage` option `bellTitle`), `server/src/services/dm/dm.service.ts` (`sendBroadcastMessage` honours blocks)
- Test: `broadcast-eligibility.test.ts` (keep v1 cases, add v2 matrix), `service.test.ts`, `classify.test.ts`, `worker.test.ts`, `routes/post-event-message.test.ts`

**Interfaces:**
- Produces: `GET …/post-event-message/eligibility?v=2` → `{ enabled: boolean; visible: boolean; reason: 'ok'|'not_ended'|'not_organiser'|'no_recipients'|'limit'|'sending'; explanation: string; audience: { tookPart: number; registeredNoShow: number }; lastSent?: { at: string; recipients: number } }`; `POST …/post-event-message` with `{ body: string; includeNoShows?: boolean }` (v2). Without `v=2` / without a body: today's v1 behaviour exactly (Review Focus 3).
- Explanations (verbatim): not ended "You can message everyone after the event ends."; no recipients "Nobody else took part in this event."; limit "You can send another message at {HH:mm}."; sending "Sending… {x} of {y}."; not organiser: `visible: false`.
- Bell title: "{name} messaged everyone from ‘{event title}’" (type stays `direct_message`).

- [ ] **Step 1: Failing tests** — v2: a member-role host who is pod director, after end → enabled; super_admin attendee is a recipient (admins included); host excluded only when the host is the sender; blocked pair → recipient row `skipped`; closed account `skipped`; 4th send in 24 h → `limit`; two organisers at once → 409 "Another organiser's message is being sent; try again in a minute." (Review Focus 2); worker sends `job.body` verbatim; classify with no matches never says "weren't able to get into the conversations"; status endpoint 403 for a plain participant; v1 unchanged.
- [ ] **Step 2: Implement. Step 3: Full checks. Step 4: Commit** (SERVER).

### Task S7: Invite candidates and batch invites (POD-02/04 server) + migration 114

Audit: `03-pods-events-config.md` §POD-02.2 (candidates, batch, declined_at, keep-for-production, realtime), §0.5 defects 7–9, 11, §POD-04.3 (co-hosts may invite).

**Files:**
- Create: `server/src/db/migrations/114_invites_declined_at.sql`, `server/src/services/invite/invite-candidates.service.ts`
- Modify: `server/src/routes/invites.ts` (`GET /candidates` **registered before** `GET /:code`; `POST /batch`; bulk skip codes `DUPLICATE_INVITE`/`POD_MEMBER_EXISTS`), `server/src/services/invite/invite.service.ts` (`pg_advisory_xact_lock(hashtext(type||target||email))` around duplicate check + insert, also for `POST /invites`; decline sets `declined_at` and keeps `status='revoked'`; list returns `declinedAt`, `inviteeUserId`; co-hosts may send event invites), `server/src/services/invite/connected-users.ts` (block filter; escaped LIKE), `server/src/services/people/connections.service.ts` (extract the "connection" signals CTE, output identical), `server/src/middleware/rateLimit.ts` (`inviteBatchLimiter` 20 batches/hour/user)
- Test: new `services/invite/invite-candidates.test.ts`, new `routes/invites-batch.test.ts`, `invite.service.test.ts`, `connected-users.test.ts`, `connections.test.ts` + `people-routes.test.ts` (output identical), new `db/migration-114.test.ts`

**Interfaces:**
- Produces: `GET /api/invites/candidates?podId=|sessionId=&source=connections|pod&q=&before=&limit=1..50` → `{ items: InviteCandidate[]; nextBefore: string|null }`; `InviteCandidate = { userId; displayName; avatarUrl: string|null; jobTitle: string|null; company: string|null; how: 'met'|'connected'|'pod'; since: string; state: 'available'|'member'|'going'|'invited'|'declined'; inviteId?: string }`. 403 when the caller may not invite to the target.
- Produces: `POST /api/invites/batch` `{ type: 'pod'|'session'; podId?; sessionId?; inviteeUserIds: uuid[1..50]; allPodMembers?: boolean }` → `{ results: { userId; outcome: 'invited'|'already_member'|'already_going'|'already_invited'|'not_allowed'|'failed'; inviteId? }[]; counts: Record<outcome, number> }`; one fan-out per target.

- [ ] **Step 1: Failing tests** — permissions mirror `createInvite` (director/host/admin; member when `allowMemberInvites`; session host/admin/co-host); states per person; blocked either way → excluded from candidates and `not_allowed` in batch (Review Focus 5); the same id twice and two parallel batches → one invite (Review Focus 2); emails never returned; decline → `declined_at`, list shows declined; legacy `POST /invites` and `/invites/bulk` still work (Review Focus 3); bulk now counts duplicates as skipped.
- [ ] **Step 2: Implement. Step 3: Full checks. Step 4: Commit** (SERVER).

### Task S8: Pod wall server (COM-01 server) + migration 115

Audit: `05-post-event-comms.md` §4.1–4.5 (option B), §7 X6 (do not copy the circle wall's realtime gaps).

**Files:**
- Create: `server/src/db/migrations/115_pod_wall.sql` (four tables per audit §4.3, **no** notifications constraint — 108 has it), `server/src/services/pod/pod-wall.service.ts`, `server/src/routes/pod-wall.ts` (mounted at `/api/pods`, paths under `/:podId/wall/…` as audit §4.3), `shared/src/types/wall.ts`
- Modify: `server/src/realtime/fanout.ts` (`fanoutPodWall(podId, extra)` — active members only), both `entities.ts` + `ENTITIES.md` (`E.podWall`, `E.podWallPost`), `server/src/index.ts` (mount)
- Test: new `services/pod/pod-wall.service.test.ts`, new `routes/pod-wall.test.ts`, new `db/migration-115.test.ts`, `client/realtime-entity-tags.test.ts`

**Interfaces:**
- Produces: `E.podWall(podId)` = `pod:${podId}:wall`; `E.podWallPost(postId)` = `pod-wall-post:${postId}`; the endpoints in audit §4.3 with circle-wall payload shapes (reuse `shared/src/types/wall.ts` for both walls' post/comment types where they match).
- Copy: non-member of a visible pod 403 "Join this pod to read and post in its discussion"; private pod non-member 404.

- [ ] **Step 1: Failing tests** — active-only gates (left/removed/invited refused); archived pod read-only; keyset; blocks filtered both ways and no bells between blocked pairs (Review Focus 5); idempotent `clientId`; moderation (author deletes own; director/host delete any and pin ≤3; admin moderates); bells: `pod_post` deduped per member per pod per hour with `group_bell` false skipped, pushed live with `notification:new` + `E.userNotifications`; one INSERT for member bells.
- [ ] **Step 2: Implement. Step 3: Full checks. Step 4: Commit** (SERVER).

### Task S9: Group chats for 3 to 50 people, and attending an event counts as meeting (COM-04, X2 server) + migration 116

Audit: `05-post-event-comms.md` §5.1–5.5 (option 1), §7 X2/X5/X7.

**Files:**
- Create: `server/src/db/migrations/116_event_groups.sql` (`dm_groups.session_id`; named type check incl. `'event'`; `pod_id` required only for `pod`; index) — verify the auto-generated constraint names on the scratch DB first (`\d dm_groups`) and drop them by name inside a guarded `DO` block
- Modify: `server/src/services/dm/group.service.ts` (create-from-event by an organiser or admin: members = everyone who took part, 3–50 incl. creator, `FOR UPDATE` cap; keyset messages; unread via `last_read_at`; `POST /:id/read`; leave; admin remove; earliest member becomes admin; block filter at read and on bells; `group_message` bell deduped per recipient per group per 10 min honouring `group_bell`), `server/src/routes/groups.ts` (zod, limiters), `server/src/realtime/fanout.ts` (`fanoutGroupEntities` emits `E.dmGroup` + `E.userDms`; remove untyped `group:<id>`), both `entities.ts` + `ENTITIES.md` (`E.dmGroup(id)` = `dm-group:${id}`), `server/src/services/dm/dm.service.ts` (`canMessage`: took part in the same completed event counts as met)
- Test: new `services/dm/group.service.test.ts`, new `routes/groups.test.ts`, new `db/migration-116.test.ts`, `services/dm/dm-mutual-gate.test.ts` (new attended-together case), `client/realtime-entity-tags.test.ts`

**Interfaces:**
- Produces: `POST /api/groups/from-event/:sessionId` `{ name?: string; memberIds?: uuid[] }` → `DmGroup`; `GET /api/groups` → `{ id; name; memberCount; unreadCount; lastMessage: { content; at; senderName } | null; sessionId: string|null }[]`; `GET /api/groups/:id/messages?before=` keyset; `POST /api/groups/:id/messages`; `POST /api/groups/:id/read`; `POST /api/groups/:id/leave`; `DELETE /api/groups/:id/members/:userId`. Copy: full "This group is full (50 people)."; fewer than 3 "A group chat needs at least 3 people."
- Constant (shared): `GROUP_CHAT_MAX_MEMBERS = 50`.

- [ ] **Step 1: Failing tests** — 51st member refused under two concurrent adds; attended gate (registered-never-joined excluded); blocked members don't see each other's messages; unread counts; leave/remove/admin hand-over; bells deduped and honouring `group_bell`; `canMessage` true for two people who both joined the same completed event.
- [ ] **Step 2: Implement. Step 3: Full checks. Step 4: Commit** (SERVER).

---

## Phase L — production's own client (branch from `origin/main`; LIVE-CLIENT)

### Task L1: Production tour — heading first, labelled English examples (ONB-04/05 on production)

Audit: `01-onboarding.md` §ONB-04.3 (production), §ONB-05.3; main's `client/src/features/onboarding/HowRsnWorks.tsx:130-240`.

**Files:** Modify `client/src/features/onboarding/HowRsnWorks.tsx` (main); Test: new pin `server/src/__tests__/client/main-tour-order.test.ts` (main), `e2e/tests/onboarding-tour.spec.ts` (main).

**Interfaces:** Consumes `EXAMPLE_PEOPLE` (S2).

- [ ] **Step 1: Failing pin** — on every card the `<h2>` and its text precede the picture in source order; no "Amara Okafor", "Tomas Lind", "Priya Raman"; the caption "Examples only. These are not real members." is outside the `aria-hidden` frame; each person card renders the text tag "Example"; names come from `EXAMPLE_PEOPLE`.
- [ ] **Step 2: Implement** (heading → text → caption → picture; no sheep above the heading; keep production's own words "Suggestions", "I want to meet").
- [ ] **Step 3: Headed local look** at 360/390/768/1280 in Chromium + WebKit; e2e order by bounding box.
- [ ] **Step 4: Commit** (LIVE-CLIENT).

### Task L2: Production profiles open in the same tab, Back works (CON-01 on production)

Audit: `02-requests-booking.md` §CON-01.3 item 6.

**Files:** Modify `client/src/components/ui/ProfileLink.tsx` (main: same tab by default; `newTab` prop adds `target="_blank" rel="noopener noreferrer"`, a visible ↗ and "(opens in a new tab)" for screen readers), every `features/live/*` caller passes `newTab`, `client/src/features/profile/PublicProfilePage.tsx` (Back: `navigate(-1)` when `location.key !== 'default'`, else the source route); Test: update the three ProfileLink pins and `e2e/tests/dm-request-profile-card.spec.ts`.

- [ ] **Step 1: Failing pins/spec** — from a meeting request card, "View full profile" stays in the tab; Back returns to `/messages`; a link inside the live event still opens a new tab and says so.
- [ ] **Step 2: Implement. Step 3: Headed look. Step 4: Commit** (LIVE-CLIENT).

### Task L3: Production create forms follow the pod type and event format (POD-01/03 on production)

Audit: `03-pods-events-config.md` §POD-01.3, §POD-03.3 client; consumes S4 definitions.

**Files:** Modify `client/src/features/pods/CreatePodModal.tsx` (main: orchestration default from `POD_TYPES[type].orchestration.default`, options limited to `allowed`, notice on change), `client/src/features/sessions/CreateSessionPage.tsx` (main: format picker limited to `eventFormatsForPod(pod.podType)`, description follows the selected format, Timing card only when `liveKindOf(format) === 'rounds'`, meeting fields length + capacity otherwise, title prefilled with `defaultTitle`, posts top-level `format`); Test: `phase4-matching-policy.test.ts` pins moved as needed, `event-schedule-timezone.test.ts` stays green (keep the local-time label).

- [ ] **Step 1: Failing pins** — no literal `'timed_rounds'` default in CreatePodModal; choosing Reason sets Freeform; CreateSessionPage renders no "Number of Rounds" for video_meeting; body carries `format`.
- [ ] **Step 2: Implement. Step 3: Headed look** (create a Reason pod and a video meeting locally at 360 and 1280). **Step 4: Commit** (LIVE-CLIENT).

---

## Phase C — preview screens (branch from `reason-m1` after `main` is merged in)

### Task C1: Onboarding v2 screens — select all, employee options, LinkedIn suggestions (ONB-01/02/03 client)

Audit: `01-onboarding.md` §ONB-01.3 client (a), §ONB-03.3 client, §Acceptance checks.

**Files:** Modify `client/src/features/onboarding/flow.ts` (`max: null`, `limitHint: null` for q1/q2/q4; remove `'too-many'`; `toggleKey` without max; `guessedSelf` returns a list), `QuestionStep.tsx` (no limit line, no disabled tiles), `OptionTile.tsx` (`note?: string` with `aria-describedby`), `OnboardingFlow.tsx` (tick every guess), `useSignupChoice.ts` (fall back to server `linkedin.chosen`); Test: `server/src/__tests__/client/onboarding-v2-flow.test.ts`, `onboarding-v2-screens.test.ts`, `e2e/tests/onboarding-v2.spec.ts` (invert the limits test; new labels; email path no guesses).

**Interfaces:** Consumes S2 (keys, labels, `selfGuesses`, `linkedin.chosen`).

- [ ] **Step 1: Failing pins/spec** — ticking 5 answers on each question and unticking one continues without any refusal; the line reads "We picked these from your LinkedIn. Change them if they're wrong."; each preselected tile shows "From LinkedIn"; an employee finishes every question without "Something else".
- [ ] **Step 2: Implement. Step 3: Headed local look** at all widths, Chromium + WebKit, incl. 360px with the keyboard up on the own-words box. **Step 4: Commit** (CLIENT).

### Task C2: Preview tour — labelled English examples (ONB-05 client)

Audit: `01-onboarding.md` §ONB-05.3; `reason-m1-look.test.ts:625-705`; `e2e/tests/onboarding-tour.spec.ts`.

**Files:** Modify `client/src/features/onboarding/HowRsnWorks.tsx` (preview); Test: rewrite `server/src/__tests__/client/reason-m1-look.test.ts:625-686` to "every person is an `EXAMPLE_PEOPLE` entry and each picture carries Example"; update `e2e/tests/onboarding-tour.spec.ts:28-29,89-100`.

- [ ] **Step 1: Failing pins** (caption verbatim, "Example" tags, names from `EXAMPLE_PEOPLE`, sheep tiles as photos, heading/text order kept).
- [ ] **Step 2: Implement. Step 3: Headed look. Step 4: Commit** (CLIENT).

### Task C3: Booking screens — the scheduler, and the 1:1 room (CON-03 client, VID-03 for 1:1)

Audit: `02-requests-booking.md` §CON-03.6 client C1–C10, §CON-04/05.6 risk "one person leaving ends the call for both".

**Files:** Modify `client/src/features/messages/MeetingScheduler.tsx`, `SystemMessageCard.tsx`, `MessagesPage.tsx` (pass the slot; `[data-scheduler-trigger]`), `MeetPage.tsx` (token minted on entry; CallEndWatcher shows "{name} left the call" with "Wait" and "Leave", never auto-ends; rejoin works); Test: `e2e/tests/scheduler-viewport-fit.spec.ts`, `meeting-loop.spec.ts`, `meeting-call.spec.ts`; new pin `server/src/__tests__/client/scheduler-flow.test.ts` (slot generation across both 2026 clock changes — Review Focus 1).

**Interfaces:** Consumes S1 (auto-confirm; 409 with scheduling).

- [ ] **Step 1: Failing pins/spec** — green "Both can" cell opens the confirm card (aria-label "Confirm {HH:mm}, you both can"); the card's time opens the scheduler on that slot; Save toasts: confirmed "Meeting confirmed: {Sun 25 Oct, 13:00}", overlap "You can both meet. Confirm a time." (panel stays open), else "Sent. They can see when you are free."; length + Video/Audio inside the confirm card; typed "Another time" kept on blur/Enter; unsaved picks prompt "Send your times?" (Send / Discard); past cells hidden; "Times in your time zone: {zone}"; slots unique across clock changes; in MeetPage one person leaves and rejoins while the other stays.
- [ ] **Step 2: Implement. Step 3: Headed two-account local run** (Chromium + WebKit, 360 and 1280). **Step 4: Commit** (CLIENT).

### Task C4: Meetings under Events, the details page, and the Events count (CON-04/05 client)

Audit: `02-requests-booking.md` §CON-04/05.4 UI, §CON-04/05.5 tests.

**Files:** Create `client/src/features/meetings/MeetingsSection.tsx`, `MeetingDetailPage.tsx`, `useMeetings.ts`; Modify `client/src/features/sessions/SessionsPage.tsx` (section above events; filters in `?filter=`), `client/src/App.tsx` (route `/meetings/:id` inside the shell), `client/src/features/reason/shell/nav.ts` (Events `match` gains `/meetings`), `ShellSidebar.tsx` + `MobileNav.tsx` (badge from `GET /meetings/summary`; aria-label "Events, {n} upcoming meeting(s)"; "live now" dot), `client/src/features/messages/MeetingScheduler.tsx` (`ThreadMeetingBanner` links the details page); Test: new pin `server/src/__tests__/client/meetings-ui.test.ts` (queries declare `meta.entities` [`E.userMeetings(me)`] / [`E.meeting(id)`]); `e2e/tests/reason-m1-shell.spec.ts` (Events badge).

**Interfaces:** Consumes S3 (`Meeting`, `MeetingSummary`, endpoints, tags).

- [ ] **Step 1: Failing pins/spec** — card "Meeting with {name}", "{Sun 25 Oct · 13:00–13:30 CET} · Video", first line of context, chip Today / Live now / Ended / Cancelled, Join enabled from 5 min before (else "Starts in {x}"), Open chat; details page shows who, when (local + zone), why, Join, "Add to calendar", "Reschedule" (→ `/messages/<conv>?schedule=1`), "Cancel meeting" (confirm "Cancel this meeting? {name} will be told."), "Open conversation"; sticky Join bar at 360px; empty state "No meetings yet. When you and someone agree a time, it appears here."
- [ ] **Step 2: Implement. Step 3: Headed two-account local run.** **Step 4: Commit** (CLIENT).

### Task C5: The bell and request cards read the server's state (CON-02 client)

Audit: `02-requests-booking.md` §CON-02.2 client.

**Files:** Modify `client/src/components/ui/NotificationBell.tsx` (React Query `['notifications']`, `meta.entities: [E.userNotifications(me)]`, draws `requestState`, no local status, 409 → "You already {accepted|declined} this request."), `client/src/features/messages/MeetingRequests.tsx` (one `mutationKey` per request shared with the focused card via `useMutationState`); Test: `server/src/__tests__/client/notification-bell-panel.test.ts`, `e2e/tests/meeting-request-bell.spec.ts`.

- [ ] **Step 1–4:** failing pins (no `useState` request status; query declares the tag) → implement → headed two-account run (accept on the card, the other device's bell flips to "Accepted" live) → Commit (CLIENT).

### Task C6: Profiles open in the same tab and Back returns to the exact place (CON-01 client)

Audit: `02-requests-booking.md` §CON-01.3 items 1–5.

**Files:** Modify `client/src/components/ui/ProfileLink.tsx` (preview; as L2), `client/src/features/reason/human/HumanProfilePage.tsx` (Back fallback table), `client/src/features/profile/PublicProfilePage.tsx`, `client/src/features/reason/shell/ReasonShell.tsx` (`useMainScrollMemory(mainRef)` per audit item 3), Events `?filter=`, Matches `?view=all`, Search `?q=`, `RecapPage.tsx` Message same tab; Test: the three ProfileLink pins, `reason-m1-profile-text.test.ts:102-104` counts, `e2e/tests/reason-m1.spec.ts:1279` (scroll restoration).

- [ ] **Step 1–4:** failing spec (open a profile from For You after scrolling, press Back, same scroll position, same filters; a live-event link still opens a new tab labelled so) → implement → headed look → Commit (CLIENT).

### Task C7: Pod and event forms follow the definitions (POD-01/03/04/05 client)

Audit: `03-pods-events-config.md` §POD-01.3 client, §POD-03.3 client, §POD-04.3.

**Files:** Create `client/src/features/pods/PodTypeFields.tsx`, `client/src/features/sessions/EventFormatFields.tsx`; Modify `CreatePodModal.tsx` + Edit Pod in `PodDetailPage.tsx` (react-hook-form; communication hidden; size hint "Up to 12 recommended"), `CreateSessionPage.tsx` (format cards; pod header from `?podId=`; title prefilled; errors at the field — title "Give your event a title" — and a summary beside the sticky submit; navigate to `/sessions/:id?invite=1`), `SessionDetailPage.tsx` (edit modal uses `EventFormatFields`; header facts follow the format; one templates endpoint; labelled "Invite people" ≥44px); Test: `phase4-matching-policy.test.ts`, `reason-wording.test.ts:140`, `event-schedule-timezone.test.ts`, `june9-client-pins.test.ts`, `s16-precohost-detail-page.test.ts`, `e2e/tests/schedule-timezone.spec.ts` (keep the label, Edit button and datetime input).

**Interfaces:** Consumes S4 rules.

- [ ] **Step 1–4:** failing pins/spec (Reason pod → Freeform with no orchestration touch; switching a video meeting to speed networking shows rounds; switching back with edited rounds asks "Switching to Video meeting removes the round settings ({n} rounds × {m} min). Continue?"; empty title error at the field) → implement → headed look at all widths → Commit (CLIENT).

### Task C8: The meeting room, and clear exits in speed networking (VID-01/02/03/04 client)

Audit: `04-live-video.md` §3.5 (MeetingStage, sizes), §4.4 (control bar, roles, Leave/End), §5.4 client, §6 (mobile rules), §7 (pins to extend), §9 slices S2, S3, S4, S6.

**Files:** Create `client/src/features/live/meeting/liveLayout.ts` (`selectMeetingLayout`, `computeStageGrid`), `MeetingRoom.tsx`, `MeetingStage.tsx`, `MeetingControlBar.tsx`, `MeetingEnded.tsx`, `useLocalMediaToggles.ts`; Modify `client/src/features/live/LiveSessionPage.tsx` (branch once on `liveKindOf(resolveEventFormat(session))`; roles computed once: `canEndEvent = isDirector || isSuperAdmin`, `canManage = isDirector || isCohost || isSuperAdmin`; loader while the session loads), `VideoRoom.tsx` / `Lobby.tsx` (export `VideoTile`, `PreLobbyWaitingRoom` only), `HostControls.tsx` (Leave before End; End the only red button; `disabled={!canEndEvent}`), `ReactionBar.tsx` (shared role helper), safe-area + 44px hardening of the speed-networking top bar, host bar and chat input; Test: new `server/src/__tests__/client/meeting-layout.test.ts` (imports `liveLayout.ts`: layouts for 1/2/3/4/9/25 people; `computeStageGrid` never exceeds W×H for 1280×720, 1440×900, 1024×768, 390×844, 360×740, 844×390), new `meeting-control-bar.test.ts` (Leave for all; End behind `canEndEvent`; confirm dialogs; `endEvent: true`; 44px; safe-area), extend `c2-video-diet.test.ts` + `p2-event-reliability.test.ts` with the meeting files, update `s19-director-only-end-event.test.ts:58-72` to `!canEndEvent`, keep `ws3-leave-buttons.test.ts` for rounds; new e2e `e2e/tests/video-meeting-1to1-headed.spec.ts`.

**Interfaces:** Consumes S4 (`resolveEventFormat`, `liveKindOf`, snapshot fields, `NOT_A_ROUNDS_EVENT`).

Layout decisions (pinned): 1 → own camera large, "Waiting for others to join" (+ host "Invite people", keeping `data-testid="live-invite-link"`); 2 → **side by side, equal size, when the stage is ≥1024px wide and landscape**; otherwise remote large (`object-contain`) + self PIP (cover) top-right; a "Focus"/"Side by side" toggle swaps them; 3+ → `computeStageGrid` grid, own tile on the first page; pin/spotlight → focus. `data-testid="meeting-stage"`, `data-layout="solo|pair|side|grid|focus"`, `data-self="true"`. Copy: Leave dialog "Leave the meeting? The others can carry on. You can rejoin from the event page."; End dialog "End the meeting for everyone? Everyone will be disconnected."; co-host note "Only {director} can end the meeting for everyone."; pre-start guest "Waiting for {host} to start the meeting"; ended screen "Meeting ended" with "Back to event" and "Back to pod".

- [ ] **Step 1: Failing pins + e2e** (two real browsers; event created with `format: 'video_meeting'`): no Compact button, no round chip, no plan strip, no check-in; remote and self tiles fully inside the viewport at the six sizes (boundingBox); Leave in the bottom bar ≥44px; guest leaves and rejoins while the host stays; guest emitting `host:end_session` gets `FORBIDDEN`; host ends → both see "Meeting ended"; DB status `completed`; a 4-person run → equal tiles, no scroll.
- [ ] **Step 2: Implement. Step 3: Headed run with the fake camera** (Chromium needs `--disable-features=MediaFoundationD3D11VideoCapture` on this machine). **Step 4: Commit** (CLIENT).

### Task C9: Invite people from your connections (POD-02/04 client)

Audit: `03-pods-events-config.md` §POD-02.3, §POD-04.3.

**Files:** Create `client/src/features/invites/InvitePickerSheet.tsx`, `InviteStatusList.tsx`, `useInviteCandidates.ts`; Modify `PodDetailPage.tsx` ("Invite members" opens the sheet; status list always visible to organisers), `SessionDetailPage.tsx` (opens on `?invite=1`; "This pod ({n})" segment with "Invite everyone in {pod} ({n})"), delete dead `client/src/features/invites/CreateInviteModal.tsx` (update its pin); Test: `june9-client-pins.test.ts`, `phase1-spa-navigation.test.ts:144-150`, `phase-may19-realtime-migration-phase3.test.ts`, `e2e/tests/verify-pod-invite-input-headed.spec.ts`; new e2e `invite-picker.spec.ts` (60+ seeded connections at 360/390/768/1280; footer button boundingBox inside the viewport).

**Interfaces:** Consumes S7.

- [ ] **Step 1–4:** failing pins/spec (search finds "Cla" → Claus; browse pages of 30 with "Show more"; chips persist across searches, collapse to "+N"; sticky footer "Send {n} invites"; rows show Member / Going / Invited / Declined and can't be re-invited; results update in place, sheet stays open with "Done"; "Invite by email" and "Share a link" with the real cap) → implement on the REASON `Sheet` → headed look → Commit (CLIENT).

### Task C10: After the event — chat history, message everyone, one path back (COM-02/03/05 client)

Audit: `05-post-event-comms.md` §2.2 client, §3.4 client, §6.3 client items 1–5.

**Files:** Create `client/src/features/sessions/EventChatHistory.tsx`, `MessageParticipantsPanel.tsx` (replaces `MessageParticipantsButton.tsx`); Modify `SessionDetailPage.tsx` (completed order: "← Back to pod", header, action row, panel, chat card, participants; organiser buttons ≥44px), `client/src/features/live/LiveSessionPage.tsx` (`handleLeave`: no `disconnectSocket()`, `navigate('/sessions/' + id, { replace: true })`; pod breadcrumb not a bare `<a>`), `SessionComplete.tsx` ("Event details" primary, "Back to pod", "Full recap"; stacked ≤640px), `RecapPage.tsx` ("← Event details"), `client/src/hooks/useSessionSocket.ts` (`chat:history` merges by id), `usePostEventMessage.ts` (v2; tags instead of polling); Test: new pins (`useInfiniteQuery` declares `E.sessionChat(id)`; `handleLeave` has no `disconnectSocket`), `ws3-leave-buttons.test.ts`, `ws2-edge-smoke.spec.ts`, `ux3-recap-newtab-smoke.spec.ts`, `post-event-message.spec.ts`.

**Interfaces:** Consumes S5, S6.

Copy (verbatim): chat empty "No messages were sent during this event."; 403 "Only people who took part in this event can read its chat."; live "The chat is inside the live event." + "Enter live event"; earlier "Show earlier messages"; panel states per S6 explanations; after send "Sent to {n} people on {date}" + "Send another message".

- [ ] **Step 1–4:** failing pins/spec (two accounts: chat during the event, host ends, both reopen the event and read the chat; participant leaves → lands on the event page, sees "Ended" without refresh and still gets a bell; organiser sends a message → attendee gets the DM + bell "{name} messaged everyone from ‘{event}’") → implement → headed run → Commit (CLIENT).

### Task C11: The pod discussion (COM-01 client)

Audit: `05-post-event-comms.md` §4.3 client.

**Files:** Create `client/src/components/wall/Wall.tsx` (extracted from `CircleWall.tsx` with `{ basePath, canPost, canModerate, entities, shareEnabled }`; `CircleWall` becomes a thin wrapper keeping `circle-wall` / `wall-post-<id>` test ids and its polling) — or, if the extraction risks the circle specs, a separate `client/src/features/pods/PodWall.tsx`; Modify `PodDetailPage.tsx` (phone: chips "Discussion · Events · Members"; ≥1024px two columns `lg:grid-cols-[minmax(0,1fr)_320px]`; `?post=` deep link; non-member copy "Members talk here. Join the pod to read and post."; composer "Write something to the pod…"); Test: new pin (`useInfiniteQuery` declares `E.podWall(podId)`, no `refetchInterval`), keep `circle-wall.spec.ts`, `circle-wall-social.spec.ts`, `circles-core.spec.ts` green; new e2e `pod-wall.spec.ts` (member A posts, B sees it live and replies, A gets a bell, director deletes, removed member 403, 360–1280).

- [ ] **Step 1–4:** failing pins/spec → implement → headed run → Commit (CLIENT).

### Task C12: Group chats in Messages (COM-04 client)

Audit: `05-post-event-comms.md` §5.3 client.

**Files:** Create `client/src/features/messages/GroupThread.tsx`, `GroupMembersSheet.tsx`, `useGroups.ts`; Modify `MessagesPage.tsx` (inbox lists groups beside 1:1 with name, members, preview, unread), `client/src/App.tsx` (route `/messages/g/:groupId`), `SessionDetailPage.tsx` ("Start a group chat" beside the message panel for organisers), shell Messages badge adds group unread; Test: new pins (queries declare `E.dmGroup(id)` / `E.userDms(me)`); new e2e `group-chat.spec.ts` with three accounts (one sends, two see it live with unread badges, one leaves, the 51st add refused with "This group is full (50 people).", phone widths).

Copy: header "{n} of 50"; product statement "Group chats hold up to 50 people."

- [ ] **Step 1–4:** failing pins/spec → implement → headed three-account run → Commit (CLIENT).

---

## Phase F — reconcile, sweep, hand over

### Task F1: The ONB-06 checklist and the note for Stefan

**Files:** Create `workspace/audits/2026-10-26-feedback-25oct/ONB-06-checklist.md` (and a PDF copy) — one row per prior onboarding requirement (from `06-onboarding-reconciliation.md` (a)) **and** one row per 25 Oct item ONB/CON/POD/VID/COM: status on production, status on the preview, the release/commit that did it, and how to see it; open items explicit (20-minute question, entity in onboarding, LinkedIn sign-in, share switch, speed-networking main-room sizes). Create `workspace/scratch/2026-10-26-feedback-25oct/message-for-stefan.txt` (plain prose, no lists, no em dashes, no colons per the client-message style; points him at preview.rsn.network for Scripts A–D and asks for the go).

- [ ] **Step 1:** fill every row from the merged code and the release log (no row without evidence). **Step 2:** controller reviews. **Step 3:** commit the progress.md entry on reason-m1 (no workspace files in the product repo).

### Task F2: Final sweep (Scripts A–D, speed-networking regression, all devices)

**Files:** Create `e2e/tests/script-a-first-member.spec.ts`, `script-b-meeting.spec.ts`, `script-c-reason-pod.spec.ts`, `script-d-after-event.spec.ts` (headed, two accounts; three for group chat).

- [ ] **Step 1:** run each on the preview against production's API in Chromium, WebKit, iPhone 14, and at 768/1024 widths, lanes in sequence (Vercel checkpoint lesson).
- [ ] **Step 2:** run the speed-networking set on production: `verify-5round-4p-full-lifecycle-headed`, `ux-1-full-journey-mixed-rating-headed`, `lcy-lifecycle-headed`, `s19-director-end-smoke`, `verify-cohost-parity-headed`, `ws2-edge-smoke`, `ws3-mobile-event-smoke` (one spec per process).
- [ ] **Step 3:** check-hole; clean up throwaway members by id; report with screenshots, results per engine, and Ali's numbered test script; name what could not be verified (real camera/mic between two humans, real iPhone Safari, real inboxes).
