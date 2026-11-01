// server/src/__tests__/client/t7-call-chat.test.ts
// Chat in the meeting room (1 Nov 2026, T7, 30 Oct review 5a). Stefan: "Add chat inside the meeting room. Right now
// people can't type to each other during a meeting." His 30 Oct meetings were 1:1 meetings in /meet (MeetPage),
// which had no chat. The panel is the pair's own conversation, so what they type stays in Messages afterwards, is
// stored, is refused by a block, and reaches the other person live through the conversation's entity tag.
// call-chat.ts is pure and runs here; the panel and the room are read from source. Two real browsers:
// e2e/tests/n1-t7-meeting-chat-calendar.spec.ts.

import * as fs from 'fs';
import * as path from 'path';
import {
  newestAt, panelOrder, PANEL_LIMIT, sendable, sendsOnKey, unreadFrom,
} from '../../../../client/src/features/meet/call-chat';
import type { DmMessage } from '../../../../client/src/features/messages/thread/dm-message';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const ME = 'u-me';
const THEM = 'u-them';
let n = 0;
const msg = (from: string, at: string, extra: Partial<DmMessage> = {}): DmMessage => ({
  id: `m${(n += 1)}`, conversationId: 'c1', fromUserId: from, content: 'hi', readAt: null, createdAt: at, ...extra,
});

describe('the Chat button\'s count', () => {
  const thread = [
    msg(THEM, '2026-11-05T17:01:00Z'),
    msg(ME, '2026-11-05T17:02:00Z'),
    msg(THEM, '2026-11-05T17:03:00Z'),
    msg(THEM, '2026-11-05T17:04:00Z', { kind: 'system' }),
  ];

  it('counts what the other person wrote after the panel was last open, never your own lines or the product\'s', () => {
    expect(unreadFrom(thread, THEM, '2026-11-05T17:01:00Z')).toBe(1);
    expect(unreadFrom(thread, THEM, '2026-11-05T17:00:00Z')).toBe(2);
    expect(unreadFrom(thread, THEM, '2026-11-05T17:05:00Z')).toBe(0);
  });

  it('with nothing seen yet (an empty conversation when the room opened), every line of theirs counts', () => {
    expect(unreadFrom(thread, THEM, null)).toBe(2);
  });

  it('counts nothing while the other person is not known yet', () => {
    expect(unreadFrom(thread, undefined, null)).toBe(0);
  });

  it('the newest time is the server\'s, whatever order the list came in', () => {
    expect(newestAt([thread[2], thread[0], thread[3], thread[1]])).toBe('2026-11-05T17:04:00Z');
    expect(newestAt([])).toBeNull();
  });
});

describe('the list and the text box', () => {
  it('lists the latest messages oldest first, so the newest is at the bottom', () => {
    const newestFirst = [msg(ME, '2026-11-05T17:03:00Z'), msg(THEM, '2026-11-05T17:02:00Z'), msg(ME, '2026-11-05T17:01:00Z')];
    expect(panelOrder(newestFirst).map((m) => m.createdAt)).toEqual(['2026-11-05T17:01:00Z', '2026-11-05T17:02:00Z', '2026-11-05T17:03:00Z']);
    const many = Array.from({ length: PANEL_LIMIT + 5 }, (_, i) => msg(ME, new Date(Date.UTC(2026, 10, 5, 17, 0, i)).toISOString()));
    const shown = panelOrder(many);
    expect(shown).toHaveLength(PANEL_LIMIT);
    expect(shown[shown.length - 1].createdAt).toBe(many[many.length - 1].createdAt);
  });

  it('Enter sends, Shift+Enter starts a new line, and Enter while a keyboard is composing does not send', () => {
    expect(sendsOnKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(sendsOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(sendsOnKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(sendsOnKey({ key: 'a', shiftKey: false })).toBe(false);
  });

  it('a box of spaces sends nothing; words are sent without their outer spaces', () => {
    expect(sendable('   \n ')).toBeNull();
    expect(sendable('  hello there \n')).toBe('hello there');
  });
});

describe('the panel', () => {
  const src = () => read('features/meet/CallChatPanel.tsx');

  it('reads and sends the pair\'s conversation through the thread hooks (the conversation\'s entity tag keeps it live)', () => {
    const s = src();
    expect(s).toMatch(/useThreadMessages\(conversationId, \{ markRead: open \}\)/);
    expect(s).toMatch(/useSendMessage<\{ content: string \}>\(conversationId, partner\?\.userId, \{/);
    expect(s).toContain('toastOnError: false');
    const hook = read('features/messages/thread/useThreadMessages.ts');
    expect(hook).toMatch(/meta: \{ entities: conversationId \? \[E\.dmConversation\(conversationId\)\] : \[\] \}/);
  });

  it('header "Chat" with a close button; "Messages stay in your conversation." under the box; the empty state', () => {
    const s = src();
    expect(s).toMatch(/>\s*Chat\s*<\/h2>/);
    expect(s).toContain('aria-label="Close the chat"');
    expect(s).toContain('Messages stay in your conversation.');
    expect(s).toContain('No messages yet. Say hello.');
  });

  it('text only: no picture or voice in the call', () => {
    const s = src();
    expect(s).not.toMatch(/cloudinary|MediaRecorder|type="file"|prepareAttachment/i);
    expect(s).toContain('send.mutate({ content });');
  });

  it('a refused send shows the server\'s sentence in the panel and keeps what was typed', () => {
    const s = src();
    expect(s).toMatch(/onFailed: \(err\) => setRefusal\(refusalText\(err\)\)/);
    expect(s).toMatch(/role="alert"/);
    expect(s).not.toMatch(/onFailed[\s\S]{0,80}setDraft\(''\)/);
  });

  it('the other person\'s lines carry their name, "Former member" once the account is closed', () => {
    const s = src();
    expect(s).toContain('FORMER_MEMBER');
    expect(read('features/messages/thread/useConversationPartner.ts')).toMatch(/otherIsFormerMember \? FORMER_MEMBER/);
  });

  it('the call\'s own lines are shown small, apart from what people wrote', () => {
    expect(src()).toContain('data-testid="call-chat-system-line"');
  });
});

describe('the room', () => {
  const src = () => read('features/messages/MeetPage.tsx');

  it('a Chat button in the top bar with the unread count, aria-pressed, 44px', () => {
    const s = src();
    expect(s).toMatch(/aria-pressed=\{chatOpen\}/);
    expect(s).toMatch(/data-testid="call-chat-toggle"[\s\S]{0,300}min-h-\[44px\]/);
    expect(s).toContain('data-testid="call-chat-unread"');
  });

  it('closed when the room opens; beside the stage from 640px (w-80), a bottom part on a phone; the video keeps running', () => {
    const s = src();
    expect(s).toMatch(/const \[chatOpen, setChatOpen\] = useState\(false\)/);
    expect(s).toContain('sm:w-80');
    expect(s).toContain('h-[45dvh]');
    // The panel lives inside the LiveKit room, so opening it never disconnects the call.
    const room = s.slice(s.indexOf('<LiveKitRoom'), s.indexOf('</LiveKitRoom>'));
    expect(room).toContain('<CallChatPanel');
  });

  it('the page is 100dvh with the safe-area bottom, so the box stays above an iPhone keyboard', () => {
    const s = src();
    expect(s).toContain('h-[100dvh]');
    expect(s).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});
