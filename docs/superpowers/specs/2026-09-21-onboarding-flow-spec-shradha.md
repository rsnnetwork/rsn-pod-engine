# RSN Onboarding: New Flow Specification (Shradha, 21 Sep 2026)

Verbatim transcription of the client deck `RSN_Onboarding_Flow_Spec_for_Ali final.pptx`
(13 slides, received 21 Sep 2026; the .pptx stays untracked in the repo root). Nothing
here is interpreted; the assessment and plan live in
`docs/superpowers/plans/2026-09-21-onboarding-tickbox-wizard-sheep.md`.

Flow on the cover: **Welcome → Tick-box questions → Confirm → Wizard tour → Explore.**
"With the black sheep avatar: wave, listening, matched."

## Slide 2. The decision: 21 Sep meeting

> Onboarding is a showstopper. It gets fixed before any user engagement - all engagement
> efforts are paused until then.

**What's broken today**

- **Unstructured chatbot.** Open-ended questions ("Why are you here?") yield unusable data for matching.
- **No platform explanation.** Users are never told what RSN is or how it works.
- **Confusing UI.** After onboarding, users are left with no guidance on next steps.
- **Stale assets.** The red dot face persists despite being flagged weeks ago.

**The fix: three tasks for Ali**

1. **Tick-box onboarding flow.** Replace open-ended chat with multiple-choice selections → structured, matchable data. Bypasses the current LLM's limitations.
2. **Onboarding wizard.** A guided tour of the platform's value and core features, ending in a clear next step.
3. **Sheep avatar.** Replace the red dot face everywhere with the black sheep - wave, listening, matched.

## Slide 3. The new flow: five steps

"One screen at a time. The sheep carries the user through it."

| Step | Sheep pose shown | Text |
|---|---|---|
| 1. WELCOME | Wave | Sheep waves. One line on what RSN is. One button. |
| 2. QUESTIONS | Listening | 4 tick-box questions. Sheep listens. |
| 3. CONFIRM | Thinking | Your answers, shown back. Edit or confirm. |
| 4. WIZARD | Welcome | 4-card tour: how RSN works. |
| 5. EXPLORE | Matched | Straight into Suggestions. Matched state fires at first match. |

> Rule for the whole flow: never show the user a guess as fact. Everything in the profile
> comes from what they ticked or typed - and they confirm it.

## Slide 4. Step 1: Welcome (sheep: WAVE)

Screen copy:

> "Hey - welcome to RSN.
> We connect you with the people you actually want to meet.
> Answer 4 quick questions so we know who that is."
>
> [ Let's go ]

Build notes: Sheep plays the wave animation once, then returns to idle. One button only -
no skip, no side panel, no pre-filled profile shown here. Photo + name from Google sign-in
are fine; nothing else is guessed.

## Slide 5. Step 2: The four questions (tick boxes) (sheep: LISTENING)

**Q1 - single select. What brings you to RSN?**

- Grow my professional network
- Find customers or partners
- Find investors or funding
- Find a co-founder or key talent
- Get advice from experienced people
- I was invited - just exploring

**Q2 - multi select (pick up to 3). Who do you want to meet?**

- Founders & entrepreneurs
- Investors & VCs
- Sales / marketing / growth leaders
- Advisors & mentors
- Developers & technical people
- Event organisers & community builders

**Q3 - multi select. What can you offer?**

- Mentoring & advice
- Investment
- Introductions & my network
- Skills & services
- Partnerships & collaboration
- Hiring - I have open roles

**Q4 - multi select. Which industries are you in?**

- Software & AI
- Finance & investing
- Health & wellbeing
- Consumer & retail
- Media & creative
- Other → short free text

> Each answer writes directly to a matching field: intent (Q1), looking_to_meet (Q2),
> can_offer (Q3), industries (Q4). No LLM interpretation needed.

## Slide 6. Step 3: Confirm (nothing guessed) (sheep: THINKING)

Screen: "Here's your profile - built from your answers."

| Row | Example value | Control |
|---|---|---|
| YOU'RE HERE TO | Find investors or funding | Edit |
| YOU WANT TO MEET | Investors & VCs · Founders | Edit |
| YOU CAN OFFER | Mentoring · Introductions | Edit |
| INDUSTRIES | Software & AI · Finance | Edit |
| ABOUT YOU (OPTIONAL) | One line, typed by the user | Edit |

Button: [ Looks right - continue ]

Why this step exists: The current flow guesses (country, company, about) and shows the
guess as fact. In Stefan's test the guess was wrong. Here the profile is assembled only
from ticked answers - every field is editable inline, and the user explicitly confirms
before matching starts.

## Slide 7. Step 4: Wizard: how RSN works

"Four cards, swiped or clicked through. Each explains one thing the user will actually see."

1. **SUGGESTIONS.** "We suggest people who match your intent. Tap 'I want to meet' to ask." Shows the Suggestions screen with one card highlighted.
2. **MATCHES.** "When they want to meet you too, it's a match - you'll see it here and in chat." Introduces the three states: not asked / pending / matched.
3. **MEETINGS.** "Share your availability, pick a green slot - we create the meeting with a link." Sets the expectation for the full loop.
4. **CIRCLES & EVENTS.** "Join circles of people who share your intent, and networking events." Ends with CTA: [ See my suggestions ]

Wizard is skippable, and re-openable later from Support / "How RSN works".

## Slide 8. The sheep avatar: build in this order

"Replaces the red dot face everywhere. Small avatar form first: onboarding and message
threads. Poses from the 3D brief (reference file)."

| # | Pose | Where | Motion |
|---|---|---|---|
| 1 | WAVE | Onboarding welcome screen; greeting a returning user. | One clear wave, warm smile, slight lean toward the person. Then back to idle. |
| 2 | LISTENING | During the tick-box questions; in chat while the other side is typing. | Still body, subtle forward lean, occasional nod. Calm - no bouncing. |
| 3 | MATCHED | Match found; meeting confirmed in the chat. | Visible lift in energy: smile, open posture, small clap. Joyful, not hyperactive. |

> Direction rule: readable with the sound off - clear beginning, readable intention, clean
> return to idle.

Images embedded in the deck (low-resolution crops from a numbered pose sheet, white
background, caption baked into the image): "1. Welcome", "2. Wave", "4. Thinking",
"6. Listening", "14. Matched", plus an uncaptioned wave on the cover.

## Slide 9. New fixes: Shradha's signup, 21 Sep

Confirm screen (screenshot of today's "Welcome to Reason" confirm card):

- LinkedIn URL overflows its box - must wrap or truncate inside the field
- ROLE (job designation) is missing - pulled as empty; a core matching field can't ship blank
- Remove the red circle face on this "Welcome" screen → sheep WAVE

Approval email (screenshot: white sheep + "RSN" on a dark navy header):

- RSN logo is wrong - white sheep. The brand mark is the BLACK sheep
- Use the black sheep asset in all emails + app header

"These land inside Task 1 (flow) and Task 3 (avatar/brand) - no new scope."

## Slide 10. Test findings (19 Sep): P0, the core loop is broken

> Two matched users cannot arrange a meeting. Both saved availability, both saw a green
> overlapping slot, one picked it, and nothing happened: no confirmation, no meeting
> object, no calendar, no next step.

Three fixes belong together:

- Picking a green slot creates a confirmed meeting with a link, posted into the chat for both sides
- The availability panel gets a terminal action, "Save and send availability", plus a close. Right now it traps you
- When both have saved, both get a system message in the chat proposing the overlap

Result today: "SO HOW DO WE DO THAT, we both have saved our availability?" ... "I have no
clue!!!" So we cannot meet currently.

Screenshot captions: "Stuck after saving availability: no way out, no close, no send." /
"Green slot picked, then nothing. No meeting created." / "The chat where the product
fails its one promise."

## Slide 11. Test findings: P1, connection states and notifications

**P1: no view of your own connections**

- No view of who you have asked to meet, and mutual matches don't list people who matched. Every session starts from zero
- Suggestions needs three states per person: not asked / asked (pending) / matched

**P1: accepting from the notification tray**

- Never accept a stranger from a toast
- The notification routes to the message thread, the profile is visible there, and accept/decline lives next to the profile

## Slide 12. Test findings: P2 session states, P3 permissions

**P2: stale session state**

- An event from two days ago still shows as active with status "Transition". Either sessions don't get closed, or the state machine has no terminal state
- Users will never know what "Transition" means. States must be named in plain words

**P3: permissions (policy, not bugs)**

- Circles can be created by anyone with no approval; users cannot create events
- Decide deliberately whether members can create either, then enforce it. Circles should be approved by an admin

## Slide 13. Build notes

**Remove**

- Open-ended chatbot questions
- Pre-filled guessed profile shown as fact
- The red dot face - everywhere

**Data**

- Q1–Q4 answers write straight to matching fields - no interpretation layer
- Options are fixed lists → filterable, comparable across users
- "Other" free text stored but never required for matching

**Avatar**

- Small avatar form: onboarding + message threads
- Order: wave → listening → matched
- Shradha supplies the exact placement list
