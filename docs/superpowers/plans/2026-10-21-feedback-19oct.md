# 19 Oct call feedback: implementation plan (21 Oct 2026)

**Spec (binding):** the client's two documents, transcribed word for word:
- `workspace/assets/RSN OVERHAUL/2026-10-19 Feedback call/REASON feedback 19 Oct - transcription.md` (the call notes)
- `workspace/assets/RSN OVERHAUL/2026-10-19 Feedback call/onboarding brief (Shradha, 19 Oct) - transcription.md` (the 8-screen onboarding brief)

Ali approved on 21 Oct, before work began:
- **The order:** the security fix first, then everything else, autonomously, finishing with headed smokes.
- **Emails say REASON now.** This is not held until go-live.
- **LinkedIn fills in the profile from the member's own profile link.** The member's LinkedIn link goes through the existing ScrapingDog lookup, which fills in role, company and industry. The member corrects anything before it is saved, and no LinkedIn app is involved. This replaces the 23 Sep "photo only" rule.

**Where the code lives:** the preview is `reason-m1`, served at preview.rsn.network. It has no server of its own: it calls the LIVE API and the LIVE database. Therefore:
- Every server change ships to `main` (Render) as an addition that the live app (`main`'s client) does not notice.
- Screens change only on `reason-m1`.
- A few client fixes must also reach live; they are marked LIVE-CLIENT.

## Global Constraints (every task)

1. **Your workspace.** Work only in the worktree named in your dispatch, on the branch named there. It was branched from `reason-m1`.
   - Never push, merge, rebase or cherry-pick to any other branch. Never deploy. The controller integrates.
2. **Never touch production.** Your worktree has no `server/.env`; never create or copy one. Never point anything at the production database or API.
   - For a local look, use only the local stack in `C:/dev/_m1-local/oct21/`, with your ports from the dispatch:
     - `start-api.sh <wt> <api> <ui>` starts your own API on the scratch database.
     - `start-ui.sh <wt> <ui> <api>` starts your client.
     - `run-local-spec.sh <wt> <ui> <api> tests/zz-local-<x>.spec.ts` runs a spec.
   - Read `C:/dev/_m1-local/LOCAL-STACK.md` for the helpers and sign-in trick. Its port numbers are superseded by yours.
   - Stop your processes by PID when done; never kill all node.exe.
   - The scratch database is shared: create your own users and delete exactly them at the end.
3. **Commits never mix layers.** Every commit is exactly one of these kinds. Name each commit's kind in your report.
   - **SERVER:** files under `server/src/` except `server/src/__tests__/client/`, files under `shared/`, and migrations. These go to live.
   - **CLIENT:** files under `client/` plus `server/src/__tests__/client/` source pins. These stay on the preview.
   - **LIVE-CLIENT:** a client fix that must also reach live. Only the tasks that say so make these.
   - **E2E:** files under `e2e/`.
4. **Live stays compatible.** A server change must keep the live app, which is `origin/main`'s client, working exactly as today.
   - The live join form still sends a LinkedIn URL.
   - The live onboarding still sends the old 5-question answers to the old endpoints.
   - The live screens still read today's response shapes.
   - Response changes are additive only: new fields and new endpoints. Nothing is removed or renamed.
   - `shared/` changes are additive only, so main's client must still compile against them.
5. **Migrations.** Use the numbers fixed here, and only these:

   | Task | Migration |
   |---|---|
   | T2 | `103_…` |
   | T3 | `104_…` |
   | T6 | `105_…` |
   | T8 | `106_…` |
   | T10 | `107_…` |

   - No `BEGIN`/`COMMIT` (the runner wraps each file).
   - Idempotent: `IF NOT EXISTS`, and guarded `DO` blocks for constraints.
   - Additive: never drop a column or table.
   - Any change to `onboarding_stage_events_stage_check` or `notifications_type_check` restates the full value list.
6. **Repo rules (CLAUDE.md), all binding:**
   - Zod on every route.
   - The `AppError` hierarchy, and no `throw new Error` in routes or services.
   - Parameterised SQL only.
   - `transaction()` for multi-table writes.
   - A rate limit on every new route.
   - Every mutation emits entity tags through `emitEntities`/`fanout`. New tags go in `ENTITIES.md` and in both `client/src/realtime/entities.ts` and `server/src/realtime/entities.ts`.
   - Every `useQuery` declares `meta.entities`; `node scripts/check-realtime-entities.js` must pass.
   - React Query owns server data; no `setQueryData` except optimistic updates paired with invalidation.
   - No `console.log`. No `any` without a comment. No `@ts-ignore`. No dead or commented-out code.
   - Services return data and routes format it.
7. **Words people read.**
   - The product is **REASON**, in capitals. Never "RSN" in anything a person sees. Web addresses (`rsn.network`) and code identifiers stay.
   - Say "event", never "session".
   - Where the spec gives copy, use it verbatim. Elsewhere use short plain sentences.
   - Error toasts are human sentences, never codes.
8. **Responsive, on every screen you touch.**
   - Check widths 360, 390, 414, 768, 1024, 1280 and 1440.
   - No horizontal scroll: `document.documentElement.scrollWidth <= innerWidth`.
   - Every tap target is at least 44px and reachable, never under a fixed bar.
   - Respect safe areas.
   - Phones get one column.
   - Loading, empty and error states exist for every new screen.
9. **Tests.**
   - TDD for logic.
   - Before reporting, all of these must pass:
     - the server suites you touched, then the full server suite (`cd server && npx jest --silent`);
     - `npx tsc --noEmit` in `server/` and in `client/`;
     - `npx vite build` in `client/`;
     - `node scripts/check-realtime-entities.js`;
     - `npm run build:shared`, first, whenever `shared/` changed.
   - Update every unit test and e2e spec that pins copy or structure you change, and list them in the report.
   - For UI, write a throwaway `e2e/tests/zz-local-<task>.spec.ts`, run it headed (`E2E_HEADED=1`) on your local stack in Chromium and WebKit, and look at the screenshots yourself.
     - Delete the spec before your last commit; `git status` must show it gone.
     - Save screenshots to `C:/dev/RSN/workspace/scratch/2026-10-21-feedback-19oct/shots-<task>/`.
10. **Commits.**
    - The subject is one plain English sentence saying what now happens, in the style of `git log`. A body is optional.
    - Commits are made as RSN Network (the repo config is already set).
    - **Never** add Co-Authored-By, or any mention of Claude, Anthropic or AI.
11. **Your report.** Write it to the report path in your dispatch. It contains:
    - what you built;
    - every commit with its kind (SERVER / CLIENT / LIVE-CLIENT / E2E);
    - the test commands and their outputs;
    - the screenshots folder;
    - every spec or test you changed;
    - anything you decided that the brief did not.

    Return only status, commits and a one-line test summary.

## Waves

| Wave | Tasks | Notes |
|---|---|---|
| 1 (now, parallel) | T1, T2, T3, T4, T5, T8, T10 | |
| 2 | T6, T7, T12, T9 | T9 starts when T8 is integrated |
| 3 | T11 | Starts when T10 is integrated |

Shared files are owned by exactly one task in a wave. Two tasks never edit the same file in the same wave.

| Shared file | Owner |
|---|---|
| `RequestToJoinPage.tsx`, `AdminJoinRequestsPage.tsx`, `AdminJoinRequestActionPage.tsx` | T2 |
| `email.service.ts` | T3 |
| `nav.ts`, `App.tsx`, `SupportPage.tsx` | T4 (wave 1) |
| `client/src/features/onboarding/HowRsnWorks.tsx`, `OnboardingTour.tsx`, `useTourState.ts` | T5 |
| `OnboardingFlow.tsx` and the rest of the onboarding folder | T9 |

---

### Task 1: Sign-in links only sign in, Google emails must be verified, join-request emails are stored lower case

Kind: SERVER only. This ships to live first, alone.

1. **Make `verifyMagicLink` accept only login links.**
   - The function is in `server/src/services/identity/identity.service.ts` (~line 440). Its lookup must accept only links whose purpose is a login. Read the migration that added `magic_links.purpose`: if the column is nullable, treat NULL as login; if it has a default, use it.
   - A link of any other purpose, today `join_request_review`, made by `admin-action-tokens.service.ts` for the Approve/Reject buttons in admin emails, must fail exactly like an unknown token (`UnauthorizedError('Invalid magic link')`). It must not mark the row used, must not create a user, and must reveal nothing.
   - Check every other reader of `magic_links`. The admin action peek/consume must still accept only `join_request_review`.
   - Tests:
     - A `join_request_review` token sent to the verify path is refused, and the admin is not signed in.
     - A normal login link still works.
     - A review token still approves through `/admin/jr/:token`.
2. **Refuse Google accounts whose email Google has not verified.**
   - In `server/src/routes/auth.ts` (Google callback, ~line 274), Google's v2 userinfo returns `verified_email`. When it is exactly `false`, refuse the sign-in through the existing `fail('google_auth_failed')` path and log a warning.
   - A missing field or `true` proceeds as today.
   - Tests cover all three cases (mock the fetch the way the existing auth tests do; if none exist, test the decision as a small pure function).
3. **Store join-request emails lower case.**
   - In `server/src/services/join-request/join-request.service.ts` (`createJoinRequest`, ~line 69), and wherever the route passes the email, trim and lower-case it before the duplicate check and before the insert.
   - The sign-in gate (`isEmailApproved`) lower-cases its input, so stored emails must match.
   - Test: a request from "Jane.Doe@Example.com" is stored as "jane.doe@example.com", and the gate then finds it approved.

Done when the three behaviours are tested, the full server suite and tsc are green, and the report is written.

### Task 2: The join form says REASON, drops "Tell us about yourself", and LinkedIn is optional

**SERVER** (live):
- **Migration** `server/src/db/migrations/103_join_request_linkedin_optional.sql`: `ALTER TABLE join_requests ALTER COLUMN linkedin_url DROP NOT NULL;`
- **Validation** in `server/src/routes/join-requests.ts` (~line 17):
  - `linkedinUrl` becomes optional. A missing value, `null`, or empty/whitespace is stored as NULL.
  - When given, it must be a LinkedIn profile address. Normalise it to `https://www.linkedin.com/in/<slug>`; any other address is refused with "Enter your LinkedIn profile link, for example linkedin.com/in/your-name".
  - The live form always sends a valid `https://linkedin.com/in/<slug>`, so live keeps working.
  - Max length stays 500.
- **Service** (`join-request.service.ts`) and approval paths (dashboard approval and `admin-action-tokens.service.ts`):
  - A NULL LinkedIn must never break approval. Skip the LinkedIn lookup when there is no URL.
  - The first-sign-in seed (`identity.service.ts` `getApprovedJoinRequestSeed`) must handle NULL; it probably already does, but confirm it with a test.
- **Do not touch `server/src/services/email/email.service.ts`.** Task 3 owns it and will print "LinkedIn: not given".
- **Tests:**
  - Route validation: absent, empty, null, a valid slug URL, `www.`, `http://`, trailing slash, query string, a non-LinkedIn URL refused.
  - Approval with a NULL LinkedIn runs no lookup and does not throw.

**LIVE-CLIENT** (these files are the same on both branches):
- `client/src/features/admin/AdminJoinRequestsPage.tsx` (~line 342): with no LinkedIn, show the text "No LinkedIn", not a link.
- `client/src/features/admin/AdminJoinRequestActionPage.tsx` (~line 185): the same.
- Those two files' wording also changes: "Approve {name}'s request to join REASON?" and the label "Why REASON".

**CLIENT** (preview only), in `client/src/features/auth/RequestToJoinPage.tsx`:
- **Logo:** `<img src="/reason-logo.png" alt="REASON">`, about 44px tall and centred. The image is already in `client/public/`.
- **Subtitle:** "REASON is invite-only." The sentence "Tell us about yourself." goes.
- **LinkedIn field:**
  - Label "LinkedIn profile (optional)".
  - Helper text under it: "Recommended. You can also add it later."
  - Not required.
  - Keep the `linkedin.com/in/` prefix UI.
- **Fix the clean-up bug** (~lines 22-29): typing `www.linkedin.com/in/jane-doe`, `linkedin.com/in/jane-doe/`, `https://uk.linkedin.com/in/jane-doe?x=1` or a bare `jane-doe` must all give `https://www.linkedin.com/in/jane-doe`. An empty field sends nothing.
- **"Why do you want to join REASON?"**
  - It stays required, max 1000, and it has **no placeholder**: the "Tell us about yourself and why…" sentence goes.
  - Ruling: the question itself stays, because admins approve from it and it seeds suggestions.
- **Other copy:**
  - "Your application will be reviewed by the REASON team. You'll receive an email with the outcome."
  - Success: "Thank you for your interest in REASON. We'll review your application and get back to you by email."
  - Footer: "Back to REASON".
  - Every "RSN" on the page becomes "REASON".
- **E2E:** update the specs that fill the reason box by its placeholder to use its label: `e2e/tests/full-flow-linkedin.spec.ts:77`, `ali-walkthrough.spec.ts:116`, `ali-account-claus.spec.ts:104`. Also `closed-account-rejoin.spec.ts`, which posts `https://example.com/…` as a LinkedIn URL and must now use a LinkedIn URL.
- **Look at it:** at 360 and 1280, empty, filled, and with validation errors.

### Task 3: Every email, bell and calendar text says REASON, and the email header is white

SERVER only. Note that `email.service.ts` has CRLF line endings: keep them.

1. **The shell** (`emailCardOpen`, ~line 35):
   - The header band background becomes `#ffffff`, not `#f4f5f8`.
   - The logo becomes `${config.clientUrl}/reason-logo.png` with `alt="REASON"`, `width="160"` and a real pixel height. The image is 1056x228, so 160x35. Drop the invalid `height="auto"`.
   - Keep the "Connect with Reason" tagline and the 4px red rule.
   - Every email keeps using the shell.
2. **The sender name** (~line 73) becomes `'REASON'`.
3. **Every subject, body line, footer line and plain-text copy that says "RSN" says "REASON".** The agent inventory lists them at about lines 128, 195, 276, 285, 639, 655, 658, 688, 704, 713, 744, 760, 763, 796, 797, 800, 801, 907, 909, 932, 1014, 1031 and 1185, plus the plain-text copies.
   - The footer line "RSN — Connect with Reason" becomes "REASON — Meet people you have a reason to know." That is the Foundation's own promise.
   - "RSN — Fast, focused, and human." becomes "REASON — Fast, focused, and human."
   - The label "Why RSN" becomes "Why REASON".
4. **Fix three layout faults:**
   - The DM email calls `emailCardClose()` twice (~lines 292 and 297).
   - The two meeting-request emails (~lines 1036 and 1081) put the "You're receiving this…" line inside the card. Move it under the card like the others.
   - The meeting-confirmed email never calls `emailCardClose` (~line 1193). Close it.
5. **Admin review email** (`sendJoinRequestAdminReviewEmail`): with no LinkedIn URL, the LinkedIn row says "Not given" and has no link. Task 2 makes LinkedIn optional.
6. **Server texts outside email:**
   - Bells: `join-request.service.ts` ~93 "{name} wants to join REASON"; ~316 and `admin-action-tokens.service.ts` ~313 "Welcome to REASON!".
   - Calendar events: "REASON event — {title}", organizer fallback "REASON". Files:
     - `calendar.service.ts` ~157, 160;
     - `routes/invites.ts` ~256, 259, 336, 339;
     - `invite.service.ts` ~286, 289;
     - `email.service.ts` ~525, 614.
   - `meeting-windows.service.ts` ~609-626 says "REASON meeting" / "arranged on REASON".
   - `routes/meeting.ts` ~43, 44 and 50: "REASON meeting", and the filename `reason-meeting.ics`.
   - `account-access.ts` ~27: "…contact the REASON team…".
   - `routes/sessions.ts` ~333: "your REASON event".
   - `routes/join-requests.ts` ~232: "Message from REASON".
   - `routes/admin.ts` ~1243: `reason-analytics-{type}.csv`.
7. **Migration** `104_email_config_reason.sql`: update the stored display subjects in `email_config` (seeded in migrations 020 and 082) so they say REASON. Read the table's columns first, and replace only the word RSN.
8. **Guard test:** render every email function with sample data (Resend disabled, the way the existing email tests do). Assert that no subject, HTML or text contains `\bRSN\b`; `rsn.network` and `rsn-` filenames are fine. Also assert that the header band is white and uses `reason-logo.png`. Update `email.service.test.ts` (~223-242), which pins the old header.
9. **Look at it:** write a throwaway script that renders every email's HTML to files under the shots folder, open them with Playwright at 360 and 600 wide, take screenshots, and look at the header, logo, footer and card edges. Delete the script before committing.

### Task 4: REASON across the preview's screens, a top-left logo that looks right, and no Introductions tab

CLIENT only (preview).

1. **`client/src/features/reason/brand/ReasonMark.tsx`:**
   - Use `/reason-mark-small.png` (480x365, already in `client/public/`, made so the sheep's face survives at small sizes) instead of `/rsn-sheep.png`, at the same boxes: 40x30 on the desktop sidebar and rail, 34x26 on phones.
   - **Remove the small "RSN".**
   - Centre the sheep and "REASON" on one line.
   - Keep `role="img" aria-label="REASON"`.
   - Look at 1x and 2x screenshots at 1440, 768 and 390.
   - Update the pins in `server/src/__tests__/client/reason-m1-look.test.ts` (~25-29) and `e2e/tests/reason-m1-shell.spec.ts` (~239-245).
2. **Sign-in and other pages say REASON:**
   - `LoginPage.tsx`: the logo becomes `/reason-logo.png` (`alt="REASON"`, about 44px tall); "REASON is invite-only. Apply and we'll review your request."; the suspended sentence says "REASON team".
   - `VerifyPage.tsx`: the same suspended sentence.
   - `InviteAcceptPage.tsx`: the platform label is "REASON".
   - `InvitesPage.tsx`: "REASON", not "RSN Platform".
   - `SettingsPage.tsx` and `BillingPage.tsx`: "Get started with REASON basics" and "Unlock the full REASON experience".
   - `CreateSessionPage.tsx`: "…anywhere on REASON…".
   - `MatchesPage.tsx` ~187: "Join the next event".
   - `SupportPage.tsx`: every "RSN" becomes "REASON", including the card "How REASON works".
   - `MeetPage.tsx`: "Connected on REASON".
   - `MessagesPage.tsx` and `MeetingScheduler.tsx`: the download filename is `reason-meeting.ics`.
   - `AdminEmailPage.tsx`: "Sent when a new user is invited to REASON".
   - **Do not touch** `RequestToJoinPage.tsx`, `AdminJoinRequestsPage.tsx` or `AdminJoinRequestActionPage.tsx` (Task 2), or anything in `client/src/features/onboarding/` (Tasks 5 and 9).
3. **Guard test:** add `server/src/__tests__/client/reason-wording.test.ts`. It scans `client/src/**/*.tsx` outside tests and asserts that no string literal or JSX text contains `\bRSN\b`.
   - Comments, `rsn-`/`rsn_`/`@rsn`/`rsn.network`, and identifiers are allowed.
   - `features/onboarding/` and the three Task 2 files are temporarily allowed, through an explicit allow-list with a comment that Tasks 2, 5 and 9 remove them.
4. **Remove Introductions.**
   - Delete `introductions` from BOTH lists in `client/src/features/reason/shell/nav.ts`: the main nav and `MOBILE_MORE`. Leaving it in `MOBILE_MORE` crashes the phone nav.
   - `App.tsx`: `/introductions` becomes `<Navigate to="/" replace />`.
   - `ComingSoonPage.tsx` drops the `introductions` kind. Icons may stay.
   - Update the pins:
     - `server/src/__tests__/client/reason-m1-shell.test.ts` ~11, 16, 47;
     - `e2e/tests/reason-m1-shell.spec.ts` ~64, 67, 276, 282, 339, 440 (the route now redirects to For You);
     - `e2e/tests/reason-m1.spec.ts` ~668-673 and 1466 (7 entries, 7 icons).
   - The For You rail's "Recent introductions" card is not the tab and stays as it is.
5. **Look at it:** the shell at 1440, 1024, 768, 390 and 360 (logo, nav, More sheet on a phone), the login page at 360 and 1280, and Support.

### Task 5: The short tour shows no made-up people, puts words above the picture, and ends on For You

CLIENT only (preview). Files: `client/src/features/onboarding/HowRsnWorks.tsx`, `OnboardingTour.tsx`, `useTourState.ts`.

1. **Remove every made-up person from the four tour visuals:** Amara Okafor, Tomas Lind, Priya Raman, "Northwind", "Baltic Seed", and any names, faces or initials. Redraw each visual from things that are not people:
   - the sheep (`/sheep/*.png` or `/sheep/v4/*.png`);
   - plain grey bars where text would be;
   - real button labels: "Meet", "Matched", "Wants to meet you";
   - a time-slot grid without names;
   - circle chips with generic words such as "Founders" and "Investors".

   Keep the four cards (For You, Matches, Meetings, Circles & events) and their meaning. Words say REASON.
2. **On each card, the heading and description come ABOVE the picture.** Today the picture is first (~line 153).
3. **The header says "How REASON works"**, both visible and `aria-label`.
4. **When the tour finishes or is skipped, the member goes to For You** (`/`) unless already there. Replay from Support stays where it is. The final button reads "See my matches".
5. **Update the pins:**
   - `server/src/__tests__/client/reason-m1-look.test.ts` ~562-605, which pins every word including the sample people;
   - `e2e/tests/onboarding-tour.spec.ts`;
   - `server/src/__tests__/client/reason-m1-for-you.test.ts` if it pins the tour.
6. **Look at it:** each card at 360, 390, 768 and 1280.

### Task 6: Your profile, the way others see it, with edit and a banner you can change

Wave 2. SERVER + LIVE-CLIENT + CLIENT.

**SERVER:**
- **Migration** `105_user_banner.sql`: on `users`, add `banner_blob BYTEA`, `banner_mime VARCHAR(40)` and `banner_updated_at TIMESTAMPTZ`.
- **Routes** in `server/src/routes/users.ts`, all authenticated, with rate limits:
  - `PUT /api/users/me/banner` with body `{ image: <data URL> }`:
    - accept only jpeg, png or webp;
    - the decoded size must be at most 3 MB;
    - store it, set `banner_updated_at`;
    - emit `user:<id>`.
  - `DELETE /api/users/me/banner`.
  - `GET /api/users/:id/banner`, public like the avatar endpoint:
    - serves the bytes with the stored type;
    - `Cache-Control: public, max-age=86400`;
    - 404 when there is none.
- **Shapes:** `bannerUrl: string | null`, as `/api/users/<id>/banner?v=<epoch ms of banner_updated_at>` or null. Add it to:
  - the shared `User` and `PublicMember` types;
  - the session user;
  - `toPublicMember` (`server/src/services/user/public-card.ts`); update `public-card.test.ts`.
  - The Human Profile brief gets it through `toPublicMember`.
- **`GET /api/people/me/card`** returns `toPublicMember(me)`, exactly what others see. Declare it before `/:userId/brief`.

**LIVE-CLIENT** (`client/src/features/profile/ProfilePage.tsx` ~142-177): fix the photo upload that hangs.
- Downscale in the browser to at most 800x800 JPEG at quality 0.85 before upload.
- Catch errors inside `reader.onload`.
- Show the server's message as a toast.
- Always reset "Uploading...".

**CLIENT** (preview):
- **`/profile` becomes the new "Your profile" page.** The old form moves to `/profile/edit`, unchanged apart from a back link. From top to bottom:
  - **Banner:** the member's banner or a default gradient, with "Change banner" (pick an image, crop/resize in the browser to 1500x500 JPEG, upload) and "Remove".
  - **Hero:** rendered from `GET /api/people/me/card` with the same look as the Human Profile hero (photo, name, role · company, industry, location, about).
  - **What you can bring:** public.
  - **Entities and roles:** placeholder "Add your company" linking to `/entities?create=1`; Task 11 wires it.
  - **A section headed "Only you see this":** who you want to meet, what you're hoping to find, and time zone.
  - **"Edit profile"** linking to `/profile/edit`, and **"Edit answers"** linking to `/onboarding?edit=q1`. Task 9 makes that link work; until then it may open onboarding.
  - **When there is no LinkedIn,** a card "Optimize your profile: connect LinkedIn", linking to `/profile/edit#linkedin`.
- **The Human Profile** (`HumanProfilePage.tsx` / `ProfileHero.tsx`):
  - Shows the person's banner, or the same default gradient, across the top of the hero.
  - Gains "Block" and "Report this member" actions in a header "More" menu, reusing the old public profile's API calls and confirmation dialogs, so nothing is lost when Task 7 points every people link here.
- **"View profile"** everywhere (ProfileMenu, MobileNav, ShellTopbar) still goes to `/profile`, which is now the new page.
- **Tests:**
  - Server route tests: mime, size, auth, 404 and cache header.
  - The public-card shape.
  - Client pins.
  - A local e2e that uploads a banner and sees it on the member's own profile and on their Human Profile as seen by another member.

### Task 7: People show your connections first, matches sit two to a row on desktop, every person opens one profile page, and For You follows the brief's screen 8

Wave 2. SERVER + CLIENT.

**SERVER:**
- **`GET /api/people/connections?limit=30&before=<ISO>`** returns `{ items: [{ userId, displayName, avatarUrl, jobTitle, company, how: 'connected' | 'met', since }], nextBefore }`.
  - **Connected:** an accepted meeting request in either direction, or a DM conversation.
  - **Met:** an `encounter_history` row, or both joined a 1:1 meeting. This is the same definition as `person-brief.service.ts` ~131-140.
  - **Excluded:** self, blocks in either direction, and accounts that are not active.
  - One row per person: `how` is 'met' if the pair ever met, `since` is the latest date, and rows are newest first.
  - `limit` is at most 50; use the people read limiter.
  - Declare the route before `/:userId/brief`.
- **Fix `getUserEncounters`** (`server/src/services/rating/rating.service.ts` ~536): exclude blocked pairs in either direction and accounts that are not active.

**CLIENT** (preview):
- **People tabs** (`PeopleTabs.tsx`, `nav.ts`):
  - A new FIRST tab "Your connections", `/connections`, a new `ConnectionsPage`. Then Find people, Your searches, Everyone who fits, People you have met.
  - The main nav's People points to `/connections` and is active on all five.
  - The page has a loading skeleton and this empty state: "No connections yet. When someone accepts your meeting request, or you meet at an event, they appear here." with the button "See who fits" going to `/`.
- **Two to a row:** from 1024px, people cards sit two per row; below 1024px, one list. This applies to:
  - For You's list, `ConnectionsPage`, `MatchesPage`, `SearchPage`, both lists in `AgentDetailPage`, and `EncounterHistoryPage`.
  - **HumanCard must work at half width:** remove the `min-[1420px]` four-track layout (~lines 77, 87, 107, 127) so the compact layout is used.
  - Widen the old pages' `max-w-3xl` containers to `max-w-6xl`.
  - The Matches footnote spans both columns.
- **Every person link opens `/people/:id`:** `MatchesPage` ~127, `SearchPage` ~108, `AgentDetailPage` ~113, `EncounterHistoryPage` ~75, and the `MessagesPage` header ~1078. The old `/profile/:id` route stays for admin links.
- **For You, per brief screen 8:**
  - Title "People worth meeting".
  - Subtitle "Based on your answers, here are people you might want to meet."
  - One line under the list: "When someone wants to meet you too, it becomes a match and you can book a time together."
  - Each card gets a "View profile" button beside "Meet"; keep Save.
  - When there are no cards and the profile is complete, the empty state is:
    - "Your people aren't here yet." / "We're still finding people who match what you're looking for. Check back soon."
    - Buttons "Explore people" (`/search`) and "Edit who I want to meet" (`/onboarding?edit=q1`).
- **Update the pins:**
  - `reason-m1-shell.test.ts` (the tab routes ~30-34 and the encounter row classes ~244-253);
  - `e2e/tests/reason-m1-shell.spec.ts` (~68-73 and 515-540: now 5 tabs; ~468: the People bar → `/connections`);
  - `reason-m1.spec.ts` (the For You title and empty state);
  - `reason-m1-for-you.test.ts`.
- **Look at it:** 1440, 1280, 1024, 768 and 390 for For You, Connections, Matches and Search.

### Task 8: Onboarding, version 2, on the server: the brief's four questions, LinkedIn fill-in, and matching words that work

Wave 1. SERVER only. It must not change anything the live app's version-1 onboarding does.

1. **Catalogue:** new file `shared/src/onboarding/options-v2.ts`, exported additively from `shared/src/index.ts`.
   - Labels are verbatim from the brief, and each option also gets a short label for summaries.
   - Each question's "Something else. I'd like to say it in my own words." has a free-text field: at most 120 characters, required when chosen.
   - Q2 also has optional `findSpecific`, at most 300 characters.

   | Question | Keys | Limit |
   |---|---|---|
   | Q1 "Who would you like to meet?" | `meet_founders_owners`, `meet_investors`, `meet_advisors_experienced`, `meet_specialists`, `meet_freelancers_consultants`, `meet_students_early_career`, `meet_other` | up to 3 |
   | Q2 "What are you hoping to find?" | `find_customers`, `find_funding`, `find_cofounder`, `find_friends_conversations`, `find_other` | up to 3 |
   | Q3 "What can you offer others?" | `offer_products_services`, `offer_investment`, `offer_join_build_team`, `offer_advice_mentoring`, `offer_introductions`, `offer_friends_conversations`, `offer_other` | any |
   | Q4 "How would you describe yourself?" | `self_founder_owner`, `self_investor`, `self_advisor_experienced`, `self_specialist`, `self_freelancer_consultant`, `self_student_early_career`, `self_other` | up to 2 |
2. **Migration** `106_onboarding_v2.sql`:
   - Add `users.hoping_to_find TEXT[] NOT NULL DEFAULT '{}'`, with a check that it holds at most 3.
   - Add `meet_other VARCHAR(120)`, `find_other VARCHAR(120)`, `find_specific VARCHAR(300)`, `offer_other VARCHAR(120)` and `self_other VARCHAR(120)`.
   - Add `onboarding_version SMALLINT`.
   - v2 keys go into the existing `looking_to_meet`, `can_offer` and `self_kinds` arrays (their limits already fit).
   - Restate `onboarding_stage_events_stage_check` with every existing value plus `linkedin_connected` and `linkedin_skipped`.
3. **Endpoints** under `/api/onboarding/v2/` (authenticated, Zod, rate limits). The v1 endpoints stay untouched.

   | Endpoint | What it does |
   |---|---|
   | `GET state` | Returns the shape below. |
   | `PUT answers` | Partial draft save into `user_intent_profiles.onboarding_draft` under a `v2` key. Sets status `in_progress`. |
   | `POST linkedin { url }` | Normalises and validates the profile URL (same rules as Task 2), saves `users.linkedin_url`, starts the existing enrichment lookup when there is no usable result yet, records the stage. Returns the linkedin block. Idempotent: no second paid lookup when one is running or done for that URL. |
   | `POST linkedin/skip` | Records the stage `linkedin_skipped`. |
   | `POST confirm` | Validates and saves everything (details below). |

   `GET state` returns:
   - `status`, `step`, `answers` (the v2 shape above, prefilled from version-1 answers through a mapping table when the member has no v2 answers yet);
   - `profile { displayName, avatarUrl, jobTitle, company, industry, timezone, linkedinUrl }`;
   - `linkedin { status: none|searching|found|partial|not_found|failed, prefill?: { displayName, photoUrl, jobTitle, company, industry, location, selfGuess } }`, where `selfGuess` is the v2 self key read from the scraped role through `ROLE_TAXONOMY`, or null;
   - `tour`.

   `POST confirm`:
   - **Body:** the full v2 answers plus `profile { displayName?, jobTitle?, company?, industry?, timezone?, useLinkedinPhoto? }`.
   - **Validation:** limits as above, "other" requires its text, and the timezone must be a real IANA zone (`Intl.supportedValuesOf` or a `DateTimeFormat` try).
   - **Writes, in one transaction:**
     - the key and free-text columns, `hoping_to_find`, and `onboarding_version = 2`;
     - the text columns that matching reads, through new `option-signals` v2 translations (rules below);
     - `industry`, `timezone`, `job_title` and `company` only when given: a missing industry never blanks the stored one;
     - status completed, `onboarding_completed = true`, `last_onboarded_at`, and `tour_due_at` if the tour was never seen; then the v2 draft is cleared.
   - **Searches:** creates them from the meet keys as v1 does, plus one search for `meetOther` in the member's words.
     - When the answers change, searches created by onboarding whose key is gone are paused, not deleted.
     - De-duplicate by key (stored in `intent.meetKey`), not by label.
   - **Side effects:** the v1 first-completion side effects (bells to matching members), and emit `user:<id>`.
4. **Matching words** (`server/src/services/matching/option-signals.ts` and `intent-signals.ts`). Each v2 key gets want, offer, intent or role text that the existing scorer understands:
   - **`intent-signals.ts:61`:** "freelance", "freelancer(s)" and "freelancing" must match the consultant category. Today `freelanc\b` never does; fix it and test it.
   - **Meet:**
     - founders/owners → founder and owner categories;
     - specialists → developer, designer and marketer;
     - freelancers → consultant;
     - students → student.
   - **Self:**
     - `self_freelancer_consultant` → the title "Consultant";
     - `self_student_early_career` → "Student";
     - `self_advisor_experienced` → "Advisor";
     - `self_specialist` → "Specialist", unless a job title was typed, in which case that wins.
   - **`find_funding`'s intent text must name investors.**
   - **Friends and good conversations (Q2 and Q3) add no want or offer words.** Otherwise everyone would match everyone.
   - **`offer_products_services` and `offer_join_build_team`** need wording that is not stop-words only. Read the stop list.
   - **Free text** ("other", `findSpecific`) is appended to the matching want or offer text and goes through the existing place and years parser.
   - **Keep and extend the "wanting X finds someone who is X" test to v2 keys.**
5. **Tests:**
   - schema and limits;
   - the confirm writes (columns and text);
   - the v1→v2 mapping;
   - industry preserved;
   - timezone validation;
   - LinkedIn idempotency, with the enrichment mocked;
   - search planning and pausing;
   - the full suite green.
   - Document the endpoint shapes in the report exactly, because Task 9 builds on them.

### Task 9: Onboarding, version 2, on screen: the brief's eight screens

Wave 2, after Task 8 is integrated. CLIENT only (preview). It replaces the preview's `OnboardingFlow` with the brief, verbatim, against the v2 endpoints. The live app keeps version 1.

1. **Welcome** (brief screen 1). The copy is verbatim; [Let's go].
2. **"Let's get you started"** (brief screen 2). The member is already signed in.
   - **[Continue with LinkedIn]** opens a LinkedIn profile field, prefilled from what they gave when they asked to join, under "We'll use your LinkedIn profile to fill in your details for you." It calls `POST v2/linkedin` and moves on while the lookup runs.
   - **[Continue with email]** calls `skip` and moves on.
3. **Screens 3 to 6** are the four questions, with titles, helper lines ("Select up to three answers." etc.) and option labels verbatim, and "1 of 4" … "4 of 4".
   - "Something else…" opens a 120-character text box.
   - Screen 4 has the optional "Is there anything specific you're looking for? (optional)" box, with the brief's example as its placeholder.
   - [Back] [Continue]; the limits are enforced with a gentle hint.
   - Screen 6 preselects `selfGuess` when LinkedIn found one: "We picked this from your LinkedIn. Change it if it's wrong."
4. **"Here's how others will see you" / "Change anything that isn't right."** (brief screen 7):
   - photo, with [Keep this photo] [Upload a new one], or the LinkedIn photo offer;
   - name, and role and company, prefilled from LinkedIn or typed;
   - industry, suggested from LinkedIn and editable;
   - time zone, detected by the browser, shown like "Asia/Kathmandu", with [Change] (a searchable list);
   - "Your answers" 1-4, each with [Edit], which opens that question and returns here. Q1, Q2 and the time zone are marked "Only you see this".
   - For email sign-ups, "Add your LinkedIn profile so people can learn more about you. You can do this later." with [Add LinkedIn] [Later].
   - [Show me my matches] confirms and goes to `/`. The tour from Task 5 then opens over For You.
5. **Edit mode:** `/onboarding?edit=q1|q2|q3|q4|profile` lets a completed member change one part and save through confirm, then return to where they came from.
6. **No "RSN" anywhere.** Remove `features/onboarding` from Task 4's allow-list in `reason-wording.test.ts`. The old welcome modal and the "Complete your profile" nudges point at `/onboarding` and say REASON.
7. **E2E:**
   - Replace `e2e/tests/onboarding-tickbox.spec.ts` on this branch with `onboarding-v2.spec.ts`, covering LinkedIn and email paths, limits, "other", edit and landing on For You.
   - Use a mocked or blank LinkedIn lookup locally: the local stack has no ScrapingDog key, so "searching" must time out gracefully to "not_found" and the flow must still finish.
8. **Look at it:** every screen at 360, 390, 768 and 1280 in Chromium and WebKit.

### Task 10: Entities on the server: members create their company and link people to it

Wave 1. SERVER only.

1. **Migration** `107_entities.sql`, with indexes on `entity_members(user_id)` and `entities(created_by)`:
   - **`entities`:**
     - `id UUID PK DEFAULT gen_random_uuid()`;
     - `name VARCHAR(200) NOT NULL`, at least 2 characters once trimmed;
     - `kind VARCHAR(40) NOT NULL CHECK IN` company, startup, fund, university, community, charity, project, investment_vehicle, association, other;
     - `about TEXT`, at most 2000 characters, enforced in Zod;
     - `location VARCHAR(200)`, `size VARCHAR(40)`, `website VARCHAR(500)`;
     - `created_by UUID REFERENCES users ON DELETE SET NULL`;
     - `created_at`, `updated_at`, `archived_at TIMESTAMPTZ`;
     - a unique index on `lower(btrim(name))` where `archived_at IS NULL`.
   - **`entity_members`:**
     - `entity_id` REFERENCES entities ON DELETE CASCADE;
     - `user_id` REFERENCES users ON DELETE CASCADE;
     - `role VARCHAR(40) NOT NULL CHECK IN` founder, employee, investor, advisor, board_member, partner, customer, member, former_employee, fan, follower, other;
     - `title VARCHAR(120)`, `is_admin BOOLEAN NOT NULL DEFAULT false`, `created_at`;
     - `PRIMARY KEY (entity_id, user_id)`.
2. **Service and routes:** `server/src/services/entity/` and `server/src/routes/entities.ts`, mounted at `/api/entities`, authenticated, Zod, with read and write rate limits.

   | Route | Behaviour |
   |---|---|
   | `GET /?q=&limit=` | `{ mine: EntitySummary[], others: EntitySummary[] }`. `others` is a name search when `q` (≥2 characters) is given, otherwise the most recently active, at most 30. `EntitySummary = { id, name, kind, location, peopleCount, myRole }`. |
   | `POST /` `{ name, kind, role, title?, about?, location?, size?, website? }` | Creates the entity and the creator's link (`is_admin = true`) in one transaction. A clash with an active entity of the same normalised name is a 409 ConflictError, with `{ existingId }` in the error details so the client can offer "Open it" and "Join it". If the creator's `users.company` is empty and the role is founder or employee, set it to the name. |
   | `GET /:id` | `{ entity, people: [{ ...publicCardBasics, role, title }], myRole, canEdit }`. Active members only, blocks in either direction filtered. 404 for missing or archived. |
   | `PATCH /:id` | Entity admins or platform admins: name, kind, about, location, size, website. |
   | `POST /:id/members` `{ role, title? }` | Join, or update your own role. |
   | `DELETE /:id/members/me` | Leave. |
   | `DELETE /:id` | Archive. Entity admins or platform admins. |
   | `GET /api/users/:id/entities` | That person's entities `[{ id, name, kind, role, title }]`. It respects blocks. |

   The person brief (`person-brief.service.ts`) also gains an additive `entities` field of the same shape.
3. **Realtime:** new tags `entity:<id>` and `user:<id>:entities`. Every write emits to the entity's members, the actor, and the affected user. Add them to `ENTITIES.md` and both `realtime/entities.ts` files.
4. **Tests:**
   - the service, including the name clash, the company back-fill, blocks, and leave/archive;
   - the routes: validation, authorisation, 404 and 409;
   - the full suite green.
   - Document the shapes in the report for Task 11.

### Task 11: Entities on screen: the Entities page, creating your company, and the entity profile

Wave 3, after Task 10 is integrated. CLIENT only (preview).

1. **`/entities`** replaces the coming-soon page:
   - title "Entities", subtitle "Companies and organisations, and the people around them.";
   - "Your entities", each with your role, and the button **"Create your company"**;
   - a search box, then other entities as cards: a letter mark, name, kind · location, "N people", and your role pill. Two per row from 1024px; one list on phones.
   - Empty, loading and error states.
   - `?create=1` opens the create sheet.
2. **The create sheet** (a bottom sheet on phones):
   - fields: name, type (select), your role (select, default Founder), your title (optional), location (optional), size (optional select: 1-10, 11-50, 51-200, 201-1000, 1000+), about (optional), website (optional);
   - "Create";
   - a 409 shows "There is already an entity called X." with [Open it] and [Join it].
3. **`/entities/:id` profile:**
   - a hero with the letter mark, name, type, location, size, website and about;
   - **"People around this entity":** cards with role and title, opening `/people/:id`;
   - **"Your relationship":** your role with [Change] and [Leave], or [Join] with a role select;
   - [Edit] for entity admins, as a sheet; [Archive] for admins, behind a confirmation dialog.
4. **The Human Profile's "Entities & roles"** lists the person's entities from the brief, with role and title, each linking to `/entities/:id`. With none, it shows the company text as today, or "No organisation shared yet".
5. **Task 6's "Your profile" page "Entities and roles" section** lists the member's own entities, using `GET /api/users/<me>/entities`, with "Add your company" linking to `/entities?create=1`.
6. **Remove the entities kind from `ComingSoonPage`.** Update the pins:
   - `reason-m1-shell.test.ts` ~46 and ~254-263;
   - `e2e/tests/reason-m1-shell.spec.ts` ~437, which expected "Entities matter.";
   - the search placeholder rule, which stays "Search people…".
7. **Look at it:** 360, 390, 768, 1024 and 1440, including a 40-character entity name and a 1-character typo case.

### Task 12: People who would also want to meet you come first

Wave 2. SERVER only.

- In `server/src/services/matching/platform-match.service.ts`, the For You and Matches source:
  - For each candidate, also score the reverse direction: the candidate's wants against the viewer's identity and offers, with the same `scoreWants`.
  - Order candidates with a strong fit both ways first, then by today's score. The list's membership and limits do not change.
- **Do not add any field that reveals the reverse score or the candidate's wants.** Wants are private. Ordering is the only effect.
- **Tests:**
  - the ordering, with a mutual candidate scoring lower one-way still coming first;
  - no new response field;
  - performance: the same number of queries, no N+1 — reuse the candidates already loaded.
