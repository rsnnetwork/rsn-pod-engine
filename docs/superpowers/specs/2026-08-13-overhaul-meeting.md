# RSN Overhaul — Meeting Summary, 13 August 2026

Source: `assets/RSN_Overhaul_Summary 13 aug.docx` (Stefan Avivson, Claus
Sønderskov, Ali Hamza). Text extracted verbatim below so the plan that
implements it can travel with the spec.

## Onboarding & Sign-Up

- Ali can flag Stefan's account to skip onboarding, or delete an account to
  re-test the sign-up flow.
- Two join requests had already been accepted (unclear if by Ali or Shradha).
- Bot pulls role/title from LinkedIn even when not explicitly set on the
  profile — needs a prompt fix so it doesn't misattribute roles.
- New user has no idea what RSN is when landing after clicking an invite link —
  needs either an on-platform explanation or, per Claus, a clearer intro in the
  invite email itself (not necessarily built into the UI).
- First agent isn't auto-creating after onboarding as it should — known bug;
  Ali to fix (backend is creating it, just not surfacing it).

## Dashboard Layout

- Order should be: Matches → Pods → Circles → Messages.
- Action buttons (e.g. "create pod," "view events") should live inside their
  respective tiles rather than as separate buttons.
- Upcoming events and invites should move to a second row or be
  removed/restructured — Claus suggested a separate "agenda" style list since
  events will grow varied (circle events, 1:1s, etc.).
- New matches should show as a notification/badge on the menu from anywhere in
  the platform.
- Consider renaming "Matches" to "Suggestions" and folding in pod/circle/event
  recommendations there too, generated based on the user's profile.

## Profiles & Messaging

- Profile card needs a major visual upgrade ("greatest thing on the platform").
- When someone reaches out, their name should be bold/clickable, linking to
  their profile — currently unclear who's messaging you.
- A short bio/description should appear in the message view, not just the name.
- "About" section was cut off/too narrow in the current build.

## Invites

- Currently only admins can send platform invitations — Stefan wants any user to
  be able to invite.
- Three ways into the platform confirmed by Ali: code invite, event invite, join
  request → platform invite.
- Circle-level invites also needed, not just pod-level.
- Link detection (e.g. www.fathom...) isn't recognizing valid links — needs a fix.

## AI Chat / Matching Agent

- The prompt is fully customizable — currently too transactional/cold; needs to
  feel more human, ideally voice-based eventually.

## Search

- No way to search for a known person (e.g. Claus) on the platform — flagged as
  a real gap.
- Decision: build a search engine within RSN rather than relying on Google.
- Longer-term idea (parked, not built now): make Reason profiles SEO/AI-
  discoverable, while giving users control over what's public vs. private.

## Circles vs. Pods

- Circle = a broader community/society around a shared interest or identity
  (can include multiple pods) — kept intentionally broad so it doesn't collapse
  into "titles and achievements."
- Pod = the more specific, contained unit within a circle (e.g. Raw Speed
  Networking sessions).

## Action Items for Ali

1. Fix agent auto-creation on onboarding.
2. Fix role/title pulling from LinkedIn.
3. Fix link recognition.
4. Implement dashboard reordering and tile/button restructuring (small but
   visible progress, per Claus).
5. Build search functionality.
6. Revise the matching-agent chat prompt to be less transactional.

---

## Corrections and decisions recorded after the meeting

**Correction — "first agent isn't auto-creating … backend is creating it, just
not surfacing it."** The backend is not creating it. `server/src/routes/auth.ts`
sets `onboarding_completed = true` and writes profile columns; nothing in the
onboarding path writes to `matching_agents`. The agents that exist came from
migration `087_reseed_agents_one_per_reason.sql`, which seeded **existing**
members only. This is a feature to build, not a display bug to fix.

**Decisions taken by Ali, 13 Aug (these override the open questions above):**

1. **Matches → Suggestions: rename only.** No recommendation umbrella for
   pods/circles/events yet. Revisit once there is real usage of agents.
2. **Member invites: direct and unlimited.** Any member may invite anyone, with
   the same effect an admin invite has today. No quota, no per-member rate
   limit. Ali was shown the abuse/dilution trade-off and chose this. Audit
   logging is retained so invite origin is traceable.
3. **Search: all active onboarded members are findable**, by name, job title and
   company. Results show name, title, company and photo, plus the existing
   "I want to meet" action. Full profile detail and messaging stay behind the
   gates that already exist. No opt-out toggle in this pass.
