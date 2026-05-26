// Client feature flags. Flip a value and redeploy (Vercel) to toggle — these are
// pure UI gates, not stored on any event, so a change applies to ALL events
// immediately (including already-scheduled ones).

// BACKGROUND_EFFECTS_ENABLED — the in-call virtual-background / blur ("BG" button)
// in the main room and breakout rooms, plus the auto-re-apply of a saved
// preference on camera publish.
//
// Disabled for live events: MediaPipe segmentation runs per video frame on the
// participant's OWN machine and can pin the CPU/GPU and hang the browser on
// weaker laptops mid-event — and attendee hardware can't be QA'd in advance.
// Gating both the button AND the auto-apply means a returning user with a saved
// background also won't silently spin it back up. Flip to `true` and redeploy to
// restore the feature.
export const BACKGROUND_EFFECTS_ENABLED = false;
