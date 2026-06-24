# SDD 08 — Matching Engine Phase 2 (one ship)

**Date:** 2026-06-25 · **Builds on:** Phase 1 (`f26c501`, onboarding-intent enhancement). **Source of truth:** `assets/RSN Matching Engine.md` (doc V1 remainder).
**Ship mode (Ali's call):** the whole of Phase 2 ships as **ONE deploy** (overrides SDD-00's one-item-per-deploy), but each item keeps full rigor: tests-first (every use + edge case), full local suite green with **zero broken pins**, then one ship, then **headed prod E2E for every use case and every edge case**, then `/checkhole`, then report. Nothing else in RSN may break.

## Items
- **P2-1** Match-storage completeness (template id, confidence, override flag; duration is derivable).
- **P2-2** Matching analytics (EXTEND the existing `/admin/analytics/*` — do not rebuild): template performance, fallback-quality, unmatched/poorly-matched users.
- **P2-3** Event intention at check-in (+ openness) → scoring overlay.
- **P2-4** Incomplete-profile scoring tiers.
- **P2-5** Structured designation + who-want/avoid categories (cleaner inputs for Phase-1 signals).
- **P2-6** Configurable rematch cooldown (a 4th matching policy with a duration).

## Migration 071 (additive, idempotent, no inner BEGIN/COMMIT)
- `ALTER TABLE matches ADD COLUMN IF NOT EXISTS matching_template_id UUID`, `ADD COLUMN IF NOT EXISTS confidence DECIMAL(5,4)`, `ADD COLUMN IF NOT EXISTS is_override BOOLEAN NOT NULL DEFAULT FALSE`.
- `ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS event_intention VARCHAR(60)`, `ADD COLUMN IF NOT EXISTS openness VARCHAR(20)`.
- (No cooldown column needed; cooldown months live in session/template `config` JSONB.)

---

## P2-1 — Match-storage completeness
**Why:** the doc's match record should capture template used, a confidence score, and whether the host overrode the auto pairing — the foundation for analytics/learning. Duration is already derivable from `started_at`/`ended_at`.

**Design (against live code):**
- `persistMatches` (matching.service.ts ~1118-1173) INSERT gains `matching_template_id`, `confidence`. Thread the resolved template id into the schedule/round flow (it's resolved when weights load, ~385-426) and into `persistMatches`.
- `confidence`: derive per pair from the engine's normalized score + fallback level (e.g. `confidence = score * (1 - 0.15*fallbackLevel)`), clamped 0..1. Add `confidence?: number` to `MatchPair` (shared/types/match.ts) and set it in the engine alongside `score`.
- `is_override`: set TRUE only on host manual pair-swaps (P3); for Phase 2 it defaults FALSE (column added now so analytics/storage are ready). `is_manual` already distinguishes manual breakouts.

**⚠ Adversarial review (REQUIRED amendments):**
- **PIN COLLISION:** `matching-engine-v1-spec.test.ts:213-218` regex-asserts the EXACT `persistMatches` INSERT column list (`match_reason, fallback_used, repeat_in_event, premium_influenced`). Adding columns breaks it. **Amendment:** update that pin's expected column list to include the new columns, with a comment noting the intentional Phase-2 addition.
- Template id may be null (sessions without a template) → column nullable; analytics must treat null as "default engine".

**Tests:** unit — engine sets `confidence` in 0..1 (and lower when fallback used); repo persists template id + confidence (mock query, assert INSERT params). Update the v1-spec pin. Edge: null template id, fallback pair confidence < fresh pair confidence.

---

## P2-2 — Matching analytics (EXTEND existing)
**Why:** see which templates/event-types produce the best conversations, how often fallback fires, and who is repeatedly unmatched — the doc's learning loop.

**Design:** the app ALREADY has `routes/admin.ts` `/admin/analytics/{overview,events,users,connections}` + `AdminAnalyticsPage.tsx` + a TTL cache, pinned by `phase-7c4-admin-analytics.test.ts`. **Add a new endpoint `GET /admin/analytics/matching`** (auth + requireRole(ADMIN), same read-through cache pattern + TTL constant) returning: per-template match count + avg rating + meet-again rate; fallback-level distribution (% of matches at each level, via `match_reason`/`fallback_used`); top "unmatched/bye" users (from round byes / `departed`); avg `confidence`. Add a **"Matching" tab** to `AdminAnalyticsPage`.

**⚠ Adversarial review:**
- **PIN:** `phase-7c4-admin-analytics.test.ts` asserts the four existing endpoints + cache TTL + canonical tables. **Do not rename/remove them.** Adding a 5th endpoint is safe; reuse the SAME cache constant/pattern so the "cache implementation" pin still holds. Add a new pinned assertion for `/analytics/matching` if the pin enumerates endpoints (verify first).
- Reads off `matches` (+ new `matching_template_id`, `confidence`), `ratings`, `matching_templates`. Must tolerate pre-migration rows (null template/confidence).

**Tests:** route tests (auth gate 401/403, shape of `/analytics/matching`, cache hit), aggregation correctness on seeded matches/ratings. Edge: zero matches, null template/confidence rows, excluded-from-stats ratings ignored.

---

## P2-3 — Event intention at check-in (+ openness)
**Why:** what a member wants differs per event; the doc asks intention + openness-to-unexpected at check-in and feeds it into scoring.

**Design:**
- Capture: a small **check-in modal** in the lobby (LiveSessionPage/Lobby) shown once per event for a participant, OR on register — store via `POST /sessions/:id/intention { intention, openness }` → `session_participants.event_intention` + `openness` (migration 071). Skippable.
- Score: in `attachIntentSignals` (matching.service.ts ~57-94) extend the query to LEFT JOIN `session_participants` for this session and set `part.eventIntention`/`part.openness`. Add an engine signal `eventIntentionAlignment` (guarded weight) that treats the per-event intention like a high-priority `wantsToMeet` overlay; `openness` tunes the existing diversity/serendipity (low openness → boost relevance weight, high → allow more diverse). Backward compatible: no intention → no effect.

**⚠ Adversarial review:**
- `attachIntentSignals` is keyed by userId across the whole pool; the session_participant join must be scoped to THIS `sessionId` (pass it in). The two finalization call-sites both have `sessionId` in scope — confirm.
- openness must never relax a HARD exclusion — it only re-weights soft signals.
- New `MatchingParticipant` optional fields (`eventIntention`, `openness`) + new optional weight key — backward compatible (Phase-1 pattern).

**Tests:** unit (eventIntention overlay raises a relevant pair; openness shifts diversity weight; absent = no change), repo (intention persisted + read scoped to session). Edge: member skips intention; intention set but no matching counterpart; openness 'only highly relevant' vs 'very open'.

---

## P2-4 — Incomplete-profile scoring tiers
**Why:** thin profiles shouldn't be scored as if rich; the doc wants full/partial/minimal tiers, never exclusion.

**Design:** compute `completeness` (0..1) per participant in `attachIntentSignals` from filled fields (company, job_title/designation, industry, interests, reasons, wantsToMeet). In the engine, when a participant is minimal, **dampen** the relevance-derived signals for that pair (lean on safe/diversity/freshness) rather than trusting sparse overlaps — a multiplier on intent/designation contributions, not a new exclusion. Add `completeness?: number` to `MatchingParticipant`.

**⚠ Adversarial review:** must not change scores for already-complete profiles (multiplier = 1 at high completeness) → existing matching tests (canonical-*, phase-*) stay green. Verify by running the full matching suite.

**Tests:** unit — completeness computed correctly; minimal profile dampens intent signal; complete profile unchanged (score identical to Phase-1). Edge: empty profile (all safe-fallback), one-field profile.

---

## P2-5 — Structured designation + who-want/avoid categories
**Why:** today designation is guessed from free-text job_title and wants/avoid are free text (fuzzy; "recruiters" vs "recruiting" misses). Structured categories → accurate, reliable matching.

**Design:**
- Onboarding extraction: add `userDesignation` (enum of the doc's designations) + `desiredDesignations: string[]` + `avoidDesignations: string[]` to `IntentSchema` + `INTENT_JSON_SCHEMA` + `EXTRACTION_PROMPT` + `OnboardingIntent`. Dual-write `userDesignation` → a normalized field; `desired/avoidDesignations` ride in `matching_intent` and feed `wantsToMeet`/`avoid`.
- `intent-signals.ts`: prefer the structured `userDesignation` when present (fall back to `normalizeDesignation(job_title)`); use structured categories for cleaner overlap.
- Client confirm card: show Designation as a structured (editable) field.

**⚠ Adversarial review:**
- **PIN:** `intent.schema.test.ts:64-67` requires the Round-B fields; adding NEW required fields breaks it. **Amendment:** update the test fixture (`validIntent`) to include the new fields, and add positive/negative cases — BEFORE changing the schema.
- **PIN:** `matching.intent-signals.test.ts` pins `normalizeDesignation`/`designationAffinity` — keep them; structured path is additive (prefer structured, else normalize).
- Onboarding is live + prod-verified; re-run the onboarding headed smoke after.

**Tests:** schema accepts new fields (+ update fixture), extraction prompt mentions them, intent-signals prefers structured designation, repo dual-writes. Edge: structured absent (fall back to job_title), unknown designation.

---

## P2-6 — Configurable rematch cooldown
**Why:** today cross-event memory is lifetime (`platform_wide`) or off; the doc wants a configurable cooldown (default 12 months) after which rematch is allowed.

**Design:** add `'cooldown'` to `MatchingPolicy` (shared) + `resolveMatchingPolicy` (matching.service.ts ~894). In `getEncounterHistoryForUsers` (~932-989), for `'cooldown'` load cross-event encounters but only **hard-exclude pairs whose `last_met_at` is within `cooldownMonths`** (from session/template config, default 12); older pairs fall through to the normal freshness penalty. Within-event no-repeat is unchanged.

**⚠ Adversarial review:**
- **PIN:** `platform-wide-hard-exclusion.test.ts:148-180` tests `platform_wide` + `within_event` + the L0→L4 ladder. **Do not alter those paths**; `'cooldown'` is a new branch. Add new test cases for cooldown (within window → excluded; outside → allowed-but-penalized).
- Keep `platform_wide` (lifetime) + `within_event` + `none` exactly as-is.

**Tests:** unit — cooldown excludes a pair met 2 months ago, allows (penalized) a pair met 14 months ago; default 12 months; platform_wide/within_event unchanged. Edge: no config → default; cooldown=0.

---

## One-ship verification plan
1. **Tests first** for all six (incl. the pinned-test updates: matching-engine-v1-spec INSERT list, intent.schema fixture, any analytics-endpoint enumeration). Red before code.
2. **Implement** all six (migration 071 + shared types + engine/service + onboarding + admin analytics + client check-in modal + analytics tab + confirm-card designation).
3. **Full local server suite green — zero broken pins.** Re-run the whole matching suite (canonical-*, phase-*, platform-wide, v1-spec, intent-signals) + onboarding + admin to prove nothing else broke. Client + shared tsc + client build.
4. **One ship:** staging → CI green → ff main → Render deploy (migration 071 auto-applies) + Vercel (confirm bundle hash changed).
5. **Headed prod E2E per use case + edge case:** storage (matches rows carry template/confidence), analytics (`/analytics/matching` renders), check-in intent (modal → intention stored → drives a round's pairing), profile tiers (thin vs rich), structured categories (onboarding → designation drives a match), cooldown (recent pair excluded). Outcomes asserted from DB/UI; 360px mobile pass for the modal + analytics tab; cleanup by ID.
6. **/checkhole**; then **report** (what shipped, evidence per case, pins updated, suite + smoke results).

## Pinned tests this ship updates (deliberately)
- `matching-engine-v1-spec.test.ts` — persistMatches INSERT column list (+ template/confidence).
- `intent.schema.test.ts` — validIntent fixture (+ structured designation fields).
- `phase-7c4-admin-analytics.test.ts` — only if it enumerates endpoints (add `/analytics/matching`); otherwise untouched.
- `platform-wide-hard-exclusion.test.ts` — untouched (add NEW cooldown cases in a new/extended file).
