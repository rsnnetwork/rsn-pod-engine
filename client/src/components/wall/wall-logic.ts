// What a wall decides, and nothing it draws. Pure on purpose (no React, axios, store or router), so a test can
// run it: server/src/__tests__/client/wall-logic.test.ts. The circle wall and the pod wall both draw from
// the components in this folder, so each rule below is written once.

import { errorMessage, memberSentence } from '../../features/reason/errors';
import type { WallComment, WallCommentList, WallViewer } from './wall-types';

// ── Reactions ────────────────────────────────────────────────────────────────

export const REACTIONS = [
  { key: 'like', emoji: '👍', label: 'Like' },
  { key: 'love', emoji: '❤️', label: 'Love' },
  { key: 'applause', emoji: '👏', label: 'Applause' },
  { key: 'insightful', emoji: '💡', label: 'Insightful' },
  { key: 'celebrate', emoji: '🎉', label: 'Celebrate' },
] as const;

export const reactionOf = (key: string | null | undefined) => REACTIONS.find((r) => r.key === key) ?? null;

// ── Small words ──────────────────────────────────────────────────────────────

export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// ── The feed ─────────────────────────────────────────────────────────────────

interface FeedPageLike<P> {
  pinned: P[];
  posts: P[];
  viewer?: WallViewer;
}

/**
 * The pages of an infinite feed as one list. The pinned strip is the first page's. The server sends a pinned
 * post in the strip AND among the posts, so the ordinary list leaves it out; a post that two pages both carry
 * (a feed that moved between two reads) is shown once.
 */
export function arrangeFeed<P extends { id: string }>(
  pages: ReadonlyArray<FeedPageLike<P>> | undefined,
): { pinned: P[]; rest: P[]; viewer?: WallViewer } {
  const first = pages?.[0];
  if (!pages || !first) return { pinned: [], rest: [] };
  const seen = new Set(first.pinned.map((p) => p.id));
  const rest: P[] = [];
  for (const page of pages) {
    for (const p of page.posts) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      rest.push(p);
    }
  }
  return { pinned: first.pinned, rest, viewer: first.viewer };
}

/** What the viewer may do. The server's word on the feed wins; with none and no fallback, nothing is allowed. */
export function viewerFor(fromFeed: WallViewer | undefined, fallback: WallViewer | undefined): WallViewer {
  return fromFeed ?? fallback ?? { canPost: false, canModerate: false };
}

/**
 * Delete is a moderator's, or the author's own: a pod that is archived takes nothing new but still lets its
 * moderators clear what should not be there and its authors take their words back. It does not depend on
 * whether the viewer can post.
 */
export function canDeleteWallItem(viewer: WallViewer, authorId: string, me: string | undefined): boolean {
  return viewer.canModerate || (me !== undefined && authorId === me);
}

export const canPinWallPost = (viewer: WallViewer): boolean => viewer.canModerate;

/**
 * Edit is the author's own, and only while they may post (S4): a member of a space that is open. Someone who left
 * keeps Delete for their own words (D8) and nothing else; a moderator never edits another person's words.
 */
export function canEditWallItem(viewer: WallViewer, authorId: string, me: string | undefined): boolean {
  return viewer.canPost && me !== undefined && authorId === me;
}

/**
 * The later of two edit stamps (S4 fix round 1): the one the list shows and the one the author's last save answered, so an
 * edit reopened before the list has refreshed opens with the version the server has, and is not refused as stale.
 */
export function newerStamp(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

/** What a comment its author deleted while it had replies says in their place (fix round 1, controller ruling). */
export const WITHDRAWN_COMMENT = 'This comment was deleted.';

/** The word after the time on something its author changed. */
export const EDITED_LABEL = 'Edited';

/** What a delete says: removed now, or removed a moment before by someone else (two moderators at once). */
export const deletedSentence = (what: 'post' | 'comment', alreadyRemoved: boolean | undefined): string =>
  alreadyRemoved ? 'Already removed.' : `${what === 'post' ? 'Post' : 'Comment'} deleted.`;

/** The look of a row's text buttons (react, comment, share, edit, delete, pin): each a 44px target. */
export const WALL_ACTION_BUTTON = 'flex items-center gap-1.5 min-h-[44px] px-2 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800';

/** What a share card says when its original is not this viewer's to see, whatever the reason (S4 fix round 1). */
export const SHARED_UNAVAILABLE = "This post isn't available";

/** Where a ?post= link lands when the post has gone (removed, or never there for this viewer). */
export const LINKED_POST_REMOVED = 'This post was removed.';

// ── Long words ───────────────────────────────────────────────────────────────

/**
 * How many lines a post or a comment shows before "Show more" (S4: one 8000-character post was dozens of screens on a
 * 360px phone). Each is a literal Tailwind class so the build keeps it.
 */
export const CLAMP_CLASS = { post: 'line-clamp-[10]', comment: 'line-clamp-6' } as const;

/** The lines each clamp shows (the numbers in CLAMP_CLASS). */
export const CLAMP_LINES = { post: 10, comment: 6 } as const;

/**
 * The height (px) of `lines` lines of text with this computed line height. A line height of "normal" (no number) is taken
 * as 1.5 times the font size.
 */
export function clampHeight(lineHeight: string, fontSize: string, lines: number): number {
  const lh = parseFloat(lineHeight);
  const per = Number.isFinite(lh) ? lh : (parseFloat(fontSize) || 16) * 1.5;
  return per * lines;
}

/** Whether text drawn clamped is cut: its full height is taller than the box it is drawn in (a pixel of rounding allowed). */
export function overflowsClamp(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}

/**
 * The first `shown` posts, reaching as far as the post a link names so a ?post= link is never hidden behind
 * "Load more". `shown` unset: everything that is loaded.
 */
export function revealedPosts<P extends { id: string }>(rest: P[], shown: number | undefined, mustShowId?: string): P[] {
  if (shown === undefined) return rest;
  const at = mustShowId ? rest.findIndex((p) => p.id === mustShowId) : -1;
  return rest.slice(0, Math.max(shown, at + 1));
}

/**
 * Folds a burst of calls into one request per window. Every reaction on a pod's wall tells every member's open
 * screen to read the feed again, and a feed that has been paged through is several requests, so a burst of
 * reactions would be a burst of requests from every screen. The first call opens a window of `windowMs`; every
 * call that arrives while it is open gets the answer of the one request made when it closes, whatever `run` it
 * brought (they all ask for the same thing). A call after that opens the next window, so a steady storm is
 * answered once a window and no change is missed: whatever arrives after a request has gone out is read by the
 * next. A failed request fails every caller of its window and leaves the next window clean.
 */
export function createCoalescer(windowMs: number): <T>(run: () => Promise<T>) => Promise<T> {
  let pending: Promise<unknown> | null = null;
  return function coalesced<T>(run: () => Promise<T>): Promise<T> {
    if (!pending) {
      pending = new Promise<void>((resolve) => setTimeout(resolve, windowMs)).then(() => {
        pending = null;
        return run();
      });
    }
    return pending as Promise<T>;
  };
}

// ── Comments ─────────────────────────────────────────────────────────────────

/** The circle wall answers a list of comments, the pod wall { comments, truncated }. */
export function normalizeComments(data: unknown): WallCommentList {
  if (Array.isArray(data)) return { comments: data as WallComment[], truncated: false };
  if (data && typeof data === 'object' && Array.isArray((data as { comments?: unknown }).comments)) {
    const list = data as { comments: WallComment[]; truncated?: unknown };
    return { comments: list.comments, truncated: list.truncated === true };
  }
  return { comments: [], truncated: false };
}

/** Comments with their replies underneath, one level deep: a reply whose comment is not in the list is not drawn. */
export function threadOf<C extends { id: string; parentCommentId: string | null }>(
  all: C[],
): { tops: C[]; repliesOf: (id: string) => C[] } {
  const byParent = new Map<string, C[]>();
  for (const c of all) {
    if (c.parentCommentId) byParent.set(c.parentCommentId, [...(byParent.get(c.parentCommentId) ?? []), c]);
  }
  return {
    tops: all.filter((c) => !c.parentCommentId),
    repliesOf: (id) => byParent.get(id) ?? [],
  };
}

// ── What a failed request says ───────────────────────────────────────────────

interface FailedRequest {
  response?: { status?: number; data?: { error?: { message?: unknown } } };
}

const requestOf = (err: unknown): FailedRequest => (typeof err === 'object' && err !== null ? err : {}) as FailedRequest;
const statusOf = (err: unknown): number | undefined => requestOf(err).response?.status;

// Refusals the wall's servers write for members: not in the pod (403), gone (404), archived (409), slow down (429).
const WRITTEN_FOR_MEMBERS = [403, 404, 409, 429];

/**
 * One sentence for a failed wall request. The server's own sentence is passed on where it is a refusal written
 * for members ("This pod is archived, so its discussion is read-only", "Slow down a moment, then try again.")
 * and fit to show; a request that got no answer says the connection was lost; anything else is the caller's
 * sentence. A 404 is never "This person is no longer available": on a wall it is a post or a comment that is gone.
 */
export function wallErrorSentence(err: unknown, fallback: string): string {
  const status = statusOf(err);
  if (status !== undefined && WRITTEN_FOR_MEMBERS.includes(status)) {
    const said = memberSentence(requestOf(err).response?.data?.error?.message);
    if (said) return said;
    if (status === 404) return fallback;
  }
  return errorMessage(err, fallback);
}

/** 403 on a wall's feed: the viewer is not (or is no longer) a member of the pod or the circle. */
export const isForbidden = (err: unknown): boolean => statusOf(err) === 403;

/** 404: the post or comment is gone (removed, or never there for this viewer; the two answer alike). */
export const isNotFound = (err: unknown): boolean => statusOf(err) === 404;

/** The refusals that mean the space itself is closed to new words: a pod archived or not open, a circle archived. */
export const SPACE_CLOSED_CODES = ['POD_ARCHIVED', 'POD_NOT_ACTIVE', 'CIRCLE_ARCHIVED'] as const;

/**
 * A 409 that says the space itself changed (one of SPACE_CLOSED_CODES), as opposed to a 409 about the item (a fourth pin,
 * an edit made over another one, a post already sent): the space's own reads are then out of date (12 Nov 2026).
 */
export function isSpaceClosed(err: unknown): boolean {
  if (statusOf(err) !== 409) return false;
  const code = (requestOf(err).response?.data as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === 'string' && (SPACE_CLOSED_CODES as readonly string[]).includes(code);
}

/**
 * 409 on a write: the wall changed under the viewer, because the pod was archived or closed after the page last
 * looked. The screen that tried is refreshed, so it stops offering what the server has just refused.
 */
export const isConflict = (err: unknown): boolean => statusOf(err) === 409;

/** An answer from the server (any 4xx) is not asked again; a lost connection or a server fault gets one more try. */
export function retryUnlessAnswered(failures: number, err: unknown): boolean {
  const status = statusOf(err);
  const answered = status !== undefined && status >= 400 && status < 500;
  return !answered && failures < 1;
}
