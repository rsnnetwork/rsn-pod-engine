// ─── Walls that work for owners, on screen (Shirley pilot S4, 11 Nov 2026) ───────────────────────────────────────
//
// The circle wall's configuration and the wall's pure rules are run; the components are React, which jest does not
// load, so, like the other files here, they are read as source.
//
// What S4 changed on screen: the circle wall follows its entity tags and never polls; every circle wall is shown to its
// members only (anyone else reads "join"); the server says who moderates (the circle's owner and moderators); authors
// edit their own posts and comments in place, which then say "Edited"; long words are cut with "Show more"; a link to
// a post opens it with its comments; a link to a post that has gone says "This post was removed." where it would be.

import * as fs from 'fs';
import * as path from 'path';
import { E as clientE } from '../../../../client/src/realtime/entities';
import { E as serverE } from '../../realtime/entities';
import {
  CIRCLE_WALL_NOT_MEMBER, circleCannotPostNote, circleWallConfig,
} from '../../../../client/src/features/circles/circle-wall-config';
import {
  CLAMP_CLASS, CLAMP_LINES, EDITED_LABEL, LINKED_POST_REMOVED, SHARED_UNAVAILABLE, WITHDRAWN_COMMENT, canDeleteWallItem, canEditWallItem,
  clampHeight, deletedSentence, newerStamp, overflowsClamp,
} from '../../../../client/src/components/wall/wall-logic';
import { CIRCLE_WALL_MEMBERS_ONLY } from '../../services/circle/circle-wall.service';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const NL = String.fromCharCode(10);
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const CIRCLE = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';
const POST = '9a1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
const ME = 'c0ffee00-0000-4000-8000-000000000001';

describe('the circle wall\'s tags are the server\'s, letter for letter', () => {
  it('circle:<id>:wall and circle-wall-post:<id>, the same on both sides', () => {
    expect(clientE.circleWall(CIRCLE)).toBe(`circle:${CIRCLE}:wall`);
    expect(clientE.circleWall(CIRCLE)).toBe(serverE.circleWall(CIRCLE));
    expect(clientE.circleWallPost(POST)).toBe(`circle-wall-post:${POST}`);
    expect(clientE.circleWallPost(POST)).toBe(serverE.circleWallPost(POST));
  });

  it('neither collides with the circle\'s own tags, which a wall change must not re-send', () => {
    const own = [clientE.circle(CIRCLE), clientE.circleMembers(CIRCLE), clientE.circleInvites(CIRCLE), clientE.circleRequests(CIRCLE)];
    expect(own).not.toContain(clientE.circleWall(CIRCLE));
    expect(own).not.toContain(clientE.circleWallPost(CIRCLE));
  });
});

describe('the circle wall\'s configuration', () => {
  const config = circleWallConfig({ circleId: CIRCLE, me: ME, isMember: true });

  it('reads and writes the circle routes', () => {
    expect(config.feedPath).toBe(`/circles/${CIRCLE}/posts`);
    expect(config.itemBase).toBe('/circles');
  });

  it('the feed declares the wall, the circle (archived or not), the viewer\'s place in it and their blocks', () => {
    expect(config.entities.feed).toEqual([`circle:${CIRCLE}:wall`, `circle:${CIRCLE}`, `circle:${CIRCLE}:members`, `user:${ME}:blocks`]);
    expect(config.entities.post(POST)).toEqual([...config.entities.feed, `circle-wall-post:${POST}`]);
    expect(config.entities.comments(POST)).toEqual([`circle-wall-post:${POST}`, `user:${ME}:blocks`]);
  });

  it('writes no tag for a member it does not know yet', () => {
    const anonymous = circleWallConfig({ circleId: CIRCLE, me: undefined, isMember: true });
    expect(JSON.stringify([anonymous.entities.feed, anonymous.entities.comments(POST)])).not.toMatch(/undefined/);
  });

  it('never polls', () => {
    expect('pollMs' in config).toBe(false);
    expect('refetchInterval' in config).toBe(false);
  });

  it('keeps its cache entries apart from every pod\'s and from one another, each under the circle', () => {
    expect(config.keys.feed).toEqual(['circleWall', CIRCLE]);
    expect(config.keys.post(POST)).toEqual(['circleWall', CIRCLE, 'post', POST]);
    expect(config.keys.comments(POST)).toEqual(['circleWall', CIRCLE, 'comments', POST]);
  });

  it('a link to a post opens its comments (a bell about a new post or a comment lands on the thread)', () => {
    expect(config.openCommentsOnLink).toBe(true);
  });

  it('someone outside reads the same sentence the server writes (D2), and no like or react button that only explains', () => {
    expect(config.copy.notMember).toBe(CIRCLE_WALL_NOT_MEMBER);
    expect(CIRCLE_WALL_NOT_MEMBER).toBe(CIRCLE_WALL_MEMBERS_ONLY);
    expect(config.copy.reactNeedsMembership).toBeUndefined();
    expect(config.copy.likeNeedsMembership).toBeUndefined();
  });

  it('says why the composer is not there: an archived circle, or an admin who reads and moderates without being in it', () => {
    expect(circleCannotPostNote(true)).toBe('This circle is archived, so its wall is read-only.');
    expect(circleCannotPostNote(false)).toBe('You can read and moderate this wall. Join the circle to post.');
  });
});

describe('the wall\'s rules for S4', () => {
  const member = { canPost: true, canModerate: false };
  const moderator = { canPost: true, canModerate: true };
  const left = { canPost: false, canModerate: false };

  it('edit is the author\'s own, while they may post; a moderator never edits another person\'s words', () => {
    expect(canEditWallItem(member, ME, ME)).toBe(true);
    expect(canEditWallItem(moderator, 'someone', ME)).toBe(false);
    expect(canEditWallItem(left, ME, ME)).toBe(false);
    expect(canEditWallItem(member, ME, undefined)).toBe(false);
  });

  it('D8: someone who can no longer post still deletes their own words', () => {
    expect(canDeleteWallItem(left, ME, ME)).toBe(true);
    expect(canDeleteWallItem(left, 'someone', ME)).toBe(false);
  });

  it('a delete says whether it removed it or someone had a moment before', () => {
    expect(deletedSentence('post', false)).toBe('Post deleted.');
    expect(deletedSentence('comment', undefined)).toBe('Comment deleted.');
    expect(deletedSentence('post', true)).toBe('Already removed.');
  });

  it('text is cut only when its full height is taller than the clamp', () => {
    expect(overflowsClamp(400, 200)).toBe(true);
    expect(overflowsClamp(201, 200)).toBe(false);
    expect(overflowsClamp(150, 200)).toBe(false);
  });

  it('the clamps are literal Tailwind classes (ten lines for a post, six for a comment), so the build keeps them', () => {
    expect(CLAMP_CLASS).toEqual({ post: 'line-clamp-[10]', comment: 'line-clamp-6' });
    expect(EDITED_LABEL).toBe('Edited');
    expect(LINKED_POST_REMOVED).toBe('This post was removed.');
  });
});

describe('the screens', () => {
  const circleWall = read('features/circles/CircleWall.tsx');
  const page = read('features/circles/CircleDetailPage.tsx');
  const wall = read('components/wall/Wall.tsx');
  const held = read('components/wall/useHeldPostEdit.ts');
  const notices = read('components/wall/WallNotices.tsx');
  // S4 fix round 1: the post card is split into its body, reactions and actions; the comment row out of the comments.
  const card = ['WallPostCard', 'WallPostBody', 'WallPostActions', 'WallPostReactions'].map((f) => read(`components/wall/${f}.tsx`)).join(NL);
  const comments = ['WallComments', 'WallCommentRow'].map((f) => read(`components/wall/${f}.tsx`)).join(NL);
  const clamped = read('components/wall/ClampedText.tsx');
  const form = read('components/wall/WallEditForm.tsx');

  it('the circle wall shows someone outside the circle no posts and asks for none (D2); the page passes who runs it', () => {
    expect(circleWall).toMatch(/if \(!isMember && !admin\) return <WallNotMember config=\{config\} \/>;/);
    expect(circleWall).not.toMatch(/pollMs|refetchInterval/);
    expect(page).toMatch(/<CircleWall circleId=\{circle\.id\} isMember=\{circle\.isMember\} canManage=\{!!circle\.canManage\} highlightPostId=\{highlightPostId\} \/>/);
  });

  it('a post: Edit by canEditWallItem, saved with PATCH and the stamp the edit opened with; "Edited" after the time', () => {
    expect(card).toMatch(/const mayEdit = canEditWallItem\(viewer, p\.authorId, userId\);/);
    expect(card).toMatch(/api\.patch\(`\$\{config\.itemBase\}\/posts\/\$\{p\.id\}`, \{ content: text, expectedEditedAt: edit\?\.stamp \?\? null \}\)/);
    expect(card).toMatch(/\{editedAt && <span data-testid=\{`post-edited-\$\{p\.id\}`\}> · \{EDITED_LABEL\}<\/span>\}/);
    expect(card).toMatch(/aria-label="Edit post"/);
  });

  it('a post\'s words are cut with "Show more", and a post a link names opens in full with its comments', () => {
    expect(card).toMatch(/<ClampedText text=\{content\} kind="post" open=\{highlighted\}/);
    expect(card).toMatch(/if \(config\.openCommentsOnLink\) setOpenComments\(true\);/);
    expect(card).not.toMatch(/openCommentsOnLink && p\.commentCount > 0/);
  });

  it('a delete that someone else made a moment before says so', () => {
    expect(card).toMatch(/deletedSentence\('post', res\.data\?\.data\?\.alreadyRemoved\)/);
    expect(comments).toMatch(/deletedSentence\('comment', r\.data\?\.data\?\.alreadyRemoved\)/);
  });

  it('the wall holds the edit, so a post removed while it is open stays as "This post was removed." with the text', () => {
    expect(held).toMatch(/const \[editing, setEditing\] = useState</);
    expect(wall).toMatch(/\{heldPost && card\(heldPost\.post, false, false, heldPost\.gone\)\}/);
    expect(card).toMatch(/gone=\{gone \? LINKED_POST_REMOVED : undefined\}/);
  });

  it('fix round 1: an edited post pushed off the loaded pages is looked up by id, and only a 404 makes it "removed"', () => {
    expect(held).toMatch(/queryFn: \(\) => api\.get\(`\$\{config\.itemBase\}\/posts\/\$\{out\}`\)/);
    expect(held).toMatch(/meta: \{ entities: config\.entities\.post\(out \?\? ''\) \}/);
    expect(held).toMatch(/gone: out !== undefined && lookup\.isError && isNotFound\(lookup\.error\)/);
    expect(held).toMatch(/loaded\.rest\.find\(\(p\) => p\.id === editing\.post\.id\) \?\? \(out \? lookup\.data : undefined\) \?\? editing\.post/);
  });

  it('a link to a post that has gone says "This post was removed." where it would be, not in a passing toast', () => {
    // While its author's edit of it is open, the edit itself says it was removed (once, not twice).
    expect(wall).toMatch(/const linkedOut = wanted !== undefined && !loadedIds\.has\(wanted\) && linked\.isError && held\.editingId !== wanted;/);
    expect(notices).toMatch(/data-testid=\{`\$\{config\.testId\}-linked-removed`\}/);
    expect(wall).not.toMatch(/That post is no longer available/);
  });

  it('fix round 1: only a 404 says "removed"; offline or a server fault says so in words and offers Try again', () => {
    expect(wall).toMatch(/const linkedGone = linkedOut && isNotFound\(linked\.error\);/);
    expect(wall).toMatch(/const linkedFailed = linkedOut && !isNotFound\(linked\.error\);/);
    expect(notices).toMatch(/wallErrorSentence\(error, 'We could not open that post just now\.'\)/);
    expect(notices).toMatch(/data-testid=\{`\$\{config\.testId\}-linked-failed`\}/);
    expect(notices).toMatch(/onClick=\{onRetry\} className="mt-2 min-h-\[44px\]">Try again</);
  });

  it('a comment: Edit by canEditWallItem, PATCH with its stamp, "Edited", cut at six lines, held when it goes', () => {
    expect(comments).toMatch(/canEditWallItem\(viewer, c\.authorId, userId\)/);
    expect(comments).toMatch(/api\.patch\(`\$\{config\.itemBase\}\/comments\/\$\{c\.id\}`, \{ content: text, expectedEditedAt: editing\?\.stamp \?\? null \}\)/);
    expect(comments).toMatch(/\{c\.editedAt && <span[^>]*> · \{EDITED_LABEL\}<\/span>\}/);
    expect(comments).toMatch(/<ClampedText text=\{c\.content\} kind="comment"/);
    expect(comments).toMatch(/gone=\{gone \? 'This comment was removed\.' : undefined\}/);
  });

  it('fix round 1: a comment edit reopened right after a save opens with the version the server answered', () => {
    expect(comments).toMatch(/saved\.current\[c\.id\] = \{ content: text, editedAt:/);
    expect(comments).toMatch(/const stamp = newerStamp\(c\.editedAt, mine\?\.editedAt\);/);
    expect(comments).toMatch(/onEdit=\{\(\) => setEditing\(openedEdit\(c\)\)\}/);
  });

  it('fix round 1: a withdrawn comment says "This comment was deleted." with its replies under it; only a moderator can clear it', () => {
    expect(comments).toMatch(/if \(c\.withdrawn\) \{/);
    expect(comments).toMatch(/\{WITHDRAWN_COMMENT\}/);
    expect(comments).toMatch(/\{viewer\.canModerate && \(/);
    expect(comments).toMatch(/The replies stay\. This cannot be undone\./);
  });

  it("fix round 1: a share card the viewer may not see says only \"This post isn't available\"", () => {
    expect(card).toMatch(/\) : p\.sharedUnavailable && \(/);
    expect(card).toMatch(/\{SHARED_UNAVAILABLE\}/);
    expect(card).toMatch(/allowEmpty=\{p\.media\.length > 0 \|\| !!p\.sharedFrom \|\| !!p\.sharedUnavailable\}/);
  });

  it('fix round 10: no wall component is over 200 lines', () => {
    for (const f of ['Wall', 'WallPostCard', 'WallPostBody', 'WallPostActions', 'WallPostReactions', 'WallCommentRow', 'WallNotices', 'ClampedText', 'WallEditForm']) {
      const lines = read(`components/wall/${f}.tsx`).split(NL).length;
      expect({ f, under200: lines <= 200 }).toEqual({ f, under200: true });
    }
  });

  it('long words never scroll sideways at 360px, and "Show more" is a 44px target measured from the box', () => {
    expect(clamped).toMatch(/min-w-0 whitespace-pre-wrap break-words \[overflow-wrap:anywhere\]/);
    expect(clamped).toMatch(/CLAMP_CLASS\[kind\]/);
    expect(clamped).toMatch(/new ResizeObserver\(measure\)/);
    // Fix round 1: drawn open from a link, it is measured against the clamp's lines, so it still offers "Show less".
    expect(clamped).toMatch(/clampHeight\(style\.lineHeight, style\.fontSize, CLAMP_LINES\[kind\]\)/);
    expect(clamped).not.toMatch(/if \(!el \|\| expanded\) return/);
    expect(clamped).toMatch(/className="min-h-\[44px\]/);
  });

  it('the edit form keeps the text on a refusal, says why under the box, and its buttons are 44px', () => {
    expect(form).toMatch(/setError\(wallErrorSentence\(err, 'Could not save your changes\. Try again\.'\)\)/);
    expect(form).not.toMatch(/onDraft\(''\)/);
    expect(form).toMatch(/role="alert"/);
    expect((form.match(/min-h-\[44px\] min-w-\[44px\]/g) ?? []).length).toBe(2);
    expect(form).toMatch(/e\.key === 'Escape'/);
  });

  it('nothing in the new pieces writes the cache by hand or polls', () => {
    for (const src of [clamped, form, circleWall, read('features/circles/circle-wall-config.ts')]) {
      expect(src).not.toMatch(/setQueryData|setInterval|refetchInterval|window\.location\.reload/);
    }
  });
});

describe('fix round 1: the pure rules', () => {
  it('a reopened edit takes the later stamp of the list and the last save', () => {
    expect(newerStamp(null, null)).toBeNull();
    expect(newerStamp('2026-11-11T10:00:00.000Z', null)).toBe('2026-11-11T10:00:00.000Z');
    expect(newerStamp(null, '2026-11-11T10:00:00.000Z')).toBe('2026-11-11T10:00:00.000Z');
    expect(newerStamp('2026-11-11T10:00:00.000Z', '2026-11-11T10:05:00.000Z')).toBe('2026-11-11T10:05:00.000Z');
    expect(newerStamp('2026-11-11T10:05:00.000Z', '2026-11-11T10:00:00.000Z')).toBe('2026-11-11T10:05:00.000Z');
  });

  it('a text drawn open is measured against the clamp: its lines times its line height (normal = 1.5 x the font)', () => {
    expect(CLAMP_LINES).toEqual({ post: 10, comment: 6 });
    expect(clampHeight('20px', '14px', 10)).toBe(200);
    expect(clampHeight('normal', '16px', 6)).toBe(144);
  });

  it('the words', () => {
    expect(SHARED_UNAVAILABLE).toBe("This post isn't available");
    expect(WITHDRAWN_COMMENT).toBe('This comment was deleted.');
  });
});
