# Stefan's 9 Sept 2026 REASON test — fix plan

Source: Stefan's 6-item feedback (pasted by Ali 9 Sep). Item 6 (host leave /
breakout rooms) PARKED by Ali ("vague, leave it for now").

Audit evidence (4 parallel code audits, 9 Sep) is inline per item. Budget rule
stands: prod LLM spend < $10/month — nothing below adds a per-match LLM call.

## Recommended order

1. **Item 4 — Calendar** (quick win, ~1h)
2. **Item 5 — Call request flow** (clear spec, mirrors pokes)
3. **Item 2 — Matching breadth** (no-LLM, highest impact on "empty results")
4. **Item 3 — Concrete time slots** (largest change, 6 layers)
5. **Item 1 — Onboarding** (BLOCKED on Claus's questions; then couples to item 2)

---

## Item 4 — Calendar invite: "Add to calendar", universal

**Finding.** The .ics is already generated (`calendar.service.ts:24-75`, valid
METHOD:REQUEST / UID / attendees / alarm) and genuinely attached to the
confirmation email (`email.service.ts:1187`). Two real gaps: (a) the attachment
has no `text/calendar; method=REQUEST` content-type, so Gmail/Outlook show a
file, not an inline Accept/Decline invite; (b) in-app there is ONLY an "Add to
Google Calendar" link — no .ics download, no .ics endpoint.

**Fix.**
- Set attachment `contentType: 'text/calendar; method=REQUEST; charset=utf-8'`
  (+ add SEQUENCE and RFC-5545 line folding for long descriptions).
- `GET /dm/conversations/:id/meeting.ics` — serves the confirmed meeting's .ics
  to a participant.
- Client: replace "Add to Google Calendar" with **"Add to calendar"** → downloads
  the .ics (works for Google, Outlook, Apple). Per Ali: no Google-specific label.

Decisions: none.

## Item 5 — Call request flow: request → duration → accept → start

**Finding.** Meet-now is fire-and-forget (`meeting-call.service.ts:99-167`):
ring + caller enters the room immediately; no accept/decline state, no
duration. Call buttons show for ANY conversation (`MessagesPage` gates only on
`partnerOnline`), including grandfathered / event / admin threads with no
accepted introduction (`dm.service.canMessage:139,157,170`). Pokes already have
the exact request→accept/decline pattern to mirror (`user_pokes` +
`acceptPoke`/`declinePoke` + notification + `emitEntities`).

**Fix.**
- Migration `call_requests(id, conversation_id, from_user_id, to_user_id, kind
  audio|video, duration_min, status pending|accepted|declined|expired|cancelled,
  created_at, responded_at)`; partial unique index on one pending per
  conversation.
- Server: `POST /conversations/:id/call/request {kind,duration}` → bell +
  socket `call:request` to callee; `POST /call/requests/:id/accept` → both get
  tokens, socket `call:accepted` to caller; `/decline`; `/cancel`; requests
  expire after 2 min (server-side check on accept).
- Gate (server-authoritative in `requireCallParticipant`): calls allowed only
  when the connection is accepted — see Decision A.
- Client: Meet-now buttons become **"Request a call"** (pick video/audio +
  duration) → caller sees "Waiting for X to accept…" (Cancel) → callee gets a
  request banner (Accept / Decline) → on accept both enter `/meet`; on decline
  the caller is told. Replaces the instant ring. Duration reuses the existing
  15–240 clamp.

Decisions: **A)** what counts as "connection accepted" — (recommended) accepted
introduction (poke) OR mutual event match; grandfathered/admin threads can
message but not call. **B)** duration options — recommended 15 / 30 / 45 / 60.

## Item 2 — Matching: broaden, related meaning, location, never empty

**Finding.** Scoring is pure lexical (`platform-match.service.ts:238`: 0.7×token
overlap + 0.6×role-regex hit, threshold 0.45). No embeddings (`embedding_text`
is raw text, never read; no pgvector). Synonyms (20 clusters) apply only at
agent-CREATE, never at score time, never to profile matching. **No widen-on-
narrow fallback anywhere** — agents hard-filter at 0.45 and write an empty set.
Location is loaded but is just loose tokens (neither filter nor boost). Zero LLM
in the matching path today (good).

**Fix (zero LLM):**
- **Never empty — widen when narrow.** If an agent/search yields < 3 strong
  matches, progressively relax: apply synonyms at score time → drop to the
  browse threshold (0.12) → rank the closest people. Return them labelled
  ("Strong matches" / "Close matches") so the user always gets something useful
  and knows how close it is.
- **Related meaning at score time.** Apply `expandWantTags` when SCORING (both
  profile and agent matching), not only when an agent is created; grow the
  synonym map from real want-texts in prod.
- **Use the WHY.** Score onboarding's `reasonForMeeting` / `desiredOutcome` /
  `meetingValueCriteria` text too (today only role keywords count). This is the
  hook item 1 plugs into.
- **Location as a real signal.** Boost when locations match; apply as a hard
  filter only when the want explicitly names a place ("in London"). Not a
  blanket hard filter — that would empty results for a distributed network.
- Embeddings: deferred. Needs pgvector + an embedding API; do synonyms+widen
  first and measure. Revisit if recall is still short.

Decisions: **C)** location = boost + explicit-only hard filter (recommended) vs
always-hard filter.

## Item 3 — Scheduling: concrete time slots, exact time + duration before confirm

**Finding.** Dayparts (morning/afternoon/evening) are baked into six layers:
DB CHECK on `meeting_availability.window_key` (075), the service
(`DAYPARTS`, `WINDOW_RE`, `windowLabel`, 21-window cap, `confirmWindow`
split), the client 7×3 grid + "finalize" step (`DAYPART_DEFAULT_TIME`,
`labelFor`), the chat/notification labels, `admin-inspect`, and ~10 unit/E2E
specs. Exact time (092) is bolted on top, not a replacement.

**Fix.** Replace dayparts with **30-minute slots stored as UTC instants**
(`'2026-09-09T13:30:00Z'`) so two people in different timezones overlap on the
same instant and each sees their own local time.
- Migration: relax the CHECK to accept instant keys; raise the cap (21 → 200);
  legacy daypart rows stay readable until they age out (30-day horizon).
- Service: validate 30-min-aligned instants within the horizon; `windowLabel`
  → exact local time; `confirmWindow` takes startAt straight from the slot (no
  separate time input) + duration + audio/video.
- Client: one-step picker — a day strip (next 7 days) → the day's time slots as
  chips (e.g. 08:00–20:00 local); tap the ones you're free; overlap slots light
  up; confirm shows **"Tue 9 Sep, 15:30 · 30 min · Video"** before you commit.
  Removes the "morning/afternoon" step entirely.
- Update thread/notification labels, admin-inspect, unit tests, E2E specs.

Decisions: **D)** 30-min granularity, 08:00–20:00 local, 7 days ahead,
durations 30/45/60 (recommended) — or different values.

## Item 1 — Onboarding around Claus's open-ended questions

**Finding.** **Claus's questions are not in the repo or assets** — only the
locked opening line ("We believe you're here for a reason — do you mind sharing
that reason with us?") and three beats (who / why / who-you-are) from the June
design. The host asks ≤3 questions (`prompts.ts:114-118`); the extractor already
produces a rich 35-field shape incl. `reasonForMeeting`, `desiredOutcome`,
`meetingValueCriteria`, `problemTheySolve` — **but matching consumes only role
keywords + token overlap; the WHY is effectively unused.** Cost: ~5–10 Haiku
calls per member, once (unchanged pattern).

**Fix (once questions arrive).**
- Reshape the host prompt around Claus's open-ended questions, why-first; keep
  the "we" voice and the ≤3-question discipline.
- Make "reason for joining" a first-class extracted field, stored privately
  (never shown on the profile) and used by matching (item 2 "Use the WHY").
- Re-onboarding existing members is a per-member Haiku cost — do only on
  request (Stefan/Claus), not as a sweep.

Decisions: **E)** BLOCKED — need Claus's actual question list (doc, message, or
Ali's paraphrase). Nothing to build until then.

## Decisions (Ali, 9 Sep) — supersede the recommendations above

- **A (item 5) — connection → meeting → call progression.** Accepted intro
  (poke accepted) → they can CHAT; video/audio calls are BLOCKED. What is
  available is the meeting scheduler (calendar icon): each picks slots they're
  free in their OWN timezone across the coming week; same slot on both sides →
  schedule. Once a scheduled meeting has ACTUALLY HAPPENED (both participants
  joined the room) → calls become ENABLED and the scheduler icon DISAPPEARS from
  that chat (they can just call now). Track attendance per side on the
  conversation (`meeting_joined_a_at` / `meeting_joined_b_at`, stamped when a
  participant fetches a room token before unlock; `calls_unlocked_at` when both
  set). Server-authoritative gate in `requireCallParticipant`.
- **B (item 5) — call duration is CUSTOM**: a number the user types (5, 10, 15,
  20… minutes), clamped to a sane range; not a fixed list.
- **C (item 2) — strict constraints, smart category.** Stefan's test: "manufacturer
  in US with 20 years experience". Explicit constraints are HARD filters:
  location must be US (not worldwide; normalise US/USA/United States), experience
  must be ≥20 years. The CATEGORY is smart: a manufacturing company that calls
  itself "industrial fabrication"/"production" still matches (synonyms + related
  meaning at score time). Widen-on-narrow relaxes ONLY the category, never the
  explicit constraints. Needs: parse location + min-years from the want text
  (regex/intent-signals, no LLM); a profile experience signal (check what exists;
  extract from enrichment/bio where present).
- **D (item 3) — approved as proposed** (30-min slots as UTC instants, 08:00–20:00
  local, 7 days ahead, one-step picker, exact time shown before confirm) with
  the duration as a CUSTOM number input, not 30/45/60.
- **E (item 1) — PARKED** until Claus's question list arrives.
- **Order:** 4 → 5 → 2 → 3 (1 parked, 6 parked).

## Status (9 Sep)

- **Item 4 — DONE, prod-verified** (main ddd85ed): text/calendar invite, folded/SEQUENCE'd .ics,
  `GET /dm/conversations/:id/meeting.ics`, single "Add to calendar" download. Smoke asserts it.
- **Item 5 — DONE, prod-verified** (main 6fae820 + d17a530): migration 097; calls locked until
  both attend a scheduled meeting; request → accept with typed minutes; scheduler steps aside
  after unlock; 44px tap targets everywhere; `meeting-call.spec` 8/8 on 3 engines; layout sweep
  19/19 at 6 widths.
- **Item 2 — DONE** (main c679ec3): strict place/years via `want-constraints.ts`, synonyms +
  related word forms at score time, never-empty widening ("Close match") for agents and the
  browse list. Profiles have no experience field → years parsed from text; unstated = kept,
  demoted, flagged. Prod smoke `matching-constraints.spec.ts`.
- **Item 3 — DONE, prod-verified** (main 7690bb0 + 2f13f13; E2E fixes aba4bef): migration 098 relaxes the CHECK to concrete 30-min UTC-instant
  slot keys (legacy day-parts still readable); `isValidWindowKey`/`windowLabel`/`confirmWindow` handle
  slots (slot = the start instant; custom 5–240 min); bell label in the partner's own timezone, thread
  line carries the instant and each client localises it; one-step picker (day strip → local 08:00–20:00
  times, green = both, auto-opens on the first day you both can), confirm card shows exact local time ·
  custom length · kind before commit. Items 1, 6 parked.

## Item 6 — PARKED (Ali, 9 Sep)

Audit for later: "Leave Event" and "End Event" are unrelated controls; a host
leaving is just marked LEFT while rounds/breakouts keep running
(`participant-flow.ts:1115-1185`); `host:end_session {endEvent:true}` already
ends for everyone; ~7 host paths still use native `confirm()` (should be the
in-app Modal). When picked up: a host-leave confirm dialog with the two
options, wired to the existing end action, + a "N still inside" banner on the
host dashboard (feed: `GET /sessions/:id/host/state` participantCount, 3s poll).

## Verification (every item)

Unit tests for each service change; full server suite; client tsc + build;
headed prod smokes on Chromium + WebKit + iPhone 14; live prod bundle grep
after each client ship; screenshots to Ali; device pass for real A/V.
