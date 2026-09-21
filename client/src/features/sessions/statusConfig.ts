// ─── Shared session-status presentation config ──────────────────────────────
// Single source of truth for converting session.status enum values into
// user-facing labels, Badge colors, and lifecycle phase classification.
//
// Before this util, SessionDetailPage used `status.replace(/_/g, ' ')` which
// produced lowercase "lobby open" strings; AdminSessionsPage rendered raw
// enum values; LiveSessionPage had its own STATE_CONFIG. Use these helpers
// for any generic status-chip display. LiveSessionPage keeps its local
// STATE_CONFIG because it has richer, context-specific copy per phase.

export type SessionStatus =
  | 'scheduled'
  | 'lobby_open'
  | 'round_active'
  | 'round_rating'
  | 'round_transition'
  | 'closing_lobby'
  | 'completed'
  | 'cancelled';

export type StatusPhase = 'pre' | 'live' | 'done' | 'cancelled';

/**
 * Who is reading. A member wants to know whether they can walk in; only the
 * person running the event cares which phase it is in (21 Sep 2026, Shradha:
 * "Users will never know what 'Transition' means. States must be named in
 * plain words"). An event of hers sat on "Transition" for two days.
 */
export type StatusAudience = 'member' | 'host';

const LABEL_MAP: Record<SessionStatus, string> = {
  scheduled: 'Upcoming',
  lobby_open: 'Live now',
  round_active: 'Live now',
  round_rating: 'Live now',
  round_transition: 'Live now',
  closing_lobby: 'Wrapping up',
  completed: 'Ended',
  cancelled: 'Cancelled',
};

/** What the host sees instead: which part of the event is running. */
const HOST_LABEL_MAP: Record<SessionStatus, string> = {
  scheduled: 'Upcoming',
  lobby_open: 'Main room open',
  round_active: 'Round in progress',
  round_rating: 'Rating the round',
  round_transition: 'Between rounds',
  closing_lobby: 'Wrapping up',
  completed: 'Ended',
  cancelled: 'Cancelled',
};

// Mirrors Badge component variants: 'default' | 'success' | 'info' | 'warning' | 'danger' | 'brand'
const COLOR_MAP: Record<SessionStatus, 'default' | 'success' | 'warning' | 'info' | 'danger'> = {
  scheduled: 'default',
  lobby_open: 'info',
  round_active: 'success',
  round_rating: 'warning',
  round_transition: 'info',
  closing_lobby: 'warning',
  completed: 'default',
  cancelled: 'danger',
};

const PHASE_MAP: Record<SessionStatus, StatusPhase> = {
  scheduled: 'pre',
  lobby_open: 'live',
  round_active: 'live',
  round_rating: 'live',
  round_transition: 'live',
  closing_lobby: 'live',
  completed: 'done',
  cancelled: 'cancelled',
};

export function sessionStatusLabel(s: string | undefined | null, audience: StatusAudience = 'member'): string {
  const map = audience === 'host' ? HOST_LABEL_MAP : LABEL_MAP;
  return (s && map[s as SessionStatus]) || 'Unknown';
}

/**
 * The extra line a host gets under the label: which round, when we know it.
 * Members never see this — "Live now" is the whole truth they need.
 */
export function sessionStatusDetail(s: string | undefined | null, round?: number | null): string | null {
  if (s === 'round_active' && round) return `Round ${round} in progress`;
  if (s === 'round_rating' && round) return `Rating round ${round}`;
  if (!s || !(s in HOST_LABEL_MAP)) return null;
  const detail = HOST_LABEL_MAP[s as SessionStatus];
  return detail === sessionStatusLabel(s) ? null : detail;
}

export function sessionStatusColor(s: string | undefined | null) {
  return (s && COLOR_MAP[s as SessionStatus]) || 'default';
}

export function sessionStatusPhase(s: string | undefined | null): StatusPhase {
  return (s && PHASE_MAP[s as SessionStatus]) || 'pre';
}
