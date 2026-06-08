# RSN Matching Engine — Gap-Closure Roadmap

**Date:** 2026-06-08 · **Author assessment basis:** read `assets/RSN Matching Engine.md` (master spec) end-to-end and verified against live code (`matching.engine.ts`, `matching.service.ts`, migration `021_matching_templates.sql`, `routes/admin.ts`, client admin pages).

**Framing:** the spec is a *configurable matching operating system*. The CORE engine is fully built and battle-tested (no-repeat, freshness-first, trio, backtracking/greedy, premium picks, encounter memory, edge cases, ratings, storage). This roadmap closes the gaps between that core and the spec, ordered by **value-for-effort and event-relevance**, not by spec order.

**Hard rule for every phase:** no behaviour change to the proven engine unless the phase is explicitly *about* that behaviour. Each item ships as its own commit + headed E2E + deploy, independently revertable (the established RSN cadence).

---

## Tier 0 — Quick wins (dead config + cheap correctness). Days, low risk.

These are already half-built; finishing them is cheap and removes "stored-but-lying" config.

### 0.1 Wire the template fields the engine ignores
- **Now:** `matching_templates.exploration_level` and `fallback_strategy` are stored (migration 021) and editable in the admin UI, but the engine **never reads them** — verified. `exploration_level` is a lie to admins.
- **Build:** thread `explorationLevel` into the engine as a configurable jitter magnitude (today's re-match jitter is a hardcoded ±2.5%); thread `fallbackStrategy` into the fallback path (`'random'` vs `'best_available'` ordering of the final greedy lap).
- **Risk:** low — additive, default to current behaviour when a template doesn't set them.

### 0.2 Surface "which template is in use" on the host dashboard
- **Now:** template resolution (session → pod → default) happens silently. Hosts can't see what ruleset their event is running.
- **Build:** add `templateName` to the host-dashboard payload; render it in the event header. Read-only.
- **Risk:** trivial.

### 0.3 Honest template defaults
- **Now:** one seeded "Speed Networking Default."
- **Build:** seed the three spec templates as starting points (Raw Speed Networking, Investor↔Founder, Employer↔Candidate) — even if the role-pairing logic (Tier 2) isn't there yet, the weight presets + descriptions are useful and set up Tier 2.
- **Risk:** trivial (data-only).

---

## Tier 1 — Event-relevant gaps that change match QUALITY. 1–2 weeks each, medium risk.

These directly affect the conversations participants get. Worth doing before scaling to many event types.

### 1.1 Per-event intention + openness/serendipity
- **Spec:** §"Event level intention" — ask at check-in "What's your intention for THIS event?" and "How open to unexpected matches?" Separate from the permanent profile.
- **Now:** not captured, not scored. `weight_intent` maps to the profile's static `reasonsToConnect`.
- **Build:**
  - DB: `session_participants.event_intention TEXT`, `event_openness SMALLINT` (1=only-relevant … 3=very-open).
  - Capture: a check-in step (or the device-test screen) before the lobby.
  - Score: intention-alignment factor in `computePairScore`; openness modulates the exploration jitter per-participant (very-open → more serendipity tolerance).
- **Value:** high — this is the spec's "controlled serendipity" lever and the difference between a flat event and a lively one.

### 1.2 "Who you do NOT want to meet" (preference-based avoidance)
- **Spec:** structured "Who would you prefer not to meet" categories (recruiters, sellers, early-stage founders, own-company, competitors…).
- **Now:** only *structural* blocks (user_block, inviter, same-company). No preference avoidance.
- **Build:**
  - DB: `user_profiles.avoid_counterpart_types TEXT[]` (structured categories) + optional free-text.
  - Score: a **soft penalty** (not a hard exclusion — the spec wants "respected where possible") when a candidate matches an avoid-category; large enough to deprioritise, not so large it strands people.
- **Value:** high — prevents the bad-experience matches the spec's core principle puts first ("prevent bad or wasteful matches").

### 1.3 Counterpart-type / designation matching + event-type templates
- **Spec:** Investor↔Founder, Employer↔Candidate templates with role-pairing biases; "who you want to meet" structured categories.
- **Now:** none — only `seniorityLevel` (read via `as any`, likely unpopulated). No designation field feeds scoring; no role-pairing.
- **Build:**
  - DB: ensure `designation` / `employment_status` are populated profile fields (spec's "Best designation options" + "Employment status" lists); `user_profiles.want_counterpart_types TEXT[]`.
  - Template: a `pairing_biases` JSON column (`{prefer:[["founder","investor"]], avoid:[["founder","founder"]]}`).
  - Engine: a counterpart-type compatibility factor + a template-driven "prefer/avoid role pair" bias; folds into the weighted score (no new hard rule unless the template marks a pairing as exclusion).
- **Value:** high IF RSN runs non-speed-networking event types (investor/founder etc.). **Lower priority if the near-term events are all Raw Speed Networking** — decide based on the actual event pipeline.

---

## Tier 2 — Robustness & fairness. Medium risk, touches the proven engine — do carefully, heavily smoked.

### 2.1 Formalize the fallback ladder (Levels 1–5) + profile-completeness tiers
- **Spec:** L1 full → L2 partial → L3 safe-only → L4 random-within-constraints → L5 long-cooldown rematch. Plus: complete profile = full scoring, partial = partial, minimal = safe fallback.
- **Now:** behaviour exists in spirit (full scoring, skips missing fields, platform-wide relaxation) but is **not levelled or labelled**, and there's no explicit completeness tier or formal L4 random.
- **Build:** a thin orchestration wrapper that (a) computes a profile-completeness tier per participant, (b) tries levels in order and records which level produced each pair (stored on the match for analytics), (c) adds an explicit L4 "random within safe constraints." The actual matching primitives already exist — this is orchestration + labelling, not new matching math.
- **Risk:** medium — wraps the round generator; needs the full trio/edge-case suite green + headed smokes.

### 2.2 Room-fairness balancing (spec §4)
- **Spec:** don't give all best matches to attractive profiles; track who's had weak matches, who's consuming too many strong pairings, who keeps getting stranded; optimise total-room quality.
- **Now:** freshness-first gives *partial* fairness (everyone meets fresh people), but no per-user weak-match/strand tracking across rounds.
- **Build:** carry a per-participant running "match-quality debt" across rounds (low-scoring or bye in round N → priority + score-floor in round N+1). Feed it as a tie-breaker/bonus in candidate ordering.
- **Risk:** medium-high — changes who-gets-whom; this is a genuine matching-behaviour change, so it needs Ali's explicit sign-off + careful A/B on a test event. **Not a pre-event hardening item — a deliberate quality investment.**

### 1.4 12-month cross-event cooldown gradient
- **Spec:** never within event; across events default no-rematch for 12 months; after 12 months rematch possible but heavily penalised, last-resort only.
- **Now:** binary — `platform_wide` = hard-never, `within_event` = allow. Soft freshness decay (`daysSince/90`) exists but no 12-month policy.
- **Build:** a `matchingPolicy='cooldown'` mode: prior-event pairs inside the cooldown window are hard-excluded; outside it they're allowed but heavily penalised (last in the freshness sort). Template owns the window length.
- **Value:** matters once the same users attend many events; **low priority until there's a returning-user base.**

---

## Tier 3 — Platform / product layer. Weeks-to-months, mostly NEW surfaces (not engine risk).

These are the spec's "matching OS" pillars beyond live events. The spec itself scopes them as V2+. Build only when the business needs them.

### 3.1 Full template builder (admin)
Richer `matching_templates` (goal, exploration low/med/high, host-review toggle, invite-block toggle, odd-number behaviour, versioning) + event-type entity + template→event-type assignment. The current admin template page is a thin weights editor; this makes it the spec's operational control system.

### 3.2 Analytics & learning surfaces
Data is already stored (the learning-loop foundation is real). Build the read surfaces: template performance, fallback-level quality, auto-vs-manual override outcomes, frequently-unmatched users, rating trends.

### 3.3 AI template wizard
Natural-language → structured template (the spec's §14). Needs the rich template schema (3.1) first. A Claude-API call that emits a validated template JSON + human-review step.

### 3.4 Relationship graph + platform-wide ongoing matching
The long-term asset: who-met-whom, what worked, ongoing relevance-based intros (buyers/sellers/offers/needs), pods, recommendations. Architecturally prepared by the existing `encounter_history` + storage; a separate product surface.

### 3.5 Premium rolling/ongoing matching mode
Continuous reallocation (60–90 min, conversation ends → next relevant available match). Needs live-availability queueing on top of the engine. Premium 12-pick is already done.

---

## Recommended near-term order
1. **Tier 0 entirely** (cheap, removes lying config, sets up Tier 1).
2. **Tier 1.1 (event intention/openness)** and **1.2 (avoid-types)** — biggest match-quality wins for the events RSN actually runs.
3. **Decide on 1.3 (role/event-types)** based on the real event pipeline — high value only if non-speed-networking events are coming soon.
4. **Tier 2.1 (formal fallback ladder)** for robustness + analytics labelling.
5. **Tier 2.2 (fairness)** only as a deliberate, signed-off quality experiment.
6. Tier 3 as the product expands beyond single-format events.

## What is genuinely fine to leave alone
The CORE engine (scoring, no-repeat, freshness, trio, backtracking, premium, edge cases, storage) is solid and proven. **None of these gaps block tomorrow's Stefan test or any Raw Speed Networking event today.** They are growth investments toward the spec's full "matching OS," not bug fixes.

## Risks / decisions needing Ali
- **Tier 2.2 (fairness)** is the only item that changes *who meets whom* — needs explicit product sign-off and A/B, never a silent ship.
- **Tier 1.3 vs 1.4 priority** depends on the real event roadmap (many event types soon? many returning users soon?) — a business call.
