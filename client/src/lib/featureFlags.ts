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
