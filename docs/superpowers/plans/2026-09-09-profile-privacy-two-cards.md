# Profile privacy — two cards (Stefan, 9 Sep 2026)

Stefan: the profile that gets built after onboarding (reasons for joining,
who you want to meet and why, interests, the whole matching card) is
**private**. Only the member and admins may see it. Everyone else sees a
smaller **public card**. Matching and agents keep using the full card
server-side; the public card is a subset of the full card. Ali approved
9 Sep with the three recommendations below.

## Audit (9 Sep, read-only)

- The public profile page rendered a "Matching Profile" block to every
  member (What I care about / What I can help with / Who I want to meet /
  Why I want to meet / My intent) plus "Reasons to Connect" and Interests.
  `GET /users/:id` returned all of those to any authenticated member
  (`routes/users.ts` non-owner branch). That is the leak.
- Suggestion + agent cards are safe: the reason line is built from the
  VIEWER's ask and the candidate's public facts; it never quotes the
  candidate's wants (`formatForSeeker`).
- Introductions disclose the SENDER's ask to the one recipient
  (`formatForRecipient` → poke message → first DM). That is the sender
  choosing to reveal their own need via the agent. Kept (decision 2).
- Directory search, DM header, circles, wall, events: neutral fields only.
  Side leaks: pod member lists, event participant lists and the
  connected-people list return `email` to normal members.
- No single public-profile projection exists; ~25 read paths hand-pick
  columns. `users.profile_visible` exists but is never enforced (out of
  scope here).

## Decisions (Ali, 9 Sep)

1. Expertise and "What I can help with" stay PUBLIC (offer side).
2. Introductions keep telling the recipient what the sender is looking for.
3. Emails are stripped from pod / event / connected-people lists for
   normal members (admins, and event hosts for their own event, keep them).

## Field split

**Public card** (`PublicMember`): id, displayName, firstName, lastName,
avatarUrl, jobTitle, company, industry, location, languages, linkedinUrl,
bio, expertiseText, whatICanHelpWith, professionalRole.

**Private** (self + admin only): email, phone, whoIWantToMeet,
whyIWantToMeet, myIntent, goals, reasonsToConnect, interests,
whatICareAbout, matchingNotes, careerStage, currentState,
meetingPreferences, notification prefs, onboarding status, invitedBy,
intent profile / transcript / enrichment (admin-inspect only, unchanged).

## Build

1. `server/src/services/user/public-card.ts` — `toPublicMember(user)`:
   the ONE projection for another member. Unit-tested: private keys are
   absent, public keys present, works on the raw `User` shape.
2. `GET /users/:id` — self/admin → full `User`; anyone else →
   `toPublicMember`. Route test pins both branches.
3. Emails: `GET /users/connected` (non-admin), `GET /pods/:id/members`
   (non-admin), `GET /sessions/:id/participants` (participant who is not
   host/admin) no longer include `email`. `interests` dropped from pod
   members.
4. Client: `PublicProfilePage` renders Reasons to Connect / Interests /
   Matching profile ONLY for the owner or an admin, under a "Private —
   only you and admins can see this" label; viewers get the public card.
   `ProfileCard` loses its latent want fields. Shared `PublicMember` type.
5. Tests: unit (projection, route branches, list shapes), E2E
   `profile-privacy.spec.ts` (viewer sees no private text; owner sees the
   private section + label; admin sees it), plus the existing
   profile-card layout spec at 5 widths.
6. Permanent sweep: server suite, client tsc/build/realtime guard, headed
   prod smokes on Chromium + WebKit + iPhone 14, widths 360–1280.

Matching / agents: no change (already server-side on the full profile).
No data migration.
