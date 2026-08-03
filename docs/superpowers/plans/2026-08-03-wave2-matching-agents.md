# Wave 2 — Matching Agents (core)

Source: `assets/RSN 30 july 2026.pdf` priorities P2, P4, P5. Wave 1 (P1 accept
flow + onboarding copy + clickable links) shipped at `0a617cd`.

> "RSN is no longer merely matching profiles. It is allowing every person to
> create active reasons for meeting people, then continually searching the
> network for those people."

## Decisions (Ali, 3 Aug)

| # | Decision |
|---|---|
| D1 | Wave 2 = **core only**: agents, persistence, dashboard counts, CRUD/lifecycle, auto-match on join. Onboarding restructure (P3) and admin demand intelligence (P7) go to Wave 3. |
| D2 | **No agent limit now.** `max_active_agents` ships on entitlements (admin-editable) but is not enforced; turning it on later is a flag, not a rebuild. |
| D3 | **Exclusions are per-agent.** Asking to meet someone through the Developer agent hides them from *that* agent only; they can still surface under Investor for a genuinely different reason. Encounters and blocks stay global. |
| D4 | **Auto-seed.** Every existing member with intent data gets one active agent created from it, labelled from what they said they wanted. Nobody re-does onboarding. |

## What exists (audited, not assumed)

- `user_intent_profiles` is **one row per user** — `user_id` is the PRIMARY KEY.
  It holds both who-they-are and what-they-want, and its `matching_intent` JSONB
  is the whole zod-validated extraction blob.
- The platform matcher reads **only flat `users` columns**, never
  `user_intent_profiles`. `saveIntentAndComplete` dual-writes those columns.
- `scoreFit(me, other)` is one-way and already separates `wantSources(me)` from
  `offerSources(other)` — the seam this wave needs.
- **Scores are never stored.** `getPlatformMatches` scores in JS per request and
  returns; there is no platform-matches table. This is why counts are impossible today.
- `notifyMatchesOfNewUser` fans out on onboarding completion, capped at 25, with a
  24h dedupe keyed on *any* `platform_match` notification.
- `user_entitlements` / `user_subscriptions` exist per user, admin-editable, essentially unenforced.

## Design

**Split the sides.** `user_intent_profiles` keeps being "who I am" (the offer
side, genuinely per-person). Agents own "what I want". This is clean because the
scorer already draws those from separate functions.

### Schema (migration 085)

```
matching_agents
  id, user_id (NOT unique - the whole point), label,
  want_text TEXT           -- free text the scorer tokenizes
  intent JSONB             -- optional structured slice, same shape as matching_intent
  matching_tags TEXT[]
  status  'active' | 'paused' | 'archived'
  created_at, updated_at, archived_at, last_matched_at
  INDEX (user_id, status)

agent_matches              -- persisted so counts are cheap and honest
  agent_id, candidate_user_id, score NUMERIC, reason TEXT,
  computed_at, PRIMARY KEY (agent_id, candidate_user_id)
  INDEX (agent_id, score DESC)

user_pokes.agent_id        -- nullable; which agent produced the intro (D3)
user_entitlements.max_active_agents  -- ships unenforced (D2)
```

Backfill (D4): one agent per user whose intent has any want signal, label
derived from `desiredRoles`/`desiredPeople`, `want_text` from the same sources
the scorer uses today. Additive and reversible.

### Scoring

Refactor `scoreFit(me, other)` into `scoreWants(wantTexts, other)` with
`scoreFit` delegating to it. Existing behaviour and tests unchanged; agents pass
their own `want_text`. No new scoring maths in this wave.

### Recompute (the persistence rule)

`recomputeAgent(agentId)` scores that agent against all eligible candidates and
upserts `agent_matches`. Triggered on: agent create, agent edit, agent
unpause, and **a new member completing onboarding** (fan out over every active
agent instead of every user). Deleting is by `computed_at` staleness, not TTL.

Counts on the dashboard read `agent_matches`, never a live re-score.

### Notifications

`notifyMatchesOfNewUser` becomes agent-aware: dedupe on `(recipient, agent)`
rather than blanket-24h, so a member with three agents can hear about three
different people. Keep the per-run cap.

## Stages (each independently verifiable)

| Stage | Deliverable |
|---|---|
| A | Migration 085, agent repo, backfill, unit tests |
| B | `scoreWants` refactor + `recomputeAgent` + persisted matches |
| C | REST: list agents with counts, create, edit, pause/resume, archive, per-agent matches |
| D | Client: agents dashboard with counts, agent detail, create/edit/lifecycle |
| E | Continuous: onboarding-completion fan-out over agents, per-agent notification dedupe |
| F | E2E on preview, then production smoke |

## Out of scope (Wave 3)

Onboarding ending on the first agent, admin demand intelligence (needs the two
rival designation taxonomies unified first — `WANT_DESIGNATIONS` has 8 buckets,
`DESIGNATION_RULES` has 12, and they disagree), circles permissions batch,
semantic/embedding matching.

## Non-negotiables

Mobile-first at 360/390/768/1024/1280. Full server suite green before every
push. Preview-verified, then production smokes covering every use case and edge
case. Additive, reversible migrations only.
