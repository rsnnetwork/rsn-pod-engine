// client/src/features/notifications/notification-logic.ts
// What a notification is and how each one reads, for the bell and the notifications page alike (30 Oct 2026 review,
// item 4.5). Pure on purpose (no React, axios, store or router), so a test can run it:
// server/src/__tests__/client/t6-notifications.test.ts.
import type { RequestStateLike } from '../messages/request-answer';
import { bellRequestView } from '../messages/request-answer';

export interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  isRead: boolean;
  createdAt: string;
  inviteStatus?: string | null; // 'pending' | 'accepted' | 'revoked' | 'expired'
  podId?: string | null;
  sessionId?: string | null;
  /** Where the meeting request behind a `poke` row stands, as the server says (25 Oct 2026). */
  requestState?: RequestStateLike | null;
  /** The older field for the same answer, read only from a server that sends no requestState. */
  pokeStatus?: string | null;
}

/** GET /notifications: the newest notifications, how many are unread, and where the next older page starts. */
export interface NotificationList {
  notifications: Notification[];
  unreadCount: number;
  /** The cursor of the next older page (absent from a server before 30 Oct 2026, which sends only the newest 20). */
  nextBefore?: string | null;
}

/** The bell's list: GET /notifications with no query string, the newest 20. */
export const NOTIFICATIONS_KEY = ['notifications'] as const;
/** The notifications page's list, a page at a time; under the bell's key, so one invalidation reaches both. */
export const NOTIFICATIONS_PAGE_KEY = ['notifications', 'page'] as const;
/** A page of the notifications page. */
export const NOTIFICATIONS_PAGE_SIZE = 30;

// T14 (1 Nov 2026): a circle invite is answered in place too (the server sends its inviteStatus since migration 118).
const INVITE_TYPES = ['pod_invite', 'event_invite', 'circle_invite'];

/** The invite code a `/invite/{code}` link carries. */
export function extractInviteCode(link?: string | null): string | null {
  if (!link) return null;
  const match = link.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

/** Where an accepted invite takes the person: the event, the pod or the circle it let them into (POST /invites/:code/accept). */
export function acceptedDestination(data: { sessionId?: string | null; podId?: string | null; circleId?: string | null } | null | undefined): string | null {
  if (data?.sessionId) return `/sessions/${data.sessionId}`;
  if (data?.podId) return `/pods/${data.podId}`;
  if (data?.circleId) return `/circles/${data.circleId}`;
  return null;
}

/** Where a notification opens. */
export function destinationOf(n: Notification): string | null {
  if (n.sessionId) return `/sessions/${n.sessionId}`;
  if (n.podId) return `/pods/${n.podId}`;
  // A meeting request goes to the conversation once accepted, else to the request.
  const request = bellRequestView(n);
  if (request) return request.destination;
  return n.link || null;
}

/** Accept and Decline are offered only for an invite still waiting for an answer. */
export function canActOnInvite(n: Notification): boolean {
  return INVITE_TYPES.includes(n.type) && !!extractInviteCode(n.link) && n.inviteStatus === 'pending';
}

/** The label of an invite that has its answer. */
export function inviteStatusLabel(n: Notification): { text: string; color: string } | null {
  if (!INVITE_TYPES.includes(n.type) || !n.inviteStatus || n.inviteStatus === 'pending') return null;
  if (n.inviteStatus === 'accepted') return { text: 'Accepted', color: 'text-emerald-700' };
  if (n.inviteStatus === 'revoked') return { text: 'Declined', color: 'text-gray-500' };
  if (n.inviteStatus === 'expired') return { text: 'Expired', color: 'text-amber-700' };
  return null;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(ts: string, now: Date = new Date()): string {
  const mins = Math.floor((now.getTime() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export type DayGroup = 'Today' | 'Yesterday' | 'Earlier';

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Which heading a notification sits under, by the reader's own calendar day. */
export function dayGroupOf(ts: string, now: Date = new Date()): DayGroup {
  const day = startOfDay(new Date(ts));
  const today = startOfDay(now);
  if (day >= today) return 'Today';
  if (day >= startOfDay(new Date(today - 12 * 3600 * 1000))) return 'Yesterday';
  return 'Earlier';
}

/** One line of the notifications page: a notification, or several messages in a row from one conversation. */
export interface PageEntry {
  key: string;
  /** The newest of them, which the line is drawn from. */
  lead: Notification;
  /** All of them, newest first (one, unless several messages ran together). */
  members: Notification[];
  /** The title the line shows: "Shradha sent you 3 messages" for several. */
  title: string;
  isRead: boolean;
}

const SENT_YOU_A_MESSAGE = /^(.+) sent you a message$/;

/** Several messages ran together: "Shradha sent you 3 messages"; the newest's own title otherwise. */
function collapsedTitle(rows: Notification[]): string {
  if (rows.length === 1) return rows[0].title;
  const name = SENT_YOU_A_MESSAGE.exec(rows[0].title)?.[1];
  return name ? `${name} sent you ${rows.length} messages` : `${rows[0].title} (${rows.length})`;
}

/**
 * The page's lines under their day headings (newest first). Consecutive message bells from the same conversation run
 * together into one line on the page only; the bell keeps each one (audit 02 §4.5).
 */
export function pageSections(rows: Notification[], now: Date = new Date()): Array<{ day: DayGroup; entries: PageEntry[] }> {
  const sections: Array<{ day: DayGroup; entries: PageEntry[] }> = [];
  for (const n of rows) {
    const day = dayGroupOf(n.createdAt, now);
    let section = sections[sections.length - 1];
    if (!section || section.day !== day) {
      section = { day, entries: [] };
      sections.push(section);
    }
    const last = section.entries[section.entries.length - 1];
    if (last && n.type === 'direct_message' && last.lead.type === 'direct_message' && !!n.link && last.lead.link === n.link) {
      last.members.push(n);
      last.title = collapsedTitle(last.members);
      last.isRead = last.isRead && n.isRead;
      continue;
    }
    section.entries.push({ key: n.id, lead: n, members: [n], title: n.title, isRead: n.isRead });
  }
  return sections;
}

/** Every loaded page's rows, newest first, each once (a refetch may shift a row from one page to the next). */
export function rowsOfPages(pages: NotificationList[]): Notification[] {
  const seen = new Set<string>();
  const out: Notification[] = [];
  for (const page of pages) for (const n of page.notifications) if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
  return out;
}
