// ─── The rules of the member notification email gate (22 Nov 2026, Stefan) ─────────────────────────────────
//
// Pure: no database, no clock of its own, no sending. notification-email.service.ts reads the rows and the member, asks
// these what to do, and writes the answer back. Tested directly in notification-email.rules.test.ts.
//
// Stefan's three asks, as rules:
//   1. "Only get notifications if I am not online": with "Only email me when I'm away" on (the default) an email waits
//      AWAY_DELAY_MINUTES and is let go if the member had REASON in front of them since it happened, or if they have
//      read it already (the bell row, the message, an answered request). Off: it goes at once.
//   2. "Max X notifications a day": at most the member's "Most emails a day" (1, 3, 5 or 10; 3 by default) on their own
//      day. What comes after that is held, and the next morning's "Yesterday on REASON" lists what is still unread.
//      Everything that is due for one member goes as ONE email, and counts once.
//   3. "A weekly digest": weeklyHasNews and weeklySuggestions below decide whether there is anything to say and the
//      one or two next steps.

import type { NotificationRoundupSections } from '../email/email.service';

export const AWAY_DELAY_MINUTES = 10;
/** A held notification older than this is let go: it is no longer news by the time any email could carry it. */
export const HELD_MAX_AGE_DAYS = 3;

export type NotificationEmailKind = 'meeting_request' | 'meeting_accepted' | 'direct_message' | 'invite';

export interface MeetingRequestPayload { senderName: string; note: string | null; reasonLine: string | null }
export interface MeetingAcceptedPayload { accepterName: string; conversationId: string }
export interface DirectMessagePayload { senderName: string; snippet: string; conversationId: string }
export interface InvitePayload {
  inviterId: string;
  inviterName: string;
  inviteType: 'pod' | 'session' | 'circle';
  targetName: string | null;
  code: string;
  podId: string | null;
  sessionId: string | null;
  circleId: string | null;
}

export type NotificationEmailPayload =
  | { kind: 'meeting_request'; payload: MeetingRequestPayload }
  | { kind: 'meeting_accepted'; payload: MeetingAcceptedPayload }
  | { kind: 'direct_message'; payload: DirectMessagePayload }
  | { kind: 'invite'; payload: InvitePayload };

/** What a caller hands the gate: who is told, about what, and what the email will say. */
export type NotificationEmailRequest = NotificationEmailPayload & {
  userId: string;
  /** The request, message or invite this is about: one email row per member, kind and source. */
  sourceId: string;
  /** Who caused it, when someone did. */
  actorId?: string | null;
  /** The bell row the same event wrote: read, it drops the email. */
  bellLink?: string | null;
};

/** One queued row as the service reads it back. */
export type OutboxItem = NotificationEmailPayload & {
  id: string;
  sourceId: string;
  actorId: string | null;
  createdAt: Date;
  sendAfter: Date;
};

/** The Settings switch each kind answers to (notification-prefs `<category>_email`). */
export function prefCategoryOf(kind: NotificationEmailKind): 'poke' | 'dm' | 'invite' {
  if (kind === 'direct_message') return 'dm';
  if (kind === 'invite') return 'invite';
  return 'poke';
}

/** The admin email_config switch each kind answers to, when it has one (the meeting request emails do, migration 082). */
export function emailTypeOf(kind: NotificationEmailKind): string | null {
  if (kind === 'meeting_request') return 'poke_request';
  if (kind === 'meeting_accepted') return 'poke_accepted';
  return null;
}

/** The member as the gate needs them. */
export interface GateMember {
  email: string | null;
  status: string;
  accountKind: string;
  notifyEmail: boolean;
}

/** Whether this account gets member notification emails at all: an active member with an address and email on. */
export function memberGetsNotificationEmails(m: GateMember | null | undefined): boolean {
  return !!m && !!m.email && m.status === 'active' && m.accountKind === 'member' && m.notifyEmail === true;
}

/** When a new row is due: AWAY_DELAY_MINUTES from now when the member is emailed only while away, else now. */
export function sendAfterFor(now: Date, awayOnly: boolean): Date {
  return awayOnly ? new Date(now.getTime() + AWAY_DELAY_MINUTES * 60_000) : now;
}

/** One item as the flush plan sees it, with the answers the service looked up. */
export interface PlannedItem {
  id: string;
  createdAt: Date;
  sendAfter: Date;
  /** The member's Settings switch for this kind, and the admin switch, are both on. */
  switchedOn: boolean;
  /** Still unread and unanswered (the bell not read, the message not read, the request still waiting...). */
  stillNews: boolean;
}

export interface FlushMember {
  /** memberGetsNotificationEmails, now. */
  eligible: boolean;
  awayOnly: boolean;
  dailyMax: number;
  /** When the member last had REASON in front of them (users.last_seen_at). */
  lastSeenAt: Date | null;
  /** Their presence says online right now. */
  onlineNow: boolean;
  /** Instant emails already counted today, on their day. */
  sentToday: number;
}

export type LetGoReason = 'not_eligible' | 'switched_off' | 'read' | 'seen';

export interface FlushPlan {
  /** Nothing of theirs is due yet: leave every row as it is. */
  wait: boolean;
  /** Let go for good, each with why. */
  letGo: Array<{ id: string; reason: LetGoReason }>;
  /** Go now, as one email. */
  send: string[];
  /** Over today's maximum: kept for the next morning's email. */
  hold: string[];
}

/**
 * What to do with a member's queued rows. Nothing happens until one of them is due; then all of them are decided
 * together, so whatever came in the meantime goes in the same email rather than in one of its own ten minutes later.
 * A member who was on REASON after something happened has seen its bell, so with "only when I'm away" on it is let go.
 */
export function planFlush(member: FlushMember, items: PlannedItem[], now: Date): FlushPlan {
  const plan: FlushPlan = { wait: false, letGo: [], send: [], hold: [] };
  if (!items.some((i) => i.sendAfter.getTime() <= now.getTime())) return { ...plan, wait: true };
  const remaining: string[] = [];
  for (const item of items) {
    if (!member.eligible) plan.letGo.push({ id: item.id, reason: 'not_eligible' });
    else if (!item.switchedOn) plan.letGo.push({ id: item.id, reason: 'switched_off' });
    else if (!item.stillNews) plan.letGo.push({ id: item.id, reason: 'read' });
    else if (member.awayOnly && (member.onlineNow || (member.lastSeenAt !== null && member.lastSeenAt.getTime() > item.createdAt.getTime()))) {
      plan.letGo.push({ id: item.id, reason: 'seen' });
    } else remaining.push(item.id);
  }
  if (remaining.length === 0) return plan;
  if (member.sentToday >= member.dailyMax) plan.hold = remaining;
  else plan.send = remaining;
  return plan;
}

// ── What an email lists ─────────────────────────────────────────────────────────────────────────────────────

export interface Counts { meetingRequests: number; acceptances: number; messages: number; invites: number }

/** "3 new messages and 1 meeting request": every kind there is, the biggest first, joined the way people write it. */
export function summaryLine(c: Counts): string {
  const parts: Array<[number, string]> = [
    [c.messages, c.messages === 1 ? 'new message' : 'new messages'],
    [c.meetingRequests, c.meetingRequests === 1 ? 'meeting request' : 'meeting requests'],
    [c.acceptances, c.acceptances === 1 ? 'accepted request' : 'accepted requests'],
    [c.invites, c.invites === 1 ? 'invite' : 'invites'],
  ];
  const named = parts
    .map((p, order) => ({ n: p[0], words: p[1], order }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n || a.order - b.order)
    .map((p) => `${p.n} ${p.words}`);
  if (named.length === 0) return 'nothing new';
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

const inviteWhat = (t: InvitePayload['inviteType']): 'pod' | 'event' | 'circle' => (t === 'session' ? 'event' : t);

/**
 * The items, grouped as an email lists them: requests, acceptances, one line per conversation (how many messages, the
 * latest one's first words) and invites, each in the order it happened. `clientUrl` is the app's address.
 */
export function sectionsOf(items: OutboxItem[], clientUrl: string): { sections: NotificationRoundupSections; counts: Counts } {
  const sorted = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sections: NotificationRoundupSections = { meetingRequests: [], acceptances: [], messages: [], invites: [] };
  const byConversation = new Map<string, { name: string; count: number; snippet: string; url: string }>();
  let messageCount = 0;
  for (const item of sorted) {
    if (item.kind === 'meeting_request') {
      sections.meetingRequests.push({ name: item.payload.senderName, note: item.payload.note, url: `${clientUrl}/messages` });
    } else if (item.kind === 'meeting_accepted') {
      sections.acceptances.push({ name: item.payload.accepterName, url: `${clientUrl}/messages/${item.payload.conversationId}` });
    } else if (item.kind === 'direct_message') {
      messageCount += 1;
      const key = item.payload.conversationId;
      const line = byConversation.get(key);
      if (line) {
        line.count += 1;
        line.snippet = item.payload.snippet;
      } else {
        const entry = { name: item.payload.senderName, count: 1, snippet: item.payload.snippet, url: `${clientUrl}/messages/${key}` };
        byConversation.set(key, entry);
        sections.messages.push(entry);
      }
    } else {
      sections.invites.push({
        inviterName: item.payload.inviterName,
        targetName: item.payload.targetName || `a ${inviteWhat(item.payload.inviteType)}`,
        what: inviteWhat(item.payload.inviteType),
        url: `${clientUrl}/invite/${item.payload.code}`,
      });
    }
  }
  return {
    sections,
    counts: {
      meetingRequests: sections.meetingRequests.length,
      acceptances: sections.acceptances.length,
      messages: messageCount,
      invites: sections.invites.length,
    },
  };
}

/** The first few words of a message as an email shows them: one line, at most 200 characters. */
export function snippetOf(content: string | null | undefined, attachmentType?: string | null): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  if (attachmentType === 'image') return 'Sent you a photo';
  if (attachmentType === 'audio') return 'Sent you a voice message';
  return 'New message';
}

// ── The weekly digest ───────────────────────────────────────────────────────────────────────────────────────

export interface WeeklyFacts {
  /** Meeting requests waiting for the member's answer, oldest first. */
  waitingForYou: Array<{ userId: string; name: string }>;
  sentUnanswered: number;
  newConnections: Array<{ userId: string; name: string; conversationId: string | null }>;
  unreadMessages: number;
  /** Who wrote the oldest unread message, when one is unread. */
  oldestUnreadFrom: { name: string; conversationId: string } | null;
  upcomingEvents: Array<{ id: string; title: string; when: string; going: boolean }>;
  newMembers: number;
  newCircles: Array<{ id: string; name: string }>;
  people: Array<{ userId: string; name: string; line: string | null }>;
  profileIncomplete: boolean;
}

/** Whether the week has anything to tell this member. A week with nothing is not emailed. */
export function weeklyHasNews(f: WeeklyFacts): boolean {
  return f.waitingForYou.length > 0 || f.sentUnanswered > 0 || f.newConnections.length > 0 || f.unreadMessages > 0
    || f.upcomingEvents.length > 0 || f.newCircles.length > 0 || f.people.length > 0;
}

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * One or two concrete next steps, the most personal first: answer someone who asked to meet you, reply to the oldest
 * unread message, join the next event you are not going to yet, and complete your profile.
 */
export function weeklySuggestions(f: WeeklyFacts, clientUrl: string): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = [];
  const first = f.waitingForYou[0];
  if (first) out.push({ text: `Reply to ${firstNameOf(first.name)}`, url: `${clientUrl}/messages` });
  if (f.oldestUnreadFrom && f.oldestUnreadFrom.name !== first?.name) {
    out.push({ text: `Reply to ${firstNameOf(f.oldestUnreadFrom.name)}`, url: `${clientUrl}/messages/${f.oldestUnreadFrom.conversationId}` });
  }
  const event = f.upcomingEvents.find((e) => !e.going);
  if (event) out.push({ text: `Join ${event.title}`, url: `${clientUrl}/sessions/${event.id}` });
  if (f.profileIncomplete) out.push({ text: 'Complete your profile', url: `${clientUrl}/profile/edit` });
  return out.slice(0, 2);
}
