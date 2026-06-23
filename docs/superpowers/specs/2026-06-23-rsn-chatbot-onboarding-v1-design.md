# RSN Chatbot Onboarding — V1 Design Spec

> **Date:** 2026-06-23 · **Status:** DESIGN (awaiting approval) · **Build target:** `RSN-dev`, feature branch → staging → main
> **Source canvas:** `assets/RSN OVERHAUL/RSN Chatbot Onboarding - canvas summary 2026-06-23.md`
> **Increment:** "Build the brain" — onboarding chatbot + structured intent capture into the user profile. **No match UI in this increment.**
> **Model decision:** Claude API, **Haiku 4.5** for both the conversation and the extraction call. **Key:** present via `ANTHROPIC_API_KEY` env.

---

## 0. Locked decisions — persona (2026-06-23, after Claus's notes)

These refine §7 and the canvas. They are **decided** — do not re-litigate.

1. **No mascot — "no sheep."** The black-sheep avatar is dropped. `<HostPresence/>` stays as a swappable slot but renders a **calm typographic host**: name "Reason", warm copy, **framer-motion only** (fade/slide-in, typing dots, gentle pulse on the active line). Human feeling — never a bot/assistant/creature.
2. **Voice = "we" (the Reason team)**, not a single "I". Locked opening line:
   > "We believe you're here for a reason — do you mind sharing that reason with us?"
3. **Adaptive segmented flow.** Three beats — (1) who you want to meet, (2) why / desired outcome, (3) who you are — each a warm standalone prompt that quietly extracts one piece. The host **reorders/merges** beats based on what the user already revealed and **never re-asks**. ("Segmented greetings, clever extraction.")
4. **Language = English only** for V1.
5. **LLM fallback** = chat-only with a **silent minimal-form fallback** (the 5 gate fields) if the LLM is down, so signup is never blocked.

---

## 1. Goal & non-goals

**Goal.** Replace the 3-step onboarding *form* with a short (under-2-minute) LLM "host" conversation that extracts three things — **who you want to meet, why, and who you are** — and saves them as **structured matching data** on the user profile, reusing RSN's existing onboarding-completion gate.

**In scope (this increment):**
- Conversational onboarding UI (replaces `OnboardingPage.tsx`).
- Two server-side Claude calls: (1) host conversation, (2) JSON extraction.
- New `user_intent_profiles` table + `onboarding_status` + dual-write into existing `users` columns.
- Confirmation screen before save. Status gate. Rate limiting. Admin-visible confidence/strength.

**Out of scope (later increments):** match cards, interested/mutual-match flow, privacy/visibility reveal, the global "match by reason" engine, embeddings/vector search, voice/avatar. (The data we capture here is the foundation for all of them.)

---

## 2. Current-state findings (audited 2026-06-23)

- **Stack:** monorepo (`shared`/`server`/`client`). Server = Express 4 + TypeScript + Postgres (`pg`, raw SQL migrations) + Redis (`ioredis`) + JWT (magic-link) auth + Zod + Sentry + pino. Client = React + Vite + Tailwind + Zustand. Tests = Jest; CI = GitHub Actions; Playwright present.
- **`users` already stores** `interests[]`, `reasons_to_connect[]`, `company`, `job_title`, `industry`, `location`, `linkedin_url`, `bio`, `languages[]`, plus (later migrations) `professional_role`, `current_state`, `career_stage`, `goals`, `meeting_preferences`, `matching_notes`, and flags `profile_complete` + `onboarding_completed`.
- **Existing onboarding flow:** `client/.../onboarding/OnboardingPage.tsx` (3 steps) → `PUT /users/me` then `POST /auth/onboarding/complete`. The complete endpoint **requires 5 fields** (displayName, company, jobTitle, industry, reasonsToConnect[]), persists them, derives first/last name, and flips `onboarding_completed` + `profile_complete`. Gate is enforced server-side (`onboarding-gate` tests) and client-side (ProtectedRoute).
- **Matching today** is *in-event, per-round* (`server/src/services/matching/*`); `matches` has `reason_tags[]` + `score`. There is **no** global person-to-person matcher yet.
- **No AI SDK** in deps yet.

**Implication:** the chatbot is a *new front door to an existing, well-structured profile + gate*. We don't redesign onboarding semantics — we change the *interface* (form → chat) and *enrich* the captured data.

---

## 3. Architecture (this increment)

```
┌────────────────────────── CLIENT (React/Vite) ──────────────────────────┐
│  features/onboarding/ChatbotOnboarding.tsx  (replaces OnboardingPage)     │
│    • message list (host left / user right), single input, typing dots     │
│    • POST /onboarding/chat  per user turn                                  │
│    • on summary → Confirm/Edit card → POST /onboarding/confirm            │
│    • mobile-first; reuses ui/{Button,Input,Card,Spinner,Toast}           │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  (JWT, existing axios `api` client)
┌───────────────▼──────────────────────────────────────────────────────────┐
│  SERVER (Express)                                                          │
│  routes/onboarding.ts        (auth + zod + rate-limit middleware)         │
│    GET  /onboarding/status   → { onboarding_status }                       │
│    POST /onboarding/chat     → { reply, ready } (host turn)               │
│    POST /onboarding/confirm  → runs extraction, saves, flips gate         │
│  services/onboarding/                                                      │
│    chatbot.service.ts  → Claude call #1 (converse) + #2 (extract JSON)    │
│    intent.repo.ts      → write user_intent_profiles + dual-write users    │
│  config: anthropicApiKey, onboardingChatModel, onboardingExtractModel     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  @anthropic-ai/sdk  (Haiku 4.5)
        ┌───────▼────────┐        ┌──────────────── POSTGRES ───────────────┐
        │  Claude API    │        │ users (+ onboarding_status, dual-write)  │
        │  claude-haiku  │        │ user_intent_profiles (JSONB intent blob) │
        └────────────────┘        └──────────────────────────────────────────┘
```

**Why this shape:** isolates the LLM in one service (single place to swap model / add streaming), keeps the flexible intent blob in its own table (canvas: "profile may grow to hundreds of attributes"), and reuses the proven auth + gate + validation + rate-limit middleware already in the codebase.

---

## 4. The LLM design (answers "which API")

**Pick: Claude API, `claude-haiku-4-5`, two calls.** Rationale:
- The task = a short, scoped host conversation + a deterministic JSON extraction. That is squarely Haiku-class work; Haiku 4.5 is fast (good chat UX), cheap ($1/$5 per M tokens), 200K context, and **supports structured outputs**.
- Claude (not a second vendor) because: the canvas specifies it, instruction-following for the "host, not assistant" persona is first-class, native structured outputs make extraction reliable, and you already have an Anthropic key. No reason to add OpenAI/Gemini or self-host an OSS model at this stage.
- **Upgrade path is one line:** model IDs live in `config`. If conversation warmth needs more, switch call #1 to `claude-sonnet-4-6` without touching the flow.

**Call #1 — conversation (per user turn).** Plain `client.messages.create`:
```ts
const reply = await anthropic.messages.create({
  model: config.onboardingChatModel,      // "claude-haiku-4-5"
  max_tokens: 1024,
  system: HOST_SYSTEM_PROMPT,              // canvas §31, verbatim
  messages: history,                        // full conversation so far
});
```
- No `thinking`/`effort`/sampling params (Haiku 4.5 — keep the request minimal).
- V1 is **request/response per message** (non-streaming) — Haiku is fast enough; SSE streaming is a clean later upgrade isolated to this service + the chat component.

**Call #2 — extraction (once, at confirm).** Structured output via `messages.parse` + a JSON schema:
```ts
const { parsed_output } = await anthropic.messages.parse({
  model: config.onboardingExtractModel,    // "claude-haiku-4-5"
  max_tokens: 2048,
  messages: [{ role: "user", content: EXTRACTION_PROMPT + serialize(conversation) }],
  output_config: { format: zodOutputFormat(IntentSchema) },   // see §5
});
```
- `messages.parse` validates against the schema and retries on mismatch — no brittle hand-parsing. (Schema avoids unsupported JSON-schema constraints: no min/max/length — fine, our schema is flat.)
- Confidence + `profile_strength` come back in the same object → drives weak-profile handling and admin debug.

**Cost (rough).** A 4–7 message onboarding ≈ a few thousand tokens across both calls. At Haiku rates that is well under **US$0.01 per completed user** — negligible even at thousands of signups. (Prompt caching not worth wiring in V1: our system prompt is below Haiku's 4096-token cache minimum.)

**Security:** `ANTHROPIC_API_KEY` via env only (Render `/etc/secrets/.env` + local `.env`), never committed; `.env.example` placeholder. Chat endpoint behind the existing Redis-backed rate limiter (cap turns/min per user) to bound cost and abuse. All onboarding routes require auth (V1 is post-login).

---

## 5. Data model (answers "save all chatbot data to the profile for matching")

New **additive, reversible** migration `0NN_onboarding_intent.sql`:

```sql
CREATE TYPE onboarding_status AS ENUM
  ('not_started','in_progress','completed','needs_review','update_required');

ALTER TABLE users
  ADD COLUMN onboarding_status onboarding_status NOT NULL DEFAULT 'not_started',
  ADD COLUMN last_onboarded_at TIMESTAMPTZ;

CREATE TABLE user_intent_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  matching_intent    JSONB   NOT NULL DEFAULT '{}',   -- desired_people/roles/seniority/stage/industries, reason_for_meeting, desired_outcome
  matching_tags      TEXT[]  NOT NULL DEFAULT '{}',
  embedding_text     TEXT,                            -- prepared now, embedded in a later increment
  profile_summary    TEXT,                            -- <60-word human summary
  avoid_preferences  TEXT[]  NOT NULL DEFAULT '{}',
  privacy_preference VARCHAR(40) NOT NULL DEFAULT 'normal',
  confidence         JSONB   NOT NULL DEFAULT '{}',
  profile_strength   VARCHAR(20),                     -- strong | weak
  onboarding_conversation JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_uip_tags   ON user_intent_profiles USING GIN (matching_tags);
CREATE INDEX idx_uip_intent ON user_intent_profiles USING GIN (matching_intent);
```

**On confirm, write BOTH:**
1. The rich blob → `user_intent_profiles` (the flexible, future-proof home for matching data).
2. **Dual-write the existing `users` columns** the current engine + UI already read: `interests`, `reasons_to_connect`, `company`, `job_title`, `industry`, `location`, `linkedin_url`, `goals`, `meeting_preferences` — then reuse the existing completion path to flip `onboarding_completed` + `profile_complete` and set `onboarding_status='completed'`, `last_onboarded_at=NOW()`.

This is the key design choice: **nothing downstream breaks, and the existing in-event matcher immediately gets better-quality `reasons_to_connect`/tags** — while the new table accumulates the structured intent the future global matcher needs.

`IntentSchema` (zod, mirrors canvas §18/§32): `desiredPeople[]`, `desiredRoles[]`, `desiredSeniority[]`, `desiredStage[]`, `desiredIndustries[]`, `reasonForMeeting`, `desiredOutcome`, `userProfileSummary`, `userRole`, `userCompany?`, `userLocation?`, `userExpertise[]`, `userCanOffer[]`, `userInterests[]`, `avoidPreferences[]`, `privacyRecommendation`, `matchingTags[]`, `embeddingText`, `confidenceScores{}`, `profileStrength`.

---

## 6. API endpoints

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/onboarding/status` | yes | — | `{ status }` (drives the gate / resume) |
| POST | `/onboarding/chat` | yes + rate-limit | `{ messages }` | `{ reply, ready }` — `ready` true once the host has summarized |
| POST | `/onboarding/confirm` | yes | `{ messages }` | `{ summary, profileComplete }` — runs extraction, saves, flips gate |

Validation via existing Zod `validate` middleware; errors via existing `errorHandler` envelope. `confirm` re-uses/extends the logic behind `POST /auth/onboarding/complete` so the gate semantics stay identical and its tests keep protecting us.

---

## 7. Client UI (answers "how will the chatbot look")

A **mobile-first chat** screen replacing the form. Host messages left, user right, one input pinned above the keyboard, typing dots while awaiting the reply, and a **Confirm/Edit card** at the end.

**Host presence (decided 2026-06-23, revised — see §0): no sheep, no bot, but a *beautiful* animated presence.** There is **no mascot and no avatar image**. The host is named **"Reason"** and comes alive through a **premium animated sequence** — a cinematic entrance plus reactive motion (the presence subtly responds while "thinking"/typing and as each beat lands). V1 builds this with **framer-motion + CSS** (already in deps — zero new packages): an animated gradient/aurora "presence" that breathes and morphs, fade/slide-in messages, and animated typing dots — tuned to feel elegant and alive, not gimmicky. Kept behind a small swappable **`<HostPresence/>`** component so a richer hand-designed sequence (Lottie / Rive / lightweight WebGL) can drop into the same slot later if we want to push it further. This honors both "no sheep / human feeling" and "make it look cool."

```
┌───────────────────────────────┐        Confirm step:
│  reason  ·  onboarding         │        ┌───────────────────────────────┐
│───────────────────────────────│        │  Here's what I understood       │
│ ┌───────────────────────────┐ │        │                                 │
│ │ Welcome to RSN. I believe │ │        │ You want to meet revenue-stage  │
│ │ you're here for a reason.  │ │        │ B2B founders stuck on sales.    │
│ │ What kind of person would │ │        │ Your reason: help them see why  │
│ │ you like to meet?         │ │        │ customers buy. You're a founder │
│ └───────────────────────────┘ │        │ & advisor in B2B sales.         │
│        ┌────────────────────┐ │        │                                 │
│        │ Serious B2B founders│ │        │  [ Looks right → Save ]         │
│        └────────────────────┘ │        │  [ Edit ]                       │
│ ┌───────────────────────────┐ │        └───────────────────────────────┘
│ │ What makes a founder       │ │
│ │ "serious" for you?  ···    │ │        States handled: typing, error/retry,
│ └───────────────────────────┘ │        "I don't know" → offer categories,
│───────────────────────────────│        resume in_progress, weak-profile nudge
│ [ Type your answer…      ] (→)│ │        ("Continue anyway / Sharpen reason").
└───────────────────────────────┘
```
- Reuses existing `ui/` primitives + Tailwind tokens (`rsn-red`, etc.) so it matches the product.
- Responsive at 360 / 390–414 / 768 / 1024 / 1280+, ≥44px tap targets, `env(safe-area-inset-*)`, input not covered by the on-screen keyboard — verified with Playwright at those widths before "done" (global responsive rule).
- Opening line is locked (§0): *"We believe you're here for a reason — do you mind sharing that reason with us?"* Voice is **"we"** (the Reason team); tone is the canvas "calm host", never "Hi, I'm your AI assistant".

---

## 8. How this helps the system (answers "how will this help")

1. **Higher completion + richer data** — a 2-minute conversation beats a 12-field form; the model also turns vague answers ("meet founders") into sharp, structured intent.
2. **Immediately upgrades the existing in-event matcher** — dual-writing better `reasons_to_connect` + tags means round-matching can weight by *reason*, not just co-presence (`matches.reason_tags`/`score` already exist).
3. **Creates the asset the overhaul is built on** — structured *intent* data (not profile data), with `matching_tags` + `embedding_text` + `confidence` staged for the future global "match by reason" layer and the REASON pivot — without building those yet.
4. **Quality signal** — `profile_strength` + `confidence` flag weak profiles for admin review and re-prompting.
5. **Clean seam** — the LLM lives behind one service; swapping models, adding streaming, or adding the extraction-only re-run later are all local changes.

---

## 9. Build plan (phased, TDD, each phase verified)

- **P0 — setup:** feature branch off `main` in `RSN-dev`; add `@anthropic-ai/sdk`; `config.anthropicApiKey` + model IDs; `ANTHROPIC_API_KEY` in local `.env` + Render secret; `.env.example` placeholder; render.yaml env entry.
- **P1 — data:** migration `0NN_onboarding_intent.sql` (+ down) ; `shared/src/types/onboarding.ts` ; zod `IntentSchema`. Unit-test schema + migration applies.
- **P2 — server:** `chatbot.service.ts` (2 Claude calls) + `intent.repo.ts` (dual-write) + `routes/onboarding.ts` (+ rate-limit). TDD: extraction maps to columns; confirm flips gate; status gate; rate-limit caps. Mock the SDK in unit tests.
- **P3 — client:** `ChatbotOnboarding.tsx` replacing the form; wire `authStore` + gate; mobile-first.
- **P4 — verify:** headed Playwright smoke — login → chat → confirm → assert `user_intent_profiles` row written, `users` dual-write present, `profile_complete=true`, gate flips; responsive checks at all widths.
- **P5 — ship:** full server test suite green → staging → CI → main → deploy verify → `/checkhole`.

**Acceptance criteria (from canvas §36):** chat opens post-login for new users; feels like a conversation, not a form; the 3 core inputs are extracted; user confirms before save; JSON persists to the profile; tags generated; privacy field stored; admin can inspect; completes under 2 minutes.

---

## 10. Risks & mitigations

- **Cost/abuse** → Redis rate-limit on `/chat`; Haiku is cheap; cap conversation length server-side.
- **Vague/junk input** → host clarifies (canvas §16/§29); weak-profile path still saves + flags for review.
- **LLM/JSON failure** → `messages.parse` validates+retries; on hard failure, fall back to a minimal form capturing the 5 gate fields so signup is never blocked.
- **Latency** → Haiku + non-streaming per turn is fast; SSE streaming is the upgrade if needed.
- **Regression of the gate** → reuse the existing completion path; its tests stay green.

## 11. Open questions — RESOLVED (2026-06-23)
- Language: **English only** for V1 (§0).
- Fallback: **chat-only with a silent minimal-form fallback** on LLM outage (§0) — the 5 gate fields, so signup is never blocked.
- Host visual: **no sheep / no bot — a beautiful animated presence** (framer-motion + CSS, swappable `<HostPresence/>`) (§0, §7).
