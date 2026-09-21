// ─── Tick-box answers: draft and confirm ─────────────────────────────────────
//
// Everything a member tells us in the five steps, and nothing else. No guesses
// reach these columns: the deck's rule is "never show the user a guess as fact.
// Everything in the profile comes from what they ticked or typed - and they
// confirm it."
//
// Answers are stored twice on purpose. The KEYS are the new, comparable truth.
// The same answers are also written as canonical TEXT into the columns the
// matcher and the public card already read, so a tick-box member is visible to
// everyone who joined before this flow existed, and vice versa. The text is
// never a label — see option-signals.ts for why.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { NotFoundError } from '../../middleware/errors';
import type {
  OnboardingAnswers, OnboardingState, OnboardingStep, TourOutcome, MeetKey, OfferKey, IndustryKey, IntentKey,
} from '@rsn/shared';
import { labelFor, shortLabelFor, ONBOARDING_INTENTS, ONBOARDING_MEET } from '@rsn/shared';
import {
  MEET_SIGNALS, INTENT_SIGNALS, industrySummary, offerSummary, roleTitlesFor,
} from '../matching/option-signals';
import type { DraftInput, ConfirmInput } from './answers.schema';

interface StateRow {
  onboarding_status: string;
  display_name: string | null;
  avatar_url: string | null;
  tour_due_at: Date | null;
  tour_seen_at: Date | null;
  tour_outcome: TourOutcome | null;
  onboarding_intent: IntentKey | null;
  looking_to_meet: MeetKey[] | null;
  can_offer: OfferKey[] | null;
  industries: IndustryKey[] | null;
  industry_other: string | null;
  self_kinds: MeetKey[] | null;
  job_title: string | null;
  company: string | null;
  bio: string | null;
  draft: (Partial<OnboardingAnswers> & { step?: OnboardingStep }) | null;
}

/**
 * What the flow needs to draw itself: the member's own answers so far, and
 * their name and photo. Deliberately NOT their guessed country, company or
 * about line — those were the "guesses shown as fact" the deck is replacing.
 */
export async function getState(userId: string): Promise<OnboardingState> {
  const r = await query<StateRow>(
    `SELECT u.onboarding_status, u.display_name, u.avatar_url,
            u.tour_due_at, u.tour_seen_at, u.tour_outcome,
            u.onboarding_intent, u.looking_to_meet, u.can_offer, u.industries,
            u.industry_other, u.self_kinds, u.job_title, u.company, u.bio,
            p.onboarding_draft AS draft
     FROM users u
     LEFT JOIN user_intent_profiles p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError('User', userId);

  // Confirmed answers win over the draft: someone who finished and came back
  // to change one thing should see what they actually have.
  const confirmed: Partial<OnboardingAnswers> = {};
  if (row.onboarding_intent) confirmed.intent = row.onboarding_intent;
  if (row.looking_to_meet?.length) confirmed.lookingToMeet = row.looking_to_meet;
  if (row.can_offer?.length) confirmed.canOffer = row.can_offer;
  if (row.industries?.length) confirmed.industries = row.industries;
  if (row.industry_other) confirmed.industryOther = row.industry_other;
  if (row.self_kinds?.length) confirmed.selfKinds = row.self_kinds;
  if (row.job_title) confirmed.jobTitle = row.job_title;
  if (row.company) confirmed.company = row.company;
  if (row.bio) confirmed.about = row.bio;

  const { step, ...draftAnswers } = row.draft ?? {};
  return {
    status: row.onboarding_status as OnboardingState['status'],
    answers: { ...draftAnswers, ...confirmed },
    step: (step as OnboardingStep) ?? 'welcome',
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    tour: {
      // Only someone who just finished the flow is shown the tour, so nobody
      // who onboarded before it existed is interrupted by it.
      pending: !!row.tour_due_at && !row.tour_seen_at,
      seenAt: row.tour_seen_at ? row.tour_seen_at.toISOString() : null,
      outcome: row.tour_outcome,
    },
  };
}

/**
 * Merge a partial answer into the draft. Never touches the live matching
 * columns: until they confirm, nothing they have ticked is shown to anyone.
 */
export async function saveDraft(userId: string, patch: DraftInput): Promise<void> {
  await query(
    `INSERT INTO user_intent_profiles (user_id, onboarding_draft)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET onboarding_draft = user_intent_profiles.onboarding_draft || $2::jsonb,
           updated_at = NOW()`,
    [userId, JSON.stringify(patch)],
  );
  await query(
    `UPDATE users SET onboarding_status = 'in_progress'
     WHERE id = $1 AND onboarding_status IN ('not_started', 'update_required')`,
    [userId],
  );
}

export interface ConfirmResult {
  /** False when they simply re-confirmed the same answers. */
  changed: boolean;
  /** True only the first time they ever finish. */
  firstCompletion: boolean;
  answers: OnboardingAnswers;
}

/**
 * Write the answers for real. One transaction, the member's row locked, so a
 * double press cannot seed two sets of searches.
 */
export async function confirm(userId: string, input: ConfirmInput): Promise<ConfirmResult> {
  const answers = input as OnboardingAnswers;
  return transaction(async (client) => {
    const cur = await client.query<{
      onboarding_status: string; onboarding_intent: string | null; looking_to_meet: string[] | null;
      can_offer: string[] | null; industries: string[] | null; self_kinds: string[] | null;
      industry_other: string | null; bio: string | null;
    }>(
      `SELECT onboarding_status, onboarding_intent, looking_to_meet, can_offer, industries,
              self_kinds, industry_other, bio
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const before = cur.rows[0];
    if (!before) throw new NotFoundError('User', userId);

    const same = (a: string[] | null | undefined, b: string[]) =>
      (a ?? []).length === b.length && (a ?? []).every(x => b.includes(x));
    const changed = !(
      before.onboarding_intent === answers.intent
      && same(before.looking_to_meet, answers.lookingToMeet)
      && same(before.can_offer, answers.canOffer)
      && same(before.industries, answers.industries)
      && same(before.self_kinds, answers.selfKinds)
      && (before.industry_other ?? null) === (answers.industryOther ?? null)
    );
    // Invite and Google sign-ups are created with onboarding_completed already
    // true, so the flag cannot tell us whether they have ever finished — the
    // status can.
    const firstCompletion = before.onboarding_status !== 'completed';

    // What the matcher and the public card read. Canonical text per key, never
    // the label: see option-signals.ts.
    const wantsText = answers.lookingToMeet.map(k => MEET_SIGNALS[k].wantText).join('; ');
    const offersText = offerSummary(answers.canOffer);
    const industryText = industrySummary(answers.industries, answers.industryOther);
    const roleTitles = roleTitlesFor(answers.selfKinds);
    const reasonText = INTENT_SIGNALS[answers.intent].reasonText;
    const reasonLabel = shortLabelFor(ONBOARDING_INTENTS, answers.intent);

    await client.query(
      `UPDATE users SET
         onboarding_intent = $2,
         looking_to_meet = $3, can_offer = $4, industries = $5,
         industry_other = $6, self_kinds = $7,
         -- typed, so only overwrite when they actually typed something
         job_title = COALESCE($8, job_title),
         job_title_source = CASE WHEN $8::text IS NULL THEN job_title_source ELSE 'stated' END,
         company = COALESCE($9, company),
         -- their own line about themselves; silence must not wipe a longer one
         -- they wrote on the profile page
         bio = COALESCE($10, bio),
         professional_role = $11,
         who_i_want_to_meet = $12,
         what_i_can_help_with = $13,
         industry = NULLIF($14, ''),
         my_intent = $15,
         reasons_to_connect = $16,
         onboarding_completed = true,
         onboarding_status = 'completed',
         last_onboarded_at = NOW(),
         -- the wizard opens once, for people who have not already seen it
         tour_due_at = CASE WHEN tour_seen_at IS NULL THEN NOW() ELSE tour_due_at END
       WHERE id = $1`,
      [
        userId, answers.intent, answers.lookingToMeet, answers.canOffer, answers.industries,
        answers.industryOther, answers.selfKinds, answers.jobTitle, answers.company, answers.about,
        roleTitles, wantsText, offersText, industryText, reasonText, [reasonLabel],
      ],
    );

    // profile_complete's old rule wanted company + job_title + industry, none
    // of which the five steps guarantee. What it is really asking is "can this
    // person be matched", and for a tick-box member that is exactly their
    // answers.
    await client.query(
      `UPDATE users SET profile_complete = ($2 AND $3 AND $4)
       WHERE id = $1`,
      [userId, !!answers.intent, answers.lookingToMeet.length > 0, answers.canOffer.length > 0],
    );

    // What the live-event matcher reads. It ignores professional_role and
    // looks here instead, so a member who only ticked boxes would otherwise
    // score neutrally in every event.
    const matchingIntent = {
      source: 'tickbox_v1',
      userDesignation: roleTitles[0] ?? null,
      userRoles: roleTitles,
      desiredPeople: answers.lookingToMeet.map(k => labelFor(ONBOARDING_MEET, k)),
      desiredDesignations: [...new Set(answers.lookingToMeet.flatMap(k => MEET_SIGNALS[k].buckets))],
      userCanOffer: offersText,
      userIndustry: industryText,
      reasonForMeeting: reasonText ?? reasonLabel,
    };
    await client.query(
      `INSERT INTO user_intent_profiles (user_id, matching_intent, onboarding_draft)
       VALUES ($1, $2::jsonb, '{}'::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET matching_intent = $2::jsonb,
             -- the draft has served its purpose; the answers are real now
             onboarding_draft = '{}'::jsonb,
             updated_at = NOW()`,
      [userId, JSON.stringify(matchingIntent)],
    );

    logger.info({ userId, changed, firstCompletion, kinds: answers.lookingToMeet }, 'onboarding answers confirmed');
    return { changed, firstCompletion, answers };
  });
}

/** Remember that the wizard has been seen. First answer wins, so a second
 *  device or a double press cannot overwrite how they left it. */
export async function markTourSeen(userId: string, outcome: TourOutcome): Promise<void> {
  await query(
    `UPDATE users
     SET tour_seen_at = COALESCE(tour_seen_at, NOW()),
         tour_outcome = COALESCE(tour_outcome, $2)
     WHERE id = $1`,
    [userId, outcome],
  );
}
