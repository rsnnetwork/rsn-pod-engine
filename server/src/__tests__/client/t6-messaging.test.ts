// ─── Messaging after the 30 Oct 2026 review (items 4.3, 4.4, 4.6; L7, L8, L9) ────────────────────────────────────────
//
// Stefan, 30 Oct: names should open profiles and a message should take a reply (4.3); a new message should sound and
// show as "(1)" in the browser tab (4.4); the red bubble is too strong, and the emoji picker closes after one (4.6).
// The client has no test runner of its own, so the pure modules behind those changes are run here, and the screens are
// pinned by their source. How they look and behave in real browsers is e2e/tests/n1-t6-messaging.spec.ts.

import * as fs from 'fs';
import * as path from 'path';
import { BUBBLE_LINK, CLUSTER_GAP_MS, OWN_BUBBLE, THEIR_BUBBLE, bubbleLook, clusterMessages } from '../../../../client/src/features/messages/bubble-look';
import {
  EARLIER_MESSAGE, ORIGINAL_DELETED, quoteView, replyContentOf, replyingTo, shorten,
} from '../../../../client/src/features/messages/reply-text';
import { EMOJI_PICKER_LIST, insertAtCaret, insertWithin, isComposingEnter } from '../../../../client/src/components/chat/emoji';
import { tabTitle } from '../../../../client/src/lib/tab-title';
import {
  CHIME_COOLDOWN_MS, chimeFromDm, chimeFromNotification, playsHere, quietHere, type ChimeVote,
} from '../../../../client/src/lib/message-chime-policy';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

// ─── 4.6: the gray bubble, everywhere ────────────────────────────────────────

describe('the bubble look (L9)', () => {
  it('your own bubble is gray, theirs white with a border: told apart by fill and border, and neither is red', () => {
    expect(OWN_BUBBLE).toBe('bg-gray-100 text-gray-900');
    expect(THEIR_BUBBLE).toBe('bg-white border border-gray-200 text-gray-900');
    expect(bubbleLook(true)).toBe(OWN_BUBBLE);
    expect(bubbleLook(false)).toBe(THEIR_BUBBLE);
    expect(`${OWN_BUBBLE} ${THEIR_BUBBLE}`).not.toMatch(/red/);
  });

  it.each([
    ['the one-to-one thread', 'features/messages/MessagesPage.tsx'],
    ['the group thread', 'features/messages/GroupThread.tsx'],
  ])('%s draws its bubbles with it, and no longer forces a link white', (_what, file) => {
    const src = read(file);
    expect(src).toMatch(/bubbleLook\((fromMe|mine)\)/);
    expect(src).not.toMatch(/bg-rsn-red text-white rounded-2xl|mine \? 'bg-rsn-red text-white'/);
    expect(src).not.toMatch(/text-white underline hover:opacity-80/);
  });

  it('the live event chat draws its own and others\' messages with it; the host keeps amber', () => {
    const src = read('features/live/ChatPanel.tsx');
    expect(src).toMatch(/isOwn\s*\? OWN_BUBBLE\s*: msg\.isHost\s*\? 'bg-amber-50[^']*'\s*: THEIR_BUBBLE/);
    expect(src).not.toMatch(/'bg-blue-50 text-gray-800'/);
  });

  it('a link in any bubble is the bubble\'s own colour, underlined, never red (fix round 1): 1:1, group and live chat', () => {
    expect(BUBBLE_LINK).toBe('break-all underline underline-offset-2 hover:opacity-80');
    expect(BUBBLE_LINK).not.toMatch(/text-|red/);
    expect(read('features/messages/MessagesPage.tsx')).toContain('<Linkify text={localizeMeetingText(m.content)} className={BUBBLE_LINK} />');
    expect(read('features/messages/GroupThread.tsx')).toContain('<Linkify text={m.content} className={BUBBLE_LINK} />');
    expect(read('features/live/ChatPanel.tsx')).toContain('<Linkify text={msg.message} className={BUBBLE_LINK} />');
  });

  it('one rule runs messages together in both threads (P18): one person, within a minute, the same day, never a card', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString();
    const runs = clusterMessages([
      { fromUserId: 'a', createdAt: at(0) },
      { fromUserId: 'a', createdAt: at(30) },
      { fromUserId: 'a', createdAt: at(30), kind: 'system' },
      { fromUserId: 'a', createdAt: at(40) },
      { fromUserId: 'b', createdAt: at(41) },
      { fromUserId: 'b', createdAt: new Date(Date.parse(at(41)) + CLUSTER_GAP_MS).toISOString() },
    ]);
    expect(runs.map((r) => [r.senderId, r.messages.length])).toEqual([['a', 2], ['a', 1], ['a', 1], ['b', 1], ['b', 1]]);
    expect(read('features/messages/MessagesPage.tsx')).not.toMatch(/function clusterMessages\(/);
    expect(read('features/messages/group-chat-text.ts')).toMatch(/return clusterMessages\(messages\);/);
  });
});

// ─── 4.6: several emojis in one opening ──────────────────────────────────────

describe('the emoji picker (L9)', () => {
  it('one list for every message box', () => {
    expect(EMOJI_PICKER_LIST).toHaveLength(20);
    for (const file of ['features/messages/MessagesPage.tsx', 'features/live/ChatPanel.tsx']) {
      expect(read(file)).not.toMatch(/EMOJI_PICKER_LIST = \[/);
    }
  });

  it('puts each emoji where the caret is and moves the caret after it, so picks run on', () => {
    let box = { value: 'Hi there', caret: 2 };
    for (const e of ['😀', '🎉', '👍']) {
      const next = insertAtCaret(box.value, box.caret, box.caret, e);
      box = { value: next.value, caret: next.caret };
    }
    expect(box.value).toBe('Hi😀🎉👍 there');
    expect(box.caret).toBe('Hi😀🎉👍'.length);
    expect(insertAtCaret('Hello', 0, 5, '👋')).toEqual({ value: '👋', caret: 2 });
    expect(insertAtCaret('Hello', null, null, '👋')).toEqual({ value: 'Hello👋', caret: 7 });
  });

  it('a pick that would run over the box\'s limit changes nothing', () => {
    expect(insertWithin('x'.repeat(4000), 4000, 4000, '😀', 4000)).toBeNull();
    expect(insertWithin('abc', 3, 3, '😀', 4000)).toEqual({ value: 'abc😀', caret: 5 });
  });

  it('stays open after a pick: nothing in it closes on a pick, and a press never takes the focus', () => {
    const picker = read('components/chat/EmojiPicker.tsx');
    const emojiButton = picker.slice(picker.indexOf('{EMOJI_PICKER_LIST.map('), picker.indexOf('</button>', picker.indexOf('{EMOJI_PICKER_LIST.map(')));
    expect(emojiButton).toMatch(/onClick=\{\(\) => onPick\(e\)\}/);
    expect(emojiButton).not.toMatch(/onClose/);
    expect(emojiButton).toMatch(/onPointerDown=\{\(ev\) => ev\.preventDefault\(\)\}/);
    expect(emojiButton).toMatch(/onMouseDown=\{\(ev\) => ev\.preventDefault\(\)\}/);
    // It closes on Escape, a press outside it that is not its own toggle, and Done.
    expect(picker).toMatch(/if \(e\.key === 'Escape'\) onClose\(\);/);
    expect(picker).toMatch(/panel\.current\?\.contains\(t\) \|\| toggleRef\?\.current\?\.contains\(t\)\) return;\s*onClose\(\);/);
    expect(picker).toMatch(/onClick=\{onClose\}[\s\S]*Done/);
    // Putting the emoji in places the caret without focusing the box (a phone keyboard would cover the picker).
    const into = picker.slice(picker.indexOf('export function pickInto('));
    expect(into).toMatch(/box\.setSelectionRange\(next\.caret, next\.caret\)/);
    expect(into).not.toMatch(/\.focus\(\)/);
  });

  it.each([
    ['the one-to-one composer', 'features/messages/MessagesPage.tsx', /onPick=\{\(e\) => pickInto\(textareaRef\.current, draft, e, setDraft\)\}/],
    ['the group composer (new)', 'features/messages/GroupThread.tsx', /onPick=\{\(e\) => pickInto\(boxRef\.current, content, e,/],
    ['the live chat', 'features/live/ChatPanel.tsx', /onPick=\{\(e\) => pickInto\(inputRef\.current, input, e, setInput\)\}/],
  ])('%s uses it, and sending closes it', (_what, file, pick) => {
    const src = read(file);
    expect(src).toMatch(/<EmojiPicker\b/);
    expect(src).toMatch(pick);
    expect(src).toMatch(/setShowEmoji\(false\);|setEmojiOpen\(false\);/);
  });

  it('the old one-pick pickers are gone: no pick closes the picker or focuses the box', () => {
    expect(read('features/messages/MessagesPage.tsx')).not.toMatch(/setDraft\(prev => prev \+ e\)/);
    expect(read('features/live/ChatPanel.tsx')).not.toMatch(/setInput\(input \+ e\); setShowEmoji\(false\)/);
  });

  it('the smile stays hidden on a phone in Messages, whose keyboard has its own emoji panel', () => {
    expect(read('features/messages/MessagesPage.tsx')).toMatch(/className="hidden sm:flex w-11 h-11 items-center/);
    expect(read('features/messages/GroupThread.tsx')).toMatch(/className="hidden h-11 w-11 [^"]*sm:flex"/);
  });
});

describe('the 1:1 composer (P22, P23)', () => {
  it('Safari\'s confirming Enter after composition (keyCode 229) is part of the composition, not a send', () => {
    expect(isComposingEnter({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingEnter({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingEnter({ isComposing: false, keyCode: 13 })).toBe(false);
    for (const file of ['features/messages/MessagesPage.tsx', 'features/messages/GroupThread.tsx', 'features/live/ChatPanel.tsx']) {
      expect(read(file)).toMatch(/e\.key === 'Enter' && !e\.shiftKey && !isComposingEnter\(e\.nativeEvent\)/);
    }
  });

  it('every button beside the box is 44px on every width, so they line up with the 44px box from 640px too', () => {
    const page = read('features/messages/MessagesPage.tsx');
    expect(page).not.toMatch(/sm:w-9 sm:h-9|sm:!w-9 sm:!h-9/);
    expect(page).toMatch(/className="!w-11 !h-11 !p-0 flex-shrink-0"/);
  });
});

// ─── 4.3: names and pictures link, and quoted replies ────────────────────────

describe('names and pictures open the profile (L7)', () => {
  const person = read('components/people/PersonLink.tsx');

  it('PersonLink is built on ProfileLink with `from`, and a former member is not a link', () => {
    expect(person).toMatch(/<ProfileLink userId=\{userId\} from=\{from\} newTab=\{newTab\}/);
    expect(person).toMatch(/if \(former\) return <span className=\{className\} data-testid="person-former">\{children\}<\/span>;/);
  });

  it('the one-to-one header: the picture and the name are one link, with "View profile ›" on every width', () => {
    const page = read('features/messages/MessagesPage.tsx');
    const header = page.slice(page.indexOf('{/* Thread header */}'), page.indexOf('<ReportUserModal'));
    const link = header.slice(header.indexOf('<PersonLink'), header.indexOf('</PersonLink>'));
    expect(link).toMatch(/from="Messages"/);
    expect(link).toMatch(/<Avatar src=\{headerContext\.otherAvatarUrl/);
    expect(link).toMatch(/data-testid="thread-partner-name"/);
    expect(link).toMatch(/<span className="shrink-0 text-\[11px\] font-medium text-gray-500">View profile ›<\/span>/);
    expect(header).not.toMatch(/<Link to=\{`\/people\//);
  });

  it('the picture beside their messages, and a group sender\'s picture and name, open their profile', () => {
    const page = read('features/messages/MessagesPage.tsx');
    expect(page).toMatch(/\{!fromMe && \(\s*<PersonLink\s+userId=\{headerContext\.otherUserId\}\s+from="Messages"/);
    const group = read('features/messages/GroupThread.tsx');
    expect(group.match(/<PersonLink\s+userId=\{first\.fromUserId\}\s+from="Messages"\s+former=\{isFormerMemberName\(first\.senderName\)\}/g)).toHaveLength(2);
  });
});

describe('quoted replies (L7)', () => {
  const quote = { id: 'm-1', senderName: 'Shradha', content: 'Shall we meet on Tuesday at ten?', kind: 'user' as const, deleted: false };

  it('the strip says whom and what is being answered, in one line', () => {
    expect(replyingTo({ id: 'm-1', senderName: 'Shradha', content: 'Shall we meet?', mine: false })).toBe('Replying to Shradha: Shall we meet?');
    expect(replyingTo({ id: 'm-1', senderName: 'Ana', content: 'Me again', mine: true })).toBe('Replying to yourself: Me again');
    expect(replyingTo({ id: 'm-1', senderName: 'Shradha', content: 'x'.repeat(200), mine: false })).toBe(`Replying to Shradha: ${'x'.repeat(80)}…`);
    expect(shorten('🙂'.repeat(5), 3)).toBe('🙂🙂🙂…');
    expect(replyContentOf({ content: null, attachmentType: 'image' })).toBe('📷 Photo');
  });

  it('a quote on the page scrolls to its original; one not loaded says "Earlier message"; a deleted one says so', () => {
    expect(quoteView(quote, true)).toEqual({ heading: 'Shradha', text: quote.content, canJump: true });
    expect(quoteView(quote, false)).toEqual({ heading: 'Shradha', text: `${EARLIER_MESSAGE} · ${quote.content}`, canJump: false });
    expect(quoteView({ ...quote, senderName: '', content: '', deleted: true }, true)).toEqual({ heading: ORIGINAL_DELETED, text: '', canJump: false });
    expect(ORIGINAL_DELETED).toBe('Original message deleted');
    expect(quoteView({ ...quote, senderName: '', content: '', hidden: true }, true)).toEqual({ heading: EARLIER_MESSAGE, text: '', canJump: false });
  });

  it.each([
    ['the one-to-one thread', 'features/messages/MessagesPage.tsx', /<ReplyButton onReply=\{\(\) => replyTo\(m, fromMe\)\} \/>/],
    ['the group thread', 'features/messages/GroupThread.tsx', /<ReplyButton onReply=\{\(\) => onReply\(m, mine\)\} \/>/],
  ])('%s offers Reply on each message, shows the quote, and the strip with its cancel above the box', (_what, file, button) => {
    const src = read(file);
    expect(src).toMatch(button);
    expect(src).toMatch(/\{m\.replyTo && (\(\s*<div[^>]*>\s*)?<ReplyQuote quote=\{m\.replyTo\} loaded=\{loadedIds\.has\(m\.replyTo\.id\)\}/);
    expect(src).toMatch(/<ReplyStrip target=\{replyTarget\} onCancel=/);
  });

  it('the reply goes to the server with the message, and only when there is one (production\'s body is unchanged otherwise)', () => {
    // The 1:1 send is T7's shared hook (thread/useSendMessage.ts); the composer hands it the reply.
    expect(read('features/messages/thread/useSendMessage.ts')).toContain('...(vars.replyToId ? { replyToId: vars.replyToId } : {}),');
    expect(read('features/messages/MessagesPage.tsx')).toContain('replyToId: replyTarget?.id ?? null,');
    expect(read('features/messages/useGroups.ts')).toMatch(/\{ content, \.\.\.\(replyToId \? \{ replyToId \} : \{\}\) \}/);
  });

  it('the Reply shows on hover where there is a mouse, and always (at half strength) on a touch screen, with a 46px target', () => {
    const strip = read('features/messages/ReplyStrip.tsx');
    expect(strip).toMatch(/opacity-50 /);
    expect(strip).toMatch(/\[@media\(hover:hover\)\]:opacity-0 \[@media\(hover:hover\)\]:group-hover\/bubble:opacity-100/);
    expect(strip).toMatch(/after:-inset-3/);
    expect(strip).toMatch(/aria-label=\{CANCEL_REPLY\}[\s\S]*className="flex h-11 w-11 /);
  });
});

// ─── 4.4: the tab count and the chime ────────────────────────────────────────

describe('the tab title (L8)', () => {
  it('"(N) REASON" while messages are unread, "REASON" when none', () => {
    expect(tabTitle(0)).toBe('REASON');
    expect(tabTitle(1)).toBe('(1) REASON');
    expect(tabTitle(12)).toBe('(12) REASON');
    expect(tabTitle(250)).toBe('(99+) REASON');
  });

  it('is mounted once, in App, beside the chime: on the profile and in the meeting room too (outside the shell)', () => {
    const app = read('App.tsx');
    expect(app.match(/useTabTitleCount\(\);/g)).toHaveLength(1);
    expect(app).toMatch(/useMessageChime\(signedInId\);/);
    expect(app).toMatch(/const signedInId = useAuthStore\(\(s\) => \(s\.isAuthenticated \? s\.user\?\.id : undefined\)\);/);
  });

  it('reads the very number the Messages badge shows: unread one-to-one messages plus every group\'s', () => {
    const unread = read('features/messages/useMessagesUnread.ts');
    expect(unread).toMatch(/queryKey: \['dm-unread-count'\]/);
    expect(unread).toMatch(/meta: \{ entities: userId \? \[E\.userDms\(userId\)\] : \[\] \}/);
    expect(unread).toMatch(/return userId \? \(unread \?\? 0\) \+ groupUnread : 0;/);
    expect(read('hooks/useTabTitleCount.ts')).toMatch(/const unread = useMessagesUnread\(\);\s*useEffect\(\(\) => \{\s*document\.title = tabTitle\(unread\);/);
    expect(read('features/reason/shell/ReasonShell.tsx')).toMatch(/const unreadCount = useMessagesUnread\(\);/);
  });
});

describe('the chime (L8)', () => {
  const me = 'u-me';
  const ev = chimeFromDm({ id: 'm-1', conversationId: 'c-1', fromUserId: 'u-them' }, me)!;
  const tab = { pathname: '/', visible: true, soundOn: true };

  it('a message from someone else may sound; your own, a card REASON wrote, and nobody signed in never do', () => {
    expect(ev).toEqual({ id: 'dm:m-1', path: '/messages/c-1' });
    expect(chimeFromDm({ id: 'm-2', conversationId: 'c-1', fromUserId: me }, me)).toBeNull();
    expect(chimeFromDm({ id: 'm-3', conversationId: 'c-1', fromUserId: 'u-them', kind: 'system' }, me)).toBeNull();
    expect(chimeFromDm({ id: 'm-4', conversationId: 'c-1', fromUserId: 'u-them' }, undefined)).toBeNull();
  });

  it('a group\'s bell may sound; no other bell does (a meeting request is not a message)', () => {
    expect(chimeFromNotification({ id: 'n-1', type: 'group_message', link: '/messages/g/g-1' })).toEqual({ id: 'bell:n-1', path: '/messages/g/g-1' });
    for (const type of ['poke', 'direct_message', 'event_invite', 'meeting_confirmed']) {
      expect(chimeFromNotification({ id: 'n-2', type, link: '/x' })).toBeNull();
    }
  });

  it('quiet in the open conversation in front of the member, in a live event, in a meeting, and with the setting off', () => {
    expect(quietHere(ev, tab)).toBe(false);
    expect(quietHere(ev, { ...tab, pathname: '/messages/c-1' })).toBe(true);
    expect(quietHere(ev, { ...tab, pathname: '/messages/c-1', visible: false })).toBe(false);
    expect(quietHere(ev, { ...tab, pathname: '/messages/c-2' })).toBe(false);
    expect(quietHere(ev, { ...tab, pathname: '/session/s-1/live' })).toBe(true);
    expect(quietHere(ev, { ...tab, pathname: '/meet/c-9' })).toBe(true);
    expect(quietHere(ev, { ...tab, soundOn: false })).toBe(true);
  });

  const vote = (tabId: string, over: Partial<ChimeVote> = {}): ChimeVote => ({ id: ev.id, tabId, quiet: false, visible: false, ...over });
  const fresh = { alreadyPlayed: false, lastPlayedAt: null, now: 10_000 };

  it('one tab plays it, the same one by every tab\'s reckoning: one in front of the member first, then the smallest id', () => {
    const votes = [vote('b'), vote('a'), vote('c')];
    expect(['a', 'b', 'c'].filter((t) => playsHere(votes, t, fresh))).toEqual(['a']);
    const withFront = [vote('a'), vote('c', { visible: true })];
    expect(['a', 'c'].filter((t) => playsHere(withFront, t, fresh))).toEqual(['c']);
  });

  it('none plays when any tab says quiet, when it has played already, or within 2 seconds of the last chime', () => {
    expect(playsHere([vote('a'), vote('b', { quiet: true })], 'a', fresh)).toBe(false);
    expect(playsHere([vote('a')], 'a', { ...fresh, alreadyPlayed: true })).toBe(false);
    expect(CHIME_COOLDOWN_MS).toBe(2000);
    expect(playsHere([vote('a')], 'a', { ...fresh, lastPlayedAt: 10_000 - 1999 })).toBe(false);
    expect(playsHere([vote('a')], 'a', { ...fresh, lastPlayedAt: 10_000 - 2000 })).toBe(true);
  });

  it('tabs agree over a BroadcastChannel, tell each other when it played, and the audio is readied by the first press', () => {
    const hook = read('hooks/useMessageChime.ts');
    expect(hook).toMatch(/new BroadcastChannel\(CHANNEL\)/);
    expect(hook).toMatch(/channel\?\.postMessage\(\{ kind: 'vote', vote \}/);
    expect(hook).toMatch(/channel\?\.postMessage\(\{ kind: 'played', id: ev\.id, at: now \}/);
    expect(hook).toMatch(/socket\.on\('dm:message'/);
    expect(hook).toMatch(/socket\.on\('notification:new'/);
    expect(hook).toMatch(/readyAudioOnFirstPress\(\)/);
    const chime = read('lib/chime.ts');
    expect(chime).toMatch(/export function playMessageChime\(/);
    expect(chime).toMatch(/document\.addEventListener\('pointerdown', ready, true\);\s*document\.addEventListener\('keydown', ready, true\);/);
    // The timer chime is untouched and the two are different tones.
    expect(chime).toMatch(/tone\(audio, 880, now, 0\.18\);\s*tone\(audio, 660, now \+ 0\.2, 0\.24\);/);
    expect(chime).toMatch(/tone\(audio, 988, now, 0\.09\);\s*tone\(audio, 1319, now \+ 0\.1, 0\.16\);/);
  });

  it('"Sound for new messages" is a setting of this device, on until switched off, under the messaging notifications', () => {
    const chime = read('lib/chime.ts');
    expect(chime).toMatch(/return localStorage\.getItem\(MESSAGE_SOUND_KEY\) !== 'off';/);
    const settings = read('features/settings/SettingsPage.tsx');
    expect(settings).toMatch(/label="Sound for new messages and calls"/);
    expect(settings).toMatch(/<MessageSoundToggle \/>\s*<\/Card>/);
  });
});
