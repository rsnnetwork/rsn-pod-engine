# RSN Matching Engine — Phase 1: onboarding-intent enhancement (live event)

> **Date:** 2026-06-25 · **Status:** SHIPPED (Phase 1) · **Source of truth:** `assets/RSN Matching Engine.md`
> **Decision:** perfect the EXISTING live-event engine per the doc (not the future platform-recommendations layer). Phase 1 = feed the onboarding intent we already capture into the live pair-scoring, **purely additively** — enhance, never break.

## Guarantee (enhance, not break)
- No hard exclusion is weakened (same-event no-repeat, cross-event/platform-wide, no-invited, blocks, same-company, already-paired, fallback ladder, fairness all unchanged).
- New signals are added to the weighted-average scoring, each guarded by `if (weights.X)`, so legacy weight configs (and every existing test) behave identically, and a participant with no onboarding data scores exactly as before.
- Proof: full server suite (2345) green incl. all 21 matching suites; new unit tests incl. a backward-compatibility test; no migration, no onboarding change.

## What Phase 1 adds (data we already capture)
New `MatchingParticipant` (optional) fields, hydrated by `attachIntentSignals()` from existing data:
- `designation` ← `normalizeDesignation(users.job_title)` (founder/investor/ceo/advisor/employee/job_seeker/…)
- `wantsToMeet` ← `user_intent_profiles.matching_intent.{desiredRoles,desiredPeople,desiredIndustries,desiredDesignations}` + `users.who_i_want_to_meet`
- `avoid` ← `user_intent_profiles.avoid_preferences` (+ `matching_intent.avoidPreferences`) — previously captured and IGNORED

New scoring signals in `matching.engine.ts` `computePairScore` (weights in `MatchingWeights`, defaults in `DEFAULT_WEIGHTS`):
- **intentAlignment** (0.20): directional "who you want to meet" vs the other's identity; mutual want bonus → `mutual_intent` / `intent_match` reason tags.
- **designationDiversity** (0.10): complementarity (founder+investor high, same designation lower) → `designation:a+b` tag.
- **avoidPenalty** (0.15): if either side's avoid matches the other's identity, that dimension scores 0 (soft deprioritise, never a hard block) → `avoid_conflict` tag.

Helpers live in `services/matching/intent-signals.ts` (pure, unit-tested): `normalizeDesignation`, `designationAffinity`, `tokenizeTerms`, `termOverlap`, `identityTokens`, `intentAlignmentScore`, `avoidConflict`.

## Files
- `shared/src/types/match.ts` — optional participant fields + weight keys.
- `server/src/services/matching/intent-signals.ts` (new) — pure helpers.
- `server/src/services/matching/matching.engine.ts` — 3 new guarded signals.
- `server/src/services/matching/matching.service.ts` — DEFAULT_WEIGHTS + template carry-forward + `attachIntentSignals` at both finalization points.
- tests: `matching.intent-signals.test.ts`, `matching.intent-enhancement.test.ts`.

## Known V1 limitations (acceptable for Phase 1)
- Term matching is substring/equality (no stemming) → "recruiters" won't match "recruiting"; avoid/intent recall is approximate. It's a soft signal, so imperfect recall only means a slightly weaker nudge, never a wrong exclusion.
- Designation is derived from free-text `job_title` (no structured capture yet).

## Deferred (later phases, per the doc + earlier plan)
Phase 2: event-intention at check-in + openness, incomplete-profile scoring tiers, fuller match storage (template/confidence/override/duration), analytics dashboards.
Phase 3: richer templates + admin CRUD, manual pair-swap, violation exclusion, remaining edge cases.
Future: AI template wizard, structured designation capture in onboarding, platform-wide "people you should meet" recommendations, semantic/embedding matching.
