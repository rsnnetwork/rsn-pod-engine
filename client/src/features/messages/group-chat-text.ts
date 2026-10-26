// ─── Group chats in Messages: what the screens say and the rules they follow (26 Oct 2026, C12, COM-04) ───
//
// Stefan, 25 Oct: "Can there be 3, 5, 10, 20, 50 people in a chat? There should be." A group chat holds 3 to 50
// people, its creator included (the server holds the line, S9), and the product says so. The people who ran a
// completed event start one with those who took part; it lives in Messages beside the one-to-one conversations.
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/c12-group-chats.test.ts.
import { z } from 'zod';
import { GROUP_CHAT_MAX_MEMBERS, GROUP_CHAT_MIN_MEMBERS } from '@rsn/shared';
import type { DmGroupLastMessage, DmGroupMember, DmGroupSummary, GroupChatMessage, GroupChatMessagePage } from '@rsn/shared';
import { CONNECTION_LOST, memberSentence } from '../reason/errors';
import { sameLocalDay } from './message-time';

// ── The cap, said in the product ──
export const GROUP_LIMIT = `Group chats hold up to ${GROUP_CHAT_MAX_MEMBERS} people.`;
// The server's own words for the two sizes it refuses (group.service.ts, GROUP_COPY), so a refusal and the screen agree.
export const GROUP_FULL = `This group is full (${GROUP_CHAT_MAX_MEMBERS} people).`;
export const GROUP_TOO_SMALL = `A group chat needs at least ${GROUP_CHAT_MIN_MEMBERS} people.`;

// ── Starting one from a completed event ──
export const START_TITLE = 'Start a group chat';
export const START_INTRO = 'Talk with the people who took part, all together, in Messages.';
export const START_SUBMIT = 'Start group chat';
export const START_MANY = `More than ${GROUP_CHAT_MAX_MEMBERS - 1} people took part. Choose up to ${GROUP_CHAT_MAX_MEMBERS - 1}, or use Message everyone who took part to reach them all.`;
export const START_FAILED = 'The group chat could not be started. Try again.';
export const PEOPLE_LEGEND = 'People who took part';
export const PEOPLE_FAILED = "We couldn't load who took part.";
export const EVENT_GROUPS = 'Your group chats from this event';

// ── The inbox ──
export const GROUPS_FAILED = "We couldn't load your group chats.";
export const NO_MESSAGES_YET = 'No messages yet';

// ── The thread ──
export const GROUP_EMPTY = 'No messages yet. Say hello to the group.';
export const GROUP_GONE = 'This group chat could not be found.';
export const NOT_IN_GROUP = 'You are not in this group.';
export const GROUP_FAILED = "We couldn't load this group chat.";
export const EARLIER_FAILED = "We couldn't load the earlier messages.";
export const SEND_FAILED = 'Your message could not be sent. Try again.';
export const SHOW_EARLIER = 'Show earlier messages';
export const TRY_AGAIN = 'Try again';
export const BACK_TO_MESSAGES = 'Back to Messages';
export const MESSAGE_PLACEHOLDER = 'Write to the group…';
export const MESSAGE_PLACEHOLDER_SHORT = 'Message…';

// ── The members sheet ──
export const MEMBERS_TITLE = 'Members';
export const MEMBERS_FAILED = "We couldn't load the members.";
export const ADMIN = 'Admin';
export const YOU = 'You';
export const CANCEL = 'Cancel';
export const REMOVE = 'Remove';
export const REMOVE_FAILED = 'They could not be removed. Try again.';
export const LEAVE = 'Leave group';
export const LEAVE_WARNING = "You will stop getting its messages. Only the group's admin can add you back.";
export const LEAVE_FAILED = 'You could not leave the group. Try again.';
export const ADD_TITLE = 'Add people who took part';
export const ADD_PEOPLE = 'Add people';
export const ADD_FAILED = 'They could not be added. Try again.';
export const EVERYONE_IN = 'Everyone who took part is already in the group.';
// The server's words (routes/groups.ts): the name a closed account goes by, and an add with nobody chosen.
export const FORMER_MEMBER = 'Former member';
export const CHOOSE_SOMEONE = 'Choose someone to add.';

// ── The message box: the server's limits and its words for them (routes/groups.ts) ──
export const GROUP_MESSAGE_MAX = 4000;
export const WRITE_FIRST = 'Write a message first.';
export const MESSAGE_TOO_LONG = `Messages can be up to ${GROUP_MESSAGE_MAX} characters.`;

export const sendSchema = z.object({
  content: z.string().trim().min(1, WRITE_FIRST).max(GROUP_MESSAGE_MAX, MESSAGE_TOO_LONG),
});
export type SendValues = z.infer<typeof sendSchema>;

/** The start sheet: the people chosen, 3 to 50 with the organiser (the problem sits on the field, so the form says it). */
export const startSchema = z.object({
  memberIds: z.array(z.string()).superRefine((ids, ctx) => {
    const problem = startProblem(ids.length);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
});
export type StartValues = z.infer<typeof startSchema>;

/** "Add people": at least one chosen. */
export const addSchema = z.object({ userIds: z.array(z.string()).min(1, CHOOSE_SOMEONE) });
export type AddValues = z.infer<typeof addSchema>;

/** The header's count: "12 of 50". */
export function ofMax(memberCount: number): string {
  return `${memberCount} of ${GROUP_CHAT_MAX_MEMBERS}`;
}

/** "1 person", "3 people". */
export function memberCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** "Add 1 person", "Add 3 people". */
export function addLabel(n: number): string {
  return `Add ${memberCountLabel(n)}`;
}

export const removeAsk = (name: string) => `Remove ${name} from the group?`;
export const removedSentence = (name: string) => `${name} is no longer in the group.`;
export const leftSentence = (groupName: string) => `You left ${groupName}.`;
export const addedSentence = (n: number) => `Added ${memberCountLabel(n)}.`;

// ── The inbox ────────────────────────────────────────────────────────────────

/** The last message's line in the inbox: "You: …" for the reader's own, else "{sender}: …". */
export function groupPreview(last: DmGroupLastMessage | null, myUserId: string | undefined): string | null {
  if (!last) return null;
  return `${last.fromUserId === myUserId ? YOU : last.senderName}: ${last.content}`;
}

/** The groups' part of the Messages badge. */
export function groupUnreadTotal(groups: DmGroupSummary[] | undefined): number {
  return (groups ?? []).reduce((sum, g) => sum + g.unreadCount, 0);
}

export type InboxRow<C> =
  | { kind: 'dm'; key: string; at: string | null; conversation: C }
  | { kind: 'group'; key: string; at: string | null; group: DmGroupSummary };

const timeOf = (at: string | null) => (at ? Date.parse(at) : Number.NEGATIVE_INFINITY);

/**
 * The inbox: one-to-one conversations and groups in one list, the latest activity first. A conversation's is its last
 * message (none yet: last, as the server lists them); a group's is its last message the reader can see, or when it was
 * started. The sort is stable, so each list keeps the server's own order between equal times, conversations first.
 */
export function mergeInbox<C extends { conversationId: string; lastMessageAt: string | null }>(
  conversations: C[],
  groups: DmGroupSummary[],
): InboxRow<C>[] {
  const rows: InboxRow<C>[] = [
    ...conversations.map((c): InboxRow<C> => ({ kind: 'dm', key: `c:${c.conversationId}`, at: c.lastMessageAt, conversation: c })),
    ...groups.map((g): InboxRow<C> => ({ kind: 'group', key: `g:${g.id}`, at: g.lastMessageAt ?? g.createdAt, group: g })),
  ];
  return rows.sort((a, b) => {
    const ta = timeOf(a.at);
    const tb = timeOf(b.at);
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  });
}

// ── The thread ───────────────────────────────────────────────────────────────

/** The pages read so far (each newest first, each next one older), as one list oldest first, every message once. */
export function threadInOrder(pages: GroupChatMessagePage[]): GroupChatMessage[] {
  const byId = new Map<string, GroupChatMessage>();
  for (const page of pages) for (const m of page.messages) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The newest message someone else wrote (the list is oldest first): the read mark follows it. */
export function newestFromOthers(messages: GroupChatMessage[], myUserId: string | undefined): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].fromUserId !== myUserId) return messages[i].id;
  return null;
}

export interface GroupCluster { senderId: string; messages: GroupChatMessage[] }

/** Messages one person sent within a minute of each other, on the same day, are drawn together under one name. */
const CLUSTER_GAP_MS = 60_000;

export function clusterGroupMessages(messages: GroupChatMessage[]): GroupCluster[] {
  const clusters: GroupCluster[] = [];
  for (const m of messages) {
    const last = clusters[clusters.length - 1];
    const prev = last?.messages[last.messages.length - 1];
    const joins = !!prev && prev.fromUserId === m.fromUserId
      && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < CLUSTER_GAP_MS
      && sameLocalDay(new Date(prev.createdAt), new Date(m.createdAt));
    if (joins && last) last.messages.push(m);
    else clusters.push({ senderId: m.fromUserId, messages: [m] });
  }
  return clusters;
}

// ── What went wrong ──────────────────────────────────────────────────────────

interface FailedRequest {
  isAxiosError?: unknown;
  request?: unknown;
  response?: { status?: number; data?: { error?: { message?: unknown; details?: unknown } } };
}

const asFailed = (err: unknown): FailedRequest => (typeof err === 'object' && err !== null ? err : {}) as FailedRequest;

/** Why a group could not be opened: it is not there (404), the reader is not in it (403), or it failed to load. */
export function groupLoadProblem(err: unknown): 'gone' | 'not-member' | 'failed' {
  const status = asFailed(err).response?.status;
  if (status === 404) return 'gone';
  if (status === 403) return 'not-member';
  return 'failed';
}

/** The first message of a validation failure's details ({ field: [messages] }). */
function firstDetail(details: unknown): unknown {
  if (!details || typeof details !== 'object') return undefined;
  for (const messages of Object.values(details)) {
    if (Array.isArray(messages) && messages.length > 0) return messages[0];
  }
  return undefined;
}

/**
 * One sentence for a group request that failed: the server's own words when they are ones a member can read (every
 * refusal of the group routes is a sentence: full, too small, not the admin, not in the group, slow down), the
 * connection when there was no answer, else the caller's plain sentence.
 */
export function groupErrorSentence(err: unknown, fallback: string): string {
  const failed = asFailed(err);
  const response = failed.response;
  if (!response) return failed.isAxiosError === true || failed.request != null ? CONNECTION_LOST : fallback;
  const error = response.data?.error;
  switch (response.status) {
    case 400:
      // A 400 with details is a validation failure, whose generic message ("Validation failed") is never shown.
      if (error?.details != null) return memberSentence(firstDetail(error.details)) ?? fallback;
      return memberSentence(error?.message) ?? fallback;
    case 403:
    case 404:
    case 409:
    case 429:
      return memberSentence(error?.message) ?? fallback;
    default:
      return fallback;
  }
}

// ── Choosing people: starting a group from an event, and adding to one ────────

/** One row of GET /api/sessions/:id/participants, as far as choosing people needs it. */
export interface EventPerson {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  status: string;
  joinedAt: string | null;
}

/**
 * The people who took part in an event, as the server counts them: they came in (joinedAt is set) and the organisers
 * did not remove them. Never anyone in `exclude` (the reader, the group's members), and each person once. The server
 * also leaves out closed accounts and anyone blocked, and says so if one is chosen.
 */
export function tookPart<P extends EventPerson>(participants: P[], exclude: Iterable<string>): P[] {
  const skip = new Set(exclude);
  const out: P[] = [];
  for (const p of participants) {
    if (!p.joinedAt || p.status === 'removed' || skip.has(p.userId)) continue;
    skip.add(p.userId);
    out.push(p);
  }
  return out;
}

const nameOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const nameOf = (p: { displayName?: string | null }) => p.displayName?.trim() ?? '';

/** People to choose from, by name ("Guest 2" before "Guest 10"), as a new list. */
export function byName<P extends { displayName?: string | null }>(people: P[]): P[] {
  return [...people].sort((a, b) => nameOrder.compare(nameOf(a), nameOf(b)));
}

/** A group's members as the sheet lists them: the admin first, then by when they joined, people who joined together by name. */
export function membersInOrder(members: DmGroupMember[]): DmGroupMember[] {
  return [...members].sort((a, b) =>
    Number(b.role === 'admin') - Number(a.role === 'admin')
    || Date.parse(a.joinedAt) - Date.parse(b.joinedAt)
    || nameOrder.compare(nameOf(a), nameOf(b)));
}

/** Who is chosen when the start sheet opens: everyone, when they all fit with the organiser; else nobody yet. */
export function startChosen(candidates: EventPerson[]): string[] {
  return candidates.length <= GROUP_CHAT_MAX_MEMBERS - 1 ? candidates.map((p) => p.userId) : [];
}

/** Why a group of the organiser and `chosenOthers` people cannot start, in the server's words, or null when it can. */
export function startProblem(chosenOthers: number): string | null {
  const total = chosenOthers + 1;
  if (total < GROUP_CHAT_MIN_MEMBERS) return GROUP_TOO_SMALL;
  if (total > GROUP_CHAT_MAX_MEMBERS) return GROUP_FULL;
  return null;
}

/** How many more people a group of `memberCount` with `chosen` more on the way can still take. */
export function roomLeft(memberCount: number, chosen: number): number {
  return Math.max(0, GROUP_CHAT_MAX_MEMBERS - memberCount - chosen);
}

/**
 * The start request. Everyone who took part chosen: no list, so the server takes everyone who took part (and skips
 * anyone it would refuse, such as a closed account). Otherwise the chosen people, by id.
 */
export function startBody(chosen: string[], candidates: EventPerson[]): { memberIds?: string[] } {
  const picked = new Set(chosen);
  const everyone = candidates.length <= GROUP_CHAT_MAX_MEMBERS - 1
    && candidates.length === picked.size
    && candidates.every((p) => picked.has(p.userId));
  return everyone ? {} : { memberIds: chosen };
}
