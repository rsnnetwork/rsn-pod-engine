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
