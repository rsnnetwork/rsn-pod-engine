# 25 Oct product changes — design (26 Oct 2026)

**Input:** "RSN Product Changes, 25 October 2026" (Stefan Avivson and Claus Sønderskov), 25 numbered items, 11 P0 / 13 P1 / 1 P2.
Verbatim spec, evidence and six audits: `workspace/audits/2026-10-26-feedback-25oct/`
(`spec-25oct-transcription.md`, `walkthrough-evidence.md`, `01-onboarding.md` … `06-onboarding-reconciliation.md`).
Every item below cites the audit section that holds the file:line detail; builders read that section before coding.

**Who decided what.** Ali asked (26 Oct, ~01:00 PKT) for a plan and autonomous delivery of all of it, with all testing and
production smokes, while he is away. There were no questions to the client. Every product call below is therefore
**Claude's call**, made at the best default the evidence supports, and listed for Ali in the final report so he can
overrule any of them before Stefan sees the work.

## 1. Intent

Stefan's objective: "A person must be able to join, understand its purpose, find someone relevant, arrange a meeting,
meet successfully and continue the relationship afterwards." The walkthrough broke at every step.

The decisive fact (evidence file): **they tested production** (app.rsn.network, `origin/main`'s client). The onboarding
they had agreed on 19 Oct is built, but only on the preview (`reason-m1`, preview.rsn.network), which goes live only on
Stefan's go. So "nothing has been done since last time" was true of production. At 2:58 Stefan said the onboarding must
become "what we already agreed, with the small changes from this call" — i.e. the preview's flow plus the 25 Oct fixes.

**Success** = Stefan and Claus run Scripts A–D on the preview end to end with two real accounts and find nothing to
raise; every server fix is already live and proven on production; and one written checklist (ONB-06) shows, item by
item, what is live, what is on the preview, and what is open.

## 2. Goals, non-goals, anti-goals

**Goals:** all 25 items built and verified; P0s first; the server half of everything live on production as soon as
it is proven; the client half on the preview, swept in three engines and at every width; the ONB-06 checklist; a
plain-prose note for Stefan (Ali sends it).

**Non-goals** (the spec's own): no new strategy, monetisation, brand redesign or AI matching algorithm. Also not in
this batch: LinkedIn as a sign-in method (needs a verified LinkedIn app), sharing wants publicly (Stefan's share-switch
decision), the Foundation's 20-minute question and an entity picker in onboarding (not in the agreed flow; listed as
open), speed-networking main-room tile sizes (Phase Q was Stefan's own request; asked, not changed).

**Anti-goals** (would fail even if it "works"):
- Merging `reason-m1` into `main` without Stefan's go. **Never.**
- A server change that breaks production's current client. Every server change is additive and compatible.
- Speed networking regressing. Every format change is gated so a missing/unknown format behaves exactly as today.
- Silent failures: a button that does nothing, a disabled control with no visible reason, a save that is discarded.
- Mass data changes. No prod UPDATE/DELETE beyond what a migration needs to add structure (CLAUDE.md §15).

## 3. Delivery model

- **Server** (`server/`, `shared/`, migrations): built on branches from `main`, shipped to production one release at a
  time through staging CI → `main` → Render, each proven with a headed smoke on production (throwaway
  `%rsn-e2e.invalid` members, cleaned up by id) and a check-hole before the next release.
- **Client:** built on `reason-m1` (the preview). After each server release, `main` is merged into `reason-m1`.
  Preview sweeps are batched (Vercel's checkpoint blocked a day of heavy preview traffic on 21 Oct).
- **LIVE-CLIENT exceptions** (also patched on production's own client, because Stefan saw them there and they are
  small): (L1) the tour cards — heading and explanation first, then labelled English examples; (L2) profile links open
  in the same tab with a working Back; (L3) a Reason pod defaults to Freeform and a Video meeting hides round
  settings in production's create forms. Production's v1 onboarding questions are **not** rebuilt (the agreed flow is
  v2 and arrives with the merge).
- Two server fixes reach production's current client with no client deploy: the bell's request state (CON-02) and
  "the same time picked by both books it" (CON-03).

## 4. Decisions (Claude's calls)

### Onboarding (audit 01, 06)
1. Every v2 question is "Select all that apply." (no maxima; at least one; ceiling 20 against abuse). DB caps dropped
   by migration 109. v1 Zod caps also dropped (harmless; production's v1 client still caps itself).
2. Employees: new v2 keys (audit 01 §ONB-02 table): meet managers/leaders, meet people hiring; find a new role, find
   advice/learning, find people to hire, find partners; offer knowledge from my work, offer referrals; self employee,
   self manager/leader. Relabel `self_advisor_experienced` → "I am an advisor or mentor." The join/approval emails stop
   saying "founders, leaders, and company owners".
3. LinkedIn suggests several self-descriptions from **stated** roles only (never inferred ones), each preselected with a
   "From LinkedIn" note; the choice survives other tabs via the server's `linkedin.chosen`.
4. Tour (both branches): heading → explanation → "Examples only. These are not real members." → picture whose people
   carry an "Example" tag, English names, varied roles including an employee, sheep tiles as photos. Names checked
   read-only against real members before shipping.
5. Extra searches are scored after the confirm responds; one newcomer bell per member, not one per search.
6. Open for Stefan (checklist, not built): the 20-minute question, an entity picker in onboarding, a daily cap on paid
   LinkedIn lookups.

### Requests and booking (audit 02)
7. Profiles open in the same tab everywhere except inside a live event (where a new tab is marked "opens in a new
   tab"); Back returns to the source route; `<main>` scroll is restored on Back; filters live in the URL.
8. The request row is the single state. `GET /notifications` returns each request's status; accept/decline are
   claims (repeat = 200, opposite = 409 with the current status); accepting closes the reverse request; resolving
   marks the bell row read. **Mutual requests become a match** (For You already promises this).
9. **Agreeing a time books it:** a save that leaves exactly one shared future time confirms it (30 min, video unless
   chosen). Two or more shared times → the confirm step stays open in front of the saver. The green cell and the
   thread card's time open the confirm step for that slot; nothing is silently discarded; the time zone is named.
10. A **`meetings` table** (one row per confirmed meeting, history kept) written in the same transaction as today's
    `dm_conversations.meeting_*`. Events gets "Your meetings" (upcoming/past/cancelled) and a details page
    `/meetings/:id` (who, when in local time, why, Join gated 5 min before, Add to calendar, Reschedule, Cancel). The
    join location stays the 1:1 room `/meet/:conversationId`. Emails to both (time in the subject, stable calendar
    UID + SEQUENCE so moves update the entry, cancellation email). Reminder bell + email 10 min before. The Events nav
    shows the number of upcoming meetings, plus a "live now" dot.
11. In the 1:1 room, one person leaving no longer ends the call for the other; they can rejoin. The token is minted
    on entry, not on page load.

### Pods and events (audit 03)
12. One editable definition in `shared/src/events/` (pod types → orchestration default/options → allowed event formats
    → form fields/defaults → live behaviour), used by every create/edit screen and enforced by the server. Offered now:
    **Speed networking** and **Video meeting**; voice/webinar/in-person stay defined but not offered until Shradha
    defines them.
13. Reason pod → Freeform by default (Freeform or Moderated allowed), formats Video meeting (default) or Speed
    networking. The communication select is hidden and derived from the type. Type changes never silently overwrite
    a value the user chose (they get an inline notice; a destructive switch asks first).
14. `sessions.event_format` column (default speed_networking, no backfill). A production "Video Meeting" choice
    (`config.eventType`) is honoured as a real meeting (option O1).
15. A video meeting = everyone in one room until the director ends it: no plan, no rounds, no ratings, no breakouts,
    one duration formula (fixes the ~55-min LiveKit token expiry), an attendance recap instead of a ratings recap.
16. Invites: a connections picker (search + browse, pages of 30, multi-select with chips, state per person: member /
    going / invited / declined), one idempotent batch call, `declined_at` so organisers see declines, co-hosts may
    invite. After "Schedule event", the event page opens with the picker. The title is prefilled ("Video meeting ·
    Test"); errors sit at the field and next to the button.

### Live video (audit 04)
17. A new **MeetingRoom** for meeting-format events, chosen by format; speed networking keeps today's tree untouched.
    Fixed-height stage that never scrolls: alone → own camera + "waiting"; **two people → side by side, equal size, on
    screens ≥1024px wide in landscape** (Stefan: "with two people we should see each other the same size"), remote
    large + self picture-in-picture on phones/portrait; three or more → an even grid sized to fit; a "Focus" toggle
    swaps between the two-person layouts. Self-view always visible. Bottom control bar (mic, camera, chat, people,
    **Leave**); director and super_admin also get **End for everyone** with a confirm. Leave keeps the meeting running
    for the others and lands on the event page.
18. Speed networking: Leave sits beside End in the host bar, End is the only red button, End is enabled for a
    super_admin (the server already allows it). An admin can no longer cancel a live event silently through DELETE.

### After the meeting (audit 05)
19. Event chat is stored in Postgres as it is sent (`event_chat_messages`), shown on the completed event page to
    people who took part plus host/co-hosts (admins: lobby messages), kept as long as the event exists; closed
    accounts show as "Former member". The broken history access check is closed first.
20. "Message all participants" v2: organisers (host, co-hosts, pod director/host) and admins, after the event ends,
    their own words, to everyone who took part (no-shows optional), admins included, blocked pairs skipped, 3 sends
    per event per sender per day, the reason shown as text when unavailable. Versioned so production's client is
    unchanged.
21. Pod wall: parallel `pod_posts` tables reusing the circle-wall rules; active members read/post/reply/react;
    director/host moderate and pin; bells honour the group preference; realtime by entity tags (no polling).
22. **Group chats: 3 to 50 people**, started by an organiser from a completed event's attendees, living in Messages
    ("Up to 50 people" stated in the product). Attending the same completed event counts as having met, so
    video-meeting attendees can also message each other one to one.
23. One path after any event: Live → Event details (completed: recap, chat, message everyone, group chat) → Back to
    pod. Leaving no longer kills the app-wide connection; completion pushes entity tags so open pages flip to "Ended".

## 5. Migrations (numbers fixed; no BEGIN/COMMIT; idempotent; additive)

| # | File | Release |
|---|---|---|
| 108 | `108_notification_types_oct25.sql` — restate `notifications_type_check` once with every new type of this batch: `meeting_reminder`, `meeting_cancelled`, `pod_post`, `pod_comment`, `pod_reply`, `pod_reaction`, `group_message` (plus the 16 existing) | first release |
| 109 | `109_onboarding_select_all.sql` — drop the three answer caps, add ceilings of 20 | onboarding server |
| 110 | `110_meetings.sql` — `meetings` + `dm_conversations.current_meeting_id` + backfill of exact-time meetings | meetings server |
| 111 | `111_event_format.sql` — `sessions.event_format` | event formats server |
| 112 | `112_event_chat.sql` — `event_chat_messages`, `event_chat_reactions` | event chat server |
| 113 | `113_post_event_message_body.sql` — `body`, `include_no_shows` | message participants server |
| 114 | `114_invites_declined_at.sql` | invites server |
| 115 | `115_pod_wall.sql` — `pod_posts`, `pod_post_comments`, `pod_post_reactions`, `pod_comment_likes` | pod wall server |
| 116 | `116_event_groups.sql` — `dm_groups.session_id`, type `event` | group chats server |

No later migration touches `notifications_type_check`; 108 carries the full final list.

## 6. Order

1. **R9a** server: CON-02 + CON-03 + migration 108 (fixes production's bell and booking now).
2. **R9b–R9i** server, one per release: onboarding (109), meetings (110), event formats + meeting runtime (111),
   event chat + completion fan-out (112), message participants v2 (113), invites (114), pod wall (115), group chats
   (116). Built in parallel worktrees, shipped one at a time.
3. **Client on reason-m1**, after `main` is merged in: onboarding v2; booking (scheduler, Events meetings, badge,
   details page, 1:1 room); navigation; pod/event forms; MeetingRoom; post-event; invites; pod wall; group chats.
4. **LIVE-CLIENT on main**: L1 tour, L2 same-tab profiles, L3 pod/event form defaults.
5. ONB-06 checklist, final sweep (Scripts A–D, three engines, 360–1440px), progress entry, the note for Stefan.

## 7. Verification (definition of done, per the spec and the house rules)

- Every slice: TDD for logic; full server jest; client tsc + production build; realtime-entities check; headed local
  look at 360/390/768/1024/1280/1440 in Chromium and WebKit.
- Every server release: CI green, deploy verified, a **headed smoke on production** with outcome assertions using two
  throwaway accounts, check-hole, before the next release.
- The preview: Scripts A–D as headed specs with two (three for group chat) accounts, Chromium + WebKit + iPhone 14 +
  tablet widths, plus the speed-networking regression set (audit 04 §7.3) — the spec's own "regression checks show
  that ordinary speed networking still works".
- Named as unverifiable from here: real two-person camera/mic media between humans, real iPhone Safari, real email
  inboxes. Ali checks those by hand with the test script.
