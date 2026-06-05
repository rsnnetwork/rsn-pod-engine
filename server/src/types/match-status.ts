/**
 * MATCH STATUS STATE MACHINE — single source of truth
 *
 * Lifecycle:
 *   scheduled → active → {completed | no_show | cancelled | reassigned}
 *
 * Status meanings (USE THESE AS THE CONTRACT):
 *
 *   scheduled:  Match row exists but round hasn't started. Created by
 *               matching algorithm during round transition (persistMatches).
 *               Not ratable. Deleted/overwritten if host regenerates pairs.
 *
 *   active:     Match is currently running in a LiveKit room. Both/all
 *               participants should be connected and talking. Set by
 *               round-lifecycle.ts:transitionToRound when round starts.
 *
 *   completed:  Match ended normally. Either round timer expired, a user
 *               voluntarily left ("return to main"), or a user disconnected
 *               after a real conversation (>30s OR ratings submitted).
 *               Counts in: People Met, recap emails, encounter history.
 *               Allowed in rating window (RATABLE).
 *
 *   no_show:    A participant NEVER connected to the LiveKit room. Only set
 *               by round-lifecycle.ts:detectNoShows (60s after round start)
 *               when presenceMap.has(userId) === false for one or both
 *               participants. RESERVED for this one meaning — do not reuse
 *               as a scratch flag. (WS2, 27 May remaining work: the old
 *               reassign flows were removed — a room dropping below 2 now
 *               ends for the survivor instead of re-pairing.)
 *
 *   cancelled:  Match was aborted before or during. Reasons:
 *                 - Host manually removed a participant mid-round
 *                 - Match pre-empted by host regenerating pairs
 *                 - Participant disconnected within first 30s with no ratings
 *                 - Duplicate-pair cleanup in migration 029
 *               Ratable within a 30s grace window after ended_at (for
 *               host-remove flow where partner still gets rating screen).
 *
 *   reassigned: Host moved participants to a different room, so this match
 *               was superseded by a new one. Ratable (was a real meeting).
 *               Counts in People Met + recap stats. Blocks future re-pairing.
 *
 * QUERY RECIPES — use these, don't invent new filters:
 *
 *   "Rounds attended":          status NOT IN ('cancelled', 'scheduled')
 *   "People I actually met":    status IN ('completed', 'active', 'no_show', 'reassigned')
 *                                 (no_show included so "partner never showed" counts attendance)
 *   "Conversations for recap":  status IN ('completed', 'reassigned')
 *                                 (no_show excluded — no real conversation)
 *   "Encounter history rows":   status IN ('completed', 'active', 'reassigned')
 *   "Active right now":         status = 'active'
 *   "Ratable":                  status IN ('completed','active','no_show','scheduled','reassigned')
 *                                 OR (status = 'cancelled' AND ended_at > NOW() - INTERVAL '30 seconds')
 *   "Blocks future re-pair":    status NOT IN ('cancelled', 'no_show')
 *
 * WHERE STATUS TRANSITIONS HAPPEN:
 *
 *   scheduled → active       : round-lifecycle.ts:transitionToRound (UPDATE matches ... status='active')
 *   active → completed       : round-lifecycle.ts:endRound (timer)
 *                            : participant-flow.ts handleLeaveConversation (voluntary leave)
 *                            : participant-flow.ts disconnect branch (>30s or rated)
 *                            : host-actions.ts host-end-match
 *   active → no_show         : round-lifecycle.ts:detectNoShows (ONLY place)
 *   active → cancelled       : host-actions.ts handleHostRemoveFromRoom
 *                            : participant-flow.ts disconnect branch (<30s, no ratings)
 *   active → reassigned      : host-actions.ts host-move-to-room
 *   scheduled → cancelled    : matching-flow.ts when host regenerates before round start
 *
 * DO NOT ADD NEW TRANSITIONS WITHOUT UPDATING THIS DOC.
 */

export type MatchStatus =
  | 'scheduled'
  | 'active'
  | 'completed'
  | 'no_show'
  | 'cancelled'
  | 'reassigned';

/**
 * Statuses that allow rating submissions (plus cancelled within grace window,
 * handled separately in rating.service.ts).
 */
export const RATABLE_STATUSES: readonly MatchStatus[] = [
  'completed',
  'active',
  'no_show',
  'scheduled',
  'reassigned',
] as const;

/** Grace window for rating submissions on recently-cancelled matches (host-remove flow). */
export const CANCELLED_RATING_GRACE_MS = 30_000;

/**
 * Statuses representing a real conversation — counted in People Met,
 * recap emails, encounter history. Excludes no_show (no actual talk).
 */
export const REAL_CONVERSATION_STATUSES: readonly MatchStatus[] = [
  'completed',
  'reassigned',
] as const;

/**
 * Statuses that block the matching algorithm from re-pairing the same users
 * in a later round. Cancelled and no_show matches do NOT block — same pair
 * may be retried.
 */
export const BLOCKS_FUTURE_REMATCH: readonly MatchStatus[] = [
  'scheduled',
  'active',
  'completed',
  'reassigned',
] as const;
