// ─── After the event: the chat kept, message everyone, one path back (C10, COM-02/03/05, 26 Oct 2026) ───
//
// 25 Oct walkthrough: Stefan pressed Leave Event and landed on the events list with the app's live connection
// cut (no bells, no "Ended", no live messages until the token rotated); Claus ended the event and stayed on an
// in-page recap with no way to the event; the completed event showed no chat; "Message all participants" was
// greyed out with its reason in a hover title. Now one path for every role: Live, then the event's page (the
// recap, the chat kept with the event, message everyone), then back to the pod. The pure parts are run here;
// the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import type { BroadcastEligibilityV2, EventChatPage, PostEventMessageJob } from '@rsn/shared';
import { LIVE_CHAT_CAP, mergeChatHistory, withoutTakenDown } from '../../../../client/src/hooks/chat-history';
import {
  BODY_TOO_LONG, LAST_SEND_FAILED, NOT_SENT, SEND_ANOTHER, WRITE_FIRST, WRITE_MESSAGE,
  composerSchema, limitSentence, panelView, people, recipientsOf, sendErrorSentence, sendLabel, sentSentence,
} from '../../../../client/src/features/sessions/post-event-panel';
import {
  CHAT_EMPTY, CHAT_FORBIDDEN, CHAT_LIVE, CHAT_PAGE_SIZE, ENTER_LIVE, SHOW_EARLIER,
  chatInOrder, chatLoadProblem, reactionSummary,
} from '../../../../client/src/features/sessions/event-chat-text';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';

const exists = (rel: string) => fs.existsSync(path.join(__dirname, '../../../../client/src', rel));
// A file that is not there reads as empty, so each test that needs it fails on its own expectations.
const read = (rel: string) =>
  exists(rel) ? fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n') : '';

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

// ── The live chat's history ───────────────────────────────────────────────────

interface Msg { id: string; timestamp: string; scope: 'lobby' | 'room'; message?: string; reactions?: Record<string, string[]> }
const t = (sec: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, sec)).toISOString();
const msg = (id: string, sec: number, extra: Partial<Msg> = {}): Msg => ({ id, timestamp: t(sec), scope: 'lobby', ...extra });
const ids = (list: { id: string }[]) => list.map((m) => m.id);

describe('chat:history is merged into the panel, never put in place of it', () => {
  it('adds what the panel lacked, oldest first', () => {
    expect(ids(mergeChatHistory([msg('b', 2)], [msg('a', 1), msg('b', 2)]))).toEqual(['a', 'b']);
  });

  it('keeps a message that came in while the history was on its way (the late-joiner race)', () => {
    expect(ids(mergeChatHistory([msg('a', 1), msg('c', 3)], [msg('a', 1), msg('b', 2)]))).toEqual(['a', 'b', 'c']);
  });

  it('holds every message once, the server\'s copy in place of ours', () => {
    const merged = mergeChatHistory([msg('a', 1, { reactions: {} })], [msg('a', 1, { reactions: { heart: ['u1'] } })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].reactions).toEqual({ heart: ['u1'] });
  });

  it('keeps the newest messages up to the panel\'s cap', () => {
    const held = Array.from({ length: 150 }, (_, i) => msg(`h${i}`, i));
    const incoming = Array.from({ length: 100 }, (_, i) => msg(`n${i}`, 150 + i));
    const merged = mergeChatHistory(held, incoming);
    expect(merged).toHaveLength(LIVE_CHAT_CAP);
    expect(merged[0].id).toBe('h50');
    expect(merged[merged.length - 1].id).toBe('n99');
  });

  it('orders messages sent in the same millisecond by id, as the server does', () => {
    expect(ids(mergeChatHistory([msg('b', 5)], [msg('a', 5)]))).toEqual(['a', 'b']);
  });

  it('an empty history changes nothing', () => {
    const held = [msg('a', 1), msg('b', 2)];
    expect(mergeChatHistory(held, [])).toEqual(held);
  });
});

describe('a message taken down leaves the live panel (the chat page is the truth)', () => {
  const page = (list: Msg[], complete: boolean) => ({
    messages: list.map((m) => ({ id: m.id, createdAt: m.timestamp, scope: m.scope })),
    complete,
  });

  it('drops a message the panel held before the page was read, which the page no longer has', () => {
    const held = [msg('a', 1), msg('b', 2), msg('c', 3)];
    expect(ids(withoutTakenDown(held, page([held[0], held[2]], true), new Set(['a', 'b', 'c']), false))).toEqual(['a', 'c']);
  });

  it('keeps a message that came in after the page was asked for', () => {
    const held = [msg('a', 1), msg('b', 2), msg('d', 4)];
    expect(ids(withoutTakenDown(held, page([held[0], held[1]], true), new Set(['a', 'b']), false))).toEqual(['a', 'b', 'd']);
  });

  it('keeps an older message the page does not reach back to', () => {
    const held = [msg('a', 1), msg('b', 2), msg('c', 3)];
    expect(ids(withoutTakenDown(held, page([held[1], held[2]], false), new Set(['a', 'b', 'c']), false))).toEqual(['a', 'b', 'c']);
  });

  it('a whole chat with nothing left in it: the last message is gone too', () => {
    const held = [msg('a', 1)];
    expect(withoutTakenDown(held, page([], true), new Set(['a']), false)).toEqual([]);
  });

  it('reaches a message of the same millisecond only when the page would have listed it first', () => {
    const oldest = msg('m', 2);
    const sameMsLater = msg('z', 2);
    const sameMsEarlier = msg('a', 2);
    const held = [sameMsEarlier, oldest, sameMsLater, msg('n', 3)];
    const kept = withoutTakenDown(held, page([oldest, held[3]], false), new Set(ids(held)), false);
    expect(ids(kept)).toEqual(['a', 'm', 'n']);
  });

  it('a room message is judged only when the reader can see room messages on the page', () => {
    const room = msg('r', 2, { scope: 'room' });
    const held = [msg('a', 1), room, msg('c', 3)];
    const before = new Set(ids(held));
    const lobbyOnly = page([held[0], held[2]], true);
    // Everyone who reads the page and is not an admin reads its rooms: the room message is gone.
    expect(ids(withoutTakenDown(held, lobbyOnly, before, false))).toEqual(['a', 'c']);
    // An admin who did not take part reads the lobby only, so a room message missing from it says nothing.
    expect(ids(withoutTakenDown(held, lobbyOnly, before, true))).toEqual(['a', 'r', 'c']);
    // An admin whose page shows a room message reads rooms.
    const other = msg('o', 4, { scope: 'room' });
    expect(ids(withoutTakenDown([...held, other], page([held[0], held[2], other], true), new Set([...before, 'o']), true)))
      .toEqual(['a', 'c', 'o']);
  });
});

// ── The event chat card ───────────────────────────────────────────────────────

describe('the event chat card', () => {
  it('says what it is in the words given', () => {
    expect(CHAT_EMPTY).toBe('No messages were sent during this event.');
    expect(CHAT_FORBIDDEN).toBe('Only people who took part in this event can read its chat.');
    expect(CHAT_LIVE).toBe('The chat is inside the live event.');
    expect(ENTER_LIVE).toBe('Enter live event');
    expect(SHOW_EARLIER).toBe('Show earlier messages');
    expect(CHAT_PAGE_SIZE).toBe(30);
  });

  it('shows the pages oldest first: the first page is the newest, each next page the one before it', () => {
    const m = (id: string, sec: number) => ({
      id, senderId: 'u', senderName: 'N', senderIsHost: false, scope: 'lobby' as const, content: id, createdAt: t(sec), reactions: {},
    });
    const pages: EventChatPage[] = [
      { messages: [m('c', 3), m('d', 4)], nextCursor: 'x' },
      { messages: [m('a', 1), m('b', 2)], nextCursor: null },
    ];
    expect(ids(chatInOrder(pages))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lists the reactions a message had, with their counts, in a fixed order', () => {
    expect(reactionSummary({ thumbs_up: 1, heart: 2, clap: 0 })).toEqual([{ emoji: '❤️', count: 2 }, { emoji: '👍', count: 1 }]);
    expect(reactionSummary({})).toEqual([]);
  });

  it('a 403 is the reader not having taken part; anything else is a failure to load', () => {
    expect(chatLoadProblem({ response: { status: 403 } })).toBe('forbidden');
    expect(chatLoadProblem({ response: { status: 500 } })).toBe('failed');
    expect(chatLoadProblem(new Error('x'))).toBe('failed');
  });
});

// ── Message everyone ─────────────────────────────────────────────────────────

const elig = (over: Partial<BroadcastEligibilityV2>): BroadcastEligibilityV2 => ({
  enabled: true, visible: true, reason: 'ok', explanation: '', audience: { tookPart: 2, registeredNoShow: 1 }, ...over,
});
const job = (over: Partial<PostEventMessageJob>): PostEventMessageJob => ({
  id: 'j', sessionId: 's', status: 'completed', totalRecipients: 2, sentCount: 2, failedCount: 0,
  createdAt: '2026-10-26T12:00:00.000Z', completedAt: '2026-10-26T12:00:20.000Z', ...over,
});
const NOON = '2026-10-26T12:00:00.000Z';

describe('the message-everyone panel says where it stands, in words, never a hover title', () => {
  it('is not there for someone who does not run the event, nor when nobody else took part', () => {
    expect(panelView(undefined, null).show).toBe(false);
    expect(panelView(elig({ enabled: false, visible: false, reason: 'not_organiser' }), null).show).toBe(false);
    expect(panelView(elig({ enabled: false, reason: 'no_recipients', explanation: 'Nobody else took part in this event.' }), null).show).toBe(false);
  });

  it('an organiser who can send: one button to write the message', () => {
    expect(panelView(elig({}), null)).toEqual({ show: true, status: null, sent: null, problem: null, action: WRITE_MESSAGE });
  });

  it('after a send: "Sent to {n} people on {date}" and "Send another message"', () => {
    const v = panelView(elig({ lastSent: { at: NOON, recipients: 2 } }), job({}));
    expect(v.sent).toBe('Sent to 2 people on 26 Oct 2026');
    expect(v.action).toBe(SEND_ANOTHER);
    expect(sentSentence(1, NOON)).toBe('Sent to 1 person on 26 Oct 2026');
  });

  it('while it goes out: the server\'s "Sending… x of y." and no button', () => {
    const v = panelView(elig({ enabled: false, reason: 'sending', explanation: 'Sending… 1 of 3.' }), job({ status: 'processing' }));
    expect(v).toEqual({ show: true, status: 'Sending… 1 of 3.', sent: null, problem: null, action: null });
  });

  it('at the limit: when the next one may go, in the reader\'s own clock', () => {
    const at = '2026-10-26T14:20:00.000Z';
    const d = new Date(at);
    const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const v = panelView(elig({
      enabled: false, reason: 'limit', explanation: 'You can send another message at 19:20.', nextSendAt: at, lastSent: { at: NOON, recipients: 2 },
    }), job({}));
    expect(v.status).toBe(`You can send another message at ${clock}.`);
    expect(v.sent).toBe('Sent to 2 people on 26 Oct 2026');
    expect(v.action).toBeNull();
    expect(limitSentence(undefined, 'You can send another message at 19:20.')).toBe('You can send another message at 19:20.');
  });

  it('before the end: the server\'s sentence and no button', () => {
    const v = panelView(elig({ enabled: false, reason: 'not_ended', explanation: 'You can message everyone after the event ends.' }), null);
    expect(v).toMatchObject({ show: true, status: 'You can message everyone after the event ends.', action: null });
  });

  it('a send that reached nobody, or missed some, is said plainly', () => {
    expect(panelView(elig({}), job({ status: 'failed', sentCount: 0, failedCount: 2 })).problem).toBe(LAST_SEND_FAILED);
    expect(panelView(elig({ lastSent: { at: NOON, recipients: 1 } }), job({ status: 'completed_with_errors', sentCount: 1, failedCount: 1 })).problem)
      .toBe('1 person could not be reached.');
    expect(panelView(elig({ lastSent: { at: NOON, recipients: 2 } }), job({})).problem).toBeNull();
  });

  it('counts the people the message will reach, and says so on the button', () => {
    expect(recipientsOf({ tookPart: 2, registeredNoShow: 1 }, false)).toBe(2);
    expect(recipientsOf({ tookPart: 2, registeredNoShow: 1 }, true)).toBe(3);
    expect(sendLabel(1)).toBe('Send to 1 person');
    expect(sendLabel(3)).toBe('Send to 3 people');
    expect(people(0)).toBe('0 people');
  });

  it('the message is the organiser\'s own words: 1 to 2000 characters, in the server\'s sentences', () => {
    expect(composerSchema.safeParse({ body: '  ', includeNoShows: false }).success).toBe(false);
    expect(composerSchema.safeParse({ body: '  ', includeNoShows: false }).error?.issues[0].message).toBe(WRITE_FIRST);
    expect(composerSchema.safeParse({ body: 'x'.repeat(2001), includeNoShows: false }).error?.issues[0].message).toBe(BODY_TOO_LONG);
    const ok = composerSchema.safeParse({ body: '  Thank you all.  ', includeNoShows: true });
    expect(ok.success && ok.data).toEqual({ body: 'Thank you all.', includeNoShows: true });
    expect(WRITE_FIRST).toBe('Write a message first.');
    expect(BODY_TOO_LONG).toBe('Messages can be up to 2000 characters.');
  });

  it('a refused send says the server\'s sentence when it is one a member can read', () => {
    const refused = (status: number, message: string, details?: unknown) => ({ response: { status, data: { error: { message, details } } } });
    expect(sendErrorSentence(refused(409, "Another organiser's message is being sent; try again in a minute.")))
      .toBe("Another organiser's message is being sent; try again in a minute.");
    expect(sendErrorSentence(refused(400, 'Validation failed', { body: ['Write a message first.'] }))).toBe('Write a message first.');
    expect(sendErrorSentence(refused(429, 'You have sent a lot of messages this hour. Please try again later.')))
      .toBe('You have sent a lot of messages this hour. Please try again later.');
    expect(sendErrorSentence({ isAxiosError: true, request: {} })).toBe(CONNECTION_LOST);
    expect(sendErrorSentence(refused(500, 'Internal error'))).toBe(NOT_SENT);
    expect(sendErrorSentence(refused(409, 'Job 3f2a9c1e-77aa conflicts'))).toBe(NOT_SENT);
  });
});

// ── The wiring ───────────────────────────────────────────────────────────────

describe('Leave keeps the app\'s live connection and lands on the event page', () => {
  const page = read('features/live/LiveSessionPage.tsx');
  const bar = read('features/live/meeting/MeetingControlBar.tsx');

  it('speed networking: Leave Event tells the server, keeps the socket, and replaces the live page with the event page', () => {
    const leave = blockFrom(page, 'const handleLeave');
    expect(leave).toMatch(/confirm\(/);
    expect(leave).toMatch(/emit\('session:leave', \{ sessionId: sessionId! \}\)/);
    expect(leave).not.toMatch(/disconnectSocket/);
    expect(leave).toMatch(/navigate\(`\/sessions\/\$\{sessionId\}`, \{ replace: true \}\)/);
    expect(page).not.toMatch(/disconnectSocket/);
  });

  it('a video meeting: Leave does the same (it cut the connection too, and the guest read "Reconnecting…")', () => {
    const leave = blockFrom(bar, 'const leaveMeeting');
    expect(leave).toMatch(/emit\('session:leave', \{ sessionId \}\)/);
    expect(leave).not.toMatch(/disconnectSocket/);
    expect(bar).not.toMatch(/disconnectSocket/);
  });

  it('the pod in the live header is not a bare link that reloads the page past the leave', () => {
    expect(page).not.toMatch(/<a href=\{`\/pods\//);
  });

  it('the check-in question never covers the end screen of an event that is over', () => {
    expect(page).toMatch(/\{!isHost && phase !== 'complete' && <EventCheckInModal \/>\}/);
  });
});

describe('the end of a speed-networking event offers the event first', () => {
  const end = read('features/live/SessionComplete.tsx');

  it('"Event details" (primary), "Back to pod", "Full recap", each replacing the live page', () => {
    const actions = end.slice(end.indexOf('{/* Actions'));
    const details = actions.indexOf('Event details');
    const pod = actions.indexOf('Back to pod');
    const recap = actions.indexOf('Full recap');
    expect(details).toBeGreaterThan(-1);
    expect(pod).toBeGreaterThan(details);
    expect(recap).toBeGreaterThan(pod);
    expect(end).toMatch(/leaveTo\(`\/sessions\/\$\{sessionId\}`\)/);
    expect(end).toMatch(/navigate\(to, \{ replace: true \}\)/);
    expect(end).not.toMatch(/Back to Events/);
  });

  it('stacked full width on a phone, in a row from 640px', () => {
    const actions = end.slice(end.indexOf('{/* Actions'));
    expect(actions).toMatch(/flex flex-col gap-3 sm:flex-row/);
    expect(actions).toMatch(/w-full sm:w-auto sm:flex-1/);
  });
});

describe('the recap goes back to the event, not one step of history', () => {
  const recap = read('features/sessions/RecapPage.tsx');
  it('"← Event details" is a link to the event page', () => {
    expect(recap).not.toMatch(/navigate\(-1\)/);
    expect(recap).toMatch(/<Link\s+to=\{`\/sessions\/\$\{sessionId\}`\}[^>]*>\s*<ArrowLeft[^>]*\/>\s*Event details\s*<\/Link>/);
  });
});

describe('the completed event page: back to pod, the event, the recap, message everyone, the chat, the people', () => {
  const page = read('features/sessions/SessionDetailPage.tsx');

  it('in that order', () => {
    const at = (marker: string) => {
      const i = page.indexOf(marker);
      if (i < 0) throw new Error(`missing: ${marker}`);
      return i;
    };
    const order = [
      at('{/* Back: to the pod first'),
      at('{/* Session Info */}'),
      at('{/* Actions'),
      at('{/* After the event'),
      at('<MessageParticipantsPanel'),
      at('<EventChatHistory'),
      at('{/* Participants */}'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('"Back to pod" is the first way back, then Events; both are links of 44px', () => {
    const back = page.slice(at(page, '{/* Back: to the pod first'), at(page, '{/* Session Info */}'));
    expect(back.indexOf('Back to pod')).toBeGreaterThan(-1);
    expect(back.indexOf('Back to pod')).toBeLessThan(back.indexOf('Events'));
    const links = back.match(/<Link\b[^>]*>/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link).toMatch(/className=\{BACK_LINK\}/);
    expect(page).toMatch(/const BACK_LINK = '[^']*min-h-\[44px\][^']*'/);
  });

  it('the old greyed-out button is gone; the panel is for the people who may run the event, once it has ended', () => {
    expect(exists('features/sessions/MessageParticipantsButton.tsx')).toBe(false);
    expect(page).not.toMatch(/MessageParticipantsButton/);
    expect(page).toMatch(/showAfterEventTools = phase === 'done' && mayRunEvent/);
  });

  it('a video meeting has no rounds to recap: its button shows who took part', () => {
    expect(page).toMatch(/isRoundsEvent \? 'View recap' : 'Who took part'/);
    expect(page).toMatch(/id="participants"/);
  });

  it('the refused page goes home, not to a /dashboard route that does not exist', () => {
    expect(page).not.toMatch(/\/dashboard/);
  });

  it('an ended event is not registered for behind the reader\'s back (it refuses, and that showed as an error)', () => {
    expect(page).toMatch(/if \(phase === 'done' \|\| phase === 'cancelled'\) return;/);
  });
});

function at(src: string, marker: string): number {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`missing: ${marker}`);
  return i;
}

describe('the chat card reads the chat kept with the event, a page at a time, and follows it live', () => {
  const card = read('features/sessions/EventChatHistory.tsx');

  it('its useInfiniteQuery declares E.sessionChat(sessionId) (the realtime check does not read infinite queries)', () => {
    const q = blockFrom(card, 'useInfiniteQuery(');
    expect(q).toMatch(/queryKey: \['event-chat', sessionId\]/);
    expect(q).toMatch(/meta: \{ entities: \[E\.sessionChat\(sessionId\)\] \}/);
    expect(q).toMatch(/getNextPageParam: \(last(?:: EventChatPage)?\) => last\.nextCursor \?\? undefined/);
    expect(q).not.toMatch(/refetchInterval/);
  });

  it('asks for a page of 30 from the chat endpoint, and does not retry a refusal', () => {
    expect(card).toMatch(/\/sessions\/\$\{sessionId\}\/chat/);
    expect(card).toMatch(/limit: CHAT_PAGE_SIZE/);
    expect(card).toMatch(/chatLoadProblem\(err\) !== 'forbidden'/);
  });

  it('"Show earlier messages" is a 44px button above the messages; long words wrap', () => {
    expect(card).toMatch(/SHOW_EARLIER/);
    expect(card).toMatch(/min-h-\[44px\]/);
    expect(card).toMatch(/\[overflow-wrap:anywhere\]/);
  });
});

describe('the live panel merges its history and drops a message taken down', () => {
  const hook = read('hooks/useSessionSocket.ts');

  it('chat:history is merged by id, and an empty one is ignored', () => {
    const handler = hook.slice(hook.indexOf("socket.on('chat:history'"), hook.indexOf("socket.on('chat:reaction_update'"));
    expect(handler).toMatch(/data\.messages\.length\s*===\s*0\)\s*return/);
    expect(handler).toMatch(/mergeChatHistory\(/);
    expect(handler).not.toMatch(/setChatMessages\(data\.messages\)/);
  });

  it('the event chat\'s tag sends the panel to the chat page, and its own listener is the only one it removes', () => {
    expect(hook).toMatch(/E\.sessionChat\(sessionId\)/);
    expect(hook).toMatch(/socket\.on\('entity:changed', onChatChanged\)/);
    expect(hook).toMatch(/socket\.off\('entity:changed', onChatChanged\)/);
    expect(hook).not.toMatch(/socket\.off\('entity:changed'\)/);
    expect(hook).toMatch(/withoutTakenDown\(/);
  });
});

describe('message everyone asks version 2, follows the event\'s tag, and never polls', () => {
  const hooks = read('features/sessions/usePostEventMessage.ts');
  const panel = read('features/sessions/MessageParticipantsPanel.tsx');

  it('version 2 eligibility and the status, both tagged with the event, no refetchInterval', () => {
    expect(hooks).toMatch(/post-event-message\/eligibility`, \{ params: \{ v: 2 \} \}/);
    expect(hooks).not.toMatch(/refetchInterval/);
    const eligibility = blockFrom(hooks, 'export function useBroadcastEligibilityV2');
    expect(eligibility).toMatch(/E\.session\(sessionId\)/);
    const status = blockFrom(hooks, 'export function usePostEventMessageStatus');
    expect(status).toMatch(/E\.session\(sessionId\)/);
  });

  it('the send carries the organiser\'s words', () => {
    const send = blockFrom(hooks, 'export function useSendPostEventMessage');
    expect(send).toMatch(/post-event-message`, input\)/);
  });

  it('the panel shows its state as text, opens a composer that portals to body, and never uses a title for the reason', () => {
    expect(panel).not.toMatch(/title="Pro/);
    expect(panel).toMatch(/<Modal/);
    expect(panel).toMatch(/text-base/);
    expect(panel).toMatch(/formResolver\(composerSchema\)/);
  });
});
