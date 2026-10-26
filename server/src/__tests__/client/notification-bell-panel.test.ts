// ─── The bell panel on a phone: clear of the home indicator, and nothing cut off ─
// (8 Oct 2026)
//
// Two faults on a phone. In portrait the panel is a sheet fixed to the bottom of the screen, and with the
// page allowed to run under the home indicator (viewport-fit=cover) the last row's Accept sat under it.
// In landscape the screen is wide enough for the dropdown and only ~390px tall, so the panel's cap of 80vh
// (312px) was shorter than its header and its list (44 + 320px): the panel clipped the bottom of the list,
// and the last row's buttons could not be scrolled into view. The client has no test runner of its own, so,
// like the other files here, this reads the source. How the panel looks and where its last row ends up, in
// portrait with a home indicator, in landscape and on a desktop, was measured in a real browser; see the
// task report.

import * as fs from 'fs';
import * as path from 'path';
import { MutationObserver, QueryClient } from '@tanstack/query-core';
import {
  alreadyAnswered, alreadyAnsweredMessage, answerOnce, bellRequestView, requestAnswerKey, requestIdFromLink,
} from '../../../../client/src/features/messages/request-answer';

const BELL = fs.readFileSync(path.join(__dirname, '../../../../client/src/components/ui/NotificationBell.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The classes of the element whose opening tag matches, split into words. */
function classesOf(re: RegExp): string[] {
  const m = BELL.match(re);
  if (!m) throw new Error(`not found in NotificationBell.tsx: ${re}`);
  return m[1].split(/\s+/).filter(Boolean);
}

const panel = () => classesOf(/<div className="(absolute z-\[9999\][^"]*)"/);
const header = () => classesOf(/<div className="([^"]*border-b border-gray-100[^"]*)">\s*<h3/);
const list = () => classesOf(/\{\/\* List\b[^*]*\*\/\}\s*<div className="([^"]*)">/);

describe('the bell panel', () => {
  it('leaves room for the home indicator on a phone, and none from the sm breakpoint up', () => {
    expect(panel()).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(panel()).toContain('sm:pb-0');
  });

  it('is a column, so that when the panel is capped it is the list that gives way', () => {
    expect(panel()).toContain('flex');
    expect(panel()).toContain('flex-col');
    expect(list()).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
  });

  it('keeps its header whole when the panel is short', () => {
    expect(header()).toContain('shrink-0');
  });

  it('is still the same panel: a bottom sheet capped at 80vh on a phone, a 20rem dropdown from sm up, the list capped at 20rem', () => {
    expect(panel()).toEqual(expect.arrayContaining([
      'absolute', 'inset-x-0', 'bottom-0', 'max-h-[80vh]', 'overflow-hidden', 'rounded-t-2xl', 'sm:rounded-xl', 'sm:inset-auto', 'sm:w-80',
    ]));
    expect(list()).toContain('max-h-80');
  });

  it('does not scroll the whole panel: only the list scrolls', () => {
    expect(panel()).not.toContain('overflow-y-auto');
    expect(panel()).not.toContain('overflow-auto');
  });
});

// ─── The bell reads the server's state of each meeting request (26 Oct 2026, CON-02) ─────────────────────────────────
//
// On 25 Oct Claus accepted Stefan's request on the Messages card, opened the bell, and its entry still offered Accept.
// The bell kept the answer in its own memory (a `pokeStatus` it set itself) and every fetch replaced its list, so the
// buttons came back. Since S1 the server says where each request stands (`requestState`). The bell now reads its list
// through React Query, refreshed by the member's notifications tag, and draws only what the server says. The three
// places a request can be answered (the bell, the Messages list card and the focused card) share one mutation key per
// request, so none of them offers a second answer while one is on its way. request-answer.ts is pure, so it is run.

const REQUEST = '3f1c2b4a-1111-4a2b-9c3d-0123456789ab';
const LINK = `/messages?poke=${REQUEST}`;
const CONV = 'aa11bb22-3333-4c4d-8e9f-0123456789cd';
const row = (extra: Record<string, unknown>) => ({ type: 'poke', link: LINK, ...extra });

describe('a meeting request in the bell is drawn from the server, never from the bell\'s own memory', () => {
  it('waiting: Accept and Decline, and the title opens the request', () => {
    expect(bellRequestView(row({ requestState: { status: 'pending', conversationId: null } })))
      .toEqual({ requestId: REQUEST, canAnswer: true, label: null, destination: LINK });
  });

  it('accepted: "Accepted", nothing to press, and the title opens the conversation', () => {
    expect(bellRequestView(row({ requestState: { status: 'accepted', conversationId: CONV }, pokeStatus: 'accepted' })))
      .toEqual({ requestId: REQUEST, canAnswer: false, label: 'Accepted', destination: `/messages/${CONV}` });
  });

  it('declined: "Declined", nothing to press', () => {
    expect(bellRequestView(row({ requestState: { status: 'declined', conversationId: null }, pokeStatus: 'declined' })))
      .toEqual({ requestId: REQUEST, canAnswer: false, label: 'Declined', destination: LINK });
  });

  it('a request that is gone (null), or in a state this build does not know, offers nothing', () => {
    expect(bellRequestView(row({ requestState: null, pokeStatus: null }))).toEqual({ requestId: REQUEST, canAnswer: false, label: null, destination: LINK });
    expect(bellRequestView(row({ requestState: { status: 'withdrawn', conversationId: null } }))).toMatchObject({ canAnswer: false, label: null });
  });

  it('a server that predates requestState is read through pokeStatus, as production\'s bell reads it', () => {
    expect(bellRequestView(row({ pokeStatus: 'accepted' }))).toMatchObject({ canAnswer: false, label: 'Accepted' });
    expect(bellRequestView(row({ pokeStatus: null }))).toMatchObject({ canAnswer: true, label: null });
    expect(bellRequestView(row({}))).toMatchObject({ canAnswer: true, label: null });
  });

  it('only a poke row with a whole request id in its link is a request', () => {
    expect(bellRequestView({ type: 'direct_message', link: LINK })).toBeNull();
    expect(bellRequestView({ type: 'poke', link: '/messages?poke=------------------------------------' })).toBeNull();
    expect(bellRequestView({ type: 'poke', link: `/messages?poke=${REQUEST}&x=1` })).toBeNull();
    expect(requestIdFromLink(LINK.toUpperCase().replace('/MESSAGES?POKE=', '/messages?poke='))).toBe(REQUEST.toUpperCase());
    expect(requestIdFromLink(undefined)).toBeNull();
  });
});

describe('answering a request that was already answered the other way', () => {
  const conflict = (status: string, message?: unknown) => ({
    response: { status: 409, data: { error: { code: 'MEETING_REQUEST_ALREADY_ANSWERED', message, details: { status } } } },
  });

  it('says the server\'s own sentence: today "You already {accepted|declined} this request."', () => {
    expect(alreadyAnswered(conflict('accepted', 'You already accepted this request.')))
      .toEqual({ status: 'accepted', message: 'You already accepted this request.' });
    expect(alreadyAnswered(conflict('declined', 'You already declined this request.')))
      .toEqual({ status: 'declined', message: 'You already declined this request.' });
  });

  it('a request a match already closed reads as the server says it: "You\'re already connected."', () => {
    expect(alreadyAnswered(conflict('accepted', "You're already connected.")))
      .toEqual({ status: 'accepted', message: "You're already connected." });
  });

  it('with no sentence fit to show, it says which answer the request has', () => {
    expect(alreadyAnswered(conflict('accepted'))).toEqual({ status: 'accepted', message: 'You already accepted this request.' });
    expect(alreadyAnswered(conflict('declined', '   '))).toEqual({ status: 'declined', message: 'You already declined this request.' });
    // A sentence carrying an id, or the code's word for a request, is never shown.
    expect(alreadyAnswered(conflict('accepted', `Poke ${REQUEST} was already accepted`)))
      .toEqual({ status: 'accepted', message: 'You already accepted this request.' });
    expect(alreadyAnsweredMessage('accepted')).toBe('You already accepted this request.');
  });

  it('anything else is not that answer', () => {
    expect(alreadyAnswered(conflict('pending'))).toBeNull();
    expect(alreadyAnswered({ response: { status: 409, data: { error: { code: 'OTHER', details: { status: 'accepted' } } } } })).toBeNull();
    expect(alreadyAnswered({ response: { status: 400, data: { error: { code: 'MEETING_REQUEST_ALREADY_ANSWERED' } } } })).toBeNull();
    expect(alreadyAnswered(new Error('network'))).toBeNull();
  });

  it('one mutation key per request, the same wherever the request is answered', () => {
    expect(requestAnswerKey(REQUEST)).toEqual(['request-answer', REQUEST]);
  });
});

describe('a double click answers once', () => {
  // Run against React Query's own mutation cache (the one the app uses), with answers that stay on their way until the
  // test lets them land. Every answer still on its way lands after each test, pass or fail: a mutation left pending
  // keeps jest from exiting.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let client: QueryClient;
  let pending: Array<() => void> = [];
  const landAll = async () => {
    const lands = pending;
    pending = [];
    for (const land of lands) land();
    await flush();
  };
  beforeEach(() => { client = new QueryClient(); });
  afterEach(async () => {
    await landAll();
    client.clear();
  });

  function answering(requestId: string) {
    const sent: string[] = [];
    const observer = new MutationObserver<void, Error, string>(client, {
      mutationKey: requestAnswerKey(requestId),
      gcTime: 0,
      mutationFn: (answer) => {
        sent.push(answer);
        return new Promise<void>((resolve) => { pending.push(resolve); });
      },
    });
    const press = (answer: string) => answerOnce(client, requestId, () => { observer.mutate(answer).catch(() => undefined); });
    return { sent, press };
  }

  it('the second press, in the same instant (no render between), finds the first on its way and sends nothing', async () => {
    const { sent, press } = answering(REQUEST);
    expect(press('accept')).toBe(true);
    expect(press('accept')).toBe(false);
    expect(press('decline')).toBe(false);
    await flush();
    expect(sent).toEqual(['accept']);
    // Once it has landed, the request can be answered again (a retry after a failure is the same press).
    await landAll();
    expect(press('accept')).toBe(true);
    await flush();
    expect(sent).toEqual(['accept', 'accept']);
  });

  it('an answer on its way for one request never holds back another request', async () => {
    const first = answering(REQUEST);
    const second = answering('f5f5f5f5-0000-4000-8000-000000000002');
    expect(first.press('accept')).toBe(true);
    expect(second.press('decline')).toBe(true);
    await flush();
    expect([first.sent, second.sent]).toEqual([['accept'], ['decline']]);
  });
});

describe('the bell and the request cards, read from source', () => {
  const bell = () => BELL;
  const requests = () => fs.readFileSync(path.join(__dirname, '../../../../client/src/features/messages/MeetingRequests.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');
  const hook = () => fs.readFileSync(path.join(__dirname, '../../../../client/src/features/messages/useRequestAnswer.ts'), 'utf8')
    .replace(/\r\n/g, '\n');

  it('the bell\'s list is React Query\'s [\'notifications\'], refreshed by the member\'s notifications tag', () => {
    expect(bell()).toMatch(/const NOTIFICATIONS_KEY = \['notifications'\] as const;/);
    expect(bell()).toMatch(/useQuery\(\{\s*queryKey: NOTIFICATIONS_KEY,/);
    expect(bell()).toMatch(/meta: \{ entities: me \? \[E\.userNotifications\(me\)\] : \[\] \}/);
  });

  it('keeps no list and no request status of its own', () => {
    expect(bell()).not.toMatch(/useState<Notification\[\]>/);
    expect(bell()).not.toMatch(/setNotifications/);
    expect(bell()).not.toMatch(/setUnreadCount/);
    expect(bell()).not.toMatch(/pokeStatus: '(accepted|declined)'/);
  });

  it('draws each request from bellRequestView, and answers through the shared hook', () => {
    expect(bell()).toMatch(/bellRequestView\(n\)/);
    expect(bell()).toMatch(/useRequestAnswer\(view\.requestId, \{/);
  });

  it('the hook keys the mutation by request and reads every answer in flight for it, from any surface', () => {
    expect(hook()).toMatch(/mutationKey: requestAnswerKey\(requestId\)/);
    expect(hook()).toMatch(/useMutationState\(\{\s*filters: \{ mutationKey: requestAnswerKey\(requestId\), status: 'pending' \}/);
  });

  it('every press goes through the double-click guard; the bare mutate is never handed out', () => {
    expect(hook()).toMatch(/const answer = \(choice: Answer\) => \{ answerOnce\(qc, requestId, \(\) => mutation\.mutate\(choice\)\); \};/);
    expect(hook()).toMatch(/return \{\s*answer,/);
    expect(hook()).not.toMatch(/answer: mutation\.mutate/);
  });

  it('an optimistic mark-read first cancels any bell fetch on its way, so an older answer cannot undo it', () => {
    expect(bell()).toMatch(/async function patchList\(qc: QueryClient, change: \(n: Notification\) => Notification\) \{\s*await qc\.cancelQueries\(\{ queryKey: NOTIFICATIONS_KEY \}\);\s*qc\.setQueryData</);
    const calls = bell().match(/\n[^\n]*\bpatchList\(qc,/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(call).toMatch(/await patchList\(qc,/);
  });

  it('the request cards\' profile links are 44px to press and look as they did: padding taken back by margins', () => {
    const src = requests();
    // The list card: a 40px avatar plus 2px all round, and a 20px name line plus 12px above and below.
    expect(src).toMatch(/className="-m-0\.5 shrink-0 p-0\.5"/);
    expect(src).toMatch(/className="relative -my-3 block truncate py-3 text-sm font-semibold/);
    // The focused card: a 28px name line plus 8px, and the 16px "View full profile" line plus 14px.
    expect(src).toMatch(/className="relative mt-1 -mb-2 block py-2 text-lg font-bold/);
    expect(src).toMatch(/className="relative -mt-0\.5 -mb-3\.5 inline-block py-3\.5 text-xs font-medium text-rsn-red underline"/);
    // Profiles open in the same tab now; nothing here says otherwise.
    expect(src).not.toMatch(/new tab/i);
  });

  it('the Messages list card and the focused card both answer through it, one request at a time', () => {
    const src = requests();
    expect(src.match(/<RequestAnswerButtons\b/g)).toHaveLength(2);
    expect(src).toMatch(/useRequestAnswer\(requestId, \{/);
    expect(src).not.toMatch(/acceptMutation|declineMutation|usePokeActions/);
  });
});
