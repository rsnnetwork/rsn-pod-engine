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
