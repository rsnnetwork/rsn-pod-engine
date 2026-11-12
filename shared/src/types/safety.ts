// ─── Presence and reports (11 Nov 2026, Shirley Palmer's RSN 07 and item 16) ──────────────────────────────

/**
 * Where a member is right now, as their conversation partners see it:
 *   - online:  REASON is open and in front of them (a foreground ping in the last minute);
 *   - away:    REASON is open somewhere (a live connection) but not in front of them; a call still reaches them;
 *   - offline: no live connection at all.
 * A read that could not tell answers null ("unknown"), which a screen shows as nothing and never as offline.
 */
export type PresenceState = 'online' | 'away' | 'offline';

/**
 * What a report names besides the member (migration 150): a direct message, a post or a comment on a pod or circle wall,
 * a message in a group chat, or a message in an event's chat.
 */
export const REPORT_SUBJECT_KINDS = [
  'dm_message', 'pod_post', 'circle_post', 'pod_comment', 'circle_comment', 'group_message', 'event_chat_message',
] as const;
export type ReportSubjectKind = typeof REPORT_SUBJECT_KINDS[number];

export const REPORT_REASONS = ['spam', 'harassment', 'inappropriate_content', 'fake_profile', 'safety', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];

/** The same reporter reporting the same member, message or post again within this many hours is told they already did. */
export const REPORT_REPEAT_HOURS = 24;
