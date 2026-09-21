# Onboarding Tick-box Flow, Wizard, Sheep Avatar + 19 Sep Test Findings: Programme Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan work package by work package. Steps use checkbox (`- [ ]`) syntax for tracking. This is a PROGRAMME plan: ten work packages, each one shippable on its own under the per-bug ship process. A package that is blocked on a client decision carries the decision and the default we build against.

**Goal:** Replace the LLM chat onboarding with a five-step tick-box flow that produces structured, matchable data; explain the product in a four-card wizard; replace the red face with the black sheep; and close the four findings from the 19 Sep test (P0 meeting loop, P1 connection states, P2 stale event state, P3 permissions).

**Architecture:** Fixed option catalogue with stable keys in `shared/`, validated by Zod enums on the server, stored as key arrays on `users` and dual-written as canonical text into the legacy columns both matchers already read, so existing and new members stay comparable. A server-side draft makes the flow refresh-survivable. The wizard is a body-portaled dialog driven by server tour state, reused from Support. The sheep ships behind one `SheepAvatar` component and one pose registry so asset delivery changes one file. The meeting loop moves into a sheet with a sticky primary action and real system messages in the thread.

**Tech Stack:** React 18 + Vite + Tailwind + React Query + react-hook-form + Zod + framer-motion (client); Express + pg + Zod + Socket.IO entity tags (server); Playwright headed E2E against preview then production.

**Spec:** `docs/superpowers/specs/2026-09-21-onboarding-flow-spec-shradha.md` (verbatim transcription of Shradha's deck, 21 Sep 2026).

**Audit evidence:** 8 parallel read-only code audits + 6 adversarial verifications on 21 Sep 2026 (126 claims confirmed, 32 corrected, 0 refuted). Every finding below carries file:line evidence from that audit. The full per-area reports (current behaviour, every finding, task-level file lists, the tests each change breaks, and the verifier's corrections) are in the private workspace at `workspace/audits/2026-09-21-onboarding-spec/<area>.audit.md` and `<area>.verify.md`; read the matching pair before starting a work package.

**Scope rule (Ali, 21 Sep 2026):** we do not send the client a question list. The ONLY client delivery we wait for is the sheep asset pack requested on 21 Sep (3D brief, full pose sheet, transparent high-quality PNG per pose including idle, animated and head-only versions if they exist, the placement list). Every other open point in the deck is decided by us at its best-case default and recorded in section 4. Nothing in this plan waits on a client answer.

## Global Constraints

- Deck rule, verbatim: "never show the user a guess as fact. Everything in the profile comes from what they ticked or typed - and they confirm it."
- Deck copy ships verbatim; every string lives in one constants file per surface so a wording change is a one-line edit.
- User-facing copy says "event", never "session"; never "poke"; never "agent" in new copy (pending decision D-C12).
- Every mutation emits entity tags (`emitEntities` / `fanoutUserEntity`); every `useQuery` declares `meta.entities`; no polling, no new bespoke socket events.
- Zod on every route, `AppError` subclasses only, a rate limiter on every new route, parameterized SQL only.
- Migrations are append-only, idempotent (`IF NOT EXISTS`), and carry NO explicit `BEGIN/COMMIT`: the runner already wraps each file (`server/src/db/migrate.ts:51-57`; 092-098 follow this). Numbers are allocated in merge order; next free today is **099**.
- `notifications_type_check` is an allowlist. Any migration that touches it restates the FULL list from the latest definition (`094_notification_call_types.sql`) plus every type added since.
- Mobile-first: 360 / 390-414 / 768 / 1024 / 1280; tap targets >= 44px; `100dvh` + `env(safe-area-inset-*)`; no horizontal scroll; fixed overlays portal to `document.body`.
- E2E primary actions are asserted with the viewport-fit helper (WP0) and clicked by coordinates. `isVisible()` and `locator.click()` hid the P0 for weeks.
- Components stay under ~200 lines. `MessagesPage.tsx` (1708) and `ChatbotOnboarding.tsx` (1287) are not grown; new work goes in new files.
- Production data: read-only SELECTs need Ali's OK; any UPDATE follows section 15 of the project rules (preview, exact ids, confirmation, users-count safety check).
- Every ship: full server suite + both builds green, headed Playwright on preview, deploy, headed Playwright on production (Chromium + WebKit, phone and tablet widths), `/checkhole`, then a numbered test script for Ali.
- Never delete `client/public/rsn-logo.png`, `rsn-logo-white.png` or `rsn-sheep-white-email.png`: delivered emails reference them, and `vercel.json` serves HTML with status 200 for a missing file.

---

## 1. Assessment of the deck

**What it gets right.** Structured answers fix the real weakness: every matching input today is free text from a 36-field LLM extraction, so nothing is filterable or comparable, and a two-word chat yields an almost empty intent (`intent.schema.ts:15-77`, `platform-match.service.ts:80-103`). The flow also removes 11-22 Haiku calls per member from a prepaid key that has run dry three times. The confirm step fixes a real breach: today three guess layers (IP country, email-domain company, LLM-inferred wants) reach the card and some reach the public profile, and pressing "Yes, continue" silently saves them as if the member had typed them (`known.ts:20-64`, `ChatbotOnboarding.tsx:706-715`, `enrichment.repo.ts:161-179`).

**What is missing or contradicts itself.**

1. **Nobody is asked who they ARE.** Slide 9 says ROLE "can't ship blank"; slides 4-6 collect no role. The scorer's strongest signal (+0.6) is a designation hit on the OTHER person's role (`platform-match.service.ts:326-356`). A member who only ticked the four questions scores at most 0.35 against anyone's search (threshold 0.45), so new members would be invisible to each other and "straight into Suggestions" would land on a thin page. Their public card would be a bare name. This is the largest hole in the deck.
2. **Option labels cannot be fed to the matcher as written.** "Skills & services" and "Grow my professional network" tokenise to nothing; "key talent" trips the HR and job-seeker buckets; "Sales / marketing / growth leaders" spans two buckets; "Event organisers & community builders" has no bucket; plural labels never trigger synonyms (`intent-signals.ts:42-100, 166-264`). A key-to-signal mapping layer is mandatory.
3. **Q4 has five industries.** Most members will pick Other, which the deck says is never required for matching.
4. **The sheep images cannot ship.** 241x327 opaque RGB crops from a numbered sheet of at least 14 poses, captions baked in. No idle pose, though every motion "returns to idle". No animation files, though slide 8 specifies motion.
5. **"Use the black sheep in emails"** is a header redesign, not a file swap: a black mark is invisible on the `#1a1a2e` band (`email.service.ts:30-33`). The app header already shows the black 2D sheep.
6. **The wizard promises things that are broken today.** Card 2 ("you'll see it here") has no screen; card 3 ("pick a green slot - we create the meeting") is the P0. The wizard ships after those fixes.
7. **Two findings are not what they seem.** P3 "anyone can create a circle" was observed from a super_admin account (image15); members cannot (`circles.ts:54`). But members CAN create events indirectly, by creating a pod first (`pods.ts:63-67`). P0 "picked it, nothing happened": the tester used the right control (image10 shows the confirm card open); the Confirm button was clipped below a non-scrollable panel.
8. **It reverses earlier client decisions** without saying so: Claus's 23 Jun "no mascot, never a creature", the 10 Sep cartoon face, Claus's 10 Sep conversational onboarding, the 19 Jun "REASON is the product name" (deck copy says RSN).

## 2. Root causes found (headline)

| # | Finding | Root cause | Evidence |
|---|---|---|---|
| P0-a | Green slot picked, nothing happens | "Confirm meeting" renders below the clip edge of a non-shrinking flex child inside an `overflow-hidden` column on any window shorter than ~970px; the confirm request was never sent | `MessagesPage.tsx:1002, 1257, 1265`; `MeetingScheduler.tsx:605-677` |
| P0-b | Stuck after saving | Save exists only while dirty and ends in a toast; no Close control; the panel squeezes the message list to 24px and clips the composer | `MeetingScheduler.tsx:216, 360, 598-602` |
| P0-c | Nobody is told both saved | `setAvailability` never writes to the thread; no system-message kind exists | `meeting-windows.service.ts:211-270` |
| P0-d | Latent: saving fails forever once any saved slot is >30 min in the past | Server rejects the WHOLE payload; client always re-sends past slots and cannot untick them | `meeting-windows.service.ts:222-226`; `MeetingScheduler.tsx:354-356, 546` |
| P0-e | Latent: double confirm duplicates message, bell, emails | Unconditional UPDATE outside a transaction; random `.ics` UID per generation | `meeting-windows.service.ts:342-400`; `calendar.service.ts:28` |
| P1-a | No sign of whom you asked | `listMatches` sorts asked people LAST then applies `LIMIT 25`; image12 shows exactly 25 un-asked rows, so asked people were cut from the payload | `agent.repo.ts:254, 281-282` |
| P1-b | Both press "I want to meet", no match | `sendPoke` never checks the reverse direction; unique index is per direction | `poke.service.ts:139-178`; `047_user_pokes.sql:33-35` |
| P1-c | "Mutual matches" empty | Filter reads the in-event rating flag; accepted requests seed it FALSE | `rating.service.ts:562-564`; `poke.service.ts:306-314` |
| P1-d | Accept from the tray | Built deliberately on 4 Sep; the deep-link target shows nothing on phones | `NotificationBell.tsx:239-284`; `MessagesPage.tsx:1002-1009` |
| P2-a | Event "in Transition" for days | `round_transition` and `lobby_open` are host-gated with no timer; nothing completes an event when the room empties; `completeSession` is not idempotent without an in-memory entry (would re-send recap emails) | `round-lifecycle.ts:947-980, 1000-1003, 1151` |
| P2-b | Dead events never leave memory | TTL age uses `timerEndsAt \|\| now`; every `session:join` re-creates an immortal entry, even for scheduled events | `orchestration.service.ts:206`; `participant-flow.ts:512-534` |
| Brand | White sheep in emails | Mark and navy band are coupled since the 11 Sep shell; two emails are mis-nested, one has no footer, one has two | `email.service.ts:285-293, 1026-1079, 1164-1187` |

Good news from the audit: hi-res transparent masters of the black 2D sheep already sit in the repo, unused (`client/public/rsn-logo-black.png` 14656x11151 ARGB, `rsn-sheep.png` 1920x1460 ARGB). The email mark, favicons and an interim avatar need nothing from the client.

## 3. Ship order

```
WP0  P0 hotfix (one class) + viewport-fit helper         today, unblocked
WP1  Meeting loop: sheet, system messages, idempotency   unblocked
WP5a Asked people never truncated                        unblocked
WP7a Plain-word event labels                             unblocked (defaults)
WP2  Tick-box: data + server                             unblocked (decisions locked, section 4)
WP3  Tick-box: client flow (interim sheep)               after WP2 contract
WP4  Sheep + brand                                       everything now except final 3D art (A7 waits for the asset pack)
WP5  Connections: states, crossed match, tray, view      5a now; 5b onward needs D-A3 (Ali)
WP6  Wizard + Explore + Support                          gated on WP1 + WP5 three states live
WP7  Event lifecycle: terminal guard, reaper, cleanup    flag ships dark
WP8  Permissions                                         build per locked decisions
WP9  Retire chat onboarding; optional re-onboard         after WP3 is prod-proven

Only ONE item in the programme waits on the client: the final 3D sheep art and its animation (WP4 A7, and the sheep slot on the WP1 confirmed card and the WP4 A5 match card, which ship with the interim sheep until then).
```

**Migration allocation (merge order; restate at merge time):** 099 `dm_system_messages` (WP1) · 100 `onboarding_tickbox` (WP2 + WP6 tour columns) · 101 `pair_requests` (WP5: pair-unique pending index + `match_seen_at_a/b`) · 102 `circle_proposals` (WP8, only if approved) · 103 `reonboard_for_tickbox` (WP9, only if approved).

---

## WP0. P0 hotfix + the test that would have caught it  (XS, today)

**Files:** Modify `client/src/features/messages/MessagesPage.tsx:1257` · Create `e2e/helpers/viewport-fit.ts` · Create `e2e/tests/scheduler-viewport-fit.spec.ts`

- [ ] **Step 0 (needs Ali's OK, read-only):** `SELECT meeting_confirmed_at, avail_updated_at_a, avail_updated_at_b FROM dm_conversations WHERE id = '2dca4608-fd62-4f61-9b56-17fcb6e84a51'` plus that conversation's `meeting_availability` rows, and a Render log search for `POST .../scheduling/confirm` on 19 Sep. Turns "the request was never sent" from inference into evidence and shows whether the stale-slot 400 (P0-d) also fired.
- [ ] **Step 1: write the helper.**

```ts
// e2e/helpers/viewport-fit.ts
import { expect, type Locator, type Page } from '@playwright/test';

/** A control counts as reachable only if a person could tap it without scrolling:
 *  fully inside the viewport, topmost at its centre, and no clipped ancestor was scrolled. */
export async function expectReachable(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox();
  expect(box, `${label}: not rendered`).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x, `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${label}: top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label}: right edge`).toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y + box!.height, `${label}: bottom edge ${box!.y + box!.height} > ${vp.height}`).toBeLessThanOrEqual(vp.height + 1);
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const onTop = await target.evaluate((el, [x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }, [cx, cy]);
  expect(onTop, `${label}: covered or clipped at its centre`).toBe(true);
  return { cx, cy };
}

/** Click where a finger would land. Never locator.click(): it scrolls clipped ancestors. */
export async function tapReachable(page: Page, target: Locator, label: string) {
  const { cx, cy } = await expectReachable(page, target, label);
  await page.mouse.click(cx, cy);
}
```

- [ ] **Step 2: write the spec.** Seed a connected pair with a shared overlap over REST (pattern: `w6-exact-meeting.spec.ts:78-89`). At 360x640, 390x844, 768x1024, 1024x600, 1280x720, 1366x768: open the panel, `expectReachable` on Save and on "Confirm meeting", log the measured boxes. Record expected-red per viewport (arithmetic says Confirm is clipped everywhere except possibly 768x1024).
- [ ] **Step 3: run it against today's build.** Expected: FAIL on Confirm at 1366x768 with `bottom edge ... > 768`.
- [ ] **Step 4: the fix.** `<div data-scheduler-panel>` becomes `<div data-scheduler-panel className="min-h-0 overflow-y-auto">` so the whole panel scrolls inside the thread column.
- [ ] **Step 5:** spec green at every size after one scroll inside the panel (assert the panel is the scroller, thread header still at y >= 0). Full suite, both builds, preview headed, ship, production headed, `/checkhole`.
- [ ] **Step 6:** when Ali reports the fix to the client (his call, his words): the loop works again and the redesign follows. Never say the testers tapped the wrong control; they did not.

## WP1. The meeting loop  (L)

**Finding.** Rows P0-a to P0-e above. Also: scheduling mutations are not block-gated; client and server disagree on "past" at confirm time (client offers the running half hour, server rejects starts older than 60s: `MeetingScheduler.tsx:134-136` vs `meeting-windows.service.ts:323-325`); no route tests exist for the scheduling endpoints; `ChatQuickAccess.tsx:166-167` would show a system card as "You: You are both free…".

**Fix.**

- **Migration 099 `dm_system_messages`:** `direct_messages.kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system'))`, `system_meta JSONB`; `dm_conversations.meeting_proposed_key TEXT`, `meeting_proposed_at TIMESTAMPTZ`; `notifications_type_check` restated in full + `'meeting_proposed'`.
- **Shared** `shared/src/types/dm.ts`: `DmMessageKind`, `DmSystemMeta = {type:'availability_shared'} | {type:'meeting_proposal', slots:string[]} | {type:'meeting_confirmed', startAt, durationMin, meetingType, joinPath}`; `lastMessageKind` on `ConversationSummary`.
- **Server, one canonical insert:** extend `insertDirectMessage` (`dm.service.ts:255-323`) with an optional `PoolClient` + `kind`/`systemMeta`; no third insert path. `from_user_id` = the member whose action triggered the card.
- **`confirmWindow`** in one transaction: lock the conversation row; same slot already confirmed and not over → 200 `alreadyConfirmed:true`, no side effects; a different standing future meeting → `ConflictError` "A meeting is already set for <time>"; else UPDATE + system row. Post-commit, each in its own try/catch: broadcast, bell with link `/messages/<convId>`, `emitEntities([a,b],[dm-conversation:<id>, user:<a>:dms, user:<b>:dms])` + `user:<partner>:notifications`, emails. Stable `.ics` UID from `conversationId + startAt`, LOCATION = join URL (`calendar.service.ts`).
- **`setAvailability`** in one transaction: DROP past slots instead of rejecting, prune past rows, single `INSERT ... SELECT unnest($3::text[])`; post exactly one system row on first share (`availability_shared`) or on an empty → non-empty FUTURE overlap (`meeting_proposal`), 10-minute cooldown, never on clears. Emit to BOTH users (today partner-only, `:259`).
- **Both mutations:** `blockService.areBlocked` guard → `ForbiddenError`; one "past" rule shared by client helper, proposal builder and `confirmWindow` (not confirmable once started); per-route limiter.
- **Client** `features/messages/scheduler/`: `SchedulerSheet` (portal; full-screen under 640px, centred `max-h-[min(90dvh,760px)]` above; header with 44px Close; ONE `min-h-0 overflow-y-auto` body; sticky footer with safe-area padding), `SlotGrid`, `DayStrip`, `ConfirmStep`, `slots.ts` (pure helpers + footer state machine + `localizeMeetingText`), `useScheduling.ts`. Footer: dirty → "Save and send availability" (deck wording); clean + overlap → "Tap a green time to confirm it"; green selected → "Confirm Sat 19 Sep, 4:00 PM". Tapping a "Both can" cell SELECTS it. Remove the document-level outside-pointerdown closer (`MessagesPage.tsx:559-573`) and, only after the both-user emit is live, the `refetchInterval`.
- **`SystemMessageCard`**: centred neutral card, no reactions, no "seen", no sender avatar. Proposal chips render from the LIVE overlap; confirmed card has an in-app Join (navigate, not Linkify's new tab), the URL as copyable text, "Add to calendar", and a 48px slot for the sheep MATCHED avatar. `ChatQuickAccess` + inbox preview understand `lastMessageKind`.
- **Thread hardening:** `shrink-0` on header, banner, incoming-call card, CallWaitingCard, composer; `min-h-0` on the list; `listRef.scrollTo` replaces `scrollIntoView`.

**Tests.** `meeting-windows.test.ts` rewritten: double confirm → one UPDATE / one message / one bell / two emails; concurrent different slots → one 200 + one 409; re-confirm allowed after the meeting is over; message insert failure rolls back; blocked pair 403; past slots dropped; first share posts once; same overlap posts nothing; two simultaneous saves post one proposal. New `__tests__/routes/meeting.test.ts`. New `e2e/tests/meeting-loop.spec.ts`: two contexts (1366x768 Europe/Oslo, 390x844 Asia/Karachi), A saves → card in B's open thread without reload, B saves → proposal on both, B taps chip → Confirm → both see the card with Join + calendar in their own local time; DB pinned once; one system row; one bell; returning user with past slots can still save.

**Breaks:** `intro-scheduling`, `w6-exact-meeting`, `meeting-call`, `meeting-call.shots`, `meeting-call.layout`, `reason-ui-matrix:312-347`, `truthful-loop:253-259`, `phaseD-dm-realtime.test.ts:46-62`. Keep the `📅 Meeting confirmed: <ISO>` content shape so cached old bundles and `dm-live-delivery.spec.ts` still read well.

**Decisions:** D-A5 (meeting length moves into the confirm step, reversing 9 Sep) is Ali's. D-C8 (link = in-app call room) and D-C9 (card copy) are locked in section 4.

## WP2. Tick-box onboarding: data + server  (L)

**The contract (decision-independent; keys are stable, labels may change, a key is never reused):**

```ts
// shared/src/onboarding/options.ts   (re-export from shared/src/index.ts; shared has no zod)
export const ONBOARDING_INTENTS = [
  { key: 'grow_network',            label: 'Grow my professional network',       shortLabel: 'Grow my network' },
  { key: 'find_customers_partners', label: 'Find customers or partners',         shortLabel: 'Customers or partners' },
  { key: 'find_investors',          label: 'Find investors or funding',          shortLabel: 'Investors or funding' },
  { key: 'find_cofounder_talent',   label: 'Find a co-founder or key talent',    shortLabel: 'Co-founder or talent' },
  { key: 'get_advice',              label: 'Get advice from experienced people', shortLabel: 'Advice' },
  { key: 'invited_exploring',       label: 'I was invited - just exploring',     shortLabel: 'Just exploring' },
] as const;

export const ONBOARDING_MEET = [
  { key: 'founders',               label: 'Founders & entrepreneurs',              shortLabel: 'Founders' },
  { key: 'investors',              label: 'Investors & VCs',                       shortLabel: 'Investors & VCs' },
  { key: 'sales_marketing_growth', label: 'Sales / marketing / growth leaders',    shortLabel: 'Growth leaders' },
  { key: 'advisors_mentors',       label: 'Advisors & mentors',                    shortLabel: 'Advisors & mentors' },
  { key: 'developers_technical',   label: 'Developers & technical people',         shortLabel: 'Technical people' },
  { key: 'event_community',        label: 'Event organisers & community builders', shortLabel: 'Community builders' },
] as const;

export const ONBOARDING_OFFERS = [
  { key: 'mentoring_advice',           label: 'Mentoring & advice',           shortLabel: 'Mentoring' },
  { key: 'investment',                 label: 'Investment',                   shortLabel: 'Investment' },
  { key: 'introductions_network',      label: 'Introductions & my network',   shortLabel: 'Introductions' },
  { key: 'skills_services',            label: 'Skills & services',            shortLabel: 'Skills & services' },
  { key: 'partnerships_collaboration', label: 'Partnerships & collaboration', shortLabel: 'Partnerships' },
  { key: 'hiring_open_roles',          label: 'Hiring - I have open roles',   shortLabel: 'Hiring' },
] as const;

export const ONBOARDING_INDUSTRIES = [
  { key: 'software_ai',       label: 'Software & AI',       shortLabel: 'Software & AI' },
  { key: 'finance_investing', label: 'Finance & investing', shortLabel: 'Finance' },
  { key: 'health_wellbeing',  label: 'Health & wellbeing',  shortLabel: 'Health' },
  { key: 'consumer_retail',   label: 'Consumer & retail',   shortLabel: 'Consumer & retail' },
  { key: 'media_creative',    label: 'Media & creative',    shortLabel: 'Media & creative' },
  { key: 'other',             label: 'Other',               shortLabel: 'Other' },
] as const;

/** "Which best describes you?" mirrors ONBOARDING_MEET so wants and identities are symmetric (D-C1). */
export const ONBOARDING_SELF_KINDS = ONBOARDING_MEET;

export const ONBOARDING_LIMITS = { meetMin: 1, meetMax: 3, selfMax: 2, otherMaxLen: 60, aboutMaxLen: 160, roleMaxLen: 120 } as const;

export type IntentKey   = typeof ONBOARDING_INTENTS[number]['key'];
export type MeetKey     = typeof ONBOARDING_MEET[number]['key'];
export type OfferKey    = typeof ONBOARDING_OFFERS[number]['key'];
export type IndustryKey = typeof ONBOARDING_INDUSTRIES[number]['key'];

export interface OnboardingAnswers {
  intent: IntentKey; lookingToMeet: MeetKey[]; canOffer: OfferKey[]; industries: IndustryKey[];
  industryOther: string | null; selfKinds: MeetKey[]; jobTitle: string | null; company: string | null; about: string | null;
}
export type OnboardingStep = 'welcome' | 'q1' | 'q2' | 'q3' | 'q4' | 'q5' | 'confirm';
export interface OnboardingState {
  status: 'not_started' | 'in_progress' | 'update_required' | 'completed';
  draft: Partial<OnboardingAnswers>; step: OnboardingStep;
  tour: { pending: boolean; seenAt: string | null; outcome: 'completed' | 'skipped' | null };
}
```

**Endpoints (all: `authenticate` → limiter → Zod → service → emit):**

| Route | Does | Emits |
|---|---|---|
| `GET /onboarding/state` | status + the member's OWN draft + tour state. No guesses, no enrichment candidate. Fires `tryGravatar` fire-and-forget | - |
| `PUT /onboarding/answers` | partial JSONB merge into `user_intent_profiles.onboarding_draft`; saved per STEP (the global 100/min `apiLimiter` sits in front) | `user:<id>:onboarding` |
| `POST /onboarding/answers/confirm` | full answers in the body; one transaction with `SELECT ... FOR UPDATE` on the users row; own path so the old `/onboarding/confirm` keeps working during the deploy window | `user:<id>`, `user:<id>:onboarding`, `admin:users`, the member's active pods |
| `POST /onboarding/tour` | `COALESCE` stamp of `tour_seen_at` + `tour_outcome` (first write wins) | `user:<id>` |

**Migration 100 `onboarding_tickbox`:** on `users`: `onboarding_intent TEXT`, `looking_to_meet TEXT[] NOT NULL DEFAULT '{}'`, `can_offer TEXT[] …`, `industries TEXT[] …`, `self_kinds TEXT[] …`, `industry_other VARCHAR(60)`, `tour_due_at`, `tour_seen_at TIMESTAMPTZ`, `tour_outcome TEXT CHECK (… IN ('completed','skipped'))`; `CHECK (cardinality(looking_to_meet) <= 3)` in a guarded DO block; on `user_intent_profiles`: `onboarding_draft JSONB NOT NULL DEFAULT '{}'`; widen `onboarding_stage_events_stage_check` with `answers_saved, tour_shown, tour_completed, tour_skipped` keeping all 11 existing values (+ update `StageEventStage` in `stage-events.repo.ts:26-37`). No GIN indexes until a query filters on them.

**Tasks.**

- [ ] **T2.1 Characterization tests first** (`__tests__/services/matching/onboarding-options-characterization.test.ts`, no production code): every deck label through `designationsWanted`, `normalizeDesignation`, `tokenizeTerms`; pin the pair "wants Investors & VCs" vs "offers Investment + Finance, no role" BELOW 0.45 for an untagged search and at 0.467 for a tagged one (a double-count accident, not coverage); pin that `scoreNewcomerAgainstAgents` and `recomputeAgent` agree.
- [ ] **T2.2 Shared catalogue** (above) + unit test: unique snake_case keys, deck order, `shortLabel <= 24`. Proof is a client PRODUCTION build importing the constants as values.
- [ ] **T2.3 `server/src/services/matching/option-signals.ts`** (pure): per meet key `{bucketKeys, agentLabel, wantText, tags}` reusing migration 087 phrases where a bucket exists; per offer key `{offerText, offerBuckets}`; per self kind `{roleTitles}`; per intent `{complementOfferKeys, primaryMeetKey}` with NO want text for `grow_network` / `invited_exploring` and never the word "talent". Guard tests: `designationsWanted(wantText + expandWantTags(tags))` equals `bucketKeys` EXACTLY; `normalizeDesignation(roleTitle)` equals the bucket; every `offerText` tokenises to at least one non-stop token.
- [ ] **T2.4 Migration 100**; apply twice locally; users count identical.
- [ ] **T2.5 `answers.schema.ts` / `answers.repo.ts`**: Zod enums from the shared keys, `.strict()`, arrays de-duplicated, `industryOther` only with `'other'`, control characters stripped. `confirm()` writes keys + canonical text into `who_i_want_to_meet`, `what_i_can_help_with`, `industry` (summary <= 100), `professional_role` (from self kinds), `job_title` (`job_title_source='stated'`), `company`, `my_intent`; `bio` ONLY when About was typed (`COALESCE`, a re-onboarding member's 2000-char bio must survive); upserts `matching_intent` with `userDesignation`, `desiredDesignations`, `desiredPeople`, `source:'tickbox_v1'` (the live-event matcher ignores `professional_role`, `matching.service.ts:89`); sets `tour_due_at = NOW()` only when `tour_seen_at IS NULL`; NEVER touches `inferred_profile`, `confirmed_profile`, `onboarding_conversation` (today's completion erases the enrichment cache, `intent.repo.ts:414`). `firstCompletion` derives from `onboarding_status`, not `onboarding_completed` (invite + Google rows are created TRUE, `identity.service.ts:714`). Side effects only on first completion or changed answers.
- [ ] **T2.6 Routes + limiters** (`onboardingAnswersLimiter` 60/min, `onboardingConfirmLimiter` 10/min), `E.userOnboarding` in both `entities.ts` files and `ENTITIES.md`. Route tests: 401; each invalid body 400; PUT then GET survives a "refresh"; two parallel confirms create agents once; confirm with zero new agents still emits; tour idempotent; 429.
- [ ] **T2.7 `planAgentsFromAnswers`** beside the untouched `planFirstAgents`: exactly one search per ticked meet key, `sales_marketing_growth` is ONE search wanting two buckets, tags per option (not the chat path's full list), de-dupe by stored `intent JSONB {source:'tickbox_v1', meetKey}` (column exists since 085:33), order = Q1's `primaryMeetKey` first. Primary scored synchronously, the rest via the background rescore. Response returns `primaryAgentId`.
- [ ] **T2.8 Scorer:** load the new columns; candidate designation also from `self_kinds` role titles (and `can_offer` offer buckets when absent); a deterministic tiebreak (reciprocal fit, shared industries, Q1/Q3 complement, recency) applied ONLY to rows already >= 0.45 or as a sort key. Snapshot test: legacy free-text member scores are byte-identical before and after.
- [ ] **T2.9 Taxonomy bucket `community`** before `manager` (`organi[sz]er`, community builder/manager/lead, event host) with a read-only before/after report of members who change bucket (D-C3).
- [ ] **T2.10 Privacy + admin:** `intent` and `lookingToMeet` into `PRIVATE_MEMBER_KEYS`; `canOffer`, `industries` onto `PublicMember` and the cards that render it (else a tick-box member's Suggestions card is a bare name); both pinned lists updated (`public-card.test.ts:86-92`, `users-public-card.test.ts:111-112`); answers + draft + tour in `GET /admin/inspect/users/:id/onboarding`; `profile_complete` from ONE helper (name + intent + >= 1 of each list); one rule for `PUT /users/me` vs the answers (the four derived legacy fields become read-only on the profile page, edited through the answers endpoint).
- [ ] **T2.11 Enrichment (D-C6):** default keeps the ScrapingDog scrape for photo + admin visibility with a SERVER-side trigger (no client calls `POST /enrich` any more), deletes the LLM extras pass and the LLM role gap-fill, and never writes an enriched field to `users` without a member action.
- [ ] **T2.12 Acceptance fixtures** from personas WE write off the option matrix, one per meet kind plus the awkward ones (invited and just exploring; Other-only industry; one tick everywhere) (`mixed-population.test.ts`): new→legacy, legacy→new, new→new for every meet kind, plus one prod-style E2E with two complementary throwaway users asserting stored `agent_matches >= 0.45` both ways.

**Blocked by:** nothing from the client (D-C1, D-C2, D-C3, D-C5, D-C6 are locked in section 4). Ali's D-A4 (all ticked searches active) only affects T2.7 and can land last.

## WP3. Tick-box onboarding: client flow  (L)

**Files (each under ~200 lines):** `features/onboarding/OnboardingFlow.tsx`, `useOnboardingDraft.ts`, `onboardingSchema.ts`, `OnboardingShell.tsx`, `components/StepProgress.tsx`, `components/OptionTile.tsx`, `steps/WelcomeStep.tsx`, `steps/QuestionStep.tsx`, `steps/ConfirmStep.tsx`, `steps/ConfirmRow.tsx`, `PhotoCard.tsx` (extracted unchanged from `ChatbotOnboarding.tsx:350-397, 1096-1131`, keeps testids `card-photo` / `use-google-photo`). Add `@hookform/resolvers` (justified by the project's forms rule; not installed today). `App.tsx`: `React.lazy(OnboardingFlow)` + Suspense in place of the eager chat import.

**Design.**

- One question per screen ("One screen at a time", slide 3) with "1 of 5", Back, and Next disabled until valid. Step lives in `?step=`, clamped to the first incomplete step computed from the SERVER draft, with `?redirect=` preserved on every push. Nested `/onboarding/*` routes would break the exact-path exemption in `ProtectedRoute.tsx:31` and its jest pin; the Google-photo round trip returns to bare `/onboarding` (`ChatbotOnboarding.tsx:371`), so the step must be recoverable from the draft alone.
- ONE react-hook-form instance (`FormProvider`, `zodResolver`) reset from the draft. Next = `trigger(field)` → PUT draft → push `?step=`. No `setQueryData`.
- `OptionTile`: full-width button, `min-h-[48px]`, `role=radio|checkbox`, `aria-checked`, visible tick box, disabled over the max with inline "You can pick up to 3.", focus ring.
- `OnboardingShell` lifts the proven layout once: `100dvh` column, `overflow-hidden` root, inner `flex-1 overflow-y-auto` with safe-area padding, `my-auto` content (the 10 Sep clipping fix), sticky footer.
- Welcome: sheep wave once, the three deck lines verbatim (the question count in line three follows D-C1: "4" as drawn, "5" if the who-are-you question is approved), ONE button "Let's go", name + photo only. No skip, no side panel.
- Confirm: "Here's your profile - built from your answers." Rows: You're here to / You want to meet / You can offer / Industries / You are / Your role (typed, required) / Company (typed, optional) / About you (optional, counter, "Shown on your public profile"). Each row has its OWN 44px Edit that expands the same option list inline, one row open at a time. Every value cell `min-w-0 break-words`; never a raw URL. "Looks right - continue" → POST confirm → `await checkSession()` (the gate is Zustand; an entity tag alone will not open it) → navigate to `/agents/<primaryAgentId>`; the wizard opens over it (WP6).
- Completed-member guard: status `completed` → redirect unless `?edit=1` (today a completed member reaching `/onboarding` from the AppLayout banner or MatchesPage re-runs everything).
- Loading = shell + sheep + spinner; query error = retry card; save error = toast with the server message, ticks preserved. The new client tolerates a 404 on `/onboarding/state` for the minutes before Render finishes (server and client deploy independently).

**Tests.** `e2e/tests/onboarding-flow.spec.ts`: gate lands on Welcome; Q1 single-select replaces; Q2 fourth tile disabled at 3; Other text required only when ticked; reload on q3 stays on q3 with q1-q2 intact (DB-asserted draft); browser Back keeps ticks; double-click Next sends ONE PUT; offline Next keeps ticks; `?step=confirm` with an empty draft bounces to q1; confirm shows ONLY ticked/typed values (assert no country / company guess text); 60-character Other causes no overflow at 360 (`scrollWidth - clientWidth <= 0`); second tab follows via the entity tag. `onboarding-devices.spec.ts`: Chromium + WebKit at 360 / 390 / 768 / 1024 / 1280 with `expectReachable` on every primary action. Shared helper `completeTickboxOnboarding(page, answers)` replaces the chat section inside the long walkthroughs (`ali-walkthrough`, `full-flow-linkedin`, `ali-account-claus`) so their meeting/agent coverage survives.

**If the old flow stays live more than a day:** one-line hotfix `min-w-0 break-all` on `ChatbotOnboarding.tsx:154` for the LinkedIn overflow.

## WP4. Sheep avatar + brand  (M now, M later)

- [ ] **A0 Asset pipeline** (no image tooling exists on this machine or in any `package.json`): `scripts/build-brand-assets.mjs` with `sharp` as a DEV dependency (D-A7) producing 1x/2x/3x WebP + PNG per pose, the email PNG, real square favicons (32, 180 opaque, 192, 512) and a genuine multi-size `favicon.ico` (today's is a 38x30 PNG mislabelled `.ico`; all favicon PNGs are one non-square 1920x1460 file). Outputs committed.
- [ ] **A1 `client/src/components/brand/SheepAvatar.tsx` + `sheepPoses.ts`.** Props `{ pose?: 'idle'|'wave'|'listening'|'thinking'|'welcome'|'matched'; size?: number; variant?: 'full'|'head' (auto head under 64px); playOnce?: boolean; onSettled?: () => void; className? }`. Square box with `object-contain` and explicit width/height (the art is portrait; no layout shift), `aria-hidden`, `data-testid="sheep-avatar"` + `data-pose`, `useReducedMotion()` → static. `sheepPoses.ts` is the ONLY file that knows asset paths.
- [ ] **A1-interim (D-A9):** until masters arrive, the registry points every pose at the EXISTING black 2D sheep cut from `rsn-sheep.png`, with framer-motion entrance + gentle bob. On-brand ("the brand mark is the BLACK sheep"), zero client dependency, and the red face is gone the day WP3 ships. Delete `HostPresence.tsx` and `OnboardingWelcomeModal.tsx` (unreachable behind the hard gate; sells "one short chat") with its two mounts, after moving nothing: it dies with WP9's `/known` cleanup.
- [ ] **A3 Email shell.** Change `emailCardOpen` ONLY, per D-C10 (locked: light header, black sheep on an opaque white badge baked into the PNG). Why the badge: today's white-on-navy is the dark-mode-safe arrangement; any black mark needs the opaque badge or Gmail/Outlook dark mode hides it. Ali sees the rendered light + dark screenshots before it ships. New file `rsn-sheep-black-email.png` (no `@` in the name), integer width/height, `color-scheme` meta. Fix the broken shells while the file is open: `sendDmNotificationEmail` (double close, two footers), `sendMeetingConfirmedEmail` (no close, no footer), both poke emails (balanced but MIS-NESTED: footer renders inside the body). **Render harness:** mock `resend` with a key set to capture HTML (14 of 15 builders return void and skip sending in tests), write to temp, Playwright screenshots at 360 and 600 in light and emulated dark; the test asserts one open marker, one close marker, div depth back at body level right before the close marker (a balanced-count test passes on the mis-nested ones). **Two deploys:** PNG to production first, verified `content-type: image/png`; then the server change.
- [ ] **A4 `BrandLogo`** at the four logo sites; only `LoginPage.tsx:111` and `RequestToJoinPage.tsx:48` (h-14) are under-resolved; favicons from A0; meta description, theme-color, og tags.
- [ ] **A5 MATCHED moments:** inline match card anchored to the ACCEPTED REQUEST (not "first message": `acceptPoke` reuses existing conversations, `poke.service.ts:317-324`), once per conversation per side via `dm_conversations.match_seen_at_a/b` (migration 101, precedent 095), mark-seen route emits `dm-conversation:<id>` + `user:<id>:dms` to both. Sheep on the WP1 confirmed card. Light surfaces only (a black sheep is invisible on the live-event overlay `#202124`).
- [ ] **A6 Dashboard wave** beside "Welcome, {name}", once per browser session, gated on `onboardingCompleted === true`.
- [ ] **A7 Phase B animation** when files land: registry gains animated sources; static under 96px, under reduced motion, and never more than one animated instance per screen; lazy chunk whose Suspense fallback is the static pose; never loaded on live-event routes. If Rive: self-host `rive.wasm` (default loader fetches from unpkg). If transparent video arrives without the HEVC-alpha `.mov` for Safari (it cannot be encoded on Windows), Safari and iPhone get animated WebP or the static pose instead; we do not go back to the client for it.
- [ ] **A8 Not built:** LISTENING "while the other side is typing". DMs have no typing signal; adding one needs an explicit exception to the no-new-socket-events rule (precedent: `presence:ping`, `events.ts:273-277`). D-C11.

**Cannot be verified from this machine (Ali's checklist):** real inbox rendering in Gmail web / Gmail mobile dark / Apple Mail / Outlook; iPhone home-screen icon; transparent-video autoplay under iOS Low Power Mode.

## WP5. Connections  (L)

- [ ] **5a Asked people are never truncated** (unblocked, ships first): `listMatches` returns outstanding (`LIMIT n`) and in-progress (`LIMIT 100`) as two bounded sets from ONE statement (`row_number()` partitioned by the asked flag); reconcile `matchCount` with what the page shows. Proven against a REAL database (the repo unit test only asserts SQL text).
- [ ] **5b Per-person state (D-A3):** drop `pk.agent_id = a.id` from the LATERAL state lookup and `countExpr` only; keep per-agent stickiness. Compute at READ time: latest request either direction, encounter, block. Return `relation: 'none'|'asked'|'asked_you'|'matched'|'met'` + `pokeId` + `otherUserId`. New `shared/src/types/meet-request.ts` (four local copies today; avoid the word "Connection", it collides with `rating.service.ts`).
- [ ] **5c Crossed requests become a match.** Serialise with migration 101: partial UNIQUE index on `(LEAST(sender_id,recipient_id), GREATEST(...)) WHERE status='pending'` (a `SELECT ... FOR UPDATE` locks nothing when neither row exists). **Pre-check (Ali's OK, read-only):** count crossed pending pairs in production first; a failing `CREATE UNIQUE INDEX` blocks the deploy because migrations run at startup. `sendPoke` accepts the reverse pending request through the extracted `acceptPoke` body; `declinePoke` becomes atomic; reuse notification type `poke_accepted` for both sides. True concurrency test: `Promise.all` of two sends against a real DB.
- [ ] **5d Realtime.** Prerequisite: `notifyAgentsOfNewUser` (`platform-match.service.ts:624-662`) emits `E.user(ownerId)` + `E.userNotifications` per owner, dedupe path included, one fan-out per owner (a batched emit leaks other owners' ids). Today the 15s polls are the ONLY delivery path for newcomer matches. Then `E.userConnections` to BOTH users on send / accept / decline / auto-match, outside the bell-preference branch, keeping `E.user`. One `useAgentsQuery` hook (the key is declared in three files with different options). Debounced reconnect resync that skips the first connect and excludes `/session/*/live` (reconnect-storm history, `socket.ts:25-34`). Only THEN remove the polls.
- [ ] **5e `GET /api/connections`** → `{ asked, askedYou, matched }` from one SQL, public-card fields only, blocks + inactive filtered, `LIMIT 200`. "Matched" = accepted request OR `mutual_meet_again`; never inferred from the existence of a conversation (admins and event mutuals create conversations without a request). Links go to `/messages/new/<otherUserId>`, which self-redirects and re-opens a deleted thread.
- [ ] **5f Cards + view.** `AgentMatchCard` / `SuggestionCard` (shared with the wizard mocks; keep testids `agent-match-<id>`, `agent-match-state-<id>` and the text "I want to meet"). People page gets tabs Matched / Asked / Asked you / Met at events.
- [ ] **5g Tray.** Remove Accept/Decline for meeting requests in `NotificationBell.tsx` (TWO instances are mounted: desktop aside + mobile header). Row → `/messages?poke=<id>` with "View request" and a server-derived status: `GET /notifications` LEFT JOINs `user_pokes` via a regex-guarded id extract (never cast a malformed link to uuid); a socket-pushed row without status reads as pending. Invites untouched (D-C13).
- [ ] **5h Request view on every width.** `MeetingRequestThread`: public card inline, the intro as a bubble, Accept/Decline bar where the composer sits. `?poke=` counts as an active pane below `lg` (today the target shows NOTHING on phones). `GET /pokes/:id` (participants only, registered AFTER `/received`, `/with/:userId`) so an answered link redirects. The compact band in Messages converges on the same `usePokeActions` hook. No conversation row before acceptance.
- [ ] **5i Hygiene required by project rules:** `meetRequestLimiter` on the three send endpoints; uuid param schemas on every poke route; `ProtectedRoute` forwards `pathname + search` as `?redirect=` so email deep links survive login and the onboarding gate (they die today, `ProtectedRoute.tsx:26, 35`); emails deep-link to the request / thread; one copy sweep with a grep pin: no `/\bpoke/i` in any `AppError` message or client string literal (ten strings in `poke.service.ts`, `SettingsPage.tsx:37`, `routes/agents.ts:131`).

**Breaks:** `meeting-request-bell.spec.ts` (written to prove the opposite; rewrite, do not delete), `ali-walkthrough:209-217`, `agent-report-block.spec.ts:57-105`, `agent.repo.test.ts:151-153, 227-229`, `poke.service.test.ts:359, 478-507`, `matching-agents.spec.ts:270-272`, `platform-match-loop:122`, `truthful-loop:177`, `dm-request-profile-card.spec.ts:94-102`.

## WP6. Wizard + Explore + Support  (L; ships after WP1 and WP5b-f are live)

- **Tour state is server state:** `tour_due_at` is set ONLY by the new confirm, so legacy members and E2E users (INSERTed `completed`, `e2e/helpers/auth.ts:49-57`) never auto-open. `useTourState` reads `GET /onboarding/state` tagged `E.user(id)`.
- **`features/tour/`:** `TourDialog.tsx` (portal to body at `z-[60]`; full-screen sheet under 640px, centred `max-w-lg` above; `role=dialog aria-modal`; hand-rolled focus trap with focus restore, no new dependency; Escape = Skip; backdrop tap does nothing; body scroll locked), `TourCarousel.tsx` (framer-motion `drag="x"` + `dragDirectionLock` + `touch-action: pan-y`; arrow keys; four dots as 8px visuals inside 44x44 hit boxes; `aria-live` "Card n of 4"; reduced motion → opacity crossfade; Back is `invisible` on card 1 so nothing jumps; final CTA "See my suggestions"), `tourCopy.ts` (deck strings verbatim), `TourCardVisuals.tsx` + `tourSampleData.ts` (live mini-mocks from the real `SuggestionCard` with FICTIONAL people, `aria-hidden`; screenshots would be stale within this same programme and must never show real members), `useFocusTrap.ts`.
- **Mount:** `AppLayout` renders the dialog while `tour.pending` and the path is not `/onboarding`. Finish or Skip: close optimistically → POST → navigate to `/agents/<primaryAgentId>` (exactly one active search) else `/agents`. If the POST fails the tour reappears on next load; the member is never blocked. Remove the post-confirm toasts (they float above the dialog at `z-[100]`).
- **Support:** `HowItWorksCard` first on `/support`, deep link `/support?tour=1` (param stripped on close), replay never POSTs an outcome; FAQ rewritten by us around Suggestions / Matches / Meetings / Circles / Events (today's describes pods, unlocks, live-event matching). Keep the pinned `my-support-tickets` query shape.
- **Explore hardening:** `isError` branches on `AgentsPage` and `AgentDetailPage` (a failed fetch reads "You have no agents yet" today); first-visit empty state with two CTAs; chip row of the member's other searches; Suggestions into the mobile bottom nav in place of Pods (D-C14) with exactly ONE `nav-suggestions-badge` node.

**Tests.** `onboarding-tour.spec.ts`: finish lands on people with "I want to meet" reachable and no toast; skip on each card; refresh mid-wizard re-opens; new context re-opens; a second open context closes without reload; a `createTestUser` user never sees it; replay leaves `tour_outcome` unchanged; focus never leaves the dialog in 12 Tabs; every control >= 44x44 and inside the viewport at 360 / 390 / 414 / 768 / 1024 / 1280 on Chromium + WebKit.

## WP7. Event lifecycle  (M + M)

- [ ] **7a Plain-word labels** (unblocked): `statusConfig.ts` stays the single source, gains `sessionStatusLabel(status, audience)` + `sessionStatusDetail(status, round)`. Members: Upcoming / Live now / Wrapping up / Ended / Cancelled. Hosts additionally: Main room open / Round N in progress / Rating the round / Between rounds. Adopt in `PodDetailPage.tsx:944-946` (renders raw `round_transition` today), `HostDashboardPage.tsx:92-131`, `SessionDetailPage.tsx:487, 633-634, 777-783`, `InviteAcceptPage.tsx:161`; `SessionsPage.tsx:49` Upcoming filter uses `sessionStatusPhase` (the hand-written list omits `closing_lobby`). Grep gate: no `status.replace(/_/g`.
- [ ] **7b Terminal guard inside `completeSession`:** `UPDATE sessions SET status=$2, ended_at=NOW() WHERE id=$1 AND status NOT IN ('completed','cancelled') RETURNING id`; return on 0 rows BEFORE any emit, sweep or email. Optional `{ reason, status, sendRecap }` argument, exported name unchanged (pinned by `may21-end-event-host-lag-pin.test.ts`).
- [ ] **7c Reaper, shipped DARK** (`ABANDONED_EVENT_REAPER_ENABLED=false`, mirrored in `render.yaml`): 5-minute tick; Postgres-first probe (the Upstash quota lesson) on the five live statuses using `GREATEST(COALESCE(active_state_updated_at, started_at), updated_at)`, served by `idx_sessions_active_state`; ground truth for emptiness = `io.in(sessionRoom(id)).fetchSockets()` ONLY (the canonical connected set can stay "connected" after a restart: image14 still shows two people "In Main Room"); two-strike `rsn:session:<id>:empty-since` (`SET NX EX 14400`, in-memory Map when Redis is null); close at empty >= 30 min or started > 12 h ago; never close a paused event with people present; lock `rsn:lock:session-complete:<id>`; `completed` if a round finished else `cancelled`; recap emails only within 60 min of last activity.
- [ ] **7d Memory hygiene:** `lastActivityAt` on `ActiveSession`, initialised in ALL five constructors (`participant-flow.ts:516-530`, `host-actions.ts:2441-2455` + the socket start path, `round-lifecycle.ts:118-138, 186-200`) and serialised in `persistToRedis`; TTL age uses it; every tick evicts local entries whose DB row is terminal (`activeSessions` is per-process); restart recovery bounded to 4 h; the join path refuses rows past the hard deadline (one curious click on "Enter Live Event" resurrects the event today); null `timerEndsAt` when entering a timerless state.
- [ ] **7e Entity tags on end:** audience = `completedParts` (`round-lifecycle.ts:1093-1097`) UNION pod members, plus `fanoutAdminEntities('sessions')`, emitted AFTER the pinned `session:completed`. NOT `fanoutSessionEntities` as-is: it excludes `left` and races the participant sweep. Add a platform-wide `sessions` tag to the Events list and Home: `GET /sessions` returns events of all public / invite-only pods, so ONE abandoned test event pollutes every member's Events tab.
- [ ] **7f Super_admin can end / cancel a live event cleanly:** all five REST host services honour `super_admin` (the route admits, the service rejects); admin cancel of a LIVE event goes through teardown (timers, LiveKit, `active_state`, participant sweep, `ended_at`, `lobby_room_id = NULL`, entity tags) instead of the raw UPDATE at `session.service.ts:716`; AdminSessionsPage gets a validated `phase=live` filter, the confirmation Modal instead of `window.confirm`, an error state, 44px buttons; `ForbiddenError` copy says "event".
- [ ] **7g One-off cleanup (runbook, section 15):** with the reaper flag still OFF, read-only SELECT of stuck rows (live statuses older than the bound, PLUS cancelled rows with `ended_at IS NULL AND lobby_room_id IS NOT NULL`) → show Ali exact ids / titles / dates → tables touched: `sessions`, `session_participants`, `matches`, `invites`, `encounter_history`; preserved: `users`, `join_requests`, `refresh_tokens`, `audit_log` and the rest of the never-delete list → explicit confirmation → close EACH id through the fixed End Event endpoint with recap suppressed (never the global flag: a flag closes whatever matches at that moment, which is not "exact ids") → after-state + users count unchanged → enable the reaper only when the candidate SELECT returns zero rows. Production smoke: event 5c8b3075 reads "Ended", no "Enter Live Event", nobody "In Main Room", the 15s sweep warning stops.

**Pins to update in the same commit:** `phase-a-state-sync-architecture.test.ts:121-160`, `tier1-a1-dashboard-coalesce.test.ts:118-130`, `s18-terminal-state-and-rating-replay.test.ts:55`, `s23-s24…test.ts:73-82`, `lcy-wave0-lifecycle-serialization.test.ts:47`, `phase2-locked-transitions.test.ts:68`; `s16-precohost-detail-smoke.spec.ts:133` asserts "Completed". 62 server test files pin source text in this area: run the full suite after every task.

## WP8. Permissions  (S proof now; L circle proposals; S events rule)

**Verified matrix today.** Circles: create / update / archive / attach = admin only, server AND client (`circles.ts:54`, `CirclesPage.tsx:86, 96`); the screenshot was taken as super_admin. Events: pod director / host / admin; but ANY member can create a pod (`pods.ts:63-67`) and therefore events. The admin user editor already has "Can create pods" and "Can host events" switches that do NOTHING (`user_entitlements` exists, unenforced).

- [ ] **8.1 Prove the matrix ourselves (no client question):** headed production check as a plain member that the New circle form is absent and `POST /circles` returns 403; record the evidence in progress.md. This closes the "anyone can create a circle" finding as a super_admin observation.
- [ ] **8.2 Members propose circles, admins approve (D-C15):** migration 102: `circles.status ('pending'|'active'|'declined')`, reuse the existing `created_by` as proposer, `decided_by`, `decided_at`, `decline_reason`, partial unique name index `WHERE status='active' AND archived_at IS NULL`, two notification types (full allowlist restated). `/circles/proposals*` routes registered BEFORE `/:id` and outside the 200-char pin windows (`circle.service.test.ts:119-136`). EVERY read filters `status='active'`, including the ones outside the circle service: `invite.service.ts`, `routes/invites.ts`, `circle-wall.service.ts`, `AppLayout`, `HomePage`, `InvitesPage`, `CircleWall`. Negative tests: a pending circle cannot be joined, listed, invited to, posted to, attached, or used as a parent. Retrofit entity emits on join / leave / create / archive (none today).
- [ ] **8.3 Events rule made visible:** a member without the role sees who can create events instead of a silently missing button; `/sessions/new` gets a real empty state. Pod creation stays open (D-C16). Parked, not built: enforcing the existing entitlement switches, which would need a read-only count of member-directed pods and an UPDATE-only backfill first (`user_entitlements` is on the never-delete list).

## WP9. Retire the chat onboarding  (L; separate commit after WP3 is prod-proven)

Delete, do not flag (D-A6): a flag keeps the prepaid-key dependency and ~3,000 lines of tests alive. Rollback = `git tag pre-chat-removal`. Precise dead list in the audit (`onboarding-server-data`, T7): `chatbot.service.ts`, `prompts.ts`, `intent.schema.ts`, `intent-strengthen.ts`, the chat routes, `saveIntentAndComplete` and friends, `known.ts` guess helpers, `POST /auth/onboarding/complete` + `OnboardingPage.tsx` (a SECOND completion path that seeds no searches, runs no newcomer fan-out and emits nothing), `ChatbotOnboarding.tsx`, `HostPresence.tsx`, shared `OPENINGS` / `hostOpening` (only after the server stops importing them). KEEP `POST /onboarding/admin/refresh-enrichment`, `normalizeLinkedinUrl`, `getOnboardingStatus`, every historical column and stage name. Reword the LLM balance alert (`email.service.ts:1117-1125`). ~19 e2e specs and 8 `.mjs` scripts call the chat endpoints: port or retire in the SAME commit.

**Optional 9b, migration 103 (D-C4, D-A8):** `UPDATE users SET onboarding_status='update_required' WHERE onboarding_status='completed' AND onboarding_intent IS NULL AND status='active'`, `onboarding_completed` stays TRUE (083 precedent, members remain matchable), excludes `in_progress`. Section 15 applies: SELECT preview with counts + sample to Ali first. "Welcome back" variant of step 1.

---

## 4. Decisions

### Ali

| # | Decision | Recommendation |
|---|---|---|
| D-A1 | Ship the WP0 one-class hotfix today, ahead of the redesign | Yes |
| D-A2 | Five read-only production checks: conversation 2dca4608 + Render confirm logs; crossed pending pairs; stuck events list; member-directed pods count; members affected by a re-onboard | Yes |
| D-A3 | Asked / matched state per PERSON, reversing your 7-8 Sep per-agent decision (pinned by `agent-report-block.spec.ts`). Per-agent is dishonest today: the DB allows one pending request per pair, so a "fresh" card on a second search returns 409 | Per person for state + counts; per agent only for stickiness. The nav badge number will drop for some members |
| D-A4 | Q2 searches: all ticked kinds active, or first active + rest paused (4 Sep rule) | All active: the member chose at most three explicitly |
| D-A5 | Meeting length moves into the confirm step (reverses 9 Sep) | Yes; keeps the sheet body short |
| D-A6 | Delete the chat onboarding outright, tag first | Delete |
| D-A7 | New dependencies: `@hookform/resolvers` (client), `sharp` (dev-only) | Yes to both; no animation runtime until animated files exist |
| D-A8 | Re-onboard existing members through the questions | Yes, after the flow is prod-proven, 083-style |
| D-A9 | Interim sheep = the existing black 2D sheep until 3D masters arrive | Yes |
| D-A10 | Claus: his 23 Jun "no mascot, never a creature" was marked do-not-re-litigate, and the chat onboarding was his 10 Sep design | Not a blocker. The 21 Sep deck is the newest instruction and we build to it. Ali's call whether to mention it to Stefan; one component + one registry keeps another reversal cheap |

### Locked by us (Ali, 21 Sep: "do on our own best cases"; the client is NOT asked)

Each row was an open point in the deck. We build the decision on the right. Every one is cheap to change later: option labels, copy and thresholds live in single constants files or env vars, and keys never change.

| # | Open point in the deck | Our decision |
|---|---|---|
| D-C1 | Nothing asks who the member IS; slide 9 says role can't ship blank | Add tick-box "Which best describes you?" (same six kinds as Q2, up to 2) + typed "Your role" (required) and "Company" (optional) on Confirm. Welcome copy becomes "5 quick questions" |
| D-C2 | Final option lists and rules | The deck's lists VERBATIM, in deck order (we do not rewrite the client's options). Q1 exactly 1; Q2 1-3; Q3 >= 1; Q4 >= 1; Other only on Q4, combinable, 2-60 chars, and the Other text IS used for matching as offer-side text so members outside the five industries still carry a signal. Widening the industry list is a follow-up suggestion after ship, not part of this build |
| D-C3 | Which "want to meet" options match which "can offer" options; bucket for organisers / community builders | We write the compatibility table and the keyword list per option ourselves in `option-signals.ts`, pinned by the T2.3 guard tests; add the `community` bucket with the before/after report reviewed by Ali |
| D-C4 | Existing members go through the questions? | Yes, later (D-A8) |
| D-C5 | "About you": length, public? Are the four answers visible to others? | 160 chars, public (`users.bio`). Intent + who-to-meet private; can-offer + industries public |
| D-C6 | LinkedIn: still collected at join, still scraped silently? Does a LinkedIn / Gravatar photo count as "guessed" for members without Google sign-in? | Keep the scrape for photo + admin visibility; show nothing; write nothing without a member action |
| D-C7 | Product name in copy: RSN (deck) or Reason (shipped) | Deck verbatim: RSN, "How RSN works"; sweep remaining "Reason" strings |
| D-C8 | The meeting "link"; one tap or tap-then-confirm; reschedule / cancel; scheduler after the first meeting | In-app call room + .ics; tap green then ONE always-visible Confirm press; first confirm wins, change/cancel as a follow-up; keep 9 Sep behaviour |
| D-C9 | Copy the deck does not supply: the three chat cards, state labels, plain-word event states, wizard controls, validation lines, Support FAQ | We write it, plain words, deck tone. States: "I want to meet" / "Asked, waiting for a reply" / "Wants to meet you" / "Matched". Chat cards: "<Name> shared times they can meet. Add yours to find a match." / "You are both free: <up to 3 times>. Pick one to confirm." / "Meeting confirmed: <time>, 30 min video call." Wizard: "How RSN works", "Next", "Back", "Skip", "Card {n} of 4". Q2 limit: "You can pick up to 3." Explore empty: "No one fits yet. We keep looking as new people join and will tell you the moment someone does." Ali reads every string in the headed smoke before it ships |
| D-C10 | Email header treatment | Light (white) header, black 2D sheep baked onto an opaque white rounded badge (dark-mode safe), dark live-text "RSN", grey tagline, red strip kept. Rendered light + dark screenshots go to Ali, not the client |
| D-C11 | Which black sheep is the brand mark (2D silhouette vs 3D character); small-avatar form; first match = once ever or every match; returning-user wave; typing indicator; dark surfaces | 2D stays the logo, 3D is the avatar; head crop under 64px; every new match once per conversation; dashboard once per session; typing indicator out of this batch; light surfaces only |
| D-C12 | The word "agent" on Suggestions, toasts and bells ("Your Sales / marketing / growth leaders agent found someone") | Rename to "search" in member copy |
| D-C13 | "Never accept from a toast": also pod and event invites? What does the asker see on decline? (Shipped today: the profile page says "A previous request was declined" and allows re-asking) | Invites out of scope; keep today's decline behaviour |
| D-C14 | Suggestions in the phone bottom nav in place of Pods | Yes |
| D-C15 | Circles: the deck says "Circles should be approved by an admin" | Exactly that: members propose, the circle is invisible to others until admin or super_admin approves, admins keep instant create. Decline reason optional, shown to the proposer |
| D-C16 | Events: the deck says "Decide deliberately whether members can create either, then enforce it" | Decided: event creation stays with pod director / host / admin, and the rule becomes VISIBLE (a member without the role reads who can create events instead of finding no button). Open pod creation stays as it is; the two dead admin switches are left alone in this batch and noted in progress.md |
| D-C17 | Abandoned event rule | Empty 30 min or 12 h after start; completed if a round ran, else cancelled; no late recap emails |

## 5. What the client delivers (asked 21 Sep, nothing else)

The one message sent to Shradha asks for: the 3D brief, the full pose sheet, each pose (wave, listening, matched, thinking, welcome, plus an idle one) as a high quality PNG with a transparent background and no text, animated versions and a head-only version if they exist, and the placement list from the last slide.

**When it arrives:** run the pack through the A0 pipeline, swap `sheepPoses.ts`, ship. If the poses do not share one canvas and feet line, A0 normalises them (trim, pad to a common box, align the baseline) so poses can cross-fade without jumping. If no head-only version comes, A0 cuts a head crop for sizes under 64px. If no animation comes, the poses ship static with the framer-motion body motion from A1 and A7 stays parked. If no placement list comes, the surfaces on slide 8 are the list: onboarding steps, dashboard greeting, the match card, the confirmed-meeting card.

**Everything else we cover ourselves:** brand mark from the 14656px black sheep already in the repo; favicons and the email badge from the A0 pipeline; header wordmark stays live text (no lockup SVG needed); acceptance personas written by us from the option matrix (every meet kind x new/legacy, both directions); tester viewports covered by the eight-size matrix in WP0 instead of asking what devices were used; re-test accounts reset with `e2e/reset-test-account.mjs` on Ali's word (never `sa@mister-raw.com`).

## 6. Risks

1. **Day-one matching regression** if the four questions ship exactly as drawn. Gate: T2.1 characterization tests + T2.12 persona fixtures green before release.
2. **Assets with no delivery date on a "showstopper".** Mitigated by A1-interim; the flow never waits for art.
3. **False-green E2E.** The P0 survived several headed production runs. Every new spec uses `expectReachable` / `tapReachable`.
4. **Three workstreams rewrite `notifications_type_check`;** the later migration must carry the earlier one's values or inserts start failing in production.
5. **Deploy skew:** client (Vercel) and server (Render) ship independently. New endpoints get new paths; the new client tolerates a 404 for the minutes in between.
6. **~45 e2e specs and ~12 jest suites pin behaviour this plan changes.** Each WP lists its casualties; rewrite in the same commit; one spec per process (shared pg pool).
7. **The reaper is an automated production mutation.** Ships dark; cleanup by exact ids first.
8. **Client reversal risk** (no sheep → face → sheep; chat → tick-box). One component + one registry + one copy file per surface keeps the next reversal cheap.

## 7. Spec coverage (self-review)

| Deck | Covered by |
|---|---|
| Slide 2 tasks 1 / 2 / 3 | WP2 + WP3 / WP6 / WP4 |
| Slide 3 five steps; "never show a guess as fact" | WP3; T2.5 + T2.11 remove all three guess layers |
| Slide 4 Welcome | WP3 WelcomeStep |
| Slide 5 four questions → fields | T2.2 - T2.5; gap raised as D-C1 / D-C2 |
| Slide 6 Confirm, inline edit | WP3 ConfirmStep / ConfirmRow |
| Slide 7 wizard, skippable, re-openable from Support | WP6 |
| Slide 8 poses, order wave → listening → matched | WP4 A1 / A5 / A7; typing-indicator surface deferred (A8, D-C11) |
| Slide 9 LinkedIn overflow / ROLE blank / red face / white sheep / app header | WP3 (+ one-line hotfix) / D-C1 / A1-interim / A3 / already black, D-C11 |
| Slide 10 P0 three fixes | WP0 + WP1 |
| Slide 11 P1 own connections; tray | WP5a-f; WP5g-h |
| Slide 12 P2; P3 | WP7; WP8 |
| Slide 13 remove / data / avatar | WP9 / WP2 / WP4 |
