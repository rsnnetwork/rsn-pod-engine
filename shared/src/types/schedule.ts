// ─── The matching board (10 Nov 2026 spec, Part 2 Task 8; sections 06, 07, 12) ─────────────────────────────
//
// An organiser's private draft of who meets whom in each round of an event. The server answers every read and
// write with the whole board, worked out from the stored seats: the basket (people of a round without a seat) is
// never stored, so no write can lose anyone. Every write names the `revision` it was made against; a write made
// against an older one is refused (SCHEDULE_CHANGED) with the board as it is now.

import type { RoomVerdict } from '../events/room-check';
import type { EventGroupRules, RoundCapacity } from '../events/group-rules';

/**
 * Where a person stands for the board.
 * - `registered`: holds a place. `present`: in the live event now. `left`: left the live event. `no_show`: did not
 *   come. People who left or did not come stay listed (in the basket when they have no seat) but are never seated
 *   automatically; an organiser may seat them by hand (a late arrival back).
 * - `absent`: the organiser marked them late or not coming for this round (on `people`: for any round).
 * - `not_in_event`: still seated here but no longer someone to match (removed from the event, or now one of the
 *   people running it). Their seat stays until an organiser moves them; it is never dropped silently.
 */
export type BoardPersonStatus = 'registered' | 'present' | 'left' | 'no_show' | 'absent' | 'not_in_event';

export interface BoardPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  groupKeys: string[];
  status: BoardPersonStatus;
}

export type BoardSeatSource = 'auto' | 'manual' | 'repair';

export interface BoardSeat extends BoardPerson {
  slotLocked: boolean;
  source: BoardSeatSource;
  /** Seated against the round's group rule by someone allowed to override it. */
  override: boolean;
}

export interface BoardRoom {
  roomNumber: number;
  seats: BoardSeat[];
  locked: boolean;
  verdict: RoomVerdict;
}

export interface BoardRound {
  roundNumber: number;
  /** When the round is expected to start (an estimate from the event's start and round length), or null. */
  startsAt: string | null;
  /** False once the round has started in the live event, or after the event ended. */
  editable: boolean;
  rooms: BoardRoom[];
  basket: BoardPerson[];
  capacity: RoundCapacity | null;
  /** People seated twice in this round. The storage makes this impossible; kept as the checker reports it. */
  collisions: string[];
  /**
   * The event now has fewer rounds than this one (its round count was lowered): its seats are shown so nobody's
   * plan disappears unseen, and the next generate clears them.
   */
  beyondLastRound?: boolean;
}

export interface ScheduleBoard {
  sessionId: string;
  revision: number;
  publishedVersion: number | null;
  draftDiffersFromPublished: boolean;
  rounds: BoardRound[];
  people: BoardPerson[];
  groupRules: EventGroupRules | null;
  /** Whether this organiser may seat people against a group rule (the event's owner or a super admin). */
  canOverride: boolean;
}

/** An optional override of the round's group rule, and the reason the organiser gave for it. */
interface BoardOpOverride {
  override?: boolean;
  reason?: string;
}

export type BoardOp = (
  | { kind: 'move'; round: number; userId: string; toRoom: number }
  | { kind: 'swap'; round: number; userId: string; withUserId: string }
  | { kind: 'unassign'; round: number; userId: string }
  | { kind: 'lock_room' | 'unlock_room'; round: number; room: number }
  | { kind: 'lock_slot' | 'unlock_slot'; round: number; userId: string }
  | { kind: 'redistribute'; rounds: number[] | 'all' }
  | { kind: 'mark_late'; userId: string; fromRound: number }
  | { kind: 'mark_no_show'; userId: string }
  | { kind: 'clear_absence'; userId: string }
) & BoardOpOverride;

export type BoardOpKind = BoardOp['kind'];

export interface BoardOpResult {
  board: ScheduleBoard;
  /** The people whose seats changed, per round (empty when the write changed nothing). */
  changed: Array<{ round: number; userIds: string[] }>;
}

/**
 * Why a move or swap was refused, and where the person could go instead: rooms of that round they may join, and
 * last "Leave them in the basket" (`room: 0`, the basket).
 */
export interface BoardRefusal {
  code: string;
  message: string;
  alternatives: Array<{ room: number; note: string }>;
}

/** The `room` of the alternative that leaves the person in the basket. */
export const BOARD_BASKET_ROOM = 0;

// ─── Published versions (10 Nov 2026 spec, Part 2 Task 9; sections 06, 07) ───────────────────────────────
//
// Publishing freezes the draft into a numbered version nobody edits again. The live event follows the latest one:
// at Start its rounds are written into the live matches, and every later version (an organiser's, or the product's
// own after someone arrives or leaves) rewrites only the rooms that changed, in rounds not yet started.

/** One room of a published round. `locked`: locked on the board; `override`: seated against the round's group rule by someone allowed to. */
export interface ScheduleSnapshotRoom {
  room: number;
  userIds: string[];
  locked: boolean;
  override: boolean;
  fallback: boolean;
  /** How the room was seated: 'manual' when an organiser placed anyone in it, else 'repair' when the product did, else 'auto'. */
  source: BoardSeatSource;
}

/** A published version's rounds, as they were published. */
export interface ScheduleSnapshot {
  rounds: Array<{ round: number; rooms: ScheduleSnapshotRoom[] }>;
}

/** Something about the draft the organiser reads before publishing. `room` is null when it is about a whole round. */
export interface PublishPreviewItem {
  round: number;
  room: number | null;
  message: string;
}

/**
 * What publishing the draft now would do. `blocking`: what has to be fixed first (two seats for one person, two
 * people kept apart, a group rule broken without an override, someone no longer in the event, a room over three).
 * `warnings`: what publishing keeps (people meeting again, a gap in a meeting, people waiting, a round's capacity).
 * `impactedUserIds`: the people whose meetings would change in rounds not yet started.
 */
export interface PublishPreview {
  blocking: PublishPreviewItem[];
  warnings: PublishPreviewItem[];
  impactedUserIds: string[];
  nextVersion: number;
}

export interface PublishResult {
  version: number;
  impactedUserIds: string[];
}

/** One published version, for the organisers' list. `publishedBy` is null for the product's own (shown "Automatic"). */
export interface ScheduleVersionSummary {
  version: number;
  publishedAt: string;
  publishedBy: { userId: string; displayName: string } | null;
  automatic: boolean;
  reason: string | null;
  note: string | null;
  impactedCount: number;
}

/** One partner in a participant's published meeting. */
export interface MySchedulePartner {
  displayName: string;
  avatarUrl: string | null;
  groupLabels: string[];
}

/**
 * A participant's own meetings in the latest published version (never the draft). `room` is null in a round they
 * have no meeting in.
 */
export interface MySchedule {
  version: number;
  publishedAt: string;
  rounds: Array<{ round: number; startsAt: string | null; room: number | null; partners: MySchedulePartner[] }>;
}
