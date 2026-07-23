# Founder Run — Runbook (Stefan · Claus · Ali)

The live proof of the truthful loop (spec: `assets/RSN Overhaul 21st june.pdf`, DoD items 5-7).
Everything below assumes the ScrapingDog paid plan is active.

## Pre-flight (Claude runs, ~10 min)

1. `/checkhole` green; Anthropic balance > $10; ScrapingDog credits visible on the dashboard.
2. Live-verify Stefan (`linkedin.com/in/avivson`) and Claus (`linkedin.com/in/claus-sønderskov-51b2943` — the unicode-slug acceptance test) via the discovery script; confirm CORRECT PERSON + photo for both. Record durations.
3. Confirm the three accounts' state: `alihammza143@gmail.com` (in_progress → will be gated), `stefanavivson@gmail.com` (completed — needs status reset to `update_required` so Stefan goes through the NEW flow: single UPDATE by email, confirm count=1), `clsonderskov@gmail.com` (update_required already).
4. Start `/liveloop`.

## The run (one founder at a time — order: Ali first as pilot, then Stefan, then Claus)

Per founder:
1. Log in on your PHONE (the primary device per the mobile-first rule). Expect: immediate redirect to onboarding.
2. Expect the SEARCHING wait card ("I am retrieving your public profile…"), then within ~a minute the FOUND card with your real LinkedIn data + photo. **If you instead get "Let us build it together", STOP — that's an enrichment failure; Claude checks the stage events in the admin inspector before continuing.**
3. Confirm the card (fix anything wrong — that's the point of it), have the chat honestly, ~4-7 messages, confirm the final summary.
4. Claude verifies in the admin inspector: transcript stored, enrichment `found`, per-stage timings sane, structured intent populated (incl. the new fields: languages, restrictions, meeting-value).
5. Claude re-runs the pair scorer. Target: each completed pair ≥ 0.45 both directions. Baseline today is 0.00 for all pairs (expected — no intent data yet). If a pair lands short after both onboarded, Claude diagnoses BEFORE the matches step: vague answers → the founder refines via chat; real algorithm gap → tune per the plan (template weights), never hack the threshold.

## The loop proof (after all three are onboarded and scores clear)

1. Each opens /matches — sees the other two with human-readable reasons.
2. One pair at a time: A presses "I want to meet" → B gets the bell (and email) → B accepts → A gets the acceptance bell (and email) → conversation opens with the intro as first message → both pick meeting windows → one confirms → pinned window + confirmation in thread.
3. Repeat for all three pairs. Claude verifies each artifact in the admin inspector as it happens.
4. DoD walkthrough: all 7 exit criteria checked live. Anything failing = bug with a stage-event trail; fix per the per-bug ship process.

## Failure playbook

- Enrichment wrong person / not found → admin inspector → stage events + `enrichment_error`; ScrapingDog dashboard logs; re-run via the inspector's Refresh button after fixing.
- Stuck on searching > 3 min → the client belts to not_found by design; check orchestrator logs on Render.
- No match shown despite scores ≥ 0.45 → check `onboarding_completed`/eligibility in platform-match SQL; the browse threshold (0.12) as fallback view.
- Any 5xx → /checkhole + Render logs; one bug per deploy.

## After the run

- Notes → `docs/founder-run-notes-<date>.md`; every hiccup becomes a tracked fix.
- Green light Stefan's follow-ups: wider member comms about re-onboarding (56 users are gated), then the network-structure planning cycle.
