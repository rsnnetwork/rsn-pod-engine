// ─── An event's lifecycle on its page: the words and the small decisions (Part 2 Task 11; spec 11) ───────────────────
// Pure (types and the shared list only), so the client test runs it. Which steps show is never worked out here: the
// server sends `allowedActions` on GET /sessions/:id, computed by the shared eventAllowedActions, and the page shows
// exactly those (in a fixed order, unknown names dropped).
import { EVENT_CANCEL_REASON_MAX, EVENT_LIFECYCLE_ACTIONS, type EventLifecycle, type EventLifecycleAction } from '@rsn/shared';

export const LIFECYCLE_COPY = {
  heading: 'Event status',
  publish: 'Publish',
  unpublish: 'Move back to draft',
  cancel: 'Cancel event',
  archive: 'Archive',
  unarchive: 'Restore',
  deletePermanently: 'Delete permanently',
  archivedInline: 'Archived.',
  cancelTitle: 'Cancel this event?',
  cancelBody: 'Everyone registered gets an email and a notification.',
  reasonLabel: 'Reason (they will see it)',
  reasonTooLong: `Keep the reason to ${EVENT_CANCEL_REASON_MAX} characters.`,
  keep: 'Keep the event',
  deleteTitle: 'Delete this event permanently?',
  deleteBody: "This permanently deletes the event and its meetings. Type the event's name to confirm.",
  nameLabel: "The event's name",
  nameMismatch: "Type the event's name exactly as it is shown.",
  cancelReasonShown: 'Reason given',
  published: 'Published.',
  unpublished: 'Moved back to draft.',
  restored: 'Restored.',
  deleted: 'Event deleted.',
  fallback: 'That did not go through. Please try again.',
} as const;

/** One line under the chip: what this state means for the people running the event. */
export const LIFECYCLE_HINTS: Record<EventLifecycle, string> = {
  draft: 'Only the people running this event can see it. Publish it when it is ready.',
  published: 'Published. Registration has not opened yet.',
  registration_open: 'People can see it and take a place.',
  live: 'The event is running now.',
  completed: 'The event has ended.',
  archived: 'Put away: it no longer shows in the event lists.',
  cancelled: 'This event was cancelled.',
};

/** The order the buttons stand in: the step forward first, the irreversible one last. */
const ORDER: readonly EventLifecycleAction[] = ['publish', 'unpublish', 'archive', 'unarchive', 'cancel', 'delete_permanently'];

/** The steps the server allows, in display order; anything it sends that this page does not know is left out. */
export function shownActions(allowed: unknown): EventLifecycleAction[] {
  if (!Array.isArray(allowed)) return [];
  const known = new Set<string>(EVENT_LIFECYCLE_ACTIONS);
  const given = new Set(allowed.filter((a): a is EventLifecycleAction => typeof a === 'string' && known.has(a)));
  return ORDER.filter((a) => given.has(a));
}

/** Whether the typed name is the event's (trimmed, any case: the server's own comparison). */
export function titleMatches(typed: string, title: string): boolean {
  const t = typed.trim().toLowerCase();
  return t !== '' && t === title.trim().toLowerCase();
}

/** The toast after a cancel: how many people were told. */
export function cancelledSentence(notified: number): string {
  if (notified <= 0) return 'Event cancelled.';
  return `Event cancelled. ${notified} ${notified === 1 ? 'person was' : 'people were'} told.`;
}
