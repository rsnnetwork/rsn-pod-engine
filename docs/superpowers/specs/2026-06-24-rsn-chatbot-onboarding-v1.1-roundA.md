# RSN Chatbot Onboarding v1.1 — Round A (MVP) Design Spec

> **Date:** 2026-06-24 · **Status:** APPROVED (decisions locked) · **Source:** `assets/RSN OVERHAUL/RSN chatbotonboarding1.1.pdf` (Stefan/Shradha feedback after first prod test)
> **Builds on:** the shipped v1 (commit 66f22b2 + d81cca9). **Build target:** `RSN-dev`, branch `feat/onboarding-chatbot` → staging → main.

## Goal
Make onboarding feel like "Reason already understands you," not a form. Use what we know, confirm guesses, ask only what matching needs, keep it short and human.

## Locked decisions (this round)
1. **MVP-first** (Stefan's 9-step MVP). Round B = full ~17-field model, confidence + confirmed-vs-guessed separation, after-each-answer extraction, resume, LinkedIn/company/website enrichment, more questions.
2. **Country = geo header if available, else ask.** Read `cf-ipcountry` / `x-vercel-ip-country` / equivalent on the request; map to name via `Intl.DisplayNames`. No external geo API. Fallback: the host asks.
3. **Company = simple email-domain inference.** Non-generic domain → title-cased SLD as a *guess to confirm*; generic providers (gmail/outlook/hotmail/yahoo/icloud/proton/…) → skip.
4. **Both cards** — early known-data confirm card + final summary card, each with Yes / Edit.

## Staged flow (client orchestrates)
1. **Welcome by name** — "Hi {firstName}. Welcome to Reason. Good to have you here." (personalized, no dashes).
2. **Confirm known-data card** — Name / Country / Company (guesses, editable) → **Yes, continue** / **Edit**. Sourced from `GET /onboarding/known`.
3. **Chat — 3 core questions** (host-driven, knows the confirmed profile so it never re-asks): (a) your reason for joining, (b) who would be valuable to meet (and why now), (c) what you can help others with.
4. **Final summary card** — the understood matching profile → **Yes, use this** / **Edit / Keep talking**.
5. **Save** (dual-write as today + confirmed known data) → flip gate → feed matching.

## Server deltas
- **`GET /onboarding/known`** (auth): `{ name, firstName, email, country, countryGuessed, company, companyGuessed }`. country from geo header(s) → `Intl.DisplayNames`; company from email domain (skip generic providers).
- **`POST /onboarding/chat` / `/confirm`**: accept optional `profile` (the confirmed known data). Inject into the host system prompt (greet by name, treat name/country/company as known, never re-ask). On confirm, persist confirmed known data: `company → users.company`, `country → users.location` (MVP; proper `country`/`city` columns are Round B).
- **Prompt service** builds the system prompt per-request with the confirmed profile woven in.

## Prompt deltas (prompts.ts)
- Personalized opening by name; **no em dashes anywhere** (Shradha); calm human host, no AI rhythm/filler/long formal explanations.
- The 3 core questions above; use known data; confirm guesses ("Looks like you're based in {country}, right?"); **don't stop early** — only emit READY after all three + a short summary.
- Remove em dash from `ONBOARDING_OPENING_LINE` (now personalized, built client-side / server-side with the name).

## Client deltas (ChatbotOnboarding)
- Stage machine: `loading → confirm-known → chat → summary → done`.
- Fetch `/onboarding/known`; render the confirm-known card (editable Name/Country/Company; Yes/Edit). On Yes, hold `confirmedProfile`, go to chat; pass it on every `/chat` + `/confirm`.
- Final summary card copy improved (Yes, use this / Edit / Keep talking).
- **Input box fixes:** larger field, higher contrast, placeholder "Write your reason here…", autofocus cursor, clearly-visible send button, mobile-first. Keep the fixed-height (`100dvh`) auto-scroll shell from d81cca9.

## Data model
No migration for MVP — reuse `users.company` + `users.location` (country) and the existing `user_intent_profiles`. Round B adds `country`/`city`, `match_priority`, `suggested_invitees`, confidence + confirmed-vs-guessed split.

## Out of scope (Round B)
Full 17-field model, confidence scores surfaced, confirmed-vs-guessed separation, resume-if-left, after-each-answer extraction, LinkedIn/company/website/CRM enrichment, questions 4–6 (who you'd be valuable to / avoid / invite), match-feedback loop.

## Verify
client+server+shared `tsc`; full server jest; a no-dash assertion test on onboarding copy; headed prod-style Playwright smoke: known card → 3-Q chat → summary → save, asserting DB writes + confirmed known data; mobile 360/390 widths; verify on prod after deploy.
