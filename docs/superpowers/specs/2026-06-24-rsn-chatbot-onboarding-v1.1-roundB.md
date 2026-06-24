# RSN Chatbot Onboarding v1.1 — Round B (full doc conformance) Design Spec

> **Date:** 2026-06-24 · **Status:** APPROVED (decisions locked) · **Source:** `assets/RSN OVERHAUL/RSN chatbotonboarding1.1.pdf`
> **Builds on:** Round A (`dfdd651` + `d5eb245` + `3d54af4`). **Goal:** close every remaining gap vs Stefan's doc so onboarding fully matches it.
> **Locked decisions:** per-answer extraction (run after each user message); invite = capture intent only (store `suggested_invitees`, no emails); ship all in one Round B.

## Gap audit (what Round B closes)
| Doc item | Status before B | Round B action |
|---|---|---|
| #2 known data: LinkedIn, role, previous attendance | missing | `/known` also returns role (job_title), linkedin_url, previousEvents count |
| #3 confirm card: Role row | missing | add Role (+ LinkedIn) rows to the card, editable |
| #4 Q4 who you'd be valuable TO | missing | add to extraction + host flow |
| #4 Q5 anyone to avoid / no re-match | missing | optional host ask + extraction (avoidPreferences exists) |
| #4 Q6 invite someone relevant | missing | optional host ask; store `suggestedInvitees` (no send) |
| #8 richer final summary + Edit | partial | summary card shows the understood profile paragraph; Yes / Edit |
| #10 data model: city, current focus, match priority, suggested invitees, confidence, confirmed-vs-guessed | partial | expand extraction; store confidence; store confirmed vs guessed separately |
| #11 extract after each answer | at-confirm only | per-answer extraction (light) + live profile update |
| #7 resume if they leave | missing | save conversation per turn; on re-entry offer Resume / Start over |
| frontend Skip button | missing | "Skip / I'm done" control that forces wrap-up |

## Data model (migration 070, additive + idempotent)
`user_intent_profiles` add:
- `confirmed_profile JSONB DEFAULT '{}'` — what the member confirmed on the card (name/country/company/role/linkedin).
- `inferred_profile JSONB DEFAULT '{}'` — what we guessed + per-field source/confidence (the "guessed, separate from confirmed").
The expanded extracted intent (valuableTo, suggestedInvitees, currentFocus, matchPriority, city, avoid) lives in the existing `matching_intent` JSONB. `confidence` column already exists. No users-table change (city/role/linkedin reuse existing columns where present).

## Extraction (IntentSchema + prompts)
Expand `OnboardingIntent` / zod `IntentSchema` / `INTENT_JSON_SCHEMA` / EXTRACTION_PROMPT with:
- `userValuableTo: string[]` (Q4), `suggestedInvitees: string[]` (Q6), `currentFocus: string`, `matchPriority: 'high'|'medium'|'low'`, `userCity: string|null`. (`avoidPreferences` already present for Q5.)
Host prompt: knows all six dimensions (reason, who-to-meet+why, what-you-offer, who-you'd-be-valuable-to, avoid, invite); asks efficiently; avoid + invite are OPTIONAL light asks; still wraps up ASAP; accepts a user-initiated finish.

## Per-answer extraction
In `POST /onboarding/chat`: after `converse`, also run a light `extractIntent` over the convo-so-far and upsert a partial `user_intent_profiles` row (matching_intent + confidence + onboarding_conversation), so the profile updates live and a resume has state. Final extraction + gate flip stays at `/confirm`.

## Known endpoint
`/onboarding/known` adds: `role` (users.job_title), `linkedin` (users.linkedin_url), `previousEvents` (count from session_participants), each with guessed=false (saved) — role/linkedin are confirmed-or-empty, not inferred in B.

## Client
- Confirm card: add **Role** and **LinkedIn** rows (editable); if `previousEvents > 0`, a light "good to see you back" line.
- **Resume:** on load, if `onboarding_status='in_progress'` with a saved conversation, offer **Resume** / **Start over**.
- **Skip / I'm done:** a small control in the chat that nudges the host to wrap up now (sends a finish signal) so the user can shortcut.
- **Summary card:** render the understood profile as a short paragraph (who you want to meet / what you bring / who you'd be valuable to), with **Yes, use this** / **Edit** (Edit returns to chat).

## Out of scope (later)
Matching engine + match cards (the REASON "first real product"), embeddings/semantic, circles/pods, LinkedIn/website/CRM enrichment, actually sending invites.

## Verify
client+server+shared tsc; full server jest (+ new tests: expanded schema, per-answer extraction route, known role/linkedin/previousEvents, resume); headed prod smoke (resume, skip-to-finish, Q4-6 captured, richer summary, confirmed-vs-guessed stored); mobile widths; verify on prod.
