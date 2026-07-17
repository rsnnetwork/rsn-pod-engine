# REASON Platform v1 — Stefan's 17 Jul asks, evaluated and phased

> Source: Stefan's WhatsApp texts 17 Jul 2026 + the agreed direction from
> `assets/RSN OVERHAUL/RSN Overhaul 0.1 - meeting summary 2026-06-19.md` (Desktop\RSN).
> Ali's decisions captured 17 Jul: match loop first; availability = simple time
> windows (no calendar integration); iOS/Android was a *reference point*
> ("think Facebook without the noise"), NOT a deliverable — out of scope.
> Status: SPEC — awaiting Stefan's answers to the definition questions below,
> then Phase 1 starts.

## The read

Stefan's texts are Phases 2–5 of the June 19 REASON plan he already agreed to,
nearly word for word. Not new direction — a pace complaint. The foundation layer
he describes first (profiling) is already shipped, which the reply to him makes
visible.

## What exists today (verified in code, 17 Jul)

- **Onboarding/profiling — SHIPPED.** Chatbot onboarding (66f22b2, 24 Jun) +
  LinkedIn enrichment (8e89003, 30 Jun). `users` already holds `my_intent`,
  `who_i_want_to_meet`, `why_i_want_to_meet`, `what_i_can_help_with`, `goals`,
  `expertise_text`, `career_stage`, embeddings.
- **Matching — event-scoped only.** The live-event matcher (P1–P3 shipped,
  `matching.engine.ts`, `intent-signals.ts`) has scoring + intent signals but
  runs only inside a live event. No standing platform-level match check.
- **Connection surfaces — partial.** Pokes (`poke.service.ts`, seeds
  encounter_history → canMessage), DMs with mutual gate (`dm.service.ts`),
  `connected-users.ts`, invites (per-event), notifications (bell/toast/email).
- **Circles — nothing.** Grep confirms only SVG `circle` hits. No schema, no UI.
- **Wall/feed — nothing.**
- **Availability/scheduling — nothing.**
- **Events/pods — production.** Pods are the activity container; circles layer
  on top (additive, not a rework).

## Build order (each phase demo-able; weekly show-and-tell to Stefan)

### Phase 1 — The standing match loop (~1 wk)
After onboarding completes (and on demand from the dashboard), the system checks
the DB for people who match this user and shows "we matched you with this
profile".
- v1 rule is deliberately dumb (June doc: "No AI required initially"):
  mutual-intent string/tag match (A wants founders + B is a founder), reusing
  the event matcher's intent signals + embeddings where free.
- **No-match screen** exactly as Stefan wrote it, three options
  1. Join the next RSN event (card → existing registration)
  2. Invite people (general referral surface over existing invite infra)
  3. Browse people near your profile (same engine, relaxed threshold)
  plus the standing side message "you'll be notified when new people arrive".
- **New-batch trigger**: on signup/onboarding-complete, re-run the check for
  affected users → notification via existing bell/email infra.

### Phase 2 — Double-opt-in intros (~1 wk)
Match card → "want to meet?" → other side gets notified → accept/decline →
on mutual accept: DM thread opens + both notified.
- **Availability v1 = time windows only.** Each side picks a few windows,
  overlap shown in the thread, they confirm there. No Google/Outlook OAuth.
- Reuses mutual-gate DM machinery; decline is quiet (no hard rejection UX).

### Phase 3 — Circles v1 (1–2 wks)
Stefan's definition: a circle is a group of people with the same intent/type
(founders, AI developers, doctors); circles can nest; circles↔pods are
many-to-many.
- Schema: `circles` (with `parent_circle_id` for nesting), `circle_members`,
  `circle_pods` join. UI flat in v1 even though schema nests.
- Admin-created v1 (pending Stefan's answer), join requests reuse pod
  join-request machinery.

### Phase 4 — The wall (1–2 wks)
Per circle: feed of posts + comments + event cards. Text-only v1 pending
Stefan's answer. The June doc's framing: the feed is the circle's heartbeat;
the event becomes one activity inside it.

### Explicitly out of scope
- Native/store mobile apps (Stefan's "Facebook" line was a reference, per Ali).
- AI/predictive matching (June doc forbids until behavioural data exists).
- Calendar integration (v2 if intros actually happen).

## Stefan's answers (17 Jul, via WhatsApp — gates cleared)
1. Match v1 definition — **"Yes"**: one-way fit (what A wants matches what B
   is/offers) is enough to SHOW the suggestion; nobody is introduced until both
   say yes. Locked.
2. The intro — **"we introduce them to each other"**: the PLATFORM performs the
   introduction. v1 interpretation: on mutual accept a chat opens that STARTS
   with an introduction of each to the other (system intro card / message with
   both profiles + why they match), not a cold empty thread. Both notified.
3. Circles creation — **"we do"**: admin-created v1. Locked.
4. Seed circles — **"let's talk"**: pending a conversation; does NOT block
   Phase 1–2 code, only the seeding content of Phase 3.
5. Wall v1 — **"photos and videos and shares from other platforms and text"**:
   bigger than text-only. Media uploads (Cloudinary already integrated for
   voice messages) + external link shares with preview cards + text. Phase 4
   scope updated accordingly.

## Notes
- 200 founding-member conversations are pending on Stefan's side — the Phase 1
  "understand users" milestone from June. Not an engineering deliverable but the
  matching data quality depends on it; the intent columns are the storage.
