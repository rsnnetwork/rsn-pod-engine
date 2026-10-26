// ─── The pod wall on the preview (26 Oct 2026, COM-01 client) ────────────────
//
// Stefan, back in the pod after an event: "We can't write in the pod itself. There's no wall." The server half
// shipped as R9f (pod_posts, /api/pods/:podId/wall/..., entity tags pod:<id>:wall and pod-wall-post:<id>).
// This is the screen: one set of wall components (client/src/components/wall) that the circle wall and the
// pod wall both draw from, and the pod page's layout around it.
//
// The pod's configuration is a pure module, so it is run. The components are React, which jest does not
// load, so, like the other files here, they are read as source. The scripts/check-realtime-entities.js guard
// only scans useQuery, never useInfiniteQuery, so the scan for "every query declares meta.entities" is here.

import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationMode, PodType } from '@rsn/shared';
import { podCannotPostNote, podStatusLooksStale, podWallConfig } from '../../../../client/src/features/pods/pod-wall-config';
import { orchestrationLabel, podStatusLabel } from '../../../../client/src/features/pods/pod-header-text';
import { podEventsInOrder } from '../../../../client/src/features/pods/pod-event-order';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const WALL_DIR = path.join(CLIENT_SRC, 'components/wall');
const wallFiles = () => fs.readdirSync(WALL_DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ name: f, src: read(`components/wall/${f}`) }));

const POD = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';
const POST = '9a1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
const ME = 'c0ffee00-0000-4000-8000-000000000001';

/** The text of each `name({ ... })` call: from the opening brace to its balanced closing brace. */
function callBodies(source: string, name: string): string[] {
  const bodies: string[] = [];
  const open = new RegExp(`\\b${name}\\s*(?:<[^(]*>)?\\(\\s*\\{`, 'g');
  let hit: RegExpExecArray | null;
  while ((hit = open.exec(source))) {
    const start = hit.index + hit[0].length - 1;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) { bodies.push(source.slice(start, i + 1)); break; }
    }
  }
  return bodies;
}

describe('the pod wall\'s configuration', () => {
  const config = podWallConfig({ podId: POD, me: ME, podStatus: 'active', isActiveMember: true });

  it('reads and writes under the pod: /pods/:podId/wall', () => {
    expect(config.feedPath).toBe(`/pods/${POD}/wall/posts`);
    expect(config.itemBase).toBe(`/pods/${POD}/wall`);
  });

  it('the feed declares what its answer depends on: the wall, the pod\'s status, the viewer\'s place in the pod, and their blocks', () => {
    expect(config.entities.feed).toEqual([`pod:${POD}:wall`, `pod:${POD}`, `pod:${POD}:members`, `user:${ME}:blocks`]);
  });

  it('one post adds its own thread\'s tag to the feed\'s four', () => {
    expect(config.entities.post(POST)).toEqual([...config.entities.feed, `pod-wall-post:${POST}`]);
  });

  it('a post\'s comments depend on the post\'s thread and on the viewer\'s blocks', () => {
    expect(config.entities.comments(POST)).toEqual([`pod-wall-post:${POST}`, `user:${ME}:blocks`]);
  });

  it('writes no tag for a member it does not know yet, instead of user:undefined:blocks', () => {
    const anonymous = podWallConfig({ podId: POD, me: undefined, podStatus: 'active', isActiveMember: true });
    expect(anonymous.entities.feed).toEqual([`pod:${POD}:wall`, `pod:${POD}`, `pod:${POD}:members`]);
    expect(anonymous.entities.comments(POST)).toEqual([`pod-wall-post:${POST}`]);
    expect(JSON.stringify(anonymous.entities.feed)).not.toMatch(/undefined/);
  });

  it('never polls: entity tags are the only way the pod wall updates', () => {
    expect(config.pollMs).toBeUndefined();
    expect('refetchInterval' in config).toBe(false);
  });

  it('keeps its cache entries apart from every circle\'s, and apart from one another', () => {
    expect(config.keys.feed).toEqual(['podWall', POD]);
    expect(config.keys.post(POST)).toEqual(['podWall', POD, 'post', POST]);
    expect(config.keys.comments(POST)).toEqual(['podWall', POD, 'comments', POST]);
    expect(JSON.stringify([config.keys.feed, config.keys.post(POST), config.keys.comments(POST)])).not.toMatch(/circle/i);
  });

  it('says what the client asked for, word for word', () => {
    expect(config.copy.placeholder).toBe('Write something to the pod…');
    expect(config.copy.notMember).toBe('Members talk here. Join the pod to read and post.');
  });

  it('opens collapsed, shows the latest ten, opens a linked post\'s comments, and has no share (pod content stays in the pod)', () => {
    expect(config.composer).toBe('collapsible');
    expect(config.visibleAtFirst).toBe(10);
    expect(config.openCommentsOnLink).toBe(true);
    expect(config.share).toBeUndefined();
  });

  it('hides the like and react buttons from someone who cannot post, instead of showing a button that only explains', () => {
    expect(config.copy.reactNeedsMembership).toBeUndefined();
    expect(config.copy.likeNeedsMembership).toBeUndefined();
  });

  it('links each author to their Human Profile, saying the member came from Pods', () => {
    expect(config.authorHref?.('u-2')).toBe('/people/u-2?from=Pods');
  });
});

describe('what the pod wall says where the composer would be, when the viewer cannot post', () => {
  it('archived: read-only, in the server\'s own words', () => {
    expect(podCannotPostNote('archived', true)).toBe('This pod is archived, so its discussion is read-only.');
  });

  it('suspended or still a draft: not open', () => {
    expect(podCannotPostNote('suspended', true)).toBe('This pod is not open for new activity right now.');
    expect(podCannotPostNote('draft', true)).toBe('This pod is not open for new activity right now.');
  });

  it('an admin who is not a member of the pod can read and moderate, and is told how to post', () => {
    expect(podCannotPostNote('active', false)).toBe('You can read and moderate this discussion. Join the pod to post.');
  });

  it('a pod that is closed wins over the viewer not being a member: it is the pod that takes nothing new', () => {
    expect(podCannotPostNote('archived', false)).toBe('This pod is archived, so its discussion is read-only.');
  });

  it('an active member who cannot post on a pod the screen still thinks is open: the server only refuses that when the pod is not open', () => {
    expect(podCannotPostNote('active', true)).toBe('This pod is not open for new activity right now.');
    expect(podCannotPostNote(undefined, true)).toBe('This pod is not open for new activity right now.');
  });
});

describe('a pod page that has not yet heard the pod was archived', () => {
  // DELETE /api/pods/:id tells the pod's screens a moment BEFORE it saves the new status, so a page that
  // refetches the pod at once reads the old one, while the wall (a slower read) already knows the pod is closed.
  it('is told by two reads that disagree: the wall says nobody can post, the pod says it is open', () => {
    expect(podStatusLooksStale(false, true, 'active')).toBe(true);
  });

  it.each([
    ['the viewer can post', true, true, 'active'],
    ['the feed has not answered yet', undefined, true, 'active'],
    ['the pod already says archived', false, true, 'archived'],
    ['the pod already says it is not open', false, true, 'suspended'],
    ['an admin who is not a member could never post, whatever the pod', false, false, 'active'],
  ] as const)('is not told by anything else: %s', (_case, canPost, isActiveMember, podStatus) => {
    expect(podStatusLooksStale(canPost, isActiveMember, podStatus)).toBe(false);
  });
});

describe('every query of the wall declares the entities it depends on', () => {
  it('there are wall components to scan', () => {
    expect(wallFiles().map((f) => f.name)).toEqual(expect.arrayContaining(['Wall.tsx', 'WallPostCard.tsx', 'WallComments.tsx', 'wall-logic.ts']));
  });

  it('every useInfiniteQuery and every useQuery in components/wall has meta: { entities: ... } (the lint script skips useInfiniteQuery)', () => {
    const calls = wallFiles().flatMap((f) => [
      ...callBodies(f.src, 'useInfiniteQuery').map((body) => ({ file: f.name, hook: 'useInfiniteQuery', body })),
      ...callBodies(f.src, 'useQuery').map((body) => ({ file: f.name, hook: 'useQuery', body })),
    ]);
    // The feed, the single linked post and a post's comments.
    expect(calls.map((c) => `${c.file}:${c.hook}`).sort()).toEqual([
      'Wall.tsx:useInfiniteQuery', 'Wall.tsx:useQuery', 'WallComments.tsx:useQuery',
    ]);
    for (const c of calls) expect({ ...c, declares: /meta:\s*\{\s*entities:\s*config\.entities\./.test(c.body) }).toEqual({ ...c, declares: true });
  });

  it('the feed\'s only polling is the interval its configuration asks for, which the pod wall does not', () => {
    const wall = read('components/wall/Wall.tsx');
    const [feed] = callBodies(wall, 'useInfiniteQuery');
    expect(feed).toMatch(/meta:\s*\{\s*entities:\s*config\.entities\.feed\s*\}/);
    expect(feed).toMatch(/refetchInterval:\s*config\.pollMs/);
    expect(feed).toMatch(/queryKey:\s*config\.keys\.feed/);
    for (const { name, src } of wallFiles()) {
      expect({ name, polls: /setInterval|setTimeout\([^)]*fetch|window\.location\.reload|router\.refresh/.test(src) }).toEqual({ name, polls: false });
    }
  });

  it('a wall told by tags folds a burst of refetches into one request per window (a storm of reactions), and never holds back the first load, the pages after the first, or a wall that polls', () => {
    const wall = read('components/wall/Wall.tsx');
    const [feed] = callBodies(wall, 'useInfiniteQuery');
    expect(wall).toMatch(/useState\(\(\) => createCoalescer\(REFETCH_WINDOW_MS\)\)/);
    // Only the first page, only with posts already on screen, only on a wall whose entities are declared.
    expect(feed).toMatch(/const refetching = pageParam === undefined && tagged && queryClient\.getQueryData\(config\.keys\.feed\) !== undefined;/);
    expect(feed).toMatch(/refetching \? coalesce\(read\) : read\(\)/);
    // The circle wall declares none, so its queries are read as they were.
    expect(read('features/circles/CircleWall.tsx')).toMatch(/entities: \{ feed: \[\]/);
  });

  it('nothing in the wall writes the cache by hand: a change is a refetch (CLAUDE.md section 4)', () => {
    for (const { name, src } of wallFiles()) expect({ name, writes: /setQueryData|setQueriesData/.test(src) }).toEqual({ name, writes: false });
  });

  it('PodWall builds the pod\'s wall from podWallConfig and asks for no polling of its own', () => {
    const pod = read('features/pods/PodWall.tsx');
    expect(pod).toMatch(/podWallConfig\(\{/);
    expect(pod).toMatch(/<Wall\b/);
    expect(pod).not.toMatch(/refetchInterval|pollMs|setInterval|\buseQuery\b|\buseInfiniteQuery\b/);
  });

  it('the circle wall keeps its 30-second poll and asks for no entity tags, as before (its routes emit none)', () => {
    const circle = read('features/circles/CircleWall.tsx');
    expect(circle).toMatch(/pollMs:\s*30_000/);
    expect(circle).toMatch(/testId:\s*'circle-wall'/);
    expect(circle).toMatch(/feed:\s*\[\]/);
    expect(circle).toMatch(/feed:\s*\['circleWall', circleId\]/);
    expect(circle).toMatch(/comments:\s*\(postId[^)]*\)\s*=>\s*\['wallComments', postId\]/);
    expect(circle).toMatch(/export default function CircleWall\(\{ circleId, isMember, highlightPostId \}/);
  });
});

describe('moderation and posting are separate in the components too', () => {
  const card = read('components/wall/WallPostCard.tsx');
  const comments = read('components/wall/WallComments.tsx');
  const wall = read('components/wall/Wall.tsx');

  it('Delete is shown by canDeleteWallItem (a moderator, or the author), Pin by canPinWallPost, never by canPost', () => {
    expect(card).toMatch(/canDeleteWallItem\(viewer, p\.authorId, userId\)/);
    expect(card).toMatch(/canPinWallPost\(viewer\)/);
    expect(comments).toMatch(/canDeleteWallItem\(viewer, c\.authorId, userId\)/);
    for (const src of [card, comments]) {
      expect(src).not.toMatch(/viewer\.canPost\s*&&[^\n]*(?:Delete|onDelete|remove\()/);
      expect(src).not.toMatch(/canModerate\s*\|\|\s*viewer\.canPost/);
    }
  });

  it('the composer, the comment box, reply, react and like are shown by viewer.canPost, never by canModerate', () => {
    expect(wall).toMatch(/viewer\.canPost\s*\?\s*\(/);
    expect(comments).toMatch(/viewer\.canPost/);
    expect(card).toMatch(/viewer\.canPost/);
    for (const src of [card, comments, wall]) expect(src).not.toMatch(/canModerate\s*&&[^\n]*(?:placeholder|Reply|Send)/);
  });

  it('the acting screen refreshes itself when its own change settles: a change that changed nothing sends it no echo', () => {
    expect(card).toMatch(/onChanged\(\)/);
    expect(comments).toMatch(/onChanged\(\)/);
    expect(wall).toMatch(/invalidateQueries\(\{ queryKey: config\.keys\.feed, exact: true \}\)/);
  });

  it('a write the server refuses with 409 (the pod was archived since the page last looked) refreshes the wall, so the control just refused goes', () => {
    const composer = read('components/wall/WallComposer.tsx');
    expect(composer).toMatch(/if \(isConflict\(err\)\) onSettled\(\);/);
    expect(card).toMatch(/if \(isConflict\(err\)\) onChanged\(\);/);
    expect(comments.match(/if \(isConflict\(err\)\) onChanged\(\);/g)).toHaveLength(2);   // a comment or reply, and a like
  });

  it('a collapsed composer, once opened, stays open: a tap on its own buttons takes the focus from the box first, and must not fold them away under the finger', () => {
    const composer = read('components/wall/WallComposer.tsx');
    expect(composer).not.toMatch(/onBlur=/);
    expect(composer).toMatch(/onFocus=\{\(\) => setOpened\(true\)\}/);
    expect(composer).toMatch(/const open = config\.composer === 'open' \|\| opened \|\| draft\.length > 0 \|\| image !== null;/);
  });

  it('a post the viewer can do nothing with (an archived pod, someone else\'s words, no comments) draws no empty row of controls under a divider', () => {
    expect(card).toMatch(/const hasControls = showsReactions \|\| showsCommentButton \|\| !!config\.share \|\| mayDelete \|\| mayPin;/);
    expect(card).toMatch(/\{hasControls && \(\s*<div className="mt-1 -ml-2 flex items-center gap-0\.5 flex-wrap border-t/);
  });

  it('a closed account\'s words stay as "Former member" with no profile link and no picture', () => {
    expect(card).toMatch(/!p\.authorClosed/);
    expect(comments).toMatch(/!c\.authorClosed/);
  });

  it('a comment list that was cut says so', () => {
    expect(comments).toMatch(/truncated/);
    expect(comments).toMatch(/Showing the first \$\{[^}]+\} comments\./);
  });

  it('the wall tells its page what the viewer may do, so the page can notice a pod status it has not heard yet', () => {
    expect(wall).toMatch(/onViewerChange\?\.\(fromFeed\)/);
    const pod = read('features/pods/PodWall.tsx');
    expect(pod).toMatch(/onViewerChange=\{onViewerChange\}/);
    expect(pod).toMatch(/podStatusLooksStale\(canPost, isActiveMember, podStatus\)\) stale\.current\(\)/);
    // Once per change: the callback is read from a ref, so a new function each render cannot run the effect again.
    expect(pod).toMatch(/\}, \[canPost, isActiveMember, podStatus\]\);/);
    expect(read('features/pods/PodDetailPage.tsx')).toMatch(/onPodStatusStale=\{refreshPod\}/);
  });

  it('a wall that answers 403 draws the not-a-member sentence instead of any stale posts', () => {
    expect(wall).toMatch(/isForbidden\(feed\.error\)/);
    expect(wall).toMatch(/config\.copy\.notMember/);
  });
});

describe('how the pod page names how its events run', () => {
  // The header showed the stored column in lower case ("timed rounds") on a pod whose type does not use it, and
  // a communication mode ("hybrid") that nothing reads and the forms no longer ask for.
  it('reads the stored mode through the pod type, so an old Reason pod saved on timed rounds says Freeform', () => {
    expect(orchestrationLabel({ podType: PodType.REASON, orchestrationMode: OrchestrationMode.TIMED_ROUNDS })).toBe('Freeform');
  });

  it('says the stored mode in plain words when the type allows it', () => {
    expect(orchestrationLabel({ podType: PodType.SPEED_NETWORKING, orchestrationMode: OrchestrationMode.TIMED_ROUNDS })).toBe('Timed rounds');
    expect(orchestrationLabel({ podType: PodType.WEBINAR, orchestrationMode: OrchestrationMode.MODERATED })).toBe('Moderated');
    expect(orchestrationLabel({ podType: PodType.CONVERSATIONAL, orchestrationMode: OrchestrationMode.FREE_FORM })).toBe('Freeform');
  });

  it('falls back to the type\'s own mode when none is stored', () => {
    expect(orchestrationLabel({ podType: PodType.REASON, orchestrationMode: null })).toBe('Freeform');
    expect(orchestrationLabel({ podType: PodType.SPEED_NETWORKING })).toBe('Timed rounds');
  });

  it('never says a raw column value: no underscores, no lower-case enum', () => {
    for (const podType of Object.values(PodType)) {
      for (const orchestrationMode of [...Object.values(OrchestrationMode), null]) {
        const label = orchestrationLabel({ podType, orchestrationMode });
        expect({ podType, orchestrationMode, label, raw: /_|^[a-z]/.test(label) }).toEqual({ podType, orchestrationMode, label, raw: false });
      }
    }
  });
});

describe('how the pod page names the pod\'s state', () => {
  // The header printed the stored value, in lower case: "active", "archived".
  it.each([
    ['active', 'Active'],
    ['archived', 'Archived'],
    ['suspended', 'Suspended'],
    ['draft', 'Draft'],
  ])('%s reads as %s', (status, label) => {
    expect(podStatusLabel(status)).toBe(label);
  });

  it('a state it does not know is still said in words, never as the stored value', () => {
    expect(podStatusLabel('under_review')).toBe('Under review');
    expect(podStatusLabel(undefined)).toBe('');
  });
});

describe('the order of the pod\'s events: what is live, then what is coming soonest first, then what has ended, latest first', () => {
  // The server sends them newest date first, so the event furthest off stood at the top and the next one below it.
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 18)).toISOString();
  const ev = (id: string, status: string, day: number | null) => ({ id, status, scheduledAt: day === null ? null : at(day) });
  const order = (events: ReturnType<typeof ev>[]) => podEventsInOrder(events).map((e) => e.id);

  it('puts a live event first, the upcoming ones soonest first, and the ended and cancelled ones latest first', () => {
    const served = [
      ev('far', 'scheduled', 20), ev('next', 'scheduled', 5), ev('live', 'round_active', 1),
      ev('ended-recently', 'completed', 0), ev('cancelled', 'cancelled', -3), ev('ended-long-ago', 'completed', -10),
    ];
    expect(order(served)).toEqual(['live', 'next', 'far', 'ended-recently', 'cancelled', 'ended-long-ago']);
  });

  it('a live event comes before an upcoming one whatever their dates: one that was never started, its time past, waits behind it', () => {
    const served = [ev('never-started', 'scheduled', -2), ev('next', 'scheduled', 5), ev('live', 'lobby_open', 1)];
    expect(order(served)).toEqual(['live', 'never-started', 'next']);
  });

  it('every live state counts as live, and one that is wrapping up still does', () => {
    const served = [ev('soon', 'scheduled', 2), ...['lobby_open', 'round_rating', 'round_transition', 'closing_lobby'].map((s, i) => ev(s, s, -i))];
    expect(order(served)[0]).not.toBe('soon');
    expect(order(served).at(-1)).toBe('soon');
  });

  it('an upcoming event with no date yet comes after the dated ones', () => {
    expect(order([ev('undated', 'scheduled', null), ev('dated', 'scheduled', 9)])).toEqual(['dated', 'undated']);
  });

  it('leaves what it was given as it was, and keeps nothing out', () => {
    const served = [ev('b', 'completed', 1), ev('a', 'scheduled', 2)];
    const copy = [...served];
    expect(podEventsInOrder(served)).toHaveLength(2);
    expect(served).toEqual(copy);
    expect(podEventsInOrder([])).toEqual([]);
  });
});

describe('the pod page', () => {
  const page = read('features/pods/PodDetailPage.tsx');

  it('shows that label in the header, and no raw orchestration value and no communication badge', () => {
    expect(page).toMatch(/<Badge variant="brand">\{orchestrationLabel\(pod\)\}<\/Badge>/);
    expect(page).not.toMatch(/orchestrationMode\?\.replace/);
    expect(page).not.toMatch(/\{pod\.communicationMode\}/);
  });

  it('names the pod\'s state in words in the header, never the stored value', () => {
    expect(page).toMatch(/\{podStatusLabel\(pod\.status\)\}<\/Badge>/);
    expect(page).not.toMatch(/>\{pod\.status\}</);
  });

  it('lists the pod\'s events in that order', () => {
    expect(page).toMatch(/podEventsInOrder\(podSessions\)\.map\(/);
  });

  it('asks for the events only when the server will list them (an active member or an admin), and tells everyone else in words', () => {
    // GET /sessions?podId= answers 403 to anyone else: the section sat on a skeleton through the retries, then said
    // "No events yet." about a pod that has events.
    expect(page).toMatch(/const mayReadEvents = !!pod\?\.memberRole \|\| user\?\.role === 'admin' \|\| user\?\.role === 'super_admin';/);
    expect(page).toMatch(/enabled: !!podId && mayReadEvents,/);
    expect(page).toMatch(/\{!mayReadEvents \|\| eventsRefused \? \(/);
    expect(page).toContain("Members see the pod's events here.");
  });

  it('a list of events that could not be loaded says so and offers to try again, instead of "No events yet."', () => {
    expect(page).toContain('We could not load the events just now.');
    expect(page).toMatch(/onClick=\{\(\) => void refetchSessions\(\)\}[^>]*min-h-\[44px\]/);
    expect(page).toMatch(/retry: retryUnlessAnswered,/);
  });

  it('reads ?post= and hands it to the wall, so a bell or a link lands on the post', () => {
    expect(page).toMatch(/useSearchParams/);
    expect(page).toMatch(/searchParams\.get\('post'\)/);
    expect(page).toMatch(/<PodWall\b[^>]*highlightPostId=\{highlightPostId\}/);
  });

  it('is one column on a phone and two from 1024px: the discussion on the left, events and members on the right', () => {
    expect(page).toMatch(/grid-cols-1[^"]*lg:grid-cols-\[minmax\(0,1fr\)_320px\]/);
  });

  it('has a row of 44px chips (Discussion, Events, Members) that is there on a phone and gone from 1024px', () => {
    expect(page).toMatch(/aria-label="Jump to a section"[^>]*className="[^"]*\blg:hidden\b/);
    for (const [label, id] of [['Discussion', 'pod-discussion'], ['Events', 'pod-events'], ['Members', 'pod-members']]) {
      expect(page).toContain(`id: '${id}', label: '${label}'`);
      expect(page).toMatch(new RegExp(`id="${id}"`));
    }
    expect(page).toMatch(/min-h-\[44px\][^"]*\brounded-full\b|\brounded-full\b[^"]*min-h-\[44px\]/);
  });

  it('gives the wall the pod\'s status and whether the viewer is a member, which the 403 and the read-only sentences need', () => {
    expect(page).toMatch(/<PodWall\b[^>]*podId=\{podId\}/);
    expect(page).toMatch(/<PodWall\b[^>]*podStatus=\{pod\.status\}/);
    expect(page).toMatch(/<PodWall\b[^>]*isMember=\{isMember\}/);
    expect(page).toMatch(/<PodWall\b[^>]*isActiveMember=\{/);
  });

  it('keeps the member list a one-column grid with its Human Profile links (pinned by the shell and profile-text tests)', () => {
    expect(page).toMatch(/<div className="grid grid-cols-1 gap-2">\s*\{\(memberStatusFilter === null \? activeMembers/);
  });
});
