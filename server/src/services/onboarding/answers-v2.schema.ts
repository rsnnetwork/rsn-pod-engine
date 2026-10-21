// ─── Onboarding v2: validation ───────────────────────────────────────────────
//
// Built from the shared catalogue, so a key the screens cannot show is a key
// this will not accept. The limits are the brief's; "Something else" requires
// its words; a time zone has to be real. Every body is strict: an unknown field
// is a mistake in the caller, and is refused rather than quietly ignored.

import { z } from 'zod';
import {
  ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF,
  ONBOARDING_V2_LIMITS as L, ONBOARDING_V2_STEPS,
} from '@rsn/shared';
import { canonicalTimeZone } from './time-zone';

const keysOf = <T extends readonly { key: string }[]>(list: T) =>
  list.map(o => o.key) as [T[number]['key'], ...T[number]['key'][]];

// Every refusal a member can cause says what to do, in words (never "Required"
// or "Invalid enum value").
const NOT_ON_THE_LIST = { errorMap: () => ({ message: 'Choose one of the answers shown.' }) };
const meetKey = z.enum(keysOf(ONBOARDING_V2_MEET), NOT_ON_THE_LIST);
const findKey = z.enum(keysOf(ONBOARDING_V2_FIND), NOT_ON_THE_LIST);
const offerKey = z.enum(keysOf(ONBOARDING_V2_OFFER), NOT_ON_THE_LIST);
const selfKey = z.enum(keysOf(ONBOARDING_V2_SELF), NOT_ON_THE_LIST);

/**
 * Typed text, capped; empty becomes null. A control character (a line break, a
 * tab) becomes a space and runs of spaces become one, so "Vienna\nor Graz"
 * keeps both places for the place parser instead of becoming "Viennaor Graz".
 */
const line = (max: number) =>
  z.string({ invalid_type_error: 'Type your answer as words.' })
    .transform(s => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim())
    .refine(s => s.length <= max, { message: `Keep this under ${max} characters.` })
    .transform(s => (s.length ? s : null))
    .nullable();

/** A set, not a list: a tick twice is one answer. */
const uniqueKeys = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item, { required_error: 'Select at least one answer.', invalid_type_error: 'Choose from the answers shown.' })
    .max(20)
    .transform(v => [...new Set(v)] as z.infer<T>[]);

/** The brief's own helper line is the message: "Select up to three answers." */
const atMost = <T extends z.ZodTypeAny>(item: T, max: number, words: string) =>
  uniqueKeys(item).refine(v => v.length <= max, { message: `Select up to ${words} answers.` });
const atLeastOne = { message: 'Select at least one answer.' };

const TIMEZONE_MESSAGE = 'Choose your time zone from the list, for example Asia/Kathmandu.';

/** Optional, and a blank means "not given": a missing time zone never blanks the stored one. */
const timezone = z.string().max(200).nullable().transform((value, ctx) => {
  const given = (value ?? '').trim();
  if (!given) return null;
  const zone = canonicalTimeZone(given);
  if (!zone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: TIMEZONE_MESSAGE });
    return z.NEVER;
  }
  return zone;
}).optional();

/** Saved as the member moves through the screens. No minimums yet, but never an unknown key. */
export const draftSchemaV2 = z.object({
  lookingToMeet: atMost(meetKey, L.meetMax, 'three').optional(),
  meetOther: line(L.otherMaxLen).optional(),
  hopingToFind: atMost(findKey, L.findMax, 'three').optional(),
  findOther: line(L.otherMaxLen).optional(),
  findSpecific: line(L.findSpecificMaxLen).optional(),
  canOffer: uniqueKeys(offerKey).optional(),
  offerOther: line(L.otherMaxLen).optional(),
  selfKinds: atMost(selfKey, L.selfMax, 'two').optional(),
  selfOther: line(L.otherMaxLen).optional(),
  step: z.enum(ONBOARDING_V2_STEPS).optional(),
}).strict();

export type DraftInputV2 = z.infer<typeof draftSchemaV2>;

const profileSchema = z.object({
  displayName: line(L.displayNameMaxLen).optional(),
  jobTitle: line(L.jobTitleMaxLen).optional(),
  company: line(L.companyMaxLen).optional(),
  industry: line(L.industryMaxLen).optional(),
  timezone,
  useLinkedinPhoto: z.boolean().optional(),
}).strict();

const OWN_WORDS = [
  { keys: 'lookingToMeet', key: 'meet_other', text: 'meetOther', message: 'Tell us who you would like to meet.' },
  { keys: 'hopingToFind', key: 'find_other', text: 'findOther', message: 'Tell us what you are hoping to find.' },
  { keys: 'canOffer', key: 'offer_other', text: 'offerOther', message: 'Tell us what you can offer.' },
  { keys: 'selfKinds', key: 'self_other', text: 'selfOther', message: 'Tell us how you would describe yourself.' },
] as const;

/** The finished set, sent whole, so confirming never depends on whether a draft save landed. */
export const confirmSchemaV2 = z.object({
  lookingToMeet: atMost(meetKey, L.meetMax, 'three').refine(v => v.length >= L.meetMin, atLeastOne),
  meetOther: line(L.otherMaxLen).optional().default(null),
  hopingToFind: atMost(findKey, L.findMax, 'three').refine(v => v.length >= L.findMin, atLeastOne),
  findOther: line(L.otherMaxLen).optional().default(null),
  findSpecific: line(L.findSpecificMaxLen).optional().default(null),
  canOffer: uniqueKeys(offerKey).refine(v => v.length >= L.offerMin, atLeastOne),
  offerOther: line(L.otherMaxLen).optional().default(null),
  selfKinds: atMost(selfKey, L.selfMax, 'two').refine(v => v.length >= L.selfMin, atLeastOne),
  selfOther: line(L.otherMaxLen).optional().default(null),
  profile: profileSchema.optional().default({}),
}).strict()
  // "Something else" with no words says nothing at all.
  .superRefine((d, ctx) => {
    for (const o of OWN_WORDS) {
      if ((d[o.keys] as readonly string[]).includes(o.key) && !d[o.text]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [o.text], message: o.message });
      }
    }
  })
  // Words left in a box whose option was unticked are not an answer.
  .transform(d => ({
    ...d,
    meetOther: d.lookingToMeet.includes('meet_other') ? d.meetOther : null,
    findOther: d.hopingToFind.includes('find_other') ? d.findOther : null,
    offerOther: d.canOffer.includes('offer_other') ? d.offerOther : null,
    selfOther: d.selfKinds.includes('self_other') ? d.selfOther : null,
  }));

export type ConfirmInputV2 = z.infer<typeof confirmSchemaV2>;

/** POST linkedin: the address is checked and normalised by the service, which can say why it is refused. */
const ENTER_LINKEDIN = 'Enter your LinkedIn profile link.';
export const linkedinSchemaV2 = z.object({
  url: z.string({ required_error: ENTER_LINKEDIN, invalid_type_error: ENTER_LINKEDIN })
    .trim()
    .min(1, ENTER_LINKEDIN)
    .max(L.linkedinUrlMaxLen, `Keep this under ${L.linkedinUrlMaxLen} characters.`),
}).strict();

export const skipSchemaV2 = z.object({}).strict();
