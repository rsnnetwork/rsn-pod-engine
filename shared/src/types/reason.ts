// ─── REASON milestone 1 (29 Sep 2026) ────────────────────────────────────────
// Shared by the server (validation, payloads) and the client (For You, the
// Human Profile). The VALUES here are rendered by the client, so index.ts also
// gives each its own named re-export (Rollup CJS interop; see OPENINGS there).

import type { PublicMember } from './user';
import type { PersonEntity } from './entity';

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
/**
 * Where a meeting request (user_pokes.status) stands. 'cancelled' is a request its sender withdrew (migration 132):
 * it reads as no request at all, never as a "no", so the sender may ask again.
 */
export type MeetingRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type RelationshipState = 'none' | 'requested' | 'incoming' | 'declined' | 'connected' | 'met';
export type PrimaryAction = 'meet' | 'requested' | 'respond' | 'declined' | 'continue';

export const MEETING_FORMATS: ReadonlyArray<{ key: MeetingFormat; label: string }> = [
  { key: 'video_20', label: '20 minute video conversation' },
  { key: 'coffee', label: 'In person coffee' },
  { key: 'message_first', label: 'Message first' },
];

// The longest note a member may add to a Meet request. It stops short of the request's whole
// message cap (REQUEST_MESSAGE_MAX on the server) so REASON's own reason still fits after it.
// The route validates against it and the Meet sheet counts against it: one number, two readers.
export const MEET_NOTE_MAX = 300;

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

/**
 * A meeting request's two texts, kept apart (30 Oct 2026): what the member wrote, and REASON's own line
 * on why it suggested the two. Either may be missing. The request's older `message` field still carries
 * the two run together, for the clients that read only that.
 */
export interface MeetingRequestText {
  note: string | null;
  reasonLine: string | null;
}

/** Why the viewer may not message a person, from the same rule as GET /dm/can-message/:userId. */
export type MessageRefusal = 'self' | 'blocked' | 'not_mutual' | 'no_encounter';

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
    /** The viewer marked this person "Already met" (outside the platform). Private to the viewer; changes no state. */
    alreadyMet: boolean;
    outcomes: Array<{ worthContinuing: WorthContinuing; outcomes: OutcomeKey[]; createdAt: string }>;
  };
  shared: {
    circles: Array<{ id: string; name: string }>;
    pods: Array<{ id: string; name: string }>;
    upcomingEvents: Array<{ id: string; title: string; scheduledAt: string }>;
  };
  path: { id: string; displayName: string } | null;
  /** The person's own entities (their company, fund…) with their role and title in each (21 Oct 2026). */
  entities: PersonEntity[];
  /** Whether the viewer may message them now, by the rule GET /dm/can-message/:userId applies (30 Oct 2026). */
  canMessage: boolean;
  /** Why not, when canMessage is false; null when it is true. */
  canMessageReason: MessageRefusal | null;
  /**
   * The viewer may ring this person for a video call now (1 Nov 2026): the two are connected, neither has blocked
   * the other, and both are members. Whether they are online is asked when the call is rung. Every server from then
   * on sends it; optional so a branch whose server predates it still compiles, and a screen reads a missing one as no.
   */
  canCall?: boolean;
}

// ─── A profile's Communities (Shirley pilot S3, RSN 14) ──────────────────────
// GET /people/:userId/communities and GET /people/me/communities (the preview). The circles and pods a person is in
// that the viewer may see: a space anyone may discover (an open circle, a Public with approval or Public open pod), or
// one the viewer is in with them. A private pod or a closed circle the viewer is not in is never named. Nothing at all
// for a person who turned "Show my communities on my profile" off or is hidden from search, and a 404 (as for an
// unknown member) when either has blocked the other. The server decides every row and its action; the screen draws them.

/** The person's own role in the space: the organisers' roles (owner, moderator; director, host), or member. */
export type ProfileCommunityRole = 'owner' | 'moderator' | 'director' | 'host' | 'member';

/**
 * Who may get in: 'open' (an open circle or a Public open pod: join at once), 'approval' (a Public with approval pod:
 * ask, the director decides), 'members' (a closed circle or a private pod, listed only because the viewer is in it).
 */
export type ProfileCommunityAccess = 'open' | 'approval' | 'members';

/**
 * What the viewer can do from the row, by the space's own rules (Shirley pilot S2's removal rules included):
 * 'open' (they are in it), 'join', 'request', 'pending' (their ask waits), 'none' (nothing: an organiser removed them
 * from a space people join at once).
 */
export type ProfileCommunityAction = 'open' | 'join' | 'request' | 'pending' | 'none';

export interface ProfileCommunity {
  kind: 'circle' | 'pod';
  id: string;
  name: string;
  role: ProfileCommunityRole;
  access: ProfileCommunityAccess;
  action: ProfileCommunityAction;
  /** A pod whose director set rules to agree to before asking: the ask is made on the pod's page, where they are shown. */
  hasJoinRules: boolean;
}

/** Why your own preview lists nothing although you are in spaces: only ever sent to the member about themselves. */
export type ProfileCommunitiesHidden = 'setting_off' | 'hidden_from_search';

export interface ProfileCommunities {
  items: ProfileCommunity[];
  /** Every row the viewer may see, of which `items` is one page. */
  total: number;
  /** The offset of the next page, or null when this page is the last. */
  nextOffset: number | null;
  /** Your own preview only: why nothing is shown. Never sent about anyone else. */
  hidden?: ProfileCommunitiesHidden | null;
}

export interface RecentConnection {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  connectedAt: string;
}

// ─── Your connections (21 Oct 2026) ──────────────────────────────────────────
// GET /people/connections: everyone the member is connected to or has met, one row per person,
// newest first (client feedback, 19 Oct: "On the People page, show the user's own connections first").

/** Met (at an event, or in a 1:1 meeting both joined) wins over connected (an accepted request, or a conversation). */
export type ConnectionHow = 'connected' | 'met';

export interface PersonConnection {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  how: ConnectionHow;
  /** The latest date of anything between the two (a request accepted, a conversation started, a meeting), ISO. */
  since: string;
}

/** One person on the Everyone list: the public card, and where a meeting request and the relationship stand. */
export type EveryoneMember = PublicMember & {
  pokeStatus: 'pending' | 'accepted' | null;
  pokeSentByOwner: boolean | null;
  relationship: RelationshipState;
  /** The viewer marked this person "Already met" (outside the platform). Private to the viewer. */
  alreadyMet: boolean;
};

export interface EveryonePage {
  people: EveryoneMember[];
  /** Ask again with ?cursor= this for the next people; null when there are no more. */
  nextCursor: string | null;
}

export interface ConnectionList {
  items: PersonConnection[];
  /** Ask again with ?before= this for the next people; null when there are no more. */
  nextBefore: string | null;
}
