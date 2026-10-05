// ─── RSN Shared Types & Contracts ────────────────────────────────────────────

export * from './types/user';
export * from './types/auth';
export * from './types/pod';
export * from './types/session';
export * from './types/match';
export * from './types/invite';
export * from './types/subscription';
export * from './types/video';
export * from './types/events';
export * from './types/api';
export * from './types/onboarding';
// Explicit named re-export alongside the `export *` above: bundlers that do
// static CJS/ESM interop (Rollup/Vite) can't see through the `__exportStar`
// runtime loop `export *` compiles to, so a real value export (OPENINGS —
// everything else here is type-only and erased, so this was never an issue
// before) needs its own statically analyzable named export to be importable
// as a value from client code. See client's onboarding truthful-state work.
// (Import-then-export, not `export {X} from`, so tsc emits a plain
// `exports.OPENINGS = ...` assignment instead of a live-binding getter —
// the getter form isn't picked up by Rollup's static CJS export detection.)
import { OPENINGS as ONBOARDING_OPENINGS } from './types/onboarding';
export const OPENINGS = ONBOARDING_OPENINGS;
export * from './onboarding/options';
// Same reason as OPENINGS above: these are real VALUES the client renders the
// whole tick-box flow from, so each needs its own statically analysable named
// export to survive Rollup's CJS interop (21 Sep 2026).
import {
  ONBOARDING_INTENTS as _INTENTS, ONBOARDING_MEET as _MEET, ONBOARDING_OFFERS as _OFFERS,
  ONBOARDING_INDUSTRIES as _INDUSTRIES, ONBOARDING_SELF_KINDS as _SELF, ONBOARDING_LIMITS as _LIMITS,
  ONBOARDING_STEPS as _STEPS, labelFor as _labelFor, shortLabelFor as _shortLabelFor,
} from './onboarding/options';
export const ONBOARDING_INTENTS = _INTENTS;
export const ONBOARDING_MEET = _MEET;
export const ONBOARDING_OFFERS = _OFFERS;
export const ONBOARDING_INDUSTRIES = _INDUSTRIES;
export const ONBOARDING_SELF_KINDS = _SELF;
export const ONBOARDING_LIMITS = _LIMITS;
export const ONBOARDING_STEPS = _STEPS;
export const labelFor = _labelFor;
export const shortLabelFor = _shortLabelFor;
export * from './types/post-event-message';
export * from './identity/displayName';
export * from './types/reason';
// Real VALUES the client renders (For You, the Human Profile), so each needs
// its own statically analysable named export, same as OPENINGS above.
import {
  MEETING_FORMATS as _MEETING_FORMATS, OUTCOME_KEYS as _OUTCOME_KEYS,
  OUTCOME_LABELS as _OUTCOME_LABELS, PERSON_RESPONSES as _PERSON_RESPONSES,
  WORTH_CONTINUING as _WORTH_CONTINUING, primaryActionFor as _primaryActionFor,
} from './types/reason';
export const MEETING_FORMATS = _MEETING_FORMATS;
export const OUTCOME_KEYS = _OUTCOME_KEYS;
export const OUTCOME_LABELS = _OUTCOME_LABELS;
export const PERSON_RESPONSES = _PERSON_RESPONSES;
export const WORTH_CONTINUING = _WORTH_CONTINUING;
export const primaryActionFor = _primaryActionFor;
