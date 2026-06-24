// ─── Onboarding Domain Types (REASON intent capture) ─────────────────────────
//
// Contracts for the onboarding chatbot: a calm "host" conversation that extracts
// who you want to meet, why, and who you are — then saves it as structured
// intent on the profile. Zod validation for the extraction call lives server-side
// (shared has no zod dependency); these are the plain type contracts both ends
// share.

/**
 * The host's fixed opening line. Rendered client-side (instant, no latency) and
 * referenced in the server host prompt so the model never repeats it.
 */
export const ONBOARDING_OPENING_LINE =
  "We believe you're here for a reason — do you mind sharing that reason with us?";

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
  // Guardrails + matching signals
  avoidPreferences: string[];
  privacyRecommendation: string;
  matchingTags: string[];
  embeddingText: string;
  confidenceScores: Record<string, number>;
  profileStrength: ProfileStrength;
}

/** GET /onboarding/status */
export interface OnboardingStatusResponse {
  status: OnboardingStatus;
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
  /** How many past Reason events the member has joined (0 for new members). */
  previousEvents: number;
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
