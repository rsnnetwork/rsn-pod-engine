// ─── Group chats in Messages (C12, COM-04, 26 Oct 2026) ──────────────────────────────────────────────────────────────
//
// Stefan, 25 Oct: "Can there be 3, 5, 10, 20, 50 people in a chat? There should be." The server (S9) holds group chats
// of 3 to 50 people, started by the people who ran a completed event with those who took part. The client now lists
// them in Messages beside the one-to-one conversations (name, members, preview, unread), opens one at
// /messages/g/:groupId with "{n} of 50" in its header, keeps a members sheet (leave; for the group's admin, remove and
// add), adds the groups' unread to the Messages badge, and offers "Start a group chat" on a completed event's page to
// the people who ran it. The pure parts are run here, the inbox row is drawn here, and the wiring is pinned by its source.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DmGroupSummary, GroupChatMessage, GroupChatMessagePage } from '@rsn/shared';
import { GROUP_CHAT_MAX_MEMBERS } from '@rsn/shared';
import * as words from '../../../../client/src/features/messages/group-chat-text';
import {
  GROUP_FULL, GROUP_LIMIT, GROUP_TOO_SMALL, addLabel, clusterGroupMessages, groupErrorSentence, groupLoadProblem, groupPreview,
  groupUnreadTotal, memberCountLabel, mergeInbox, newestFromOthers, ofMax, roomLeft, sendSchema, startBody,
  startChosen, startProblem, threadInOrder, tookPart, addSchema, startSchema, byName, membersInOrder,
  START_MANY, MARK_READ_DEBOUNCE_MS, readMarkKey, isRateLimited, rateLimitWaitMs, groupReadRetry, groupReadRetryDelay,
  EARLIER_PAGE_TRIES, untilEarlierPage,
} from '../../../../client/src/features/messages/group-chat-text';
import { PANEL_TITLE } from '../../../../client/src/features/sessions/post-event-panel';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const ME = 'me-1';
const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 10, min)).toISOString();

function group(over: Partial<DmGroupSummary> & { id: string }): DmGroupSummary {
  return {
    name: 'Founders night', type: 'event', podId: null, sessionId: 's-1', createdBy: ME, createdAt: at(0),
    lastMessageAt: null, memberCount: 3, unreadCount: 0, lastMessage: null, myRole: 'member', ...over,
  };
}
const dm = (conversationId: string, lastMessageAt: string | null) => ({ conversationId, lastMessageAt });

/** The text of a function or block, from its first line to the matching close of its first `{`. */
function blockFrom(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unclosed block: ${marker}`);
}

/** The first className="…" after `marker` (the element the marker opens). */
function classAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const m = src.slice(at).match(/className="([^"]*)"/);
  if (!m) throw new Error(`no className after: ${marker}`);
  return m[1];
}

/** A client file's text, or '' when it is not there yet (so each test fails on its own expectations). */
function read(rel: string): string {
  try { return readClientSource(rel); } catch { return ''; }
}

// ── The words ────────────────────────────────────────────────────────────────

describe('the product says how big a group chat can be', () => {
  it('"Group chats hold up to 50 people." and "{n} of 50" in the header, from the shared cap', () => {
    expect(GROUP_CHAT_MAX_MEMBERS).toBe(50);
    expect(GROUP_LIMIT).toBe('Group chats hold up to 50 people.');
    expect(ofMax(12)).toBe('12 of 50');
    expect(ofMax(50)).toBe('50 of 50');
  });

  it('a full group and a group too small are refused in the server\'s own words', () => {
    expect(GROUP_FULL).toBe('This group is full (50 people).');
    expect(GROUP_TOO_SMALL).toBe('A group chat needs at least 3 people.');
  });

  it('every sentence says "event", never "session", and REASON, never RSN', () => {
    const sentences = Object.values(words as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
    expect(sentences.length).toBeGreaterThan(15);
    for (const s of sentences) {
      expect(s).not.toMatch(/session/i);
      expect(s).not.toMatch(/\bRSN\b/);
    }
  });

  it('the start sheet points to the message-everyone panel by its own title, so the two cannot drift apart', () => {
    expect(PANEL_TITLE).toBe('Message everyone who took part');
    expect(START_MANY).toBe('More than 49 people took part. Choose up to 49, or use Message everyone who took part to reach them all.');
    expect(read('features/messages/group-chat-text.ts')).toMatch(/or use \$\{PANEL_TITLE\} to reach them all\./);
  });

  it('keeps no sentence that no screen says', () => {
    expect('MEMBERS_FAILED' in words).toBe(false);
  });

  it('counts people as people', () => {
    expect(memberCountLabel(1)).toBe('1 person');
    expect(memberCountLabel(3)).toBe('3 people');
    expect(addLabel(1)).toBe('Add 1 person');
    expect(addLabel(4)).toBe('Add 4 people');
  });
});

// ── The inbox ────────────────────────────────────────────────────────────────

describe('the inbox lists groups beside the one-to-one conversations, the latest first', () => {
  it('interleaves the two by their latest message; a group with none yet sits at when it was started', () => {
    const rows = mergeInbox(
      [dm('c-new', at(5)), dm('c-old', at(1))],
      [group({ id: 'g-busy', lastMessageAt: at(10) }), group({ id: 'g-quiet', createdAt: at(3) })],
    );
    expect(rows.map((r) => r.key)).toEqual(['g:g-busy', 'c:c-new', 'g:g-quiet', 'c:c-old']);
  });

  it('a conversation with no message yet goes last, as the server lists it', () => {
    const rows = mergeInbox([dm('c-none', null), dm('c-a', at(2))], [group({ id: 'g-1', lastMessageAt: at(1) })]);
    expect(rows.map((r) => r.key)).toEqual(['c:c-a', 'g:g-1', 'c:c-none']);
  });

  it('keeps each list\'s own order when times are equal, the conversation first', () => {
    const rows = mergeInbox([dm('c-1', at(4)), dm('c-2', at(4))], [group({ id: 'g-1', lastMessageAt: at(4) })]);
    expect(rows.map((r) => r.key)).toEqual(['c:c-1', 'c:c-2', 'g:g-1']);
  });

  it('tells a group row from a conversation row, and carries each one whole', () => {
    const g = group({ id: 'g-1' });
    const c = dm('c-1', at(1));
    const rows = mergeInbox([c], [g]);
    expect(rows.find((r) => r.kind === 'group')).toEqual({ kind: 'group', key: 'g:g-1', at: g.createdAt, group: g });
    expect(rows.find((r) => r.kind === 'dm')).toEqual({ kind: 'dm', key: 'c:c-1', at: c.lastMessageAt, conversation: c });
    expect(mergeInbox([], [])).toEqual([]);
  });

  it('the preview says who wrote it: "You" for the reader, else the sender\'s name', () => {
    expect(groupPreview({ content: 'See you all', at: at(1), fromUserId: ME, senderName: 'Claus' }, ME)).toBe('You: See you all');
    expect(groupPreview({ content: 'See you all', at: at(1), fromUserId: 'u-2', senderName: 'Ana' }, ME)).toBe('Ana: See you all');
    expect(groupPreview({ content: 'Bye', at: at(1), fromUserId: 'u-3', senderName: 'Former member' }, ME)).toBe('Former member: Bye');
    expect(groupPreview(null, ME)).toBeNull();
  });

  it('the Messages badge adds up every group\'s unread', () => {
    expect(groupUnreadTotal([group({ id: 'a', unreadCount: 2 }), group({ id: 'b' }), group({ id: 'c', unreadCount: 3 })])).toBe(5);
    expect(groupUnreadTotal([])).toBe(0);
    expect(groupUnreadTotal(undefined)).toBe(0);
  });
});

describe('a group row in the inbox: its name, its members, the last message and the unread count', () => {
  // Loaded when a test draws it, so a missing file fails each test rather than the whole suite.
  const row = () => loadClientModule('features/messages/GroupInboxRow.tsx', {
    'react-router-dom': {
      Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => createElement('a', { href: to, ...rest }, children),
    },
    'lucide-react': iconStandIns,
  }).default as (props: { group: DmGroupSummary; active: boolean; myUserId: string }) => JSX.Element;
  const draw = (over: Partial<DmGroupSummary>, active = false) =>
    renderToStaticMarkup(createElement(row(), { group: group({ id: 'g-7', ...over }), active, myUserId: ME }));

  it('opens the group at /messages/g/:id and names it, with how many people are in it', () => {
    const html = draw({ name: 'Founders night', memberCount: 12 });
    expect(html).toContain('href="/messages/g/g-7"');
    expect(html).toContain('Founders night');
    expect(html).toContain('12 people');
  });

  it('shows the last message with who wrote it, and the unread count', () => {
    const html = draw({ unreadCount: 2, lastMessageAt: at(1), lastMessage: { content: 'See you all', at: at(1), fromUserId: 'u-2', senderName: 'Ana' } });
    expect(html).toContain('Ana: See you all');
    expect(html).toMatch(/data-testid="group-unread"[^>]*>2</);
  });

  it('no unread count when everything is read; 99+ past ninety-nine', () => {
    expect(draw({ unreadCount: 0 })).not.toContain('data-testid="group-unread"');
    expect(draw({ unreadCount: 140 })).toMatch(/data-testid="group-unread"[^>]*>99\+</);
  });

  it('a group with no message yet says so', () => {
    expect(draw({})).toContain('No messages yet');
  });
});

// ── The thread ───────────────────────────────────────────────────────────────

const msg = (id: string, min: number, from = 'u-2'): GroupChatMessage => ({
  id, groupId: 'g-1', fromUserId: from, senderName: from === ME ? 'Me' : 'Ana', senderAvatarUrl: null, content: id, createdAt: at(min),
});

describe('the thread reads a page at a time and shows the oldest first', () => {
  it('each page is newest first, and each next page is older: shown oldest to newest', () => {
    const pages: GroupChatMessagePage[] = [
      { messages: [msg('d', 4), msg('c', 3)], nextCursor: 'c' },
      { messages: [msg('b', 2), msg('a', 1)], nextCursor: null },
    ];
    expect(threadInOrder(pages).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a message two pages both hold (a new one moved the edge) is shown once', () => {
    const pages: GroupChatMessagePage[] = [
      { messages: [msg('e', 5), msg('d', 4)], nextCursor: 'd' },
      { messages: [msg('d', 4), msg('c', 3)], nextCursor: null },
    ];
    expect(threadInOrder(pages).map((m) => m.id)).toEqual(['c', 'd', 'e']);
  });

  it('messages of the same moment keep the server\'s order (by id)', () => {
    expect(threadInOrder([{ messages: [msg('y', 2), msg('x', 2)], nextCursor: null }]).map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('one person\'s messages within a minute are drawn under one name; another sender or a minute\'s gap starts anew', () => {
    const list = [msg('a', 1), { ...msg('b', 1), createdAt: new Date(Date.parse(at(1)) + 30_000).toISOString() }, msg('c', 3), msg('d', 3, ME), msg('e', 3, ME)];
    expect(clusterGroupMessages(list).map((c) => [c.senderId, c.messages.map((m) => m.id)])).toEqual([
      ['u-2', ['a', 'b']], ['u-2', ['c']], [ME, ['d', 'e']],
    ]);
    expect(clusterGroupMessages([])).toEqual([]);
  });

  it('the read mark follows the newest message someone else wrote', () => {
    const list = threadInOrder([{ messages: [msg('c', 3, ME), msg('b', 2), msg('a', 1)], nextCursor: null }]);
    expect(newestFromOthers(list, ME)).toBe('b');
    expect(newestFromOthers([msg('a', 1, ME)], ME)).toBeNull();
    expect(newestFromOthers([], ME)).toBeNull();
  });

  it('the message box takes the server\'s 1 to 4000 characters, in its words', () => {
    expect(sendSchema.safeParse({ content: '   ' }).error?.issues[0].message).toBe('Write a message first.');
    expect(sendSchema.safeParse({ content: 'x'.repeat(4001) }).error?.issues[0].message).toBe('Messages can be up to 4000 characters.');
    const ok = sendSchema.safeParse({ content: '  Thanks all  ' });
    expect(ok.success && ok.data).toEqual({ content: 'Thanks all' });
  });
});

describe('what went wrong, said plainly', () => {
  const refused = (status: number, message: string, details?: unknown) => ({ response: { status, data: { error: { message, details } } } });

  it('a thread that cannot open: gone (404), not in it (403), or a failure to load', () => {
    expect(groupLoadProblem({ response: { status: 404 } })).toBe('gone');
    expect(groupLoadProblem({ response: { status: 403 } })).toBe('not-member');
    expect(groupLoadProblem({ response: { status: 500 } })).toBe('failed');
    expect(groupLoadProblem(new Error('x'))).toBe('failed');
  });

  it('a refusal is the server\'s own sentence when it is one a member can read', () => {
    const F = 'Fallback.';
    expect(groupErrorSentence(refused(409, 'This group is full (50 people).'), F)).toBe('This group is full (50 people).');
    expect(groupErrorSentence(refused(403, "Only the group's admin can add people."), F)).toBe("Only the group's admin can add people.");
    expect(groupErrorSentence(refused(404, 'This person is not in the group.'), F)).toBe('This person is not in the group.');
    expect(groupErrorSentence(refused(429, 'You are sending messages very quickly. Wait a moment, then try again.'), F))
      .toBe('You are sending messages very quickly. Wait a moment, then try again.');
    expect(groupErrorSentence(refused(400, 'Validation failed', { content: ['Write a message first.'] }), F)).toBe('Write a message first.');
  });

  it('anything else is the caller\'s plain sentence, and a lost connection says so', () => {
    const F = 'Fallback.';
    expect(groupErrorSentence(refused(500, 'Internal error'), F)).toBe(F);
    expect(groupErrorSentence(refused(409, 'Group 3f2a9c1e-77aa conflicts'), F)).toBe(F);
    expect(groupErrorSentence(refused(400, 'Validation failed', {}), F)).toBe(F);
    expect(groupErrorSentence({ isAxiosError: true, request: {} }, F)).toBe(CONNECTION_LOST);
    expect(groupErrorSentence(new TypeError('boom'), F)).toBe(F);
  });
});

// ── The read budget: the server allows 120 group reads a minute per member ────

describe('the read mark: once per burst, and never for a group already read', () => {
  const base = { loaded: true, seen: true, unread: 3, groupId: 'g-1', newestOther: 'm-9', marked: null };

  it('marks up to the newest message someone else wrote while something is unread', () => {
    expect(readMarkKey(base)).toBe('g-1:m-9');
  });

  it('a group opened with nothing unread is not marked', () => {
    expect(readMarkKey({ ...base, unread: 0 })).toBeNull();
  });

  it('not before the group has loaded, and never from a tab in the background', () => {
    expect(readMarkKey({ ...base, loaded: false })).toBeNull();
    expect(readMarkKey({ ...base, seen: false })).toBeNull();
  });

  it('a message already marked is not marked again; a newer one is', () => {
    expect(readMarkKey({ ...base, marked: 'g-1:m-9' })).toBeNull();
    expect(readMarkKey({ ...base, marked: 'g-1:m-8' })).toBe('g-1:m-9');
  });

  it('one mark per burst: it waits a second, and each newer message starts the second again', () => {
    expect(MARK_READ_DEBOUNCE_MS).toBe(1000);
  });
});

describe('a read refused for going too fast keeps what is shown, and is tried again after the limit\'s window', () => {
  const limited = (headers: Record<string, string> = {}) =>
    ({ response: { status: 429, headers, data: { error: { message: 'Slow down a moment, then try again.' } } } });

  it('tells a 429 from any other refusal', () => {
    expect(isRateLimited(limited())).toBe(true);
    expect(isRateLimited({ response: { status: 403 } })).toBe(false);
    expect(isRateLimited(new Error('x'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });

  it('waits as long as the server asks when the browser may read it, else the limit\'s window of a minute', () => {
    expect(rateLimitWaitMs(limited({ 'retry-after': '12' }))).toBe(12_000);
    expect(rateLimitWaitMs(limited({ 'ratelimit-reset': '30' }))).toBe(30_000);
    // Cross-origin, the browser does not show these headers to the page: the window it is.
    expect(rateLimitWaitMs(limited())).toBe(60_000);
    expect(rateLimitWaitMs(limited({ 'retry-after': 'soon' }))).toBe(60_000);
  });

  it('a 429 is tried twice more, each after the wait; any other 4xx is an answer; a lost connection or a 5xx gets one more try', () => {
    expect(groupReadRetry(0, limited())).toBe(true);
    expect(groupReadRetry(1, limited())).toBe(true);
    expect(groupReadRetry(2, limited())).toBe(false);
    expect(groupReadRetry(0, { response: { status: 404 } })).toBe(false);
    expect(groupReadRetry(0, { response: { status: 403 } })).toBe(false);
    expect(groupReadRetry(0, { response: { status: 500 } })).toBe(true);
    expect(groupReadRetry(1, { response: { status: 500 } })).toBe(false);
    expect(groupReadRetryDelay(0, limited({ 'retry-after': '5' }))).toBe(5_000);
    expect(groupReadRetryDelay(1, limited())).toBe(60_000);
    expect(groupReadRetryDelay(0, { response: { status: 500 } })).toBe(1_000);
    expect(groupReadRetryDelay(1, { response: { status: 500 } })).toBe(2_000);
  });
});

// A change to the group landing while the earlier page is on its way (a message, the member's own read mark) starts a
// refetch of what is shown, and React Query drops the page fetch in flight for it: the pages do not grow, and nothing
// appears. Found by the group-chat spec in WebKit on 26 Oct 2026.
describe('an earlier page asked for while a change to the group lands is asked for again until it has come', () => {
  type Answer = { data?: { pages: unknown[] }; hasNextPage: boolean; isFetchNextPageError: boolean };
  const answer = (pages: number, over: Partial<Answer> = {}): Answer =>
    ({ data: { pages: Array.from({ length: pages }, (_v, i) => i) }, hasNextPage: true, isFetchNextPageError: false, ...over });
  const asking = (...answers: Answer[]) => {
    let i = 0;
    return jest.fn(async () => answers[Math.min(i++, answers.length - 1)]);
  };

  it('one ask when the page comes', async () => {
    const came = answer(2);
    const ask = asking(came);
    expect(await untilEarlierPage(ask, 1)).toBe(came);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again while the pages did not grow and more is to come (the fetch was dropped), until the page comes', async () => {
    const dropped = answer(1);
    const came = answer(2);
    const ask = asking(dropped, dropped, came);
    expect(await untilEarlierPage(ask, 1)).toBe(came);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('stops when there is nothing earlier, and when the page fetch failed (the thread says so itself)', async () => {
    const nothing = answer(1, { hasNextPage: false });
    const askNothing = asking(nothing);
    expect(await untilEarlierPage(askNothing, 1)).toBe(nothing);
    expect(askNothing).toHaveBeenCalledTimes(1);
    const failed = answer(1, { isFetchNextPageError: true });
    const askFailed = asking(failed);
    expect(await untilEarlierPage(askFailed, 1)).toBe(failed);
    expect(askFailed).toHaveBeenCalledTimes(1);
  });

  it('gives up after three asks', async () => {
    expect(EARLIER_PAGE_TRIES).toBe(3);
    const dropped = answer(1);
    const ask = asking(dropped);
    expect(await untilEarlierPage(ask, 1)).toBe(dropped);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('runs what is given before each ask (the thread notes where the reader is, so a dropped ask does not keep an old place)', async () => {
    const before = jest.fn();
    const ask = asking(answer(1), answer(2));
    await untilEarlierPage(ask, 1, before);
    expect(before).toHaveBeenCalledTimes(2);
    expect(before.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder[0]);
    expect(before.mock.invocationCallOrder[1]).toBeLessThan(ask.mock.invocationCallOrder[1]);
  });
});

// ── Choosing people: starting a group from an event, and adding to one ────────

const person = (userId: string, over: Partial<{ status: string; joinedAt: string | null; displayName: string }> = {}) => ({
  userId, displayName: userId, avatarUrl: null, status: 'left', joinedAt: at(0), ...over,
});

describe('who can be chosen: the people who took part in the event', () => {
  it('took part = came in and was not removed; never yourself, nor anyone already in the group', () => {
    const list = [
      person('ana'), person('ben', { joinedAt: null, status: 'registered' }), person('cara', { status: 'removed' }),
      person(ME), person('dan'), person('dan'), person('eve', { status: 'no_show', joinedAt: null }), person('fay'),
    ];
    expect(tookPart(list, [ME, 'fay']).map((p) => p.userId)).toEqual(['ana', 'dan']);
  });

  it('the people to choose from are listed by name, numbers in their order, without changing the list given', () => {
    const list = [person('u3', { displayName: 'guest 10' }), person('u1', { displayName: 'Guest 2' }), person('u2', { displayName: 'ana' })];
    expect(byName(list).map((p) => p.displayName)).toEqual(['ana', 'Guest 2', 'guest 10']);
    expect(list.map((p) => p.userId)).toEqual(['u3', 'u1', 'u2']);
  });

  it('the members: the admin first, then by when they joined, and people who joined together by name', () => {
    const m = (userId: string, displayName: string, role: 'admin' | 'member', joinedAt: string) => ({ userId, displayName, avatarUrl: null, role, joinedAt });
    const list = [m('z', 'Zoe', 'member', at(0)), m('l', 'Late', 'member', at(9)), m('b', 'Ben', 'member', at(0)), m('a', 'Claus', 'admin', at(0))];
    expect(membersInOrder(list).map((x) => x.displayName)).toEqual(['Claus', 'Ben', 'Zoe', 'Late']);
    expect(list[0].displayName).toBe('Zoe');
  });

  it('starting: everyone is chosen when they all fit, nobody when more than 49 took part', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => person(`p${i}`));
    expect(startChosen(ids(2))).toEqual(['p0', 'p1']);
    expect(startChosen(ids(49))).toHaveLength(49);
    expect(startChosen(ids(50))).toEqual([]);
  });

  it('starting needs 3 to 50 people with yourself, said in the server\'s words', () => {
    expect(startProblem(0)).toBe(GROUP_TOO_SMALL);
    expect(startProblem(1)).toBe(GROUP_TOO_SMALL);
    expect(startProblem(2)).toBeNull();
    expect(startProblem(49)).toBeNull();
    expect(startProblem(50)).toBe(GROUP_FULL);
  });

  it('the room left in a group: nobody can be chosen past 50', () => {
    expect(roomLeft(1, 49)).toBe(0);
    expect(roomLeft(49, 0)).toBe(1);
    expect(roomLeft(49, 1)).toBe(0);
    expect(roomLeft(50, 0)).toBe(0);
    expect(roomLeft(50, 3)).toBe(0);
  });

  it('the start form refuses fewer than 3 or more than 50 on its field; "Add people" needs someone chosen, in the server\'s words', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    expect(startSchema.safeParse({ memberIds: ids(1) }).error?.issues[0]).toMatchObject({ path: ['memberIds'], message: GROUP_TOO_SMALL });
    expect(startSchema.safeParse({ memberIds: ids(2) }).success).toBe(true);
    expect(startSchema.safeParse({ memberIds: ids(49) }).success).toBe(true);
    expect(startSchema.safeParse({ memberIds: ids(50) }).error?.issues[0]).toMatchObject({ path: ['memberIds'], message: GROUP_FULL });
    expect(addSchema.safeParse({ userIds: [] }).error?.issues[0]).toMatchObject({ path: ['userIds'], message: 'Choose someone to add.' });
    expect(addSchema.safeParse({ userIds: ['p1'] }).success).toBe(true);
  });

  it('everyone chosen asks the server for everyone who took part; a choice names them', () => {
    const all = [person('ana'), person('ben')];
    expect(startBody(['ana', 'ben'], all)).toEqual({});
    expect(startBody(['ben', 'ana'], all)).toEqual({});
    expect(startBody(['ana'], all)).toEqual({ memberIds: ['ana'] });
  });
});

// ── The wiring ───────────────────────────────────────────────────────────────

describe('every group query declares the tags the server sends (the realtime check does not read infinite queries)', () => {
  const hooks = read('features/messages/useGroups.ts');

  // Every group read waits a 429 out and keeps what it had (groupReadRetry and groupReadRetryDelay, run above).
  const retriesGroupReads = (q: string) => {
    expect(q).toMatch(/retry: groupReadRetry,/);
    expect(q).toMatch(/retryDelay: groupReadRetryDelay,/);
  };

  it('the list (and the inbox) follows the member\'s Messages and blocks', () => {
    const q = blockFrom(hooks, 'export function useMyGroups');
    expect(q).toMatch(/queryKey: groupKeys\.list,/);
    expect(q).toMatch(/meta: \{ entities: me \? \[E\.userDms\(me\), E\.userBlocks\(me\)\] : \[\] \}/);
    expect(hooks).toMatch(/list: \['dm-groups'\] as const/);
    retriesGroupReads(q);
  });

  it('the Messages badge reads the same list, as the sum of its unread', () => {
    const q = blockFrom(hooks, 'export function useGroupUnreadTotal');
    expect(q).toMatch(/queryKey: groupKeys\.list,/);
    expect(q).toMatch(/select: groupUnreadTotal/);
    expect(q).toMatch(/meta: \{ entities: me \? \[E\.userDms\(me\), E\.userBlocks\(me\)\] : \[\] \}/);
    retriesGroupReads(q);
  });

  it('a group\'s details and members follow the group and blocks (as ENTITIES.md lists them); a 4xx other than 429 is not asked again', () => {
    const q = blockFrom(hooks, 'export function useGroup(');
    // Every change that moves them (a message, a read mark, an add, a leave, a removal, a hand-over) sends dm-group:<id>
    // with user:<id>:dms, so the group's own tag is enough; user:<id>:dms alone is any conversation's or group's news.
    expect(q).toMatch(/meta: \{ entities: groupId && me \? \[E\.dmGroup\(groupId\), E\.userBlocks\(me\)\] : \[\] \}/);
    retriesGroupReads(q);
    expect(q).toMatch(/enabled: !!me && isGroupId\(groupId\)/);
  });

  it('the thread is a useInfiniteQuery that follows the group and blocks, a page of 50 before a message id', () => {
    const q = blockFrom(hooks, 'export function useGroupMessages');
    expect(q).toMatch(/useInfiniteQuery\(\{/);
    expect(q).toMatch(/meta: \{ entities: groupId && me \? \[E\.dmGroup\(groupId\), E\.userBlocks\(me\)\] : \[\] \}/);
    expect(q).toMatch(/getNextPageParam: \(last(?:: GroupChatMessagePage)?\) => last\.nextCursor \?\? undefined/);
    retriesGroupReads(q);
    expect(hooks).toMatch(/params: \{ limit: GROUP_PAGE_SIZE, \.\.\.\(before \? \{ before \} : \{\}\) \}/);
    expect(hooks).toMatch(/const GROUP_PAGE_SIZE = 50;/);
    expect(q).not.toMatch(/refetchInterval/);
  });

  it('each write calls its route; none writes the cache by hand', () => {
    expect(hooks).toMatch(/api\.post\(`\/groups\/\$\{encodeURIComponent\(groupId\)\}\/messages`, \{ content \}\)/);
    expect(hooks).toMatch(/api\.post\(`\/groups\/\$\{encodeURIComponent\(groupId\)\}\/read`\)/);
    expect(hooks).toMatch(/api\.post\(`\/groups\/\$\{encodeURIComponent\(groupId\)\}\/leave`\)/);
    expect(hooks).toMatch(/api\.post\(`\/groups\/\$\{encodeURIComponent\(groupId\)\}\/members`, \{ userIds \}\)/);
    expect(hooks).toMatch(/api\.delete\(`\/groups\/\$\{encodeURIComponent\(groupId\)\}\/members\/\$\{encodeURIComponent\(userId\)\}`\)/);
    expect(hooks).toMatch(/api\.post\(`\/groups\/from-event\/\$\{encodeURIComponent\(sessionId\)\}`, body\)/);
    expect(hooks).not.toMatch(/setQueryData/);
  });
});

describe('the group thread', () => {
  const thread = read('features/messages/GroupThread.tsx');

  it('says "{n} of 50" in its header, which opens the members sheet', () => {
    expect(thread).toMatch(/ofMax\(group\.memberCount\)/);
    expect(thread).toMatch(/<GroupMembersSheet/);
    expect(thread).toMatch(/aria-haspopup="dialog"/);
  });

  it('marks the group read once per burst, only with something unread, and only while the page is seen', () => {
    expect(thread).toMatch(/const newestOther = newestFromOthers\(messages, myUserId\);/);
    expect(thread).toMatch(/const unread = detail\.data\?\.unreadCount \?\? 0;/);
    const effect = blockFrom(thread, 'useEffect(() => {\n    const mark = readMarkKey(');
    expect(effect).toMatch(/readMarkKey\(\{ loaded: readable, seen: pageSeen, unread, groupId, newestOther, marked: marked\.current \}\)/);
    expect(effect).toMatch(/if \(!mark\) return;/);
    // The debounce: the mark waits a second, and the effect's clean-up cancels it when a newer message comes first.
    expect(effect).toMatch(/const timer = window\.setTimeout\(\(\) => \{[\s\S]*?markRead\(undefined, \{ onError: \(\) => \{ marked\.current = null; \} \}\);[\s\S]*?\}, MARK_READ_DEBOUNCE_MS\);/);
    expect(effect).toMatch(/return \(\) => window\.clearTimeout\(timer\);/);
    // Every value it reads is a dependency (the mutation's mutate is stable), so no lint rule is switched off for it.
    expect(thread).toMatch(/\}, \[readable, pageSeen, unread, groupId, newestOther, markRead\]\);/);
    expect(thread).not.toMatch(/eslint-disable/);
    // The page is seen while it is in front of the member: read from the document, and followed as it changes.
    const seen = blockFrom(thread, 'function usePageSeen');
    expect(seen).toMatch(/document\.visibilityState === 'visible'/);
    expect(seen).toMatch(/addEventListener\('visibilitychange'/);
  });

  it('opens at the newest message even when the details come after the messages: the first scroll waits for the list to be drawn', () => {
    // The list is drawn only once both have arrived; "shown" makes the effect run then, not only when a page changes.
    expect(thread).toMatch(/const shown = !!detail\.data && !!thread\.data;/);
    expect(thread).toMatch(/\}, \[shown, newest\?\.id, newest\?\.fromUserId, pagesLength, myUserId\]\);/);
    expect(thread).toMatch(/data-testid="group-thread-scroll"/);
  });

  it('"Show earlier messages" asks for the page again when a change to the group dropped it, noting the place before each ask', () => {
    const earlier = blockFrom(thread, 'const showEarlier');
    expect(earlier).toMatch(/untilEarlierPage\(/);
    expect(earlier).toMatch(/\(\) => thread\.fetchNextPage\(\)/);
    expect(earlier).toMatch(/thread\.data\?\.pages\.length \?\? 0/);
    expect(earlier).toMatch(/keepPlace\.current = \{ height: el\.scrollHeight, top: el\.scrollTop \}/);
  });

  it('a first read refused for going too fast says so, with Try again, while it is tried again after the window', () => {
    expect(thread).toMatch(/isRateLimited\(detail\.failureReason\) \|\| isRateLimited\(thread\.failureReason\)/);
  });

  it('the message box is 44px tall on every width, and Enter does not send while a word is still being composed', () => {
    expect(classAfter(thread, '<textarea').split(/\s+/)).toContain('min-h-[44px]');
    expect(thread).toMatch(/if \(e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing\)/);
  });

  it('has a loading, an empty and three error states, each with a way back to Messages', () => {
    expect(thread).toMatch(/data-testid="group-thread-loading"/);
    expect(thread).toMatch(/GROUP_EMPTY/);
    expect(thread).toMatch(/GROUP_GONE/);
    expect(thread).toMatch(/NOT_IN_GROUP/);
    expect(thread).toMatch(/GROUP_FAILED/);
    expect(thread).toMatch(/BACK_TO_MESSAGES/);
  });

  it('"Show earlier messages" loads the page before, from a 44px button', () => {
    expect(thread).toMatch(/fetchNextPage\(\)/);
    expect(thread).toMatch(/SHOW_EARLIER/);
  });

  it('the message box is a react-hook-form with the server\'s rules, 16px on a phone, and a 44px send button', () => {
    expect(thread).toMatch(/useForm<SendValues>\(\{[\s\S]*?resolver: formResolver\(sendSchema\)/);
    expect(thread).toMatch(/maxLength=\{GROUP_MESSAGE_MAX\}/);
    expect(thread).toMatch(/text-base sm:text-sm/);
    expect(thread).toMatch(/aria-label="Send message"/);
    expect(thread).toMatch(/h-11 w-11/);
    expect(thread).toMatch(/env\(safe-area-inset-bottom/);
  });

  it('a failed send keeps the words and says why in a sentence', () => {
    expect(thread).toMatch(/groupErrorSentence\(err, SEND_FAILED\)/);
  });
});

describe('the members sheet', () => {
  const sheet = read('features/messages/GroupMembersSheet.tsx');

  it('is the REASON sheet (a bottom sheet on a phone, portalled to the page)', () => {
    expect(sheet).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
  });

  it('states the cap and the count', () => {
    expect(sheet).toMatch(/ofMax\(/);
    expect(sheet).toMatch(/GROUP_LIMIT/);
  });

  it('Leave asks first, then leaves and goes back to Messages', () => {
    expect(sheet).toMatch(/LEAVE_WARNING/);
    expect(sheet).toMatch(/leave\.mutate\(/);
    expect(sheet).toMatch(/navigate\('\/messages', \{ replace: true \}\)/);
  });

  it('only the group\'s admin removes people (never themselves) and adds people who took part in its event', () => {
    expect(sheet).toMatch(/const isAdmin = group\.myRole === 'admin';/);
    expect(sheet).toMatch(/isAdmin && m\.userId !== myUserId/);
    expect(sheet).toMatch(/isAdmin && group\.type === 'event' && group\.sessionId/);
  });

  it('nobody can be added past 50: the full group says so in the server\'s words', () => {
    expect(sheet).toMatch(/roomLeft\(/);
    expect(sheet).toMatch(/GROUP_FULL/);
    expect(sheet).toMatch(/byName\(tookPart\(/);
  });

  it('lists the members admin first, then as they joined, people who joined together by name', () => {
    expect(sheet).toMatch(/membersInOrder\(group\.members\)\.map\(/);
  });
});

describe('the group screens share one class for their text buttons, 44px tall', () => {
  it('one string, in one place', () => {
    expect(read('features/messages/buttons.ts')).toMatch(/export const TEXT_BUTTON = '[^']*\bmin-h-\[44px\][^']*';/);
  });

  it.each([
    ['the thread', 'features/messages/GroupThread.tsx'],
    ['the members sheet', 'features/messages/GroupMembersSheet.tsx'],
    ['the start card', 'features/sessions/StartGroupChatCard.tsx'],
  ])('%s uses it, and keeps no copy of its own', (_name, file) => {
    const src = read(file);
    expect(src).toMatch(/import \{ TEXT_BUTTON \} from '[^']*buttons';/);
    expect(src).not.toMatch(/const BUTTON = /);
  });
});

describe('Messages: groups in the inbox, a group open at /messages/g/:groupId', () => {
  const page = read('features/messages/MessagesPage.tsx');
  const app = read('App.tsx');

  it('the address of a group chat opens it in Messages (the temporary redirect is gone)', () => {
    expect(app).toMatch(/<Route path="\/messages\/g\/:groupId" element=\{<MessagesPage \/>\} \/>/);
    expect(app).not.toMatch(/\/messages\/g\/:groupId" element=\{<Navigate/);
    expect(app).not.toMatch(/until it goes live/);
  });

  it('the page reads the group from the address and draws its thread in place of a conversation', () => {
    expect(page).toMatch(/groupId\?: string;/);
    expect(page).toMatch(/\{groupId \? \(\s*<GroupThread key=\{groupId\} groupId=\{groupId\} \/>/);
  });

  it('on a phone an open group hides the inbox, as an open conversation does', () => {
    expect(page).toMatch(/const threadShown = !!activeId \|\| isComposeMode \|\| !!groupId;/);
  });

  it('the inbox merges the groups in, each as its own row', () => {
    expect(page).toMatch(/mergeInbox\(inboxData, groups\.data \?\? \[\]\)/);
    expect(page).toMatch(/<GroupInboxRow/);
    expect(page).toMatch(/GROUPS_FAILED/);
  });

  it('a group list that could not be read is said only when there is none to show; a 429 being waited out does not hold the inbox up', () => {
    expect(page).toMatch(/const groupsUnavailable = !groups\.data && \(groups\.isError \|\| isRateLimited\(groups\.failureReason\)\);/);
    expect(page).toMatch(/\{groupsUnavailable && \(/);
    expect(page).toMatch(/inboxData === undefined \|\| \(groups\.isPending && !groupsUnavailable\) \?/);
    expect(page).not.toMatch(/\{groups\.isError && \(/);
  });

  it('the one-to-one message box is 44px tall too, and Enter does not send mid-composition', () => {
    expect(classAfter(page, '<textarea').split(/\s+/)).toContain('min-h-[44px]');
    expect(page).toMatch(/if \(e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing\)/);
  });
});

describe('the Messages badge counts the groups\' unread too', () => {
  const shell = read('features/reason/shell/ReasonShell.tsx');

  it('the one-to-one count plus every group\'s, for the sidebar and the phone bar alike', () => {
    expect(shell).toMatch(/const groupUnread = useGroupUnreadTotal\(\);/);
    expect(shell).toMatch(/const unreadCount = \(unread \?\? 0\) \+ groupUnread;/);
    expect(shell).toMatch(/<ShellSidebar unreadCount=\{unreadCount\} \/>/);
    expect(shell).toMatch(/<MobileNav unreadCount=\{unreadCount\} \/>/);
  });
});

describe('"Start a group chat" on a completed event, for the people who ran it', () => {
  const page = read('features/sessions/SessionDetailPage.tsx');
  const card = read('features/sessions/StartGroupChatCard.tsx');

  it('sits beside the message-everyone panel, in the after-event tools only the people who ran the event see', () => {
    const tools = page.slice(page.indexOf('data-testid="after-event-tools"'));
    expect(tools.indexOf('<MessageParticipantsPanel')).toBeGreaterThan(-1);
    expect(tools.indexOf('<StartGroupChatCard')).toBeGreaterThan(tools.indexOf('<MessageParticipantsPanel'));
    expect(tools.indexOf('<StartGroupChatCard')).toBeLessThan(tools.indexOf('</div>'));
    expect(page).toMatch(/showAfterEventTools = phase === 'done' && mayRunEvent/);
  });

  it('chooses from the people who took part (by name), states the cap, and stops at 3 to 50', () => {
    expect(card).toMatch(/byName\(tookPart\(/);
    expect(card).toMatch(/startChosen\(/);
    expect(card).toMatch(/startProblem\(/);
    expect(card).toMatch(/roomLeft\(/);
    expect(card).toMatch(/GROUP_LIMIT/);
    expect(card).toMatch(/ofMax\(/);
  });

  it('one press starts one group (the button is off while it starts), then the group opens', () => {
    expect(card).toMatch(/disabled=\{start\.isPending \|\| problem !== null\}/);
    expect(card).toMatch(/navigate\(`\/messages\/g\/\$\{created\.id\}`\)/);
    expect(card).toMatch(/startBody\(/);
  });

  it('has a loading and an error state', () => {
    expect(card).toMatch(/data-testid="start-group-loading"/);
    expect(card).toMatch(/PEOPLE_FAILED/);
  });

  it('can be narrower than a long group name: a grid item is as wide as its longest line unless it may shrink', () => {
    // At 360px a long name in "Your group chats from this event" pushed both after-event cards past the screen's edge.
    expect(card).toMatch(/const CARD = 'min-w-0 [^']*';/);
    expect(card).toMatch(/<span className="min-w-0 truncate font-medium">\{g\.name\}<\/span>/);
  });
});
