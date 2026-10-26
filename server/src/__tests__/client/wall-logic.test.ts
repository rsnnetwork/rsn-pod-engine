// ─── What a wall decides, executed (26 Oct 2026, COM-01 client) ──────────────
//
// The circle wall and the pod wall draw from one set of components (client/src/components/wall). Everything
// those components DECIDE lives in wall-logic.ts, which has no React, axios, store or router behind it, so
// it is run here: how a feed's pages are arranged, who sees which control, what a failed request says.
// What the components DRAW is pinned in pod-wall-client.test.ts, which reads their source.

import {
  REACTIONS, arrangeFeed, canDeleteWallItem, canPinWallPost, createCoalescer, domainOf, isConflict, isForbidden, normalizeComments,
  reactionOf, retryUnlessAnswered, revealedPosts, threadOf, timeAgo, viewerFor, wallErrorSentence,
} from '../../../../client/src/components/wall/wall-logic';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';

const post = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });
const page = (posts: string[], extra: Record<string, unknown> = {}) => ({
  pinned: [] as Array<{ id: string }>, posts: posts.map((id) => post(id)), nextCursor: null as string | null, ...extra,
});

describe('arrangeFeed: the pages of a feed as one list', () => {
  it('is empty before the first page has arrived', () => {
    expect(arrangeFeed(undefined)).toEqual({ pinned: [], rest: [] });
    expect(arrangeFeed([])).toEqual({ pinned: [], rest: [] });
  });

  it('takes the pinned strip from the first page only, and keeps the order of the posts', () => {
    const first = page(['a', 'b'], { pinned: [post('p1'), post('p2')] });
    const second = page(['c', 'd'], { pinned: [post('late-pin')] });
    const arranged = arrangeFeed([first, second]);
    expect(arranged.pinned.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(arranged.rest.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves a pinned post out of the ordinary list: the server sends it in both places', () => {
    const first = page(['p1', 'a', 'p2', 'b'], { pinned: [post('p1'), post('p2')] });
    expect(arrangeFeed([first]).rest.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('shows a post once, even if two pages both carry it', () => {
    expect(arrangeFeed([page(['a', 'b']), page(['b', 'c'])]).rest.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('carries the first page\'s viewer, and none when the feed names none (the circle wall)', () => {
    const viewer = { canPost: true, canModerate: false };
    expect(arrangeFeed([page(['a'], { viewer }), page(['b'])]).viewer).toEqual(viewer);
    expect(arrangeFeed([page(['a'])]).viewer).toBeUndefined();
  });
});

describe('viewerFor: what the viewer may do', () => {
  const fallback = { canPost: true, canModerate: false };

  it('believes the feed over everything else: the server decides', () => {
    const fromFeed = { canPost: false, canModerate: true };
    expect(viewerFor(fromFeed, fallback)).toEqual(fromFeed);
  });

  it('uses the fallback when the feed names no viewer (the circle wall asks the page instead)', () => {
    expect(viewerFor(undefined, fallback)).toEqual(fallback);
  });

  it('allows nothing when neither is known, so a control never appears by default', () => {
    expect(viewerFor(undefined, undefined)).toEqual({ canPost: false, canModerate: false });
  });
});

describe('moderation and posting are two separate questions', () => {
  const me = 'me';
  const readOnly = { canPost: false, canModerate: false };
  const moderatorOfClosedPod = { canPost: false, canModerate: true };
  const member = { canPost: true, canModerate: false };

  it('an author can delete their own post or comment whatever the pod\'s state, and nobody else\'s', () => {
    for (const viewer of [readOnly, member, moderatorOfClosedPod]) {
      expect(canDeleteWallItem(viewer, me, me)).toBe(true);
    }
    expect(canDeleteWallItem(readOnly, 'someone-else', me)).toBe(false);
    expect(canDeleteWallItem(member, 'someone-else', me)).toBe(false);
  });

  it('a moderator deletes anyone\'s, also on a pod that is archived (canPost false)', () => {
    expect(canDeleteWallItem(moderatorOfClosedPod, 'someone-else', me)).toBe(true);
  });

  it('only a moderator pins, and being able to post is no part of it', () => {
    expect(canPinWallPost(moderatorOfClosedPod)).toBe(true);
    expect(canPinWallPost(member)).toBe(false);
    expect(canPinWallPost(readOnly)).toBe(false);
  });

  it('no signed-in member means no authorship, so nothing is anyone\'s own', () => {
    expect(canDeleteWallItem(readOnly, 'someone', undefined)).toBe(false);
  });
});

describe('revealedPosts: the first few posts, and more when asked', () => {
  const rest = ['a', 'b', 'c', 'd', 'e'].map((id) => post(id));

  it('shows the first N', () => {
    expect(revealedPosts(rest, 2).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('shows everything when N is more than there is, or when no limit is set', () => {
    expect(revealedPosts(rest, 50)).toHaveLength(5);
    expect(revealedPosts(rest, undefined)).toHaveLength(5);
  });

  it('reaches as far as a linked post that sits beyond the limit, so a ?post= link is never hidden', () => {
    expect(revealedPosts(rest, 2, 'd').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(revealedPosts(rest, 2, 'not-there').map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('normalizeComments: the circle wall answers a list, the pod wall an object', () => {
  const c = { id: 'c1' };

  it('reads the circle wall\'s bare list', () => {
    expect(normalizeComments([c])).toEqual({ comments: [c], truncated: false });
  });

  it('reads the pod wall\'s { comments, truncated }, and keeps the cut-off flag', () => {
    expect(normalizeComments({ comments: [c], truncated: true })).toEqual({ comments: [c], truncated: true });
    expect(normalizeComments({ comments: [c] })).toEqual({ comments: [c], truncated: false });
  });

  it('reads nothing as an empty thread', () => {
    for (const nothing of [undefined, null, {}, 'x']) {
      expect(normalizeComments(nothing)).toEqual({ comments: [], truncated: false });
    }
  });
});

describe('threadOf: comments with their replies underneath', () => {
  const list = [
    { id: 'c1', parentCommentId: null },
    { id: 'c2', parentCommentId: null },
    { id: 'r1', parentCommentId: 'c1' },
    { id: 'r2', parentCommentId: 'c2' },
    { id: 'r3', parentCommentId: 'c1' },
  ];

  it('lists the top-level comments in order, and each one\'s replies in order', () => {
    const t = threadOf(list);
    expect(t.tops.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(t.repliesOf('c1').map((c) => c.id)).toEqual(['r1', 'r3']);
    expect(t.repliesOf('c2').map((c) => c.id)).toEqual(['r2']);
    expect(t.repliesOf('nobody')).toEqual([]);
  });
});

describe('timeAgo and domainOf', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('says now, minutes and hours', () => {
    expect(timeAgo(ago(5), now)).toBe('now');
    expect(timeAgo(ago(59), now)).toBe('now');
    expect(timeAgo(ago(60), now)).toBe('1m');
    expect(timeAgo(ago(59 * 60), now)).toBe('59m');
    expect(timeAgo(ago(3600), now)).toBe('1h');
    expect(timeAgo(ago(23 * 3600), now)).toBe('23h');
  });

  it('says the date from a day on', () => {
    expect(timeAgo(ago(2 * 86400), now)).toMatch(/\d/);
    expect(timeAgo(ago(2 * 86400), now)).not.toMatch(/^\d+[mh]$/);
  });

  it('shows a link by its host, without www, and falls back to the text when it is not an address', () => {
    expect(domainOf('https://www.example.com/a/b?x=1')).toBe('example.com');
    expect(domainOf('not a url')).toBe('not a url');
  });
});

describe('reactions', () => {
  it('are the five kinds the servers accept, in the order the picker shows them', () => {
    expect(REACTIONS.map((r) => r.key)).toEqual(['like', 'love', 'applause', 'insightful', 'celebrate']);
  });

  it('are looked up by key, and null when there is none', () => {
    expect(reactionOf('love')?.label).toBe('Love');
    expect(reactionOf(null)).toBeNull();
    expect(reactionOf('angry')).toBeNull();
  });
});

describe('createCoalescer: a burst of refetches is one request', () => {
  // Every reaction on a pod's wall tells every member's open screen to read the feed again, and a feed that has
  // been paged through is several requests. A burst of those is folded into one request per window.
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs one request for every call inside the window, and every caller gets its answer', async () => {
    const run = jest.fn().mockResolvedValue('the feed');
    const coalesced = createCoalescer(200);
    const callers = [coalesced(run), coalesced(run), coalesced(run)];
    jest.advanceTimersByTime(199);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(Promise.all(callers)).resolves.toEqual(['the feed', 'the feed', 'the feed']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a call that comes in while the window is open does not push it back: a steady storm still gets an answer every window', async () => {
    const run = jest.fn().mockResolvedValue('the feed');
    const coalesced = createCoalescer(200);
    const first = coalesced(run);
    jest.advanceTimersByTime(150);
    const late = coalesced(run);
    jest.advanceTimersByTime(50);
    await expect(Promise.all([first, late])).resolves.toEqual(['the feed', 'the feed']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a call after the request has gone out opens a new window, and gets its own request', async () => {
    const run = jest.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const coalesced = createCoalescer(200);
    const one = coalesced(run);
    jest.advanceTimersByTime(200);
    await expect(one).resolves.toBe('first');
    const two = coalesced(run);
    jest.advanceTimersByTime(200);
    await expect(two).resolves.toBe('second');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a request that fails fails every caller of its window, and the next window starts clean', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('back');
    const coalesced = createCoalescer(200);
    const callers = [coalesced(run), coalesced(run)];
    const settled = Promise.allSettled(callers);
    jest.advanceTimersByTime(200);
    expect((await settled).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const next = coalesced(run);
    jest.advanceTimersByTime(200);
    await expect(next).resolves.toBe('back');
  });
});

// What axios hands a catch block when the server refused: the error envelope under response.data.
const refused = (status: number, error: { message?: unknown; details?: unknown } = {}) =>
  ({ isAxiosError: true, response: { status, data: { success: false, error } } });
const FALLBACK = 'Could not post.';

describe('wallErrorSentence: what a failed wall request says', () => {
  it('passes on the server\'s own sentence for the refusals written for members', () => {
    expect(wallErrorSentence(refused(429, { message: 'Slow down a moment, then try again.' }), FALLBACK))
      .toBe('Slow down a moment, then try again.');
    expect(wallErrorSentence(refused(429, { message: 'You\'re posting too fast - give it a moment' }), FALLBACK))
      .toBe('You\'re posting too fast - give it a moment');
    expect(wallErrorSentence(refused(409, { message: 'This pod is archived, so its discussion is read-only' }), FALLBACK))
      .toBe('This pod is archived, so its discussion is read-only');
    expect(wallErrorSentence(refused(403, { message: 'Join this pod to read and post in its discussion' }), FALLBACK))
      .toBe('Join this pod to read and post in its discussion');
  });

  it('says what is gone, never the profile page\'s "This person is no longer available"', () => {
    const said = wallErrorSentence(refused(404, { message: 'That post could not be found' }), FALLBACK);
    expect(said).toBe('That post could not be found');
    expect(said).not.toMatch(/person/i);
  });

  it('says the connection was lost when nothing came back, never the library\'s words', () => {
    const networkError = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', request: {} });
    expect(wallErrorSentence(networkError, FALLBACK)).toBe(CONNECTION_LOST);
    expect(wallErrorSentence(networkError, FALLBACK)).not.toMatch(/Network Error|AxiosError/);
  });

  it('uses the caller\'s sentence for a server fault, for text with an id in it, and for code words', () => {
    expect(wallErrorSentence(refused(500, { message: 'Internal server error' }), FALLBACK)).toBe(FALLBACK);
    expect(wallErrorSentence(refused(404, { message: 'Post with id 3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03 not found' }), FALLBACK)).toBe(FALLBACK);
    expect(wallErrorSentence(refused(403, { message: 'poke refused' }), FALLBACK)).toBe(FALLBACK);
    expect(wallErrorSentence(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('reads a validation failure from its details, not from "Validation failed"', () => {
    expect(wallErrorSentence(refused(400, { message: 'Validation failed', details: { content: ['Keep a post to 8000 characters.'] } }), FALLBACK))
      .toBe('Keep a post to 8000 characters.');
    expect(wallErrorSentence(refused(400, { message: 'Validation failed', details: {} }), FALLBACK)).toBe(FALLBACK);
  });
});

describe('forbidden, conflict and retry', () => {
  it('a 403 is the one answer that means "not a member of this pod"', () => {
    expect(isForbidden(refused(403))).toBe(true);
    for (const e of [refused(404), refused(409), refused(429), refused(500), undefined, null, 'x']) expect(isForbidden(e)).toBe(false);
  });

  it('a 409 is the one answer that means the wall changed under the viewer (the pod was archived, or closed, since the page last looked)', () => {
    expect(isConflict(refused(409, { message: 'This pod is archived, so its discussion is read-only' }))).toBe(true);
    for (const e of [refused(400), refused(403), refused(404), refused(429), refused(500), undefined, null, 'x']) expect(isConflict(e)).toBe(false);
  });

  it('an answer is not asked again; a lost connection or a server fault gets one more try', () => {
    for (const status of [400, 403, 404, 409, 429]) expect(retryUnlessAnswered(0, refused(status))).toBe(false);
    expect(retryUnlessAnswered(0, refused(500))).toBe(true);
    expect(retryUnlessAnswered(0, { isAxiosError: true })).toBe(true);
    expect(retryUnlessAnswered(1, refused(500))).toBe(false);
  });
});
