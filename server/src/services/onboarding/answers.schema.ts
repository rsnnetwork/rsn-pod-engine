// ─── Tick-box answer validation ──────────────────────────────────────────────
//
// The vocabulary comes from shared, so what the client shows and what the
// server accepts are the same list by construction: a key the flow cannot
// display is a key this will not accept.

import { z } from 'zod';
import {
  ONBOARDING_INTENTS, ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INDUSTRIES,
  ONBOARDING_LIMITS, ONBOARDING_STEPS,
} from '@rsn/shared';

const keysOf = <T extends readonly { key: string }[]>(list: T) =>
  list.map(o => o.key) as [string, ...string[]];

const intentKey = z.enum(keysOf(ONBOARDING_INTENTS));
const meetKey = z.enum(keysOf(ONBOARDING_MEET));
const offerKey = z.enum(keysOf(ONBOARDING_OFFERS));
const industryKey = z.enum(keysOf(ONBOARDING_INDUSTRIES));

/** Typed text: trimmed, control characters stripped, capped. Empty becomes null. */
const line = (max: number) =>
  z.string()
    .transform(s => s.replace(/[\u0000-\u001F\u007F]/g, '').trim())
    .refine(s => s.length <= max, { message: `Keep this under ${max} characters` })
    .transform(s => (s.length ? s : null))
    .nullable();

/** A set, not a list: order carries no meaning and duplicates are not answers. */
const uniqueKeys = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).transform(v => [...new Set(v)] as z.infer<T>[]);

/**
 * A partial answer, saved as the member moves through the steps. Every field
 * is optional because the draft is written before the flow is finished — but
 * an unknown KEY is still refused, so a half-finished draft can never hold a
 * value the confirm step would later reject.
 */
export const draftSchema = z.object({
  intent: intentKey.optional(),
  lookingToMeet: uniqueKeys(meetKey)
    .refine(v => v.length <= ONBOARDING_LIMITS.meetMax, { message: `Pick up to ${ONBOARDING_LIMITS.meetMax}` })
    .optional(),
  canOffer: uniqueKeys(offerKey).optional(),
  industries: uniqueKeys(industryKey).optional(),
  industryOther: line(ONBOARDING_LIMITS.otherMaxLen).optional(),
  selfKinds: uniqueKeys(meetKey)
    .refine(v => v.length <= ONBOARDING_LIMITS.selfMax, { message: `Pick up to ${ONBOARDING_LIMITS.selfMax}` })
    .optional(),
  jobTitle: line(ONBOARDING_LIMITS.roleMaxLen).optional(),
  company: line(ONBOARDING_LIMITS.companyMaxLen).optional(),
  about: line(ONBOARDING_LIMITS.aboutMaxLen).optional(),
  step: z.enum(ONBOARDING_STEPS as unknown as [string, ...string[]]).optional(),
}).strict();

export type DraftInput = z.infer<typeof draftSchema>;

/**
 * The finished set. Sent whole, so confirming never depends on whether the
 * last draft save happened to land.
 */
export const confirmSchema = z.object({
  intent: intentKey,
  lookingToMeet: uniqueKeys(meetKey)
    .refine(v => v.length >= ONBOARDING_LIMITS.meetMin, { message: 'Pick at least one' })
    .refine(v => v.length <= ONBOARDING_LIMITS.meetMax, { message: `Pick up to ${ONBOARDING_LIMITS.meetMax}` }),
  canOffer: uniqueKeys(offerKey).refine(v => v.length >= ONBOARDING_LIMITS.offersMin, { message: 'Pick at least one' }),
  industries: uniqueKeys(industryKey).refine(v => v.length >= ONBOARDING_LIMITS.industriesMin, { message: 'Pick at least one' }),
  industryOther: line(ONBOARDING_LIMITS.otherMaxLen).optional().default(null),
  selfKinds: uniqueKeys(meetKey)
    .refine(v => v.length >= ONBOARDING_LIMITS.selfMin, { message: 'Pick at least one' })
    .refine(v => v.length <= ONBOARDING_LIMITS.selfMax, { message: `Pick up to ${ONBOARDING_LIMITS.selfMax}` }),
  jobTitle: line(ONBOARDING_LIMITS.roleMaxLen).optional().default(null),
  company: line(ONBOARDING_LIMITS.companyMaxLen).optional().default(null),
  about: line(ONBOARDING_LIMITS.aboutMaxLen).optional().default(null),
})
  // Free text for "Other" is only meaningful when Other was ticked, and is
  // required then — otherwise that member has told us no industry at all.
  .refine(d => !d.industries.includes('other') || !!d.industryOther, {
    message: 'Tell us which industry', path: ['industryOther'],
  })
  .refine(d => d.industries.includes('other') || !d.industryOther, {
    message: 'Tick Other to add your own industry', path: ['industryOther'],
  });

export type ConfirmInput = z.infer<typeof confirmSchema>;

export const tourSchema = z.object({
  outcome: z.enum(['completed', 'skipped']),
  lastCard: z.number().int().min(1).max(4).optional(),
}).strict();
