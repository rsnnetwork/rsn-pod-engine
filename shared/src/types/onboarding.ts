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
  // C2: minimum structured profile additions. All empty-safe (empty array/string,
  // false, or null) rather than guessed when the member didn't say.
  /** Languages the member speaks or wants to meet others in. */
  userLanguages: string[];
  /** One short sentence describing the problem the member solves for others. */
  problemTheySolve: string;
  /** The member's decision making authority (for example "final decision maker", "influences budget", "individual contributor"). */
  authorityLevel: string;
  /** What the member explicitly said they need help with right now (distinct from desiredOutcome). */
  needsHelpWith: string[];
  /** What the member said would make a meeting valuable to them. */
  meetingValueCriteria: string;
  /** Who the member does NOT want to be matched with, only what they actually stated. */
  restrictions: {
    noCompetitors: boolean;
    competitorNote: string | null;
    geography: string[];
    industriesToAvoid: string[];
    seniorityToAvoid: string[];
    requiredLanguages: string[];
  };
}

/** Enrichment lifecycle, as surfaced to the member (provider identity/`source` stays admin-only). */
export type OnboardingEnrichmentStatus = 'none' | 'searching' | 'found' | 'partial' | 'not_found' | 'failed';

/**
 * The enriched profile found for the member — the confirm-card prefill.
 * Typed pragmatically (shared cannot import the server's EnrichedProfile):
 * these mirror the field names the client consumes; the server may send
 * additional fields the client ignores.
 */
export interface OnboardingEnrichmentCandidate {
  fullName?: string | null;
  headline?: string | null;
  currentRole?: string | null;
  currentCompany?: string | null;
  industry?: string | null;
  location?: string | null;
  summary?: string | null;
  likelyWantsToMeet?: string[];
  likelyOffers?: string[];
  linkedinUrl?: string | null;
}

export interface OnboardingEnrichmentState {
  status: OnboardingEnrichmentStatus;
  /** Always null on the member-facing payload — the raw enrichment error is
   *  admin-only (GET /admin/inspect/users/:id/onboarding surfaces the real
   *  one). Kept in the shape for stability, never populated for members. */
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Present ONLY when status is 'found' or 'partial' — the member's own
   *  cached enriched profile, so the client can seed the confirm card. Never
   *  included on any other status. */
  candidate?: OnboardingEnrichmentCandidate;
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
  /** Saved bio / professional summary, if any (not inferred, so no guessed flag).
   *  Surfaced so a bio-only profile (no company/role saved) still prefills the
   *  confirm card's About field instead of rendering blank. */
  about: string | null;
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
