// client/src/features/messages/bubble-look.ts
// How a chat bubble looks, and how a thread's messages run together, in every chat: the one-to-one thread, the group
// thread and the live event's chat (30 Oct 2026 review, item 4.6, L9). Pure on purpose (no React), so a test can run
// it: server/src/__tests__/client/t6-messaging.test.ts.
//
// Stefan: "the red color is too strong; change it to gray so new messages still stand out." Your own bubble is gray,
// theirs is white with a border, and the two are told apart by side, fill and border. Red is kept for what is new
// (unread badges and dots) and for primary buttons. A link in either bubble is the bubble's own text colour,
// underlined (BUBBLE_LINK): neither the old forced white nor Linkify's red.

/** Your own message. */
export const OWN_BUBBLE = 'bg-gray-100 text-gray-900';

/** Someone else's message. */
export const THEIR_BUBBLE = 'bg-white border border-gray-200 text-gray-900';

/**
 * A link inside a bubble, own or theirs, in the live chat too: the bubble's own text colour, underlined. Not Linkify's
 * default brand red: L9 keeps red for unread badges and primary buttons only (T6 fix round 1).
 */
export const BUBBLE_LINK = 'break-all underline underline-offset-2 hover:opacity-80';

/** The fill of a bubble, by who wrote it. */
export const bubbleLook = (mine: boolean): string => (mine ? OWN_BUBBLE : THEIR_BUBBLE);

/** One person's messages written within a minute of each other run together under one name, avatar and time. */
export const CLUSTER_GAP_MS = 60_000;

/** What clustering needs of a message. */
export interface Clusterable {
  fromUserId: string;
  createdAt: string;
  /** 'system': a card the product wrote, which never runs together with anyone's messages. */
  kind?: string;
}

export interface Cluster<T extends Clusterable> {
  senderId: string;
  messages: T[];
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The thread's messages (oldest first) as runs: one person's messages within CLUSTER_GAP_MS of the last one, on the same
 * local day, and never a system card. The one-to-one and the group thread both draw from this (P18, 26 Oct 2026).
 */
export function clusterMessages<T extends Clusterable>(messages: T[]): Array<Cluster<T>> {
  const clusters: Array<Cluster<T>> = [];
  for (const m of messages) {
    const last = clusters[clusters.length - 1];
    const prev = last?.messages[last.messages.length - 1];
    const joins = !!prev && prev.fromUserId === m.fromUserId
      && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < CLUSTER_GAP_MS
      && sameLocalDay(new Date(prev.createdAt), new Date(m.createdAt))
      && m.kind !== 'system' && prev.kind !== 'system';
    if (joins && last) last.messages.push(m);
    else clusters.push({ senderId: m.fromUserId, messages: [m] });
  }
  return clusters;
}
