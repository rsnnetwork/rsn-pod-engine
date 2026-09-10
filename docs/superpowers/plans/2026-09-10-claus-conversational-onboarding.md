# Onboarding around Claus's open questions (item 1 of the 9 Sep review)

Claus (via Ali, 10 Sep 2026):

> #1 We've already put together a first version of your profile. But before we
> get into that, I'd rather hear from you. We believe you're here for a reason.
> Do you mind sharing what brought you here?
> #2 What's taking up your attention these days?
> #3 And if being here turned out to be genuinely valuable, what might come from it?
>
> IT IS NOT literally three static questions in sequence. Open question →
> listen → short reflection or follow up → next opening. Q1 = universal
> opening, Q2 = adaptive exploration, Q3 = adaptive value/future question.
> Behind the scenes we extract intent, current focus, problems, ambitions,
> expertise, curiosity, desired relationships, resources offered, resources
> sought, time horizon, identity signals and language/values without ever
> asking the user to classify themselves. Don't ask people to describe their
> profile or specify what they want. Create a conversation from which the
> profile, wishes and desires become visible. Imagine a verbal conversation.

## What the host did before (audit, 10 Sep)

- The prompt asked, in order, "who would be valuable for them to meet", "why",
  "what they can help others with": exactly the self-classification Claus rules
  out.
- Any reflection was forbidden ("never repeat or paraphrase"; the style guard
  rejects "So you…"). Claus's example reply is a reflection.
- When the join request already held a reason, the opening never asked it; a
  generated opening (one extra LLM call) referenced the card instead.
- "At most three questions" lived only in prompt text. No server-side bound.
- The extractor had no prose rule for `reasonForMeeting`, `desiredOutcome`,
  `userCanOffer`, `userExpertise`, `userInterests`, `userProfileSummary`, and
  its "never guess" rule blocked inferring wants from an open answer.
- Matching reads ~12 of the 35 extracted fields (desiredPeople/Roles/…,
  reasonForMeeting, desiredOutcome, userCanOffer, userExpertise, + role/company/
  industry/interests/languages). Those must now come from open answers.

## Design

**Opening (Q1) is universal and fixed, no LLM call.** `hostOpening(known)` in
shared: with a profile on file → Claus's lead + question; without →
`OPENINGS.not_found` + question. `POST /onboarding/open` returns it (still 503
when the LLM is disabled so the form fallback engages early). One call per
member saved; the wording is Claus's, always.

**Q2 and Q3 are adaptive.** The host prompt names the two defaults and tells
the host to shape them from what was said, never to ask them mechanically, and
never to ask the member to describe themselves, list who they want to meet or
say what they offer. One short follow-up per opening at most, only for a
one-line answer or a genuine misunderstanding. Language / competitor /
geography / invite are noted if mentioned, never asked.

**Reflection is allowed and defined.** One line that adds a thought or
reframes, as a statement (so the one-question rule holds), with Claus's
example verbatim. Reading back ("So you…", quoting) stays forbidden. Message
budget 25 → 30 words to leave room for it (style guard 28 → 34).

**Spoken register.** "Imagine this is a spoken conversation; if a line would
sound odd said out loud across a table, rewrite it."

**Server-side bound.** `MAX_HOST_QUESTIONS = 6` (3 openings + 3 follow-ups).
`/chat` counts assistant turns in the transcript, passes "asked N of at most 6"
into the prompt, and forces a hard wrap at 6. Soft finish ("I'm done") asks Q3
once if it has not been asked, otherwise summarises.

**Extractor.** New rules: wants and offers are INFERRED from the open answers
(desiredPeople/Roles, userCanOffer, userValuableTo, matchingTags), with
confidence set honestly; facts (company, role, city, languages, restrictions)
are never invented; explicit rules for reasonForMeeting, desiredOutcome,
userExpertise/userCanOffer, userInterests (curiosity), userProfileSummary
(identity signals, values). Schema unchanged (grammar limit; 35 fields).

**Model.** Stays `claude-haiku-4-5` (prod LLM budget < $10/month). Worst case
per member: 6 host turns (+ rewrites) + 6 live-card extractions + 1 final ≈
$0.06.

**Client.** Opening strings come from shared (`hostOpening`,
`HOST_OPENING_QUESTION`); resume shows the bare question; header caption
"a short chat".

## Decisions (mine, flagged to Ali)

1. Q1 is asked even when the join request holds a reason (Claus: universal
   opening; the lead acknowledges the profile). Reverses the 4 Sep behaviour.
2. Reflection allowed as a statement, not a second question, so Stefan's
   one-question rule and Claus's reflection coexist.
3. Six host questions max, server-enforced.

## Tests

Unit: prompts (arc, reflection, defaults, budget, no self-classification,
progress line), chatbot style guard (30 words), routes (/open fixed text by
opening state, /chat cap + progress). E2E on prod with the real model:
`onboarding-journey.spec.ts` rewritten around Claus's flow (opening exact,
every reply one question, never "who do you want to meet", agent seeded from
inferred wants, member completed); `onboarding-states.spec.ts` constants.
Then the permanent sweep: server suite, client tsc/build, headed smokes.
