# Founder Run — Runbook (Stefan · Claus · Ali · Shradha)

The live proof of the truthful loop (spec: `assets/RSN Overhaul 21st june.pdf`, DoD items 5-7).
Everything below assumes the ScrapingDog paid plan is active.

Shradha is the 4th tester, added to cover the path the three founders can't:
the FULL virgin new-member journey (join request → admin approval → magic
link → onboarding → matching), start to finish, on a brand-new account. The
three founders stay on the status-flip path (their accounts already exist;
see step 3 of pre-flight) — they prove the re-onboarding loop, not the
brand-new-signup loop.

## Pre-flight (Claude runs, ~10 min)

1. `/checkhole` green; Anthropic balance > $10; ScrapingDog credits visible on the dashboard.
2. Live-verify Stefan (`linkedin.com/in/avivson`) and Claus (`linkedin.com/in/claus-sønderskov-51b2943` — the unicode-slug acceptance test) via the discovery script; confirm CORRECT PERSON + photo for both. Record durations.
3. Confirm the three founders' accounts' state: `alihammza143@gmail.com` (in_progress → will be gated), `stefanavivson@gmail.com` (completed — needs status reset to `update_required` so Stefan goes through the NEW flow: single UPDATE by email, confirm count=1), `clsonderskov@gmail.com` (update_required already).
4. Pre-warm the three founders' enrichment (3 scrape calls) so their cards are instant too: run the admin refresh-enrichment call for each founder's account BEFORE the run starts (same endpoint as the discovery script in step 2 — it's a fresh cache write). This mirrors, for an EXISTING account, the same instant-card effect the approved-join-request preload gives Shradha's brand-new one: by the time each founder logs in, `user_intent_profiles.enrichment_status` is already `found`/`partial`, so their status-flip run shows the confirm card immediately instead of the searching wait.
5. Start `/liveloop`.

## Shradha's run — the FULL virgin journey (new: proves the instant found card)

Unlike the founders, Shradha has no existing account. This is the acceptance
test for "approved members land on an instant found card":

1. Shradha submits a join request WITH her real LinkedIn URL.
2. Claude (as admin) approves it. This fires the background ScrapingDog
   preload (`join-request.service.ts`) — confirm in the admin inspector that
   `join_requests.enriched` gets populated within the expected window.
3. Shradha clicks her magic link (first login ever for this email).
4. Expect the confirm card to be INSTANT — no searching flash. This is the
   behavior under test: the preload copy-forward
   (`identity.service.ts::verifyMagicLink`) seeds
   `user_intent_profiles.enrichment_status` from the join-request blob at
   account-creation time, so the very first `GET /onboarding/status` already
   returns `found`/`partial` with the candidate — not `none`. If Shradha
   instead sees even a brief searching state, that's a regression; Claude
   checks the admin inspector's stage events and `enrichment_status`/`source`
   columns before continuing.
5. Shradha proceeds through onboarding normally (confirm the card, chat,
   confirm the summary) — same verification as the founders' step 4 below.
6. Confirm Shradha appears in /matches for at least one founder once scores
   clear, proving the virgin journey reaches the same loop the founders test.

## The founders' run (one at a time — order: Ali first as pilot, then Stefan, then Claus)

Per founder:
1. Log in on your PHONE (the primary device per the mobile-first rule). Expect: immediate redirect to onboarding.
2. Because of the pre-warm in pre-flight step 4, expect the FOUND card with your real LinkedIn data + photo to appear immediately — not the SEARCHING wait card. (The searching → found flip is what a cold/un-pre-warmed account would show; pre-warming is what makes the founders' cards instant too.) **If you instead get "Let us build it together", STOP — that's an enrichment failure; Claude checks the stage events in the admin inspector before continuing.**
3. Confirm the card (fix anything wrong — that's the point of it), have the chat honestly, ~4-7 messages, confirm the final summary.
4. Claude verifies in the admin inspector: transcript stored, enrichment `found`, per-stage timings sane, structured intent populated (incl. the new fields: languages, restrictions, meeting-value).
5. Claude re-runs the pair scorer. Target: each completed pair ≥ 0.45 both directions. Baseline today is 0.00 for all pairs (expected — no intent data yet). If a pair lands short after both onboarded, Claude diagnoses BEFORE the matches step: vague answers → the founder refines via chat; real algorithm gap → tune per the plan (template weights), never hack the threshold.

## The loop proof (after Shradha + all three founders are onboarded and scores clear)

1. Each opens /matches — sees the others with human-readable reasons (Shradha included).
2. One pair at a time: A presses "I want to meet" → B gets the bell (and email) → B accepts → A gets the acceptance bell (and email) → conversation opens with the intro as first message → both pick meeting windows → one confirms → pinned window + confirmation in thread.
3. Repeat for enough pairs to cover all four testers at least once (prioritize at least one pair involving Shradha, to close the virgin-journey loop). Claude verifies each artifact in the admin inspector as it happens.
4. DoD walkthrough: all 7 exit criteria checked live. Anything failing = bug with a stage-event trail; fix per the per-bug ship process.

## Failure playbook

- Enrichment wrong person / not found → admin inspector → stage events + `enrichment_error`; ScrapingDog dashboard logs; re-run via the inspector's Refresh button after fixing.
- Stuck on searching > 3 min → the client belts to not_found by design; check orchestrator logs on Render.
- Shradha sees a searching flash instead of an instant card → check `join_requests.enriched` was populated before her magic-link click (approval-time preload may still be running — the ~50s lookup); if it was populated but the card still isn't instant, check `user_intent_profiles.enrichment_status`/`enrichment_source` were actually set at account creation (identity.service.ts's preload copy-forward), not left at `none`.
- No match shown despite scores ≥ 0.45 → check `onboarding_completed`/eligibility in platform-match SQL; the browse threshold (0.12) as fallback view.
- Any 5xx → /checkhole + Render logs; one bug per deploy.

## After the run

- Notes → `docs/founder-run-notes-<date>.md`; every hiccup becomes a tracked fix.
- Green light Stefan's follow-ups: wider member comms about re-onboarding (56 users are gated), then the network-structure planning cycle.
