// ─── REASON milestone 1 (29 Sep 2026) ────────────────────────────────────────
// Shared by the server (validation, payloads) and the client (For You, the
// Human Profile). The VALUES here are rendered by the client, so index.ts also
// gives each its own named re-export (Rollup CJS interop; see OPENINGS there).

import type { PublicMember } from './user';

// What a member can do with a person (Save = maybe later, Pass = not relevant).
// The routes and the client read this list. The CHECK in migration 101 is the same
// list written out, and migration-101.test.ts fails if the two ever differ.
export const PERSON_RESPONSES = ['saved', 'passed'] as const;
export type PersonResponse = (typeof PERSON_RESPONSES)[number];

// "Was it worth continuing?", asked after two people have met.
export const WORTH_CONTINUING = ['yes', 'maybe', 'no'] as const;
export type WorthContinuing = (typeof WORTH_CONTINUING)[number];

export type MeetingFormat = 'video_20' | 'coffee' | 'message_first';
export type MatchStrength = 'strong' | 'close';
export type RelationshipState = 'none' | 'requested' | 'incoming' | 'declined' | 'connected' | 'met';
export type PrimaryAction = 'meet' | 'requested' | 'respond' | 'declined' | 'continue';

export const MEETING_FORMATS: ReadonlyArray<{ key: MeetingFormat; label: string }> = [
  { key: 'video_20', label: '20 minute video conversation' },
  { key: 'coffee', label: 'In person coffee' },
  { key: 'message_first', label: 'Message first' },
];

// Foundation S10, "What came from the conversation?"
export const OUTCOME_KEYS = [
  'follow_up', 'introduction', 'potential_customer', 'potential_partnership',
  'advice', 'investment', 'hiring', 'friendship', 'nothing_yet',
] as const;
export type OutcomeKey = (typeof OUTCOME_KEYS)[number];

export const OUTCOME_LABELS: Record<OutcomeKey, string> = {
  follow_up: 'Follow up',
  introduction: 'Introduction',
  potential_customer: 'Potential customer',
  potential_partnership: 'Potential partnership',
  advice: 'Advice',
  investment: 'Investment',
  hiring: 'Hiring',
  friendship: 'Friendship',
  nothing_yet: 'Nothing yet',
};

// Only compiles while every RelationshipState has a case in primaryActionFor, because
// the state reaching it is then `never`. A state this build does not know (a newer
// server) still gets the Meet button, which is what the old default gave.
function unlistedState(_state: never): PrimaryAction {
  return 'meet';
}

/** What the main button on a person offers, given where the relationship stands. */
export function primaryActionFor(state: RelationshipState): PrimaryAction {
  switch (state) {
    case 'none': return 'meet';
    case 'requested': return 'requested';
    case 'incoming': return 'respond';
    case 'declined': return 'declined';
    case 'connected':
    case 'met': return 'continue';
    default: return unlistedState(state);
  }
}

export interface PersonBrief {
  person: PublicMember;
  match: { reason: string; strength: MatchStrength } | null;
  /** The person's own public offer ("what I can help with"). */
  theyCanBring: string | null;
  /** The VIEWER's own want. Never the other person's (those stay private). */
  youAreLookingFor: string | null;
  opener: string;
  relationship: {
    state: RelationshipState;
    pokeId: string | null;
    timesMet: number;
    lastMetAt: string | null;
    saved: boolean;
    passed: boolean;
    outcomes: Array<{ worthContinuing: WorthContinuing; outcomes: OutcomeKey[]; createdAt: string }>;
  };
  shared: {
    circles: Array<{ id: string; name: string }>;
    pods: Array<{ id: string; name: string }>;
    upcomingEvents: Array<{ id: string; title: string; scheduledAt: string }>;
  };
  path: { id: string; displayName: string } | null;
}

export interface RecentConnection {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  connectedAt: string;
}
