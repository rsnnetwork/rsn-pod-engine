// Client feature flags. Flip a value and redeploy (Vercel) to toggle — these are
// pure UI gates, not stored on any event, so a change applies to ALL events
// immediately (including already-scheduled ones).

// BACKGROUND_EFFECTS_ENABLED — master kill-switch for in-call virtual
// backgrounds (blur / image). The processor itself is heavily tuned to stay
// light and self-disable on weak devices (see lib/backgroundEffects.ts and
// lib/bgFrameHealth.ts), and the UI is additionally gated at runtime on
// supportsModernBackgroundProcessors(). Set to `false` to hard-hide the feature
// everywhere without a code change if it ever needs an emergency disable.
export const BACKGROUND_EFFECTS_ENABLED = true;

// BG_NOFLASH_TRANSFORMER — Bug④ (2026-06-08). On the MODERN-API path (desktop),
// build the background pipeline from the vendored transformer
// (lib/bgNoFlashTransformer): identical to stock (same proven category mask)
// EXCEPT it drops the first-frame raw-clone enqueue, so applying a background
// no longer briefly flashes the user's real room. Mobile / canvas fallback /
// flag-off keep the stock BackgroundProcessor. Flip to false to instantly
// revert to stock everywhere. (Confidence-mask feathered edges were prototyped
// and parked — the library shader composites them inverted; see the transformer
// header. Edge quality stays at the stock model's level until a shader fork.)
export const BG_NOFLASH_TRANSFORMER = true;
