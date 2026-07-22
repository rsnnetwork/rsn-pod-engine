# RSN Overhaul — The Truthful Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source spec:** `Desktop\RSN\assets\RSN Overhaul 21st june.pdf` (Stefan + Claus meeting directive).
**Audit basis:** Full-stack audit of `origin/main` @ `a361295` performed 2026-07-22 (six parallel deep audits: enrichment, chatbot, gating, admin, match loop, DB/Redis/infra). Every file:line reference below was verified against that commit.

**Goal:** Prove one complete, truthful human-connection loop — join request → approval → correct LinkedIn data → honest onboarding conversation → structured profile → matching → meeting request → clear notification → acceptance → shared conversation → agreed meeting — with Stefan, Claus, and Ali as the first controlled test group.

**Architecture:** Replace the Claude web-search identity guess with a deterministic ScrapingDog fetch of the exact LinkedIn URL behind a provider interface; introduce a real enrichment state machine (searching/found/partial/not_found/failed) that drives four truthful chatbot openings; force every existing user through onboarding via a status-based route guard (the DB discriminator already exists for free); expose the already-stored onboarding transcripts plus DMs/reports through a new per-user admin inspector; and close the loop's two notification holes (no acceptance notification, no email). Everything reuses the existing rails: `EnrichResult` seam, `user_intent_profiles`, poke → DM → meeting-windows.

**Tech Stack:** Node/Express + pg (Neon), React/Vite, Socket.IO, Redis (ephemeral only), ScrapingDog LinkedIn API (new), Anthropic Haiku (chat/extract stays), Jest + Playwright.

## Global Constraints

- **No AI attribution anywhere in git** — no Co-Authored-By, no "Generated with", no 🤖 (standing rule).
- **Mobile-first responsive, verified at 360 / 390 / 768 / 1024 / 1280 px** on every UI change (standing rule).
- User-visible copy says **"event"**, never "session".
- **Ship process: one workstream per deploy** — fix → full server jest suite → headed Playwright smoke on prod → /checkhole → next (standing per-bug ship process; FULL suite, not just touched files).
- Branch flow: feature branch → staging (CI) → fast-forward main → Render autodeploys. Never push main directly.
- Migrations are **additive only** (new columns nullable/defaulted; enum additions; no destructive change). Migrations auto-run on server boot.
- **Migration numbering:** main is at `077_circle_wall.sql` as of the audit. Numbers below assume 078+ — **re-check `ls server/src/db/migrations | tail` at execution time** and renumber if parallel work landed.
- New server secrets (SCRAPINGDOG_API_KEY) must be added **manually in the Render dashboard** (autoDeploy ships code only; render.yaml autoSync is OFF; there is no env validation — a missing key silently defaults to `''`).
- Real secrets never leave local; `.env.example` gets placeholders only.
- Anthropic prod key is **prepaid** — check balance before any live test marathon.
- **Explicitly out of scope** (the spec's don't-build list): voice onboarding, circles expansion, complex scheduling/calendar-OAuth, large-scale event features, beautiful admin design, multilingual behaviour, new profile features, speculative matching concepts, embeddings/pgvector (`embedding_text` stays staged and unread).

## Definition of Done (from the spec — the only exit criteria)

1. The correct LinkedIn person is retrieved (every time, from the exact submitted URL, with photo, current title/company, history).
2. The bot never pretends it has data it does not have (four state-driven openings).
3. Onboarding produces usable structured matching data (schema extension, Stefan-confirmed).
4. All onboarding conversations are visible internally (admin inspector, incl. failures + per-stage timing).
5. Stefan, Claus and Ali are correctly matched to each other.
6. A meeting request can be sent, accepted and discussed (with clear notifications both directions).
7. No one needs Ali to explain what to press.

## Open decisions (need Ali/Stefan before the marked tasks)

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| D1 | ScrapingDog account + billing (~$40/mo entry plan, ~1k free trial credits). Who signs up? (Stefan owns Anthropic billing today.) | A5+ live | Ali signs up with dev@rsn.network, Stefan reimburses; trial credits cover all of dev+testing |
| D2 | Profile photo policy: LinkedIn photo overwrites an existing Google avatar? | A7 | Yes — spec demands "correct profile photo"; Google stays as fallback when LinkedIn has none |
| D3 | Admin reading member DMs: role=ADMIN with audit-logging, or SUPER_ADMIN only? | E4 | ADMIN + mandatory audit_log row per access (spec explicitly wants this visibility during first-users phase) |
| D4 | Extraction schema extension (Task C1 field list) | C1 | Send Stefan the proposed field list from C1 as *his* "minimum structured profile" draft to confirm — he asked to define it |
| D5 | Email notifications on meet-request + acceptance | F2 | Yes — a logged-out founder otherwise never learns about the request and the 3-person test stalls |

## Sequencing

```
A (provider)  ──→  B (truthful states)  ──→  D (re-onboard gate)
      │                                          │
      └──→  E (admin inspector)                  │
C (schema, parallel any time after A) ───────────┤
F (loop notifications + E2E + founder run) ← after B+D+E
```

Estimated effort: A ≈ 1.5 days · B ≈ 1 day · C ≈ 0.5 day · D ≈ 1 day · E ≈ 2 days · F ≈ 1 day + live founder session.

---

# Workstream A — ScrapingDog LinkedIn provider (spec priority 1)

**Current state (audited):** Claude web_search is hardwired in `server/src/services/onboarding/enrichment.service.ts` (`runEnrichOnce` L217-228, Haiku→Sonnet escalation L240-251). It cannot open LinkedIn pages, found the wrong Claus, works ~half the time. The wrong-person guard (`applyMatchVerification` L169-177) only fires when the model self-reports a *different* URL. No photo capture. No state machine — "state" is an implicit confidence number with three inconsistent thresholds (0.15/0.35/0.6). No timing or failure logging. The one clean seam: **every consumer depends only on the `EnrichResult` shape** (route `onboarding.ts:157`, `enrichment.repo`, `intent.repo`, `join-request.service.ts:242`, `identity.service.ts:482/652`, client card).

**Design:** `EnrichmentProvider` interface; ScrapingDog fetches the exact `linkId` slug → identity is correct **by construction**. A cheap no-tools Haiku pass afterwards derives the conversational extras (`likelyWantsToMeet`, `conversationStarters`, `questionsToVerify`) from the real fetched facts — it can no longer hallucinate identity because it isn't searching. Claude web-search is retired from the identity path (per spec: "Do not let Claude guess which person the user is"); no LinkedIn URL → no enrichment → the `not_found` opening ("Let us build it together"). Enrichment becomes a **server-side background job with a DB state machine**; the client polls status instead of holding a 70s request.

### Task A1: Config + env plumbing

**Files:**
- Modify: `server/src/config/index.ts` (~L59-65, next to `anthropicApiKey`)
- Modify: `server/.env.example`, `render.yaml` (envVars block, `sync: false` entry)

**Interfaces:**
- Produces: `config.scrapingdogApiKey: string`, `config.enrichProvider: 'scrapingdog' | 'claude_web' | 'none'`

- [ ] **Step 1:** Add to config:

```ts
scrapingdogApiKey: process.env.SCRAPINGDOG_API_KEY || '',
// rollback switch: 'scrapingdog' (default), 'claude_web' (old path), 'none' (kill)
enrichProvider: (process.env.ENRICH_PROVIDER || 'scrapingdog') as 'scrapingdog' | 'claude_web' | 'none',
```

- [ ] **Step 2:** `SCRAPINGDOG_API_KEY=` placeholder in `.env.example`; `- key: SCRAPINGDOG_API_KEY` / `sync: false` in render.yaml. Commit.
- [ ] **Step 3 (external, D1):** Ali creates the ScrapingDog account, puts the real key in `RSN-dev/server/.env` locally and in the **Render dashboard** env vars (manual — see Global Constraints).

### Task A2: Discovery — record the real response shape

**Files:**
- Create: `e2e/scrapingdog-discover.mjs` (throwaway, gitignored pattern like other `.mjs` smokes)
- Create: `server/src/__tests__/fixtures/scrapingdog-profile.json` (recorded fixture, secrets stripped)

- [ ] **Step 1:** Script: `GET https://api.scrapingdog.com/linkedin/?api_key=$KEY&type=profile&linkId=<slug>&private=true` for Ali's own profile slug; print status + full JSON; handle `202` by retrying every 20 s up to 6 times. (Statuses per ScrapingDog docs: 200 = data; 202 = still scraping, uncharged, retry; 400/404 = unavailable.)
- [ ] **Step 2:** Run it for Ali's profile; save the exact 200 body as the fixture. Record which fields exist for: full name, headline, photo URL, location, about, experience array (title/company/duration), education. **The A3 mapping is finalized against this fixture** — field names below are the expected ScrapingDog names, adjust to what the fixture actually shows.

### Task A3: The provider + mapping (TDD)

**Files:**
- Create: `server/src/services/onboarding/providers/scrapingdog.provider.ts`
- Create: `server/src/services/onboarding/providers/provider.types.ts`
- Test: `server/src/__tests__/services/onboarding/scrapingdog.provider.test.ts`

**Interfaces:**
- Consumes: `config.scrapingdogApiKey`, existing `linkedinSlug()` / `normalizeLinkedinUrl()` (enrichment.service.ts L141-160 — export them), existing `EnrichResult`/`EnrichedProfile` (L65-93).
- Produces:

```ts
// provider.types.ts
export type ProviderOutcome =
  | { kind: 'found'; result: EnrichResult; photoUrl: string | null }
  | { kind: 'partial'; result: EnrichResult; photoUrl: string | null; missing: string[] }
  | { kind: 'not_found'; reason: string }        // 400/404/410 — profile genuinely unretrievable
  | { kind: 'retry_exhausted' }                   // 202s past the deadline
  | { kind: 'provider_error'; reason: string };   // network / 5xx / bad key
export interface EnrichmentProvider {
  readonly name: 'scrapingdog' | 'claude_web';
  enrich(input: { linkedinUrl: string; fullName?: string }): Promise<ProviderOutcome>;
}
```

Also: `EnrichedProfile` gains `photoUrl: string | null` (additive; all existing consumers ignore it).

- [ ] **Step 1: Failing tests first** (mock `fetch` via jest):

```ts
// scrapingdog.provider.test.ts — the shape, one test per behavior
it('maps a 200 profile to EnrichResult with confidence 0.95 and echoes the requested URL', ...)
it('returns partial with missing[] when headline/experience are absent', ...)
it('returns not_found on 404 and 400', ...)
it('retries on 202 up to maxAttempts then retry_exhausted', ...)   // use fake timers
it('returns provider_error on network failure and 5xx', ...)
it('derives the slug from a full URL with query params and trailing slash', ...)
```

- [ ] **Step 2:** Verify all fail. **Step 3:** Implement:

```ts
// scrapingdog.provider.ts (core; field names finalized against the A2 fixture)
const BASE = 'https://api.scrapingdog.com/linkedin/';
const RETRY_DELAY_MS = 20_000, MAX_ATTEMPTS = 6, FETCH_TIMEOUT_MS = 30_000;

async function fetchOnce(slug: string): Promise<{ status: number; body?: any }> {
  const url = `${BASE}?api_key=${config.scrapingdogApiKey}&type=profile&linkId=${encodeURIComponent(slug)}&private=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, body: await res.json() };
}

function mapProfile(raw: any, requestedUrl: string): { profile: EnrichedProfile; missing: string[] } {
  const p = Array.isArray(raw) ? raw[0] : raw;
  const exp: any[] = p.experience ?? [];
  const current = exp[0] ?? {};
  const profile: EnrichedProfile = {
    fullName: p.fullName ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? null,
    headline: p.headline ?? null,
    currentRole: current.position ?? current.title ?? null,
    currentCompany: current.company_name ?? current.company ?? null,
    industry: p.industry ?? null,
    location: p.location ?? null,
    summary: p.about ?? null,
    pastRoles: exp.slice(1).map((e: any) => ({ role: e.position ?? e.title ?? null, company: e.company_name ?? e.company ?? null, duration: e.duration ?? null })),
    education: p.education ?? [],
    skills: p.skills ?? [],
    photoUrl: p.profile_photo ?? p.profile_pic_url ?? null,
    likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [], questionsToVerify: [],
    linkedinUrl: requestedUrl,
  };
  const missing = (['headline', 'currentRole', 'currentCompany'] as const).filter((k) => !profile[k]);
  return { profile, missing };
}

export const scrapingdogProvider: EnrichmentProvider = {
  name: 'scrapingdog',
  async enrich({ linkedinUrl }) {
    const slug = linkedinSlug(linkedinUrl);
    if (!slug) return { kind: 'not_found', reason: 'no /in/ slug in submitted URL' };
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { status, body } = await fetchOnce(slug);
        if (status === 200) {
          const { profile, missing } = mapProfile(body, normalizeLinkedinUrl(linkedinUrl)!);
          const result: EnrichResult = {
            profile, confidence: missing.length === 0 ? 0.95 : 0.7,
            sources: [`scrapingdog:${slug}`], foundLinkedinUrl: normalizeLinkedinUrl(linkedinUrl),
            requestedLinkedinUrl: normalizeLinkedinUrl(linkedinUrl), enrichedAt: new Date().toISOString(),
          };
          return missing.length === 0
            ? { kind: 'found', result, photoUrl: profile.photoUrl }
            : { kind: 'partial', result, photoUrl: profile.photoUrl, missing };
        }
        if (status === 202) { await sleep(RETRY_DELAY_MS); continue; }
        if ([400, 404, 410].includes(status)) return { kind: 'not_found', reason: `scrapingdog ${status}` };
        return { kind: 'provider_error', reason: `scrapingdog ${status}` };
      }
      return { kind: 'retry_exhausted' };
    } catch (err) {
      return { kind: 'provider_error', reason: err instanceof Error ? err.message : 'unknown' };
    }
  },
};
```

- [ ] **Step 4:** Tests green. **Step 5:** Commit `feat(enrichment): ScrapingDog provider with typed outcomes`.

### Task A4: Enrichment state machine (migration 078)

**Files:**
- Create: `server/src/db/migrations/078_enrichment_state.sql`
- Modify: `server/src/services/onboarding/enrichment.repo.ts`
- Test: `server/src/__tests__/services/onboarding/enrichment.repo.test.ts` (extend)

**Interfaces:**
- Produces: `enrichRepo.setEnrichmentState(userId, state: EnrichmentDbState)`, `enrichRepo.getEnrichmentState(userId)` where

```ts
type EnrichmentStatus = 'none' | 'searching' | 'found' | 'partial' | 'not_found' | 'failed';
interface EnrichmentDbState { status: EnrichmentStatus; source: string | null; error: string | null; startedAt: string | null; completedAt: string | null; }
```

- [ ] **Step 1:** Migration:

```sql
-- 078_enrichment_state.sql — single source of truth for enrichment state
-- (replaces the implicit 0.15/0.35/0.6 confidence thresholds as state)
DO $$ BEGIN
  CREATE TYPE enrichment_status AS ENUM ('none','searching','found','partial','not_found','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE user_intent_profiles
  ADD COLUMN IF NOT EXISTS enrichment_status enrichment_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS enrichment_source TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_error TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_completed_at TIMESTAMPTZ;
```

- [ ] **Step 2:** Repo functions upsert into `user_intent_profiles` (same upsert pattern as `saveEnrichedCandidate` L21-31). Failing test → implement → green. Commit.

### Task A5: Rewire `enrichProfile` through the provider registry + background job

**Files:**
- Modify: `server/src/services/onboarding/enrichment.service.ts` (add `runEnrichment(userId, input)` orchestrator; keep old `enrichProfile` exported for the `claude_web` fallback path)
- Modify: `server/src/routes/onboarding.ts` `POST /onboarding/enrich` (L119-173)
- Modify: `server/src/services/join-request/join-request.service.ts` L242-248 (preload path uses the same orchestrator)
- Test: `server/src/__tests__/services/onboarding/enrichment.orchestrator.test.ts`

**Interfaces:**
- Produces: `runEnrichment(userId: string, input: { linkedinUrl: string | null; fullName?: string }): Promise<void>` — fire-and-forget-safe; writes state transitions + result blob; **never throws**.
- `POST /onboarding/enrich` now returns `202 { status: 'searching' }` immediately (or `200 { status }` when cache-fresh); client learns the outcome by polling (Task B2).

**Orchestrator logic (implement exactly):**
1. If `config.enrichProvider === 'none'` or no `linkedinUrl` → state `not_found` (`error: 'no linkedin url'` only in the null-URL case), return.
2. Keep the existing **90-day cache check** (onboarding.ts L140-154 moves into the orchestrator): fresh cache + same slug → ensure status reflects cached outcome, return.
3. Write `searching` + `enrichment_started_at = NOW()`. Log `{ userId, slug, provider }`.
4. Call provider (registry: `scrapingdog` default, `claude_web` legacy via config flag). Measure `Date.now()` delta.
5. On `found`/`partial`: run the **facts-grounded extras pass** — one no-tools Haiku call (`config.onboardingChatModel`, max_tokens 800) with the fetched profile JSON as input: "From these verified facts only, suggest likelyWantsToMeet, likelyOffers, 3 conversationStarters, questionsToVerify. JSON only." Merge into `result.profile`. On extras failure: proceed without extras (log, don't fail the enrichment).
6. `saveEnrichedCandidate(userId, result)` + `setEnrichmentState` → `found`/`partial` + `completedAt`; kick photo task (A7).
7. On `not_found` / `retry_exhausted` / `provider_error`: state `not_found` or `failed` (+`enrichment_error = reason`), **persisted, not just logged** — the spec demands visible failed searches.
8. Every terminal transition logs `{ userId, provider, outcome, durationMs }` and records a stage event (E1).
9. The Haiku→Sonnet escalation loop (L240-251) is **not used** for scrapingdog (identity is deterministic); it remains only inside the legacy `claude_web` path.

- [ ] Steps: failing orchestrator tests (each transition, cache path, extras-failure tolerance, never-throws) → implement → route rewire (auth + same rate limits; 503 only when provider `none` AND no key) → join-request preload calls `runEnrichment`-equivalent against `join_requests.enriched` (same provider, same logging, stays fire-and-forget) → full server suite green → commit `feat(enrichment): provider registry, state machine, background orchestration`.

### Task A6: Verification belt stays

- [ ] Keep `applyMatchVerification` (L169-177) applied to provider results (slug equality is now tautological for scrapingdog — it's the belt for the `claude_web` legacy path and for future providers). One test: scrapingdog result passes through unchanged. Commit with A5.

### Task A7: Profile photo capture + serving

**Files:**
- Create: `server/src/db/migrations/079_avatar_blob.sql`
- Create: `server/src/services/onboarding/avatar.service.ts`
- Modify: `server/src/routes/users.ts` (add `GET /users/:id/avatar`)
- Modify: orchestrator (A5 step 6 calls `captureAvatar`)
- Test: `server/src/__tests__/services/onboarding/avatar.service.test.ts`

**Interfaces:**
- Produces: `captureAvatar(userId: string, photoUrl: string): Promise<boolean>`; public `GET /api/users/:id/avatar` → image bytes with `Cache-Control: public, max-age=86400`.

- [ ] **Step 1:** Migration:

```sql
-- 079_avatar_blob.sql — LinkedIn photos are served from expiring CDN URLs;
-- we download once and serve from our own endpoint. BYTEA is fine at current
-- scale (<1k users, ~100KB each); revisit with object storage past ~10k users.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_blob BYTEA,
  ADD COLUMN IF NOT EXISTS avatar_blob_type TEXT;
```

- [ ] **Step 2 (TDD):** `captureAvatar` downloads (10s timeout, max 2MB, content-type must be `image/*`), stores blob + type, and sets `users.avatar_url = '/api/users/' + userId + '/avatar'` **per D2: LinkedIn photo wins; skip overwrite only if download fails**. Serve endpoint streams the blob, 404 when absent. Failure never breaks enrichment (returns false, logs, stage event).
- [ ] **Step 3:** Client check — every avatar render uses `user.avatar_url` already, so no client change; verify with one Playwright assert in F4. Full suite → commit `feat(enrichment): capture LinkedIn profile photo`.

### Task A8: Live verification (gate to ship A)

- [ ] With the real key in local `.env`: run onboarding enrich for **Ali, Stefan, Claus** URLs (the exact three the loop needs — Claus is the known wrong-person case). Assert: correct person, photo bytes served, title/company current, states land `found`, durations logged. If Claus's profile is CAPTCHA-gated, confirm `private=true` handles it; if a field never arrives, adjust the A3 mapping to the real fixture.
- [ ] Ship A per ship process (full suite → staging → main → headed prod smoke → /checkhole). **Add the key to Render dashboard before merging to main.**

---

# Workstream B — Truthful state-driven openings (spec priority 2)

**Current state (audited):** The opening is client-picked from exactly two strings, branched only on `known?.reason` (`ChatbotOnboarding.tsx:347/506/514` — L347's branch even reads stale state and always yields `FIRST_QUESTION`). Enrichment runs concurrently with chat; the host may imply knowledge while the search is still running. A dead third opening (`ONBOARDING_OPENING_LINE`, `shared/src/types/onboarding.ts:13`) is unused. The spec's four state-driven openings do not exist.

**Design:** The server owns the opening. `GET /onboarding/status` returns the enrichment state + the opening variant; the client shows a **Searching** wait state (polling every 2.5 s) and only opens the chat when the state is terminal. The host system prompt receives the state and is explicitly forbidden from claiming unreviewed knowledge.

### Task B1: Server — status endpoint carries enrichment state + opening

**Files:**
- Modify: `server/src/routes/onboarding.ts` `GET /onboarding/status` (L67-82)
- Modify: `shared/src/types/onboarding.ts` (replace the dead `ONBOARDING_OPENING_LINE` with the real four)
- Test: extend `server/src/__tests__/routes/onboarding.test.ts`

**Interfaces:**
- Produces on `GET /onboarding/status`:

```ts
{
  status: OnboardingStatus,                    // existing
  enrichment: { status: EnrichmentStatus, error: string | null, startedAt: string | null, completedAt: string | null },
  opening: 'searching' | 'found' | 'partial' | 'not_found'   // searching only while non-terminal
}
```

- Shared copy (exact spec wording):

```ts
export const OPENINGS = {
  searching: 'I am retrieving your public profile. This normally takes less than a minute.',
  found: 'I found your profile. Let me confirm what I understand about you.',
  partial: 'I found part of your profile, but I need your help filling the gaps.',
  not_found: 'I could not reliably identify your profile. Let us build it together.',
} as const;
```

Mapping: `searching → searching`; `found → found`; `partial → partial`; `none | not_found | failed → not_found` (a failure and a genuine miss read the same to the member; the difference is admin-visible via `enrichment_error`).

- [ ] TDD: one test per mapping row → implement → green → commit.

### Task B2: Client — wait state, polling, state-driven chat open

**Files:**
- Modify: `client/src/features/onboarding/ChatbotOnboarding.tsx` (stage machine L29, effects L304-370, openings L22-27, sendTurn)
- Test: `e2e/tests/onboarding-states.spec.ts` (new, headed)

**Behavior to implement exactly:**
1. New stage `'searching'` between `loading` and `confirm`/`chat`: full-screen calm card with the `searching` copy + HostPresence thinking animation; polls `GET /onboarding/status` every 2.5 s; transitions when `opening !== 'searching'`. After 3 minutes of searching, treat as `not_found` (server will have hit `retry_exhausted` long before).
2. The first assistant bubble = `OPENINGS[opening]` followed by the existing question flow (`known?.reason` still selects whether the reason question is skipped — that logic is orthogonal and stays). Remove the stale-state defect at L347 by deriving the opening exclusively from the fetched status payload, never from component state races.
3. `found`/`partial` keep the existing confirm-card ("Is this you?" / field confirmation) before chat; `not_found` skips the card entirely and goes straight to build-together chat.
4. Kill the client-side 70 s enrich timeout + silent 503 swallow (L406-444) — the server job owns retries now; the client only reads states.
5. Responsive at 360/390/768/1024/1280 (standing rule); the wait card must respect `100dvh` + safe-area like the rest of the component.
- [ ] Playwright spec: stub the status endpoint per state → assert the four openings render, searching blocks chat, not_found never shows a confirm card. Commit.

### Task B3: Host prompt honesty clause

**Files:**
- Modify: `server/src/services/onboarding/prompts.ts` (`buildHostSystemPrompt` L65-100), `server/src/routes/onboarding.ts` chat handler (L203-247 passes state)
- Test: extend `server/src/__tests__/services/onboarding/prompts.test.ts`

- [ ] Add to the host system prompt, driven by the actual state:
  - `found/partial`: "We retrieved parts of their public profile. Confirm facts before building on them. Never invent facts not present in the known-profile block."
  - `not_found`: "We could NOT retrieve their profile. Never imply we reviewed anything. Build their profile together from their answers."
  - `searching` never reaches the chat (B2 gates it), but if it does, treat as `not_found`.
- [ ] Unit test: prompt contains/omits the clauses per state. Full suite → ship B per ship process.

---

# Workstream C — Extraction schema extension (Stefan's "minimum structured profile")

**Current state (audited):** `IntentSchema` (`server/src/services/onboarding/intent.schema.ts:15-55`) covers most of the target but is missing: **languages**, **whatProblemTheySolve**, **whatWouldMakeAMeetingValuable**, **authorityLevel**, and ALL structured restrictions (**noCompetitors**, **geoRestrictions**, **industryExclusions**, **seniorityExclusions**, **languageRequirements**). `embedding_text` is written but never read — leave as is (out of scope).

### Task C1: Propose the field list to Stefan (D4)

- [ ] Draft (send via Ali, plain prose per client-message style): the current schema + these additions:

```ts
// additions to IntentSchema (all nullable/empty-safe — the extractor must
// return empty rather than guess):
userLanguages: z.array(z.string()),            // Identity: languages
problemTheySolve: z.string(),                  // Professional reality
authorityLevel: z.string(),                    // e.g. "final decision maker", "influences budget", "individual contributor"
needsHelpWith: z.array(z.string()),            // Meeting intent (explicit, not implied by desiredOutcome)
meetingValueCriteria: z.string(),              // "what would make a meeting valuable"
restrictions: z.object({
  noCompetitors: z.boolean(),
  competitorNote: z.string().nullable(),
  geography: z.array(z.string()),              // exclusions or requirements, free-form normalized
  industriesToAvoid: z.array(z.string()),
  seniorityToAvoid: z.array(z.string()),
  requiredLanguages: z.array(z.string()),
}),
```

### Task C2: Implement once confirmed (TDD)

**Files:**
- Modify: `intent.schema.ts` (zod + `INTENT_JSON_SCHEMA` mirror L68-120), `shared/src/types/onboarding.ts:42-85`, `prompts.ts` `EXTRACTION_PROMPT` (L102-122) + host guidance to actually ask about restrictions/languages/authority, `intent.repo.ts` (blob write is automatic via `matching_intent` JSONB; add `users` promotions only for `languages` → existing `users.languages text[]`)
- Test: extend `server/src/__tests__/services/onboarding/intent.schema.test.ts` + extraction prompt test

- [ ] Failing tests (parse fixture with new fields; reject wrong shapes) → schema + JSON-schema mirror + prompt additions → green → full suite → ship C (can ride along with B or D deploy).
- **Note:** no migration needed — new fields live inside `matching_intent` JSONB; only `userLanguages` promotes to the existing `users.languages` column.

---

# Workstream D — Every existing user completes onboarding (spec priority 3)

**Current state (audited):** Migration 033 backfilled ALL existing users to `onboarding_completed = true`; migration 069 later added `onboarding_status` defaulting `'not_started'` — so the discriminator **already exists**: old-era users are exactly `onboarding_completed=true AND onboarding_status='not_started'`. The client never sees `onboarding_status` (session payload omits it, `auth.ts:127-157`); `ProtectedRoute` is auth-only (legacy gate behind an off-by-default env flag); nudges are a dismissible banner + once-per-session modal. **Redirect-loop trap:** the fallback form's `POST /auth/onboarding/complete` (auth.ts:281-370) sets `onboarding_completed` but NOT `onboarding_status` — with a status-keyed gate this loops forever. **The enum's `update_required` value is unhandled** in `markInProgress` (intent.repo.ts:121-127) and `savePartialIntent`'s re-arm guard (L407-410).

### Task D1: Server — surface the status + close the loop trap

**Files:**
- Modify: `server/src/routes/auth.ts` (session payload L127-157; `POST /auth/onboarding/complete` L326-361)
- Modify: `server/src/services/identity/identity.service.ts` `getUserById` (~L86 select)
- Modify: `server/src/services/onboarding/intent.repo.ts` (L121-127, L359-363, L407-410: accept `'update_required'` everywhere `'not_started'` is accepted)
- Modify: `shared/src/types/user.ts` (declare `onboardingStatus`, `lastOnboardedAt` — kill the `(user as any)` casts)
- Test: extend auth route tests + intent.repo tests

- [ ] TDD each: session returns `onboardingStatus`; form-complete sets `onboarding_status='completed', last_onboarded_at=NOW()`; `update_required` transitions to `in_progress` on first chat turn and re-arms partial saves. Green → commit.

### Task D2: The gate

**Files:**
- Modify: `client/src/components/layout/ProtectedRoute.tsx` (replace the `VITE_LEGACY_ONBOARDING_GATE` block L31-44)
- Test: `client` typecheck + `e2e/tests/reonboarding-gate.spec.ts` (new)

- [ ] Implement (same shape as the legacy block it replaces):

```tsx
const status = user.onboardingStatus;
const needsOnboarding = status !== undefined && status !== 'completed';
const exempt =
  location.pathname === '/onboarding' ||
  location.pathname.startsWith('/invite/') ||
  (location.pathname.startsWith('/session/') && location.pathname.includes('/live'));
if (needsOnboarding && !exempt) {
  const safeRedirect = location.pathname.startsWith('/onboarding') ? '/' : location.pathname;
  return <Navigate to={`/onboarding?redirect=${encodeURIComponent(safeRedirect)}`} replace />;
}
```

  - **No role exemption** — Stefan, Claus and Ali (admins) are precisely the first cohort; the token-auth admin approve page (`/admin/jr/:token`) sits outside `ProtectedRoute` and keeps working mid-gate.
  - Keep the live-event + invite exemptions (audited necessity: `SessionGuard` route `/session/:id/live`, invite landing `/invite/:code`).
  - Remove the now-dead banner/modal special-casing only if it double-fires (banner keys on `onboardingCompleted===false` and won't show for re-onboarders — leave it).
- [ ] Playwright: an `update_required` user landing on `/` is redirected to `/onboarding`; completing the chat (or the fallback form) exits the gate and lands back on the redirect target; a `completed` user is untouched; `/invite/x` and live-session paths pass through. 

### Task D3: The backfill (migration 080) — LAST, after D1+D2 are live

**Files:**
- Create: `server/src/db/migrations/080_reonboard_existing_users.sql`

```sql
-- 080_reonboard_existing_users.sql — route every old-era account through the
-- new onboarding on next login (spec: "Old accounts should not bypass the new
-- process."). Old era = completed the pre-chatbot form (033 backfill) but
-- never produced chatbot intent data (069 default).
-- onboarding_completed stays TRUE so platform matching eligibility
-- (platform-match.service L194) is not regressed during the transition.
UPDATE users
SET onboarding_status = 'update_required'
WHERE onboarding_status = 'not_started'
  AND onboarding_completed = true;
```

- [ ] **Ship D1+D2 first, verify with a hand-flipped test user on prod, then ship D3** (it auto-runs on boot). Deploy outside any live event window (standing rule). Headed smoke: log in as an old-era test account → gated → complete → normal landing.

---

# Workstream E — Conversation storage visibility + admin inspector (spec priorities 4+5)

**Current state (audited):** Transcripts ARE stored per-turn (`user_intent_profiles.onboarding_conversation` JSONB, migration 069:44) — but the only reader is self-scoped `getResume`. No admin endpoint or UI reads it. No per-stage timing exists anywhere. DM routes are strictly self-scoped (`dm.service.canMessage`, participant-only `listMessages`). Two redundant report backends (`violations` = UI-wired; `user_reports` = richer, orphaned); **no user-facing report button exists at all**. `POST /onboarding/admin/refresh-enrichment` exists with no UI caller. There is no per-user admin page — admin rows deep-link to the public profile.

### Task E1: Stage-event telemetry (migration 081)

**Files:**
- Create: `server/src/db/migrations/081_onboarding_stage_events.sql`
- Create: `server/src/services/onboarding/stage-events.repo.ts`
- Modify: orchestrator (A5), chat route (first turn), confirm route, fallback-form route — each records its event
- Test: `server/src/__tests__/services/onboarding/stage-events.test.ts`

```sql
-- 081_onboarding_stage_events.sql — per-stage timing + failure trail for the
-- first-users observation phase (spec: "time taken for each stage",
-- "failed searches and errors").
CREATE TABLE IF NOT EXISTS onboarding_stage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN (
    'enrich_started','enrich_found','enrich_partial','enrich_not_found','enrich_failed',
    'photo_captured','photo_failed','chat_started','confirmed','fallback_form','extract_failed')),
  detail JSONB NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ose_user ON onboarding_stage_events(user_id, created_at);
```

- [ ] TDD repo (`record(userId, stage, detail?, durationMs?)` — never throws) → wire the emit points → green → commit.

### Task E2: Admin read API

**Files:**
- Create: `server/src/routes/admin-inspect.ts` (mount at `/api/admin` in `index.ts` next to L328-349)
- Test: `server/src/__tests__/routes/admin-inspect.test.ts`

**Interfaces (all `authenticate + requireRole(UserRole.ADMIN)`; D3 decision applies to the DM endpoints):**

```
GET /admin/users/:id/onboarding   → { linkedinUrl, enrichment: {status,source,error,startedAt,completedAt,result},
                                      conversation: [...], intent: {matchingIntent, tags, avoidPreferences,
                                      profileStrength, confidence}, stageEvents: [...], onboardingStatus, lastOnboardedAt }
GET /admin/users/:id/conversations → [{ conversationId, partner: {id,name,avatar}, lastMessageAt, messageCount, meetingConfirmedWindow }]
GET /admin/conversations/:id/messages → [{ id, fromUserId, content, attachmentUrl, createdAt }]   // writes audit_log row per call
GET /admin/users/:id/interactions  → { pokesSent: [...], pokesReceived: [...],                     // initiator visibility
                                       reports: [...union of violations + user_reports, both directions...],
                                       blocks: {given, received} }
```

- [ ] TDD: role-gated (member → 403), onboarding payload joins `users` + `user_intent_profiles` + `onboarding_stage_events`, DM read inserts `audit_log (action='admin_read_dm', entity_type='dm_conversation', entity_id, actor_id)` — assert the audit row in the test. Sources for the union: `violations` (020) + `user_reports` (049); pokes from `user_pokes` (047). Green → commit.

### Task E3: Admin inspector UI

**Files:**
- Create: `client/src/features/admin/AdminUserInspectorPage.tsx`
- Modify: `client/src/App.tsx` (route `/admin/users/:id` inside the admin block L196-205), `client/src/features/admin/AdminUsersPage.tsx` (row link → inspector instead of public profile)
- Test: `e2e/tests/admin-inspector.spec.ts`

- [ ] Four tabs, plain and usable (spec: "does not need to be elegant"): **Onboarding** (status, LinkedIn URL as link, enrichment state + error + durations, stage-event timeline, the full transcript as chat bubbles, the structured intent JSON, and a **Refresh enrichment** button wiring the existing `POST /onboarding/admin/refresh-enrichment` then re-triggering `POST /onboarding/enrich` on their behalf — finally giving that orphaned endpoint a caller); **Profile & Matching** (full user object via existing `GET /users/:id` admin path + intent data); **Conversations** (thread list → read-only message view; loud "access is audit-logged" banner); **Reports & Interactions** (union list + pokes both directions with dates → "who initiated"). Standard `isAdmin` page-shield like `AdminUsersPage.tsx:57`. Responsive per standing rule (tables → stacked cards under 768px).
- [ ] Playwright: admin opens inspector for a seeded user → sees transcript text, enrichment state, a DM thread, a report row; non-admin gets the shield. Ship E per ship process.

### Task E4: The report front door (closes the spec's "reports or complaints" input gap)

**Files:**
- Create: `client/src/components/ReportUserModal.tsx`
- Modify: `client/src/features/profile/PublicProfilePage.tsx` (overflow menu "Report"), `client/src/features/messages/MessagesPage.tsx` (thread-header menu "Report")
- Test: extend `e2e/tests/admin-inspector.spec.ts`

- [ ] Modal → existing `POST /api/reports` (routes/reports.ts L28, already auth-only) with the reason enum (spam/harassment/inappropriate_content/fake_profile/safety/other) + free text. Reports land in `user_reports` and are already read by E2's union. 44px targets, portal-to-body (standing modal-transform trap). Playwright: report from a profile → appears in the inspector's Reports tab.

---

# Workstream F — Close the loop + prove it with three humans (spec priority 6)

**Current state (audited):** The 9-step loop is ~80% built on the poke rails: platform matches (`/matches`, rule-based `scoreFit` = 0.7·termOverlap(wants,offers) + 0.6·designation, threshold 0.45, top-10, computed live), "I want to meet" → `expressInterest` → poke with composed intro, bell+socket to recipient, accept → DM conversation + seeded intro message, meeting windows (day+daypart, both-select-then-confirm). **The two holes:** (1) the sender gets NO notification on acceptance — only a silent badge refresh (`routes/pokes.ts:50`); (2) there is no email anywhere in the loop, so a logged-out founder never learns anything. Matching reads the chatbot's dual-written `users` columns (good — C's richer data flows in automatically), NOT `matching_intent`.

### Task F1: Acceptance notification (migration 082)

**Files:**
- Create: `server/src/db/migrations/082_notification_poke_accepted.sql` (extend the CHECK allowlist exactly like 074/075 did: drop constraint, re-add with `'poke_accepted'` included)
- Modify: `server/src/services/poke/poke.service.ts` `acceptPoke` (L146-227)
- Test: extend `server/src/__tests__/services/poke/poke.service.test.ts`

- [ ] In the accept transaction: insert notification for the **sender** — `type='poke_accepted'`, title `"{recipient} accepted your meeting request"`, body = first line of the intro, `link='/messages'` — then `io.to('user:{senderId}').emit('notification:new', ...)` + entity fanout, mirroring the sendPoke pattern (L90-126). TDD → green → commit.

### Task F2: Email for request + acceptance (D5)

**Files:**
- Modify: `server/src/services/poke/poke.service.ts` (sendPoke + acceptPoke)
- Reuse: the existing email service/templates layer (Resend; `email_config` toggles; the join-request fan-out in `join-request.service.ts:105` is the pattern to mirror)
- Test: service tests assert the mailer was called with recipient + subject; respect `users.notify_email`

- [ ] Two plain emails: "「name」 wants to meet you on RSN" (body = intro message + link to /messages) and "「name」 accepted your meeting request" (link to /messages). Fire-and-forget after commit, never blocks the transaction; honors `notify_email` + `email_config` kill-switches. TDD → green → commit.

### Task F3: The message-less poke edge (small)

- [ ] `acceptPoke` seeds the intro only when `poke.message` is non-empty (L203-213); a bare poke accepted → 0-message conversation that `canMessage` blocks (`not_mutual`, dm.service L138-165). Fix: when accepting with no message, seed a minimal system line `"You're connected. Say hello."` from the sender-side so the grandfather clause opens the thread. One unit test. (Platform loop always has a message; this is belt for organic pokes.) Commit with F1.

### Task F4: E2E — the whole loop, one spec

**Files:**
- Create: `e2e/tests/truthful-loop.spec.ts` (extends the assertions of `platform-match-loop.spec.ts` + `intro-scheduling.spec.ts` into one journey)

- [ ] Headed against prod with throwaway users (existing JWT-mint helpers `e2e/helpers/auth.ts`): user A onboards (mock-free: real chat against prod LLM, or stubbed status states when credits are a concern) → enrichment state lands → B onboards → A sees B in `/matches` with a reason → "I want to meet" → **B's bell shows the poke AND A's bell shows `poke_accepted` after B accepts** → conversation opens with the intro as first message → both pick overlapping windows → confirm → `meeting_confirmed` notification + pinned window. Assert outcome states (boundingBox-fit for fixed UI per standing rule), not just visibility. Clean up by ID.

### Task F5: Founder relevance pre-check + the live run

- [ ] **Pre-check (before the founders touch it):** after Ali/Stefan/Claus complete real onboarding on prod, run a one-off script (pattern: `e2e/matching-grand-prod.mjs`) printing `scoreFit` for the three pairs in both directions. If any pair scores < 0.45 (three founders may want "founders/investors" while offering similar things — a real risk with directional wants→offers scoring), tune per template weights or have the chatbot's `who_i_want_to_meet` capture make wants explicit — do NOT hack the threshold globally without seeing the numbers.
- [ ] **The live run (the actual milestone):** Stefan joins → approval → onboarding; Claus (the known wrong-person case — watch the enrichment land on the RIGHT Claus); Ali. Each sees the other two as matches; one full request→accept→chat→meeting-window round-trip between each pair. Run `/liveloop` during the session. Every hiccup becomes a bug with a stage-event/admin-inspector trail (that's what E was for).
- [ ] DoD walkthrough: check all 7 exit criteria against observed behavior; anything failing loops back into its workstream before calling the milestone done.

---

## Self-review (spec coverage)

| Spec requirement | Tasks |
|---|---|
| 1. ScrapingDog via exact URL, correct person/photo/title/history, clear error state | A1-A8 |
| 2. Four distinct data-state openings, no pretending | B1-B3 |
| 3. Every existing user through onboarding on next login | D1-D3 |
| 4. Store conversation + retrieved data + URL + errors + per-stage timing | already stored (069) + E1 (timing/errors) + E2 (access) |
| 5. Admin viewer: bot conversation, profile/matching data, member conversations, reports, initiator | E2-E4 |
| 6. Three-person loop: match → request → notify → accept → chat → meeting | F1-F5 (loop was ~80% built; F fills notification holes) |
| Stefan's structured-profile schema | C1-C2 (delta list ready for his confirmation) |
| "What not to build" list | Global Constraints — explicitly excluded |
