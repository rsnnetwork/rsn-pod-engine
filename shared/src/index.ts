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
export * from './types/post-event-message';
export * from './identity/displayName';
