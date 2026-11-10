// ─── An event's lifecycle (Part 2 foundation, Task 2; spec 11) ───────────────────────────────────
//
// D1: the lifecycle sits beside sessions.status, not inside it. status stays the live orchestrator's state machine;
// draft and archived are facts of their own (sessions.publication, sessions.archived_at), and the seven states the
// spec names are worked out here, in one pure function, so the server and the client never disagree about them.
// Ending stays the live event's own (End Event, the overdue job); deleting is a separate, super-admin-only act.

export type EventPublication = 'draft' | 'published';

export const EVENT_PUBLICATIONS: readonly EventPublication[] = ['draft', 'published'];

export function isEventPublication(value: unknown): value is EventPublication {
  return typeof value === 'string' && (EVENT_PUBLICATIONS as readonly string[]).includes(value);
}

export type EventLifecycle =
  | 'draft' | 'published' | 'registration_open' | 'live' | 'completed' | 'archived' | 'cancelled';

/** The statuses an event is live in: started and not yet over (the server's LIVE_STATUSES, as plain strings). */
export const EVENT_LIVE_STATUSES: readonly string[] = [
  'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby',
];

/** The most characters an organiser's reason for cancelling may have (sessions.cancel_reason holds the same). */
export const EVENT_CANCEL_REASON_MAX = 500;

export interface EventLifecycleInput {
  status: string;
  publication: EventPublication;
  archivedAt: string | Date | null;
  registrationOpensAt: string | Date | null;
}

function instant(value: string | Date | null): number | null {
  if (value === null) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Where the event stands, in this order: cancelled, archived, completed, live, draft, then published while its
 * registration has not opened yet, else registration open. A cancelled event that was archived still reads
 * cancelled; a live draft cannot happen (Start refuses a draft) and would read live.
 */
export function eventLifecycleOf(e: EventLifecycleInput, now: Date = new Date()): EventLifecycle {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.archivedAt !== null && e.archivedAt !== undefined) return 'archived';
  if (e.status === 'completed') return 'completed';
  if (EVENT_LIVE_STATUSES.includes(e.status)) return 'live';
  if (e.publication === 'draft') return 'draft';
  const opensAt = instant(e.registrationOpensAt ?? null);
  if (opensAt !== null && opensAt > now.getTime()) return 'published';
  return 'registration_open';
}

export type EventLifecycleAction = 'publish' | 'unpublish' | 'cancel' | 'archive' | 'unarchive' | 'delete_permanently';

export const EVENT_LIFECYCLE_ACTIONS: readonly EventLifecycleAction[] = [
  'publish', 'unpublish', 'cancel', 'archive', 'unarchive', 'delete_permanently',
];

/**
 * Who is asking, about this event. `isAdmin`: a platform admin, or an admin of the event's pod (its creator or a
 * director); `isSuperAdmin` on its own, so a super admin who only attends still holds the super admin's actions.
 */
export interface EventLifecycleWho {
  isOwner: boolean;
  isCohost: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/**
 * What this person may do to the event now. `registeredCount`: the places held by anyone but its host and co-hosts.
 *   publish             a draft; its organisers (host, co-host, admin, super admin)
 *   unpublish           published or registration open, with nobody registered; its organisers
 *   cancel              draft, published or registration open; its host or an admin (a co-host may not)
 *   archive             completed or cancelled, and not archived yet; its host, a co-host or an admin
 *   unarchive           archived (a cancelled event that was archived included); the same
 *   delete_permanently  any state but live; a super admin only
 *
 * `options.archived` (fix round 1): whether the event's archived_at is set. The lifecycle alone cannot say it for a
 * cancelled event, which reads 'cancelled' archived or not (D1's order), so without it a cancelled event that was put
 * away would offer Archive again and never Unarchive. Pass it whenever the event is known (eventAllowedActions does);
 * an 'archived' lifecycle implies it.
 */
export function allowedLifecycleActions(
  lifecycle: EventLifecycle,
  who: EventLifecycleWho,
  registeredCount: number,
  options: { archived?: boolean } = {},
): EventLifecycleAction[] {
  const organiser = who.isOwner || who.isCohost || who.isAdmin || who.isSuperAdmin;
  const ownerOrAdmin = who.isOwner || who.isAdmin || who.isSuperAdmin;
  const archived = lifecycle === 'archived' || options.archived === true;
  const actions: EventLifecycleAction[] = [];
  if (lifecycle === 'draft' && organiser) actions.push('publish');
  if ((lifecycle === 'published' || lifecycle === 'registration_open') && organiser && registeredCount === 0) {
    actions.push('unpublish');
  }
  if ((lifecycle === 'draft' || lifecycle === 'published' || lifecycle === 'registration_open') && ownerOrAdmin) {
    actions.push('cancel');
  }
  if ((lifecycle === 'completed' || lifecycle === 'cancelled') && !archived && organiser) actions.push('archive');
  if (archived && (lifecycle === 'archived' || lifecycle === 'cancelled') && organiser) actions.push('unarchive');
  if (lifecycle !== 'live' && who.isSuperAdmin) actions.push('delete_permanently');
  return actions;
}

/**
 * The steps this person may take on this event now, read from the event itself: its lifecycle (eventLifecycleOf) and
 * whether it is archived. The one function the server's GET /sessions/:id `allowedActions` and every step's check use,
 * and the one a client should call.
 */
export function eventAllowedActions(
  event: EventLifecycleInput,
  who: EventLifecycleWho,
  registeredCount: number,
  now: Date = new Date(),
): EventLifecycleAction[] {
  const archived = event.archivedAt !== null && event.archivedAt !== undefined;
  return allowedLifecycleActions(eventLifecycleOf(event, now), who, registeredCount, { archived });
}
