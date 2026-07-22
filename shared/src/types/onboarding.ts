// ─── Onboarding Domain Types (REASON intent capture) ─────────────────────────
//
// Contracts for the onboarding chatbot: a calm "host" conversation that extracts
// who you want to meet, why, and who you are — then saves it as structured
// intent on the profile. Zod validation for the extraction call lives server-side
// (shared has no zod dependency); these are the plain type contracts both ends
// share.

/**
 * Enrichment lifecycle as surfaced to the member (mirrors the server-side
 * EnrichmentStatus, collapsed at the boundary — see `openingFromEnrichment`
 * mapping in the status route: none/not_found/failed all read as not_found).
 */
export type OnboardingOpening = 'searching' | 'found' | 'partial' | 'not_found';

/**
 * The host's opening line for each enrichment state — server-derived and
 * client-rendered verbatim (instant, no latency) as the chatbot's first
 * message. Exact product-spec wording; do not edit.
 */
export const OPENINGS = {
  searching: 'I am retrieving your public profile. This normally takes less than a minute.',
  found: 'I found your profile. Let me confirm what I understand about you.',
  partial: 'I found part of your profile, but I need your help filling the gaps.',
  not_found: 'I could not reliably identify your profile. Let us build it together.',
} as const satisfies Record<OnboardingOpening, string>;

/** Lifecycle of a user's onboarding conversation. Mirrors the SQL enum in 069. */
export type OnboardingStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'needs_review'
  | 'update_required';

/** A single turn in the onboarding host conversation. */
export interface OnboardingMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** How strong/usable the captured intent is — drives weak-profile handling. */
export type ProfileStrength = 'strong' | 'weak';

/** How strongly to prioritise this member in matching (derived from clarity/urgency). */
export type MatchPriority = 'high' | 'medium' | 'low';

/**
 * Structured intent extracted from the onboarding conversation (canvas §18/§32).
 * This is the contract the matching layer will read; the DB stores it as the
 * JSONB `matching_intent` blob plus a few promoted columns. Kept intentionally
 * flexible — the profile is expected to grow many more attributes over time.
 */
export interface OnboardingIntent {
  // Who they want to meet
  desiredPeople: string[];
  desiredRoles: string[];
  desiredSeniority: string[];
  desiredStage: string[];
  desiredIndustries: string[];
  // Why
  reasonForMeeting: string;
  desiredOutcome: string;
  // Who the user is
  userProfileSummary: string;
  userRole: string;
  userCompany: string | null;
  userIndustry: string | null;
  userLocation: string | null;
  userExpertise: string[];
  userCanOffer: string[];
  userInterests: string[];
  userCity: string | null;
  // Round B: richer matching dimensions
  /** Who the member would be valuable to (Q4). */
  userValuableTo: string[];
  /** People the member would like to invite (Q6, names/handles only; no send). */
  suggestedInvitees: string[];
  /** What the member is focused on right now. */
  currentFocus: string;
  /** How strongly to prioritise this member in matching. */
  matchPriority: MatchPriority;
  // Phase 2: structured designation categories (cleaner than free-text role).
  /** The member's own designation bucket (founder/investor/ceo/advisor/...). */
  userDesignation: string;
  /** Structured designations the member wants to meet. */
  desiredDesignations: string[];
  /** Structured designations the member would rather avoid. */
  avoidDesignations: string[];
  // Guardrails + matching signals
  avoidPreferences: string[];
  privacyRecommendation: string;
  matchingTags: string[];
  embeddingText: string;
  confidenceScores: Record<string, number>;
  profileStrength: ProfileStrength;
}

/** Enrichment lifecycle, as surfaced to the member (provider identity/`source` stays admin-only). */
export type OnboardingEnrichmentStatus = 'none' | 'searching' | 'found' | 'partial' | 'not_found' | 'failed';

export interface OnboardingEnrichmentState {
  status: OnboardingEnrichmentStatus;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** GET /onboarding/status */
export interface OnboardingStatusResponse {
  status: OnboardingStatus;
  enrichment: OnboardingEnrichmentState;
  opening: OnboardingOpening;
}

/** POST /onboarding/chat — one host turn. */
export interface OnboardingChatRequest {
  messages: OnboardingMessage[];
}

export interface OnboardingChatResponse {
  reply: string;
  /** true once the host has summarized and is ready to confirm + save. */
  ready: boolean;
}

/** POST /onboarding/confirm — runs extraction, saves, flips the gate. */
export interface OnboardingConfirmRequest {
  messages: OnboardingMessage[];
}

export interface OnboardingConfirmResponse {
  summary: string;
  profileComplete: boolean;
}

// ─── v1.1: known-data confirmation ───────────────────────────────────────────

/** What the system already knows or can infer about the member (GET /onboarding/known). */
export interface OnboardingKnownProfile {
  name: string | null;
  firstName: string | null;
  /** true when the name was derived from the email (no saved name yet). */
  nameGuessed: boolean;
  email: string;
  country: string | null;
  /** true when country came from an IP geo guess (not a saved value). */
  countryGuessed: boolean;
  company: string | null;
  /** true when company was inferred from the email domain (not a saved value). */
  companyGuessed: boolean;
  /** Saved role / job title, if any (Round B; not inferred, so no guessed flag). */
  role: string | null;
  /** Saved LinkedIn URL, if any (Round B). */
  linkedin: string | null;
  /** The member's stated reason for joining (from their join request), if any. */
  reason: string | null;
  /** How many past Reason events the member has joined (0 for new members). */
  previousEvents: number;
  /** Who invited this member (inviter's name or email), if they joined via an invite. */
  invitedBy: string | null;
}

/** The member-confirmed basics, sent back on chat/confirm so the host never re-asks. */
export interface OnboardingConfirmedProfile {
  name?: string | null;
  firstName?: string | null;
  country?: string | null;
  company?: string | null;
  role?: string | null;
  linkedin?: string | null;
}

/** GET /onboarding/resume — lets a member continue an in-progress onboarding. */
export interface OnboardingResume {
  status: OnboardingStatus;
  messages: OnboardingMessage[];
}
