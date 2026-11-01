// ─── The admin onboarding report (30 Oct review, 2.3; L4) ───────────────────
//
// "Onboarding answers should be saved and visible in the admin report." They were saved, but an admin saw them
// only as raw keys in the stage timeline. Two readings of the same columns:
//   - one member's answers, for the inspector's "Onboarding answers" card (GET /admin/users/:id/onboarding);
//   - every active member's answers as rows, for the CSV (GET /admin/onboarding/export.csv), with each answer
//     as its label from the shared catalogue, never a key.
// A v2 answer and a v1 answer share the key columns, so each list is filtered to v2 keys and whatever else the
// columns hold is the earlier onboarding's, kept raw.

import { query } from '../../db';
import {
  ONBOARDING_V2_FIND, ONBOARDING_V2_MEET, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF, onboardingDone, shortLabelFor,
} from '@rsn/shared';
import type { AdminOnboardingAnswers, OnboardingOption } from '@rsn/shared';
import { isFindV2Key, isMeetV2Key, isOfferV2Key, isSelfV2Key } from './answers-v2.map';

/** The users columns both readings select. */
export const ANSWER_COLUMNS = `u.onboarding_version, u.location, u.timezone, u.onboarding_intent,
       u.looking_to_meet, u.meet_other, u.hoping_to_find, u.find_other, u.find_specific,
       u.can_offer, u.offer_other, u.self_kinds, u.self_other`;

export interface AnswerRow {
  onboarding_version: number | null;
  location: string | null;
  timezone: string | null;
  onboarding_intent: string | null;
  looking_to_meet: string[] | null;
  meet_other: string | null;
  hoping_to_find: string[] | null;
  find_other: string | null;
  find_specific: string | null;
  can_offer: string[] | null;
  offer_other: string | null;
  self_kinds: string[] | null;
  self_other: string | null;
}

/** One member's answers as the inspector's card shows them. */
export function answersFromRow(row: AnswerRow): AdminOnboardingAnswers {
  const lists = [row.looking_to_meet, row.hoping_to_find, row.can_offer, row.self_kinds].map(l => l ?? []);
  const [meet, find, offer, self] = lists;
  const isV2 = (k: string) => isMeetV2Key(k) || isFindV2Key(k) || isOfferV2Key(k) || isSelfV2Key(k);
  const v1Keys = [...new Set([...(row.onboarding_intent ? [row.onboarding_intent] : []), ...lists.flat().filter(k => !isV2(k))])];
  return {
    version: row.onboarding_version,
    lookingToMeet: meet.filter(isMeetV2Key),
    meetOther: row.meet_other,
    hopingToFind: find.filter(isFindV2Key),
    findOther: row.find_other,
    findSpecific: row.find_specific,
    canOffer: offer.filter(isOfferV2Key),
    offerOther: row.offer_other,
    selfKinds: self.filter(isSelfV2Key),
    selfOther: row.self_other,
    v1Keys,
    location: row.location,
    timezone: row.timezone,
  };
}

/** The CSV's columns, in order: its header row. */
export const ONBOARDING_CSV_COLUMNS = [
  'Name', 'Email', 'Onboarding', 'Status', 'Last onboarded', 'Location', 'Time zone',
  'Who they want to meet', 'Meet (own words)', 'Hoping to find', 'Find (own words)', 'Anything specific',
  'Can offer', 'Offer (own words)', 'Describes themselves as', 'Self (own words)',
] as const;

export type OnboardingCsvRow = Record<typeof ONBOARDING_CSV_COLUMNS[number], string | null>;

interface ReportRow extends AnswerRow {
  display_name: string | null;
  email: string;
  onboarding_status: string;
  last_onboarded_at: Date | null;
}

/** The most rows one download holds: production has about 80 active members. */
export const ONBOARDING_CSV_LIMIT = 1000;

const labels = (list: readonly OnboardingOption[], keys: readonly string[]): string =>
  keys.map(k => shortLabelFor(list, k)).join('; ');

/** One row per active member, by name: who they are, which onboarding they did, and every answer as its label. */
export async function onboardingReportRows(): Promise<OnboardingCsvRow[]> {
  const r = await query<ReportRow>(
    `SELECT u.display_name, u.email, u.onboarding_status, u.last_onboarded_at, ${ANSWER_COLUMNS}
       FROM users u
      -- switch to activeMemberSql after T2
      WHERE u.status = 'active'
      ORDER BY lower(COALESCE(u.display_name, u.email)), u.id
      LIMIT $1`,
    [ONBOARDING_CSV_LIMIT],
  );
  return r.rows.map((row) => {
    const a = answersFromRow(row);
    return {
      'Name': row.display_name,
      'Email': row.email,
      'Onboarding': onboardingDone(row.onboarding_status, row.onboarding_version),
      'Status': row.onboarding_status,
      'Last onboarded': row.last_onboarded_at ? new Date(row.last_onboarded_at).toISOString() : null,
      'Location': row.location,
      'Time zone': row.timezone,
      'Who they want to meet': labels(ONBOARDING_V2_MEET, a.lookingToMeet),
      'Meet (own words)': a.meetOther,
      'Hoping to find': labels(ONBOARDING_V2_FIND, a.hopingToFind),
      'Find (own words)': a.findOther,
      'Anything specific': a.findSpecific,
      'Can offer': labels(ONBOARDING_V2_OFFER, a.canOffer),
      'Offer (own words)': a.offerOther,
      'Describes themselves as': labels(ONBOARDING_V2_SELF, a.selfKinds),
      'Self (own words)': a.selfOther,
    };
  });
}
