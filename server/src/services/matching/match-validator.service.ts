// ─── Match Validator (T0-1) ─────────────────────────────────────────────────
//
// Single audited gatekeeper for every code path that writes to the `matches`
// table. Replaces the ad-hoc per-handler checks (or absence thereof) in
// `handleHostCreateBreakout`, `handleHostCreateBreakoutBulk`,
// `handleHostSwapMatch`, and `handleHostExcludeFromRound`.
//
// Two layers of validation:
//
// 1. **Structural** (always run, no DB roundtrip):
//    - participantAId is required (≥1 participant)
//    - All non-null participant IDs are distinct
//    - Optional: caller can require ≥N via `minParticipants`
//
// 2. **Cross-match conflict** (DB-aware, opt-out via `skipConflictCheck`):
//    - No other match in this session+round (with one of `conflictingStatuses`,
//      defaulting to `['active']`) holds any of these participants
//    - When updating an existing match, pass `excludeMatchId` so the match
//      under edit isn't flagged as conflicting with itself
//
// The validator NEVER throws. It returns `{ valid, errors[], conflictingUserIds[] }`
// so handlers can emit a structured socket error to the host UI.

import { query } from '../../db';

export type MatchStatus = 'scheduled' | 'active' | 'completed' | 'cancelled' | 'no_show' | 'reassigned';

export interface MatchValidationInput {
  sessionId: string;
  roundNumber: number;
  participantAId: string;
  participantBId?: string | null;
  participantCId?: string | null;
  /** Skip the participant in this match when checking conflicts (UPDATE case). */
  excludeMatchId?: string;
  /** Skip the cross-match DB query (use when caller has just reassigned conflicts). */
  skipConflictCheck?: boolean;
  /** Match statuses considered "occupied" for conflict purposes. Default: ['active']. */
  conflictingStatuses?: MatchStatus[];
  /** Minimum participant count to consider valid. Default: 1 (allow solo holder rooms). */
  minParticipants?: number;
  /**
   * When true, in addition to the per-round conflict check, ALSO query for
   * any 'active' match in this session in ANY round number containing any of
   * these participants. Used by handlers that enforce the session-wide
   * "one user = one room at any moment" invariant — specifically the manual
   * force-match path (where the host might pair someone who is currently
   * inside an active manual breakout from a different round number).
   * Default: false. The per-round check at conflictingStatuses is sufficient
   * for swap/exclude paths that operate on the preview state only.
   */
  sessionWideActiveCheck?: boolean;
}

export interface MatchValidationResult {
  valid: boolean;
  errors: string[];
  /** User IDs that are already in another active match in this session+round. */
  conflictingUserIds: string[];
}

const DEFAULT_CONFLICTING_STATUSES: MatchStatus[] = ['active'];

export async function validateMatchAssignment(
  input: MatchValidationInput
): Promise<MatchValidationResult> {
  const {
    sessionId,
    roundNumber,
    participantAId,
    participantBId = null,
    participantCId = null,
    excludeMatchId,
    skipConflictCheck = false,
    conflictingStatuses = DEFAULT_CONFLICTING_STATUSES,
    minParticipants = 1,
    sessionWideActiveCheck = false,
  } = input;

  const errors: string[] = [];
  const conflictingUserIds: string[] = [];

  // ── Structural rule 1: participantAId is required ─────────────────────────
  if (!participantAId) {
    errors.push('participantAId is required (at least one participant)');
  }

  // ── Build deduplicated, non-null participant list ────────────────────────
  const ids = [participantAId, participantBId, participantCId].filter(
    (id): id is string => !!id
  );
  const uniqueIds = Array.from(new Set(ids));

  // ── Structural rule 2: all non-null IDs are distinct ─────────────────────
  if (uniqueIds.length !== ids.length) {
    errors.push('Participant IDs must be unique within a match (no duplicates)');
  }

  // Phase 8A.3 (8 May spec) — Stefan #7: explicit self-match check. The
  // schema CHECK no_self_match (migration 001:222) catches this at the
  // DB layer, but only AFTER LiveKit tokens have been issued and
  // match:assigned has been emitted. Failing fast here keeps clients
  // from briefly seeing an invalid pairing they have to roll back.
  if (
    (participantAId && participantBId && participantAId === participantBId) ||
    (participantAId && participantCId && participantAId === participantCId) ||
    (participantBId && participantCId && participantBId === participantCId)
  ) {
    errors.push('A user cannot be matched with themselves');
  }

  // ── Structural rule 3: minimum count (caller-configurable) ───────────────
  if (uniqueIds.length < minParticipants) {
    errors.push(
      `Match must have at least ${minParticipants} unique participant${minParticipants === 1 ? '' : 's'}, got ${uniqueIds.length}`
    );
  }

  // ── Conflict check (opt-out) ──────────────────────────────────────────────
  if (!skipConflictCheck && uniqueIds.length > 0 && participantAId) {
    // Inline the status list so this query stays parameter-bound for sessionId,
    // roundNumber, excludeMatchId, and the participant id array. Statuses are
    // an internal allow-list (TypeScript type), not user input.
    const statusInClause = conflictingStatuses.map(s => `'${s}'`).join(', ');

    const conflictQuery = `
      SELECT id AS match_id, user_id
      FROM matches m,
           LATERAL UNNEST(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS user_id
      WHERE m.session_id = $1
        AND m.round_number = $2
        AND m.status IN (${statusInClause})
        AND m.id != COALESCE($3, '00000000-0000-0000-0000-000000000000'::uuid)
        AND user_id = ANY($4)
        AND user_id IS NOT NULL
    `;

    const conflictResult = await query<{ match_id: string; user_id: string }>(
      conflictQuery,
      [sessionId, roundNumber, excludeMatchId || null, uniqueIds]
    );

    if (conflictResult.rows.length > 0) {
      const conflictSet = new Set(conflictResult.rows.map(r => r.user_id));
      conflictingUserIds.push(...conflictSet);
      errors.push(
        `${conflictSet.size} participant${conflictSet.size === 1 ? ' is' : 's are'} already in another active match in this round`
      );
    }
  }

  // ── Session-wide active-match check (opt-in) ──────────────────────────────
  // Used by manual force-match to catch the case where a user is mid-call
  // inside a manual breakout from a different round number — that breakout
  // is status='active' and lives outside the current round's preview, so the
  // per-round check above won't see it. The "one user = one room at any
  // moment" invariant requires us to look across all rounds for active rows.
  if (sessionWideActiveCheck && !skipConflictCheck && uniqueIds.length > 0 && participantAId) {
    const sessionWideQuery = `
      SELECT id AS match_id, user_id, round_number
      FROM matches m,
           LATERAL UNNEST(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS user_id
      WHERE m.session_id = $1
        AND m.status = 'active'
        AND m.id != COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
        AND user_id = ANY($3)
        AND user_id IS NOT NULL
    `;
    const sessionWideResult = await query<{ match_id: string; user_id: string; round_number: number }>(
      sessionWideQuery,
      [sessionId, excludeMatchId || null, uniqueIds]
    );
    if (sessionWideResult.rows.length > 0) {
      const newConflicts = new Set(sessionWideResult.rows.map(r => r.user_id));
      // Don't double-add ids already flagged by the per-round check.
      const alreadyFlagged = new Set(conflictingUserIds);
      for (const uid of newConflicts) {
        if (!alreadyFlagged.has(uid)) conflictingUserIds.push(uid);
      }
      // Only add a separate error message if these conflicts are NEW (not
      // already covered by the per-round check above). Otherwise the same
      // user would generate two error lines.
      const newOnly = [...newConflicts].filter(uid => !alreadyFlagged.has(uid));
      if (newOnly.length > 0) {
        errors.push(
          `${newOnly.length} participant${newOnly.length === 1 ? ' is' : 's are'} currently inside another active room in this event`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    conflictingUserIds,
  };
}
