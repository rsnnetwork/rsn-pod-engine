// ─── Onboarding v2: state, draft and confirm ─────────────────────────────────
//
// The server half of Shradha's eight-screen brief (19 Oct 2026). Version 1
// (answers.repo.ts) is untouched and keeps serving the live app until go-live.
//
// Answers are stored twice, as in v1: the KEYS in looking_to_meet,
// hoping_to_find, can_offer and self_kinds (v2 keys beside v1 keys, which are
// different strings), and the same answers as TEXT in the columns the matcher
// and the public card read, translated in option-signals.ts. A label never
// reaches either.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { NotFoundError } from '../../middleware/errors';
import { ONBOARDING_V2_MEET, ONBOARDING_V2_STEPS, shortLabelFor } from '@rsn/shared';
import type {
  OnboardingStatus, OnboardingV2Answers, OnboardingV2State, OnboardingV2Step, TourOutcome,
} from '@rsn/shared';
import { v2FromV1, isMeetV2Key, isFindV2Key, isOfferV2Key, isSelfV2Key } from './answers-v2.map';
import { linkedinBlock, asResult } from './linkedin-v2';
import { getCachedEnrichment, sameTitle, type EnrichmentStatus } from './enrichment.repo';
import type { EnrichResult } from './enrichment.service';
import {
  wantTextV2, intentTextV2, offerTextV2, roleTitlesV2, reasonsV2, desiredDesignationsV2,
} from '../matching/option-signals';
import { normalizeDesignation } from '../matching/intent-signals';
import type { DraftInputV2, ConfirmInputV2 } from './answers-v2.schema';

type Draft = Partial<OnboardingV2Answers> & { step?: OnboardingV2Step };

interface StateRow {
  onboarding_status: OnboardingStatus;
  onboarding_version: number | null;
  display_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  company: string | null;
  industry: string | null;
  timezone: string | null;
  linkedin_url: string | null;
  tour_due_at: Date | null;
  tour_seen_at: Date | null;
  tour_outcome: TourOutcome | null;
  onboarding_intent: string | null;
  looking_to_meet: string[] | null;
  can_offer: string[] | null;
  self_kinds: string[] | null;
  hoping_to_find: string[] | null;
  meet_other: string | null;
  find_other: string | null;
  find_specific: string | null;
  offer_other: string | null;
  self_other: string | null;
  draft: Draft | null;
  enriched: unknown;
  enrichment_status: EnrichmentStatus | null;
  enrichment_started_at: Date | string | null;
  enrichment_completed_at: Date | string | null;
  preload: unknown;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

/** One answer layer: a field is undefined when this layer says nothing about it. */
type Layer = Partial<OnboardingV2Answers>;

/** The member's confirmed v2 answers, question by question; a question with no v2 key says nothing. */
function confirmedLayer(row: StateRow): Layer {
  const out: Layer = {};
  const meet = (row.looking_to_meet ?? []).filter(isMeetV2Key);
  if (meet.length) Object.assign(out, { lookingToMeet: meet, meetOther: row.meet_other });
  const find = (row.hoping_to_find ?? []).filter(isFindV2Key);
  if (find.length) Object.assign(out, { hopingToFind: find, findOther: row.find_other, findSpecific: row.find_specific });
  const offer = (row.can_offer ?? []).filter(isOfferV2Key);
  if (offer.length) Object.assign(out, { canOffer: offer, offerOther: row.offer_other });
  const self = (row.self_kinds ?? []).filter(isSelfV2Key);
  if (self.length) Object.assign(out, { selfKinds: self, selfOther: row.self_other });
  return out;
}

type ArrayField = 'lookingToMeet' | 'hopingToFind' | 'canOffer' | 'selfKinds';
type TextField = 'meetOther' | 'findOther' | 'findSpecific' | 'offerOther' | 'selfOther';

/**
 * What the screens show. Field by field, the first layer that says anything
 * wins: for a member who finished v2, what they have, then a draft they left;
 * for anyone else, their draft (the newest thing they said), then confirmed v2
 * answers. Version 1 answers, through the mapping table, come last.
 */
function resolveAnswers(row: StateRow): { answers: OnboardingV2Answers; prefilledFromV1: boolean } {
  const confirmed = confirmedLayer(row);
  const draft: Layer = row.draft && typeof row.draft === 'object' ? row.draft : {};
  const v1 = v2FromV1({
    intent: row.onboarding_intent,
    lookingToMeet: row.looking_to_meet,
    canOffer: row.can_offer,
    selfKinds: row.self_kinds,
  });
  const layers: Layer[] = row.onboarding_status === 'completed' ? [confirmed, draft] : [draft, confirmed];

  let prefilledFromV1 = false;
  const pickArray = <K extends ArrayField>(field: K): OnboardingV2Answers[K] => {
    for (const layer of layers) if (layer[field] !== undefined) return layer[field] as OnboardingV2Answers[K];
    if (v1[field].length) prefilledFromV1 = true;
    return v1[field] as OnboardingV2Answers[K];
  };
  const pickText = (field: TextField): string | null => {
    for (const layer of layers) if (layer[field] !== undefined) return layer[field] ?? null;
    return null;
  };

  const a: OnboardingV2Answers = {
    lookingToMeet: pickArray('lookingToMeet'),
    meetOther: pickText('meetOther'),
    hopingToFind: pickArray('hopingToFind'),
    findOther: pickText('findOther'),
    findSpecific: pickText('findSpecific'),
    canOffer: pickArray('canOffer'),
    offerOther: pickText('offerOther'),
    selfKinds: pickArray('selfKinds'),
    selfOther: pickText('selfOther'),
  };
  // A box's words belong to its option: shown only while it is chosen.
  if (!a.lookingToMeet.includes('meet_other')) a.meetOther = null;
  if (!a.hopingToFind.includes('find_other')) a.findOther = null;
  if (!a.canOffer.includes('offer_other')) a.offerOther = null;
  if (!a.selfKinds.includes('self_other')) a.selfOther = null;
  return { answers: a, prefilledFromV1 };
}

const isStep = (s: unknown): s is OnboardingV2Step =>
  typeof s === 'string' && (ONBOARDING_V2_STEPS as readonly string[]).includes(s);

/** GET /onboarding/v2/state: one query, everything the eight screens draw from. */
export async function getState(userId: string): Promise<OnboardingV2State> {
  const r = await query<StateRow>(
    `SELECT u.onboarding_status, u.onboarding_version, u.display_name, u.avatar_url,
            u.job_title, u.company, u.industry, u.timezone, u.linkedin_url,
            u.tour_due_at, u.tour_seen_at, u.tour_outcome,
            u.onboarding_intent, u.looking_to_meet, u.can_offer, u.self_kinds, u.hoping_to_find,
            u.meet_other, u.find_other, u.find_specific, u.offer_other, u.self_other,
            p.onboarding_draft->'v2' AS draft,
            p.inferred_profile->'enriched' AS enriched,
            p.enrichment_status, p.enrichment_started_at, p.enrichment_completed_at,
            jr.enriched AS preload
       FROM users u
       LEFT JOIN user_intent_profiles p ON p.user_id = u.id
       -- The lookup made when they were approved, for a member who signed in before it landed.
       LEFT JOIN LATERAL (
         SELECT j.enriched FROM join_requests j
          WHERE lower(j.email) = lower(u.email) AND j.status = 'approved'
          ORDER BY j.reviewed_at DESC NULLS LAST
          LIMIT 1
       ) jr ON TRUE
      WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError('User', userId);

  const { answers, prefilledFromV1 } = resolveAnswers(row);
  return {
    status: row.onboarding_status,
    version: row.onboarding_version,
    step: isStep(row.draft?.step) ? row.draft!.step! : 'welcome',
    answers,
    prefilledFromV1,
    profile: {
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      jobTitle: row.job_title,
      company: row.company,
      industry: row.industry,
      timezone: row.timezone,
      linkedinUrl: row.linkedin_url,
    },
    linkedin: linkedinBlock({
      currentUrl: row.linkedin_url,
      state: {
        status: row.enrichment_status ?? 'none',
        startedAt: iso(row.enrichment_started_at),
        completedAt: iso(row.enrichment_completed_at),
      },
      ownCache: asResult<EnrichResult>(row.enriched),
      preload: asResult<EnrichResult & { provider?: string | null }>(row.preload),
      now: Date.now(),
    }),
    tour: {
      // Only someone who just finished is shown the tour.
      pending: !!row.tour_due_at && !row.tour_seen_at,
      seenAt: iso(row.tour_seen_at),
      outcome: row.tour_outcome,
    },
  };
}

/**
 * Merge a partial answer into the v2 draft (onboarding_draft->'v2'), leaving
 * the rest of the draft, a v1 one included, alone. Never touches the matching
 * columns: until they confirm, nothing they ticked is shown to anyone.
 */
export async function saveDraft(userId: string, patch: DraftInputV2): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO user_intent_profiles (user_id, onboarding_draft)
       VALUES ($1, jsonb_build_object('v2', $2::jsonb))
       ON CONFLICT (user_id) DO UPDATE
         SET onboarding_draft = jsonb_set(
               user_intent_profiles.onboarding_draft,
               '{v2}',
               COALESCE(user_intent_profiles.onboarding_draft->'v2', '{}'::jsonb) || $2::jsonb),
             updated_at = NOW()`,
      [userId, JSON.stringify(patch)],
    );
    await client.query(
      `UPDATE users SET onboarding_status = 'in_progress'
        WHERE id = $1 AND onboarding_status IN ('not_started', 'update_required')`,
      [userId],
    );
  });
}

interface BeforeRow {
  onboarding_status: string;
  onboarding_version: number | null;
  looking_to_meet: string[] | null;
  meet_other: string | null;
  hoping_to_find: string[] | null;
  find_other: string | null;
  find_specific: string | null;
  can_offer: string[] | null;
  offer_other: string | null;
  self_kinds: string[] | null;
  self_other: string | null;
  job_title: string | null;
  industry: string | null;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/** Did these answers change anything a search or a card depends on? */
function sameAnswers(before: BeforeRow, a: OnboardingV2Answers): boolean {
  return before.onboarding_version === 2
    && sameSet((before.looking_to_meet ?? []).filter(isMeetV2Key), a.lookingToMeet)
    && sameSet((before.hoping_to_find ?? []).filter(isFindV2Key), a.hopingToFind)
    && sameSet((before.can_offer ?? []).filter(isOfferV2Key), a.canOffer)
    && sameSet((before.self_kinds ?? []).filter(isSelfV2Key), a.selfKinds)
    && (before.meet_other ?? null) === a.meetOther
    && (before.find_other ?? null) === a.findOther
    && (before.find_specific ?? null) === a.findSpecific
    && (before.offer_other ?? null) === a.offerOther
    && (before.self_other ?? null) === a.selfOther;
}

/** First word, then the rest: how a corrected name becomes first and last name. */
function splitName(displayName: string): [string, string] {
  const parts = displayName.split(/\s+/).filter(Boolean);
  return [parts[0] ?? displayName, parts.slice(1).join(' ')];
}

export interface ConfirmResultV2 {
  /** False when they confirmed the same answers again. */
  changed: boolean;
  /** True only the first time they ever finish onboarding. */
  firstCompletion: boolean;
  answers: OnboardingV2Answers;
}

/**
 * Write the answers for real, in one transaction with the member's row locked,
 * so a double press cannot seed two sets of searches.
 */
export async function confirm(userId: string, input: ConfirmInputV2): Promise<ConfirmResultV2> {
  const answers: OnboardingV2Answers = {
    lookingToMeet: input.lookingToMeet, meetOther: input.meetOther,
    hopingToFind: input.hopingToFind, findOther: input.findOther, findSpecific: input.findSpecific,
    canOffer: input.canOffer, offerOther: input.offerOther,
    selfKinds: input.selfKinds, selfOther: input.selfOther,
  };
  const profile = input.profile ?? {};
  const given = <T>(v: T | null | undefined): T | null => v ?? null;

  // The title is a matching input: kept unchanged from their LinkedIn page it
  // is 'inferred', typed it is 'stated' (13 Aug, B1).
  const cached = profile.jobTitle ? await getCachedEnrichment(userId).catch(() => null) : null;
  const titleSource = sameTitle(profile.jobTitle, cached?.profile?.currentRole) ? 'inferred' : 'stated';

  return transaction(async (client) => {
    const cur = await client.query<BeforeRow>(
      `SELECT onboarding_status, onboarding_version, looking_to_meet, meet_other, hoping_to_find,
              find_other, find_specific, can_offer, offer_other, self_kinds, self_other, job_title, industry
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const before = cur.rows[0];
    if (!before) throw new NotFoundError('User', userId);

    const changed = !sameAnswers(before, answers);
    // Invite and Google sign-ups start with onboarding_completed already true,
    // so only the status says whether they have ever finished.
    const firstCompletion = before.onboarding_status !== 'completed';

    // What the matcher and the public card read: canonical text, never a label.
    const roleTitles = roleTitlesV2(answers.selfKinds, answers.selfOther, given(profile.jobTitle) ?? before.job_title);
    const wantText = wantTextV2(answers.lookingToMeet, answers.meetOther);
    const intentText = intentTextV2(answers.hopingToFind, answers.findOther, answers.findSpecific);
    const offerText = offerTextV2(answers.canOffer, answers.offerOther);
    const displayName = given(profile.displayName);
    const [firstName, lastName] = displayName ? splitName(displayName) : [null, null];

    await client.query(
      `UPDATE users SET
         looking_to_meet = $2, meet_other = $3,
         hoping_to_find = $4, find_other = $5, find_specific = $6,
         can_offer = $7, offer_other = $8,
         self_kinds = $9, self_other = $10,
         onboarding_version = 2,
         professional_role = $11,
         who_i_want_to_meet = NULLIF($12, ''),
         my_intent = $13,
         what_i_can_help_with = $14,
         reasons_to_connect = $15,
         -- the profile: only what was given, so silence never blanks a field
         display_name = COALESCE($16, display_name),
         first_name = CASE WHEN $16::text IS NULL OR $16 = display_name THEN first_name ELSE $22 END,
         last_name = CASE WHEN $16::text IS NULL OR $16 = display_name THEN last_name ELSE $23 END,
         job_title = COALESCE($17, job_title),
         job_title_source = CASE WHEN $17::text IS NULL THEN job_title_source ELSE $18 END,
         company = COALESCE($19, company),
         industry = COALESCE($20, industry),
         timezone = COALESCE($21, timezone),
         -- "can this person be matched": for a v2 member, exactly their answers
         profile_complete = true,
         onboarding_completed = true,
         onboarding_status = 'completed',
         last_onboarded_at = NOW(),
         -- the tour opens once, for people who have not already seen it
         tour_due_at = CASE WHEN tour_seen_at IS NULL THEN NOW() ELSE tour_due_at END,
         updated_at = NOW()
       WHERE id = $1`,
      [
        userId,
        answers.lookingToMeet, answers.meetOther,
        answers.hopingToFind, answers.findOther, answers.findSpecific,
        answers.canOffer, answers.offerOther,
        answers.selfKinds, answers.selfOther,
        roleTitles, wantText, intentText, offerText, reasonsV2(answers.hopingToFind),
        displayName, given(profile.jobTitle), titleSource, given(profile.company),
        given(profile.industry), given(profile.timezone),
        firstName, lastName,
      ],
    );

    // What the live-event matcher reads. It ignores professional_role and
    // looks here, so a v2 member would otherwise score neutrally in every event.
    const matchingIntent = {
      source: 'tickbox_v2',
      userDesignation: roleTitles.map(t => normalizeDesignation(t)).find(Boolean) ?? null,
      userRoles: roleTitles,
      desiredPeople: [
        ...answers.lookingToMeet.filter(k => k !== 'meet_other').map(k => shortLabelFor(ONBOARDING_V2_MEET, k)),
        ...(answers.meetOther ? [answers.meetOther] : []),
      ],
      desiredDesignations: desiredDesignationsV2(answers.lookingToMeet, answers.hopingToFind),
      userCanOffer: offerText,
      userIndustry: given(profile.industry) ?? before.industry,
      reasonForMeeting: intentText,
    };
    await client.query(
      `INSERT INTO user_intent_profiles (user_id, matching_intent)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET matching_intent = $2::jsonb,
             -- the v2 draft has served its purpose; anything else in it stays
             onboarding_draft = user_intent_profiles.onboarding_draft - 'v2',
             updated_at = NOW()`,
      [userId, JSON.stringify(matchingIntent)],
    );

    logger.info({ userId, changed, firstCompletion, kinds: answers.lookingToMeet }, 'onboarding v2 answers confirmed');
    return { changed, firstCompletion, answers };
  });
}
