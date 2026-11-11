// ─── Session Domain Types ────────────────────────────────────────────────────

import type { EventFormat, EventVisibility } from '../events/definitions';
import type { EventPublication } from '../events/lifecycle';

export enum SessionStatus {
  SCHEDULED = 'scheduled',
  LOBBY_OPEN = 'lobby_open',
  ROUND_ACTIVE = 'round_active',
  ROUND_RATING = 'round_rating',
  ROUND_TRANSITION = 'round_transition',
  CLOSING_LOBBY = 'closing_lobby',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum ParticipantStatus {
  REGISTERED = 'registered',
  CHECKED_IN = 'checked_in',
  IN_LOBBY = 'in_lobby',
  IN_ROUND = 'in_round',
  DISCONNECTED = 'disconnected',
  REMOVED = 'removed',
  LEFT = 'left',
  NO_SHOW = 'no_show',
}

export enum SegmentType {
  LOBBY_MOSAIC = 'lobby_mosaic',
  TIMED_ONE_TO_ONE = 'timed_one_to_one',
  CLOSING_LOBBY = 'closing_lobby',
  TRANSITION = 'transition',
}

export type TimerVisibility = 'hidden' | 'always_visible' | 'last_10s' | 'last_30s' | 'last_60s' | 'last_120s';

/**
 * Phase 4 (29 April 2026 spec) — matching policy chosen at event creation.
 *
 * Per Stefan's clarification: there's no single hard-coded rule for the
 * whole platform. Different events have different purposes, so the event
 * creator picks how strict the matching engine should be.
 *
 *   'platform_wide' — strictest. If two people have ever met before
 *                     anywhere on RSN, they will never be matched again.
 *                     Good for large-scale discovery events.
 *   'within_event'  — balanced default. Pairs that already met in THIS
 *                     event won't be re-paired within this event. They
 *                     can meet again in future events.
 *   'none'          — no restriction. Anyone can be paired again, even
 *                     if they met before. Useful for smaller groups,
 *                     curated sessions, or repeat-conversation events.
 *
 * Encounter history is still tracked GLOBALLY across the platform —
 * the policy only governs how the matching engine USES that history.
 */
export type MatchingPolicy = 'platform_wide' | 'within_event' | 'none' | 'cooldown';

export interface SessionConfig {
  numberOfRounds: number;
  roundDurationSeconds: number;
  lobbyDurationSeconds: number;
  transitionDurationSeconds: number;
  ratingWindowSeconds: number;
  closingLobbyDurationSeconds: number;
  noShowTimeoutSeconds: number;
  maxParticipants: number;
  timerVisibility: TimerVisibility;
  /**
   * Phase 4 — see MatchingPolicy for the three options. Optional for
   * backwards compatibility with existing sessions; if absent the engine
   * treats the session as `'within_event'` (the new default).
   */
  matchingPolicy?: MatchingPolicy;
  /**
   * Phase 2 (matching) — for matchingPolicy='cooldown', how many months a pair
   * stays un-rematchable after meeting. Older pairs become eligible again (with
   * a freshness penalty). Defaults to 12 when absent.
   */
  cooldownMonths?: number;
  /**
   * Phase 3 (1 May spec) — pluggable matching engine. Each event picks
   * which algorithm to use. Speed-networking events use
   * 'speed_networking_v1' (the default Engine V1.0). Future event types
   * (roundtable, mentorship, etc.) self-register their own engine in
   * server matching.registry.ts and pick a different ID here.
   */
  matchingAlgorithmId?: string;
  /**
   * Bug 28 (19 May Ali + Stefan) — count of "Another Round" presses that
   * extended the event past its originally-configured numberOfRounds.
   * Stefan called these "bonus rounds". UI uses this to:
   *   • render a small "Bonus" badge on the round header for any round
   *     beyond (numberOfRounds - bonusRoundsAdded)
   *   • report the total honestly in the recap ("3 rounds + 1 bonus")
   * Default 0; bumped by +1 every successful "Another Round" click.
   */
  bonusRoundsAdded?: number;
  /**
   * 26 Oct 2026 — a meeting-kind event's length in minutes (a video meeting's "Length"). Its calendar
   * entry, invite emails and LiveKit token lifetime follow it. Never filtered, so it lives here, not in a column.
   */
  durationMinutes?: number;
  /**
   * 30 Oct 2026 — where an in-person event happens: an address or a venue, trimmed, at most 300 characters
   * (the format's "Where" field). Shown and mailed as typed; never filtered, so it lives here, not in a column.
   */
  location?: string;
  /**
   * The event's format as production's old form sends it. Since 26 Oct 2026 the server keeps it equal to
   * the stored format (sessions.event_format), so a copy the old form makes keeps the format.
   */
  eventType?: string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  numberOfRounds: 5,
  roundDurationSeconds: 480,         // 8 minutes
  lobbyDurationSeconds: 480,         // 8 minutes
  transitionDurationSeconds: 30,     // 30 seconds
  // F5 (21 May Ali) — bumped 10 → 30. 10 s was too short for users to
  // read the form, pick stars + connect toggle, and submit; live test
  // (21 May) had users repeatedly miss the form because the timer
  // expired mid-click. 30 s is paired with the trio doubling
  // (round-lifecycle.ts: scaledDuration = base × maxPartnerCount), so
  // pairs get 30 s, trios get 60 s. The early-exit-when-all-rated
  // safety net still fires, so this is the ceiling not the floor —
  // empirically rated within 5–10 s the round still ends fast.
  ratingWindowSeconds: 30,
  closingLobbyDurationSeconds: 480,  // 8 minutes
  noShowTimeoutSeconds: 60,          // 60 seconds
  maxParticipants: 500,
  timerVisibility: 'last_10s' as TimerVisibility,
  matchingPolicy: 'within_event',
  matchingAlgorithmId: 'speed_networking_v1',
};

/**
 * Phase G (10 May 2026 spec item 11) — host/co-host visibility mode.
 * Controls how a host or co-host renders in the lobby/breakout video grid.
 *  • big_speaker — pinned as the big tile
 *  • normal      — regular participant tile (default)
 *  • producer    — not visible in any video tile (off-camera operator)
 *  • hidden      — not rendered anywhere (off-stage organiser)
 *
 * Mirrors the Postgres `host_visibility_mode` enum (migration 059).
 */
export type HostVisibilityMode = 'big_speaker' | 'normal' | 'producer' | 'hidden';
export const HOST_VISIBILITY_MODES: readonly HostVisibilityMode[] = [
  'big_speaker', 'normal', 'producer', 'hidden',
] as const;
export function isHostVisibilityMode(v: unknown): v is HostVisibilityMode {
  return typeof v === 'string' && (HOST_VISIBILITY_MODES as readonly string[]).includes(v);
}

export interface Session {
  id: string;
  podId: string;
  title: string;
  description: string | null;
  scheduledAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  status: SessionStatus;
  currentRound: number;
  config: SessionConfig;
  hostUserId: string;
  lobbyRoomId: string | null;
  hostVisibilityMode?: HostVisibilityMode;
  /** 26 Oct 2026 — what the event is (speed networking, a video meeting…); sessions.event_format. */
  format?: EventFormat;
  /** T11 (1 Nov 2026) — who can join (sessions.visibility). NULL: the event follows its pod, as before. */
  visibility?: EventVisibility | null;
  /** T13 (1 Nov 2026) — the circle the event is for (sessions.circle_id); its members are the event's audience too. NULL: none. */
  circleId?: string | null;
  /** Part 2 Task 2 — 'draft' (seen only by the people who run it) or 'published' (every existing event). */
  publication?: EventPublication;
  /** When it was first published; null for a draft and for events made before drafts existed. */
  publishedAt?: Date | null;
  /** Registration opens at this time; null: as soon as it is published. */
  registrationOpensAt?: Date | null;
  /** Put away after it ended or was cancelled: out of the default lists. */
  archivedAt?: Date | null;
  /** When it was cancelled, and the organiser's reason, if they gave one. */
  cancelledAt?: Date | null;
  cancelReason?: string | null;
  /**
   * Part 3 Task 1 (K1) — the IANA zone every time of the event is written in (sessions.timezone): bells, emails and
   * screens print its wall clock and name it. Existing events took their host's zone, else UTC.
   */
  timezone: string;
  /** Part 3 Task 1 — the event's image (absolute, with ?v= its last change), or null when it has none. */
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionParticipant {
  id: string;
  sessionId: string;
  userId: string;
  status: ParticipantStatus;
  joinedAt: Date | null;
  leftAt: Date | null;
  currentRoomId: string | null;
  isNoShow: boolean;
  roundsCompleted: number;
}

/**
 * The settings a create or edit may send: stored settings, plus the round length in minutes as the event
 * forms hold it (the server stores it as `roundDurationSeconds`).
 */
export type SessionConfigInput = Partial<SessionConfig> & {
  roundMinutes?: number;
  matchingTemplateId?: string;
};

export interface CreateSessionInput {
  podId: string;
  title: string;
  description?: string;
  scheduledAt: string;  // ISO date string
  /**
   * 26 Oct 2026 — checked against the pod's type. Production's old form omits it: the server then reads an
   * offered `config.eventType` (option O1), else speed networking.
   */
  format?: EventFormat;
  /** T11 (1 Nov 2026) — who can join. Production's form omits it: the event then follows its pod (NULL). */
  visibility?: EventVisibility;
  /**
   * T13 (1 Nov 2026) — an event for a whole circle: its managers (and admins) may name it. The event still lives in
   * the pod; with no visibility it is private (the circle). Production's form omits it: no circle, as before.
   */
  circleId?: string;
  /** Part 2 Task 2 — 'draft' keeps it to the people who run it until it is published. Omitted: published, as today. */
  publication?: EventPublication;
  /** Part 2 Task 2 — registration opens at this ISO time; omitted or null: as soon as it is published. */
  registrationOpensAt?: string | null;
  /**
   * Part 3 Task 1 — the event's IANA zone. Omitted (production's form): the host's own zone when it is real, else UTC.
   * scheduledAt stays an instant: the form converts its wall clock in this zone before sending.
   */
  timezone?: string;
  config?: SessionConfigInput;
}

export interface UpdateSessionInput {
  title?: string;
  description?: string;
  scheduledAt?: string;
  /** 26 Oct 2026 — a scheduled event may switch to another format its pod holds. */
  format?: EventFormat;
  /** T11 (1 Nov 2026) — who can join; a scheduled event may change it. Going private removes nobody. */
  visibility?: EventVisibility;
  /** T13 (1 Nov 2026) — set (a circle's manager) or clear (null) the circle the event is for. */
  circleId?: string | null;
  /** Part 3 Task 1 — a new zone. The stored instant is kept: the server never reinterprets scheduledAt. */
  timezone?: string;
  config?: SessionConfigInput;
}

/** T13 (1 Nov 2026) — the circle an event is for, as GET /sessions/:id names it (additive). */
export interface SessionCircle {
  id: string;
  name: string;
}

export interface SessionSegment {
  segmentType: SegmentType;
  roundNumber: number | null;
  durationSeconds: number;
  startedAt: Date | null;
  endsAt: Date | null;
}

// ─── Host Control Types ─────────────────────────────────────────────────────

export interface HostBroadcast {
  sessionId: string;
  message: string;
  fromUserId: string;
  sentAt: Date;
}

export interface HostReassignment {
  sessionId: string;
  roundNumber: number;
  participantId: string;
  newPartnerId: string | null;
  reason: string;
}

// ─── Admission per event (Part 2, Task 4, 10 Nov 2026) ──────────────────────
//
// Who gets a place, beside who sees the event (sessions.visibility). NULL (every event made before) keeps today's rules
// exactly. The server decides from it (server/src/services/session/event-access.ts); the link alone never grants a
// place on an event that is not open.

/** sessions.admission_mode: open (any active account), approval (outsiders request), restricted ("Invitation only"). */
export type AdmissionMode = 'open' | 'approval' | 'restricted';

/** The three, in the order an organiser's form offers them. */
export const ADMISSION_MODES: readonly AdmissionMode[] = ['open', 'approval', 'restricted'] as const;

/**
 * What decides a place on an event today: its own admission mode, or, with none, the T11 rules for members
 * (`members_only`, an event with its own visibility) or its pod's rules (`pod_rules`, an event with neither).
 */
export type EffectiveAdmission = AdmissionMode | 'members_only' | 'pod_rules';

/** session_participants.admitted_via: what gave a place on an event with an admission mode (NULL: given before one). */
export type AdmittedVia = 'open' | 'approval' | 'invite' | 'allow_list' | 'code' | 'audience' | 'admin';

/** GET /sessions/:id/admission (the event's organisers). */
export interface EventAdmissionOverview {
  mode: AdmissionMode | null;
  effective: EffectiveAdmission;
  counts: { listed: number; registered: number; codesUnused: number; codesUsed: number };
}

/** One allowed email as the organisers' list shows it. `registered`: the address belongs to someone holding a place. */
export interface AdmissionEntryRow {
  id: string;
  email: string;
  groupKey: string | null;
  status: 'listed' | 'registered' | 'revoked';
  displayName: string | null;
}

/** POST /sessions/:id/admission/emails. `invalid` holds at most 50 examples. */
export interface AddAdmissionEmailsResult {
  added: number;
  alreadyListed: number;
  restored: number;
  invalid: string[];
}

/** One admission code as the organisers' list shows it: never the code itself, only its last four symbols. */
export interface AdmissionCodeRow {
  id: string;
  last4: string;
  label: string | null;
  groupKey: string | null;
  status: 'unused' | 'used' | 'revoked' | 'expired';
  redeemedBy: { id: string; displayName: string } | null;
}

/** A code as generated: the only time its plaintext is ever sent (`XXXX-XXXX-XXXX`). */
export interface GeneratedAdmissionCode {
  id: string;
  code: string;
}

// ─── The waiting list (10 Nov 2026 spec, Part 3 Task 3; plan K3) ─────────────
//
// A full event (sessions.config.maxParticipants places held by anyone but its host and co-hosts) puts the next eligible
// person on its waiting list; the first in line is given the next place that frees. The list is its own table
// (event_waitlist), never a participant status, so nobody waiting is matched, admitted, reminded or counted.

/** How a person reached the line: the event page, the RSN Call link, an approved request, an accepted invite. */
export type WaitlistJoinedVia = 'register' | 'call_link' | 'approval' | 'invite';

/** event_waitlist.status. */
export type WaitlistStatus = 'waiting' | 'promoted' | 'left' | 'removed' | 'lapsed';

/**
 * The additive `access.waitlist` block on GET /sessions/:id: whether the event is full, and this person's place in the
 * line (1 = next). Attendees are never told how many places or people there are.
 */
export interface EventWaitlistAccess {
  full: boolean;
  position: number | null;
}

/** One person on the line, as the event's organisers see it (GET /sessions/:id/waitlist). */
export interface WaitlistEntryCard {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  position: number;
  queuedAt: string;
  joinedVia: WaitlistJoinedVia;
  accountKind: 'member' | 'event_guest';
}

/** POST /sessions/:id/register with `waitlist: true` on a full event: 202 and this. */
export interface WaitlistedRegistration {
  waitlisted: true;
  position: number;
}
