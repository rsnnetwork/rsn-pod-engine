# SDD 09 — LinkedIn / web profile enrichment + live preview

**Date:** 2026-06-26 · **Status:** spike validated, building. New feature (beyond matching Phase 3).
**Mechanism (proven):** Claude API `web_search` tool (Sonnet 4.6) from RSN's existing Anthropic key returns clean, cited, structured person data — for both a LinkedIn-URL case and a name+company+city case. Evidence: `e2e/spike-enrich.mjs` (Collison conf 0.99 + sources; Matthew Jones/Cruise Globe no-URL path). NOT LinkedIn's API, NOT a login-scrape — public web search + synthesis.

## Goal
Auto-fill a member's profile (real profile page + DB) and matching signals from their public web/LinkedIn footprint, with minimal asking, and show it being built live in the onboarding chat. Strengthens the matching engine (Phases 1–3) with far less manual input.

## Inputs we already hold
- **Name + email** — from signup (never ask).
- **LinkedIn URL** — present for most users (profile field). Ask once only if missing.
- **City/country** — often present; a disambiguator.

## Decision tree (the enrichment branch)
1. **LinkedIn on file** → search includes the exact URL → high-confidence → populate (editable).
2. **No URL, work email** → email *domain* → company; search name + company + city → **"is this you?"** confirm → on yes, populate + **save the found URL**.
3. **No URL, personal email** (gmail/outlook/…) → search name + city → "is this you?" (weaker) → confirm or ask for URL.
4. **No confident match / "not me"** → ask for the URL or let them fill manually. Never populate unverified data.

Email→company uses the **domain only** (skip free providers); we never web-search the raw email address.

## Ship 1 — backend enrichment (this ship)
- `server/src/services/onboarding/enrichment.service.ts`:
  - Pure helpers (unit-tested): `companyFromEmail(email)` (domain→company, free-provider list), `buildEnrichmentQuery(signals)`, `parseEnriched(text)` (extract+validate JSON).
  - `enrichProfile({fullName,email,city,country,company,linkedinUrl})` → Claude `messages.create` on `config.onboardingEnrichModel` (Sonnet 4.6) with `web_search` tool → returns `{ profile, confidence, sources, foundLinkedinUrl }`. (web_search is incompatible with `output_config.format`, so we prompt for a JSON block + parse — matches the spike.)
  - Resilient: on API error / low confidence, return `{confidence:0}` — never throws into onboarding.
- **Profile mapping** → map enriched fields to the real schema (job_title/role, company, industry, location, bio, linkedin + `user_intent_profiles` matching fields) — **additive + suggested**: fill blanks, store the full result in `inferred_profile` (migration 070), never clobber user-entered values.
- **Endpoints:**
  - `POST /onboarding/enrich { linkedinUrl? }` → run enrichment for the current user, store candidate in `inferred_profile`, return it + confidence for the "is this you?" preview. Does NOT overwrite the live profile.
  - `POST /onboarding/enrich/apply { fields }` → write the confirmed/edited fields to the real profile (users + intent profile).
- Config: `ONBOARDING_ENRICH_MODEL` (default `claude-sonnet-4-6`) added to server config + Render env.
- Tests: helpers (email→company, query build, parse), route auth + shape (mock the Claude call). Cache: store enriched result keyed to (user, linkedinUrl/signals); don't re-run within a window.

## Ship 2 — live preview card + confirm UI
- Split onboarding layout: **profile card on the left, chat on the right** (mobile: card stacks above / collapsible — responsive, ≥44px targets, no overflow).
- Card binds to the live profile snapshot; updates as enrichment lands + on each chat turn (extraction already runs per answer — surface it).
- "Is this you?" confirm card for the no-URL branch (candidate name/role/company + found LinkedIn) → confirm/apply or correct.
- Ask-for-LinkedIn-if-missing prompt (one optional field).

## Constraints (honest)
- **Accuracy = suggest, then confirm** — editable, never silently written; quality scales with public footprint (great for public people, weak for low-profile → low confidence → confirm step protects).
- **Cost** — one enrichment call per user (cached); web_search has a per-use charge (~5 searches/lookup in the spike). Fine at onboarding volume.
- **Consent/privacy** — member's own profile, from data they gave us; store only what we'd show them; the inferred snapshot is theirs to edit.

## Verification (each ship)
tests-first → full server suite green (zero broken pins) + client tsc/build → one deploy (Render env var added) → headed prod E2E (enrich a real onboarded test user end-to-end: URL path + name+city path + apply-writes-profile + card renders) → /checkhole → report.
