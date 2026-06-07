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

// BG_CONFIDENCE_MASK — Bug④ (2026-06-08). On the MODERN-API path (desktop),
// build the background pipeline from the vendored confidence-mask transformer
// (lib/bgConfidenceTransformer): true 0..1 per-pixel edges instead of the
// hard category mask the shader has to fake-soften (which bleeds the real room
// in around the body), plus no first-frame raw flash on apply. Mobile / canvas
// fallback / flag-off keep the proven stock BackgroundProcessor. Flip to false
// to instantly revert to stock everywhere if the confidence path regresses.
export const BG_CONFIDENCE_MASK = true;
