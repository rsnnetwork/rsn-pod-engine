// ─── A refused chat message keeps its words (C8 fix round 2, 26 Oct 2026) ────
//
// The live chat emptied its box as soon as a message left, so a message the server
// refused (in a meeting whose director had stepped out, the server's "Chat is
// available once the host joins") was lost with its words. chat:send now goes with
// the acknowledgement S5's server answers (ChatSendAck): the box empties only when
// the message went out; a refusal keeps the words and says why, beside the box. A
// server with no acknowledgement still sends our own message back, which counts as
// the answer. The send is shared by the meeting and speed networking: speed
// networking's chat is otherwise exactly as it was.

import * as fs from 'fs';
import * as path from 'path';
import {
  CHAT_ACK_WAIT_MS,
  CHAT_NOT_SENT,
  CHAT_NOT_SENT_YET,
  isOwnEcho,
  textAfterSent,
} from '../../../../client/src/features/live/chatSend';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../..', rel), 'utf8').replace(/\r\n/g, '\n');
const HOOK = 'client/src/features/live/useChatSend.ts';
const PANEL = 'client/src/features/live/ChatPanel.tsx';
const PAGE = 'client/src/features/live/LiveSessionPage.tsx';
const ROOM = 'client/src/features/live/meeting/MeetingRoom.tsx';

describe('textAfterSent: what the box holds once the message has gone out', () => {
  it('empties a box that still holds just what was sent', () => {
    expect(textAfterSent('hello there', 'hello there')).toBe('');
    expect(textAfterSent('hello there  ', 'hello there  ')).toBe('');
  });

  it('keeps what was typed after it, when the person carried on typing', () => {
    expect(textAfterSent('hello there and more', 'hello there')).toBe('and more');
    expect(textAfterSent('hello there', 'hello')).toBe('there');
  });

  it('leaves words the person rewrote meanwhile untouched', () => {
    expect(textAfterSent('something else', 'hello there')).toBe('something else');
    expect(textAfterSent('', 'hello there')).toBe('');
  });
});

describe('isOwnEcho: our message coming back from a server with no acknowledgement', () => {
  const msg = { id: 'm2', userId: 'me', message: 'hello' };
  it('is ours, with the words we sent, and new', () => {
    expect(isOwnEcho(msg, 'me', 'hello', new Set(['m1']))).toBe(true);
  });
  it('is not someone else\'s, other words, one we already had, or anyone\'s while we are signed out', () => {
    expect(isOwnEcho({ ...msg, userId: 'someone' }, 'me', 'hello', new Set())).toBe(false);
    expect(isOwnEcho(msg, 'me', 'hello!', new Set())).toBe(false);
    expect(isOwnEcho(msg, 'me', 'hello', new Set(['m2']))).toBe(false);
    expect(isOwnEcho(msg, undefined, 'hello', new Set())).toBe(false);
  });
});

describe('the sentences and the wait', () => {
  it('waits a few seconds for the answer, and says what happened in plain words', () => {
    expect(CHAT_ACK_WAIT_MS).toBeGreaterThanOrEqual(3000);
    expect(CHAT_ACK_WAIT_MS).toBeLessThanOrEqual(15000);
    for (const line of [CHAT_NOT_SENT_YET, CHAT_NOT_SENT]) {
      expect(line).not.toMatch(/ack|socket|error|code|timeout|server/i);
      expect(line.length).toBeLessThan(90);
    }
  });
});

describe('useChatSend: the send waits for the server before the words go', () => {
  const src = read(HOOK);

  it('sends with an acknowledgement and a clientId', () => {
    expect(src).toMatch(/socket\.emit\('chat:send', \{ sessionId, message: text, scope, clientId \}, \(res\) => \{\n\s*settle\(m, res\.ok \? null : res\.message \|\| CHAT_NOT_SENT\);\n\s*\}\);/);
  });

  it('empties the box only when the message went out, and keeps it on a refusal', () => {
    const settle = src.slice(src.indexOf('const settle = useCallback('), src.indexOf('}, [setInput]);'));
    expect(settle).toMatch(/if \(refusal === null\) \{[\s\S]*?setInput\(\(cur\) => textAfterSent\(cur, m\.raw\)\);\n\s*\}/);
    // A refusal sets the sentence; it never touches the words.
    expect(settle).toMatch(/setNotice\(refusal\);/);
    expect(settle.match(/setInput\(/g)).toHaveLength(1);
    // Nowhere does the send empty the box outright.
    expect(src).not.toMatch(/setInput\(''\)/);
    expect(read(PANEL)).not.toMatch(/setInput\(''\)/);
  });

  it('one message at a time; no answer in time frees the button and says so; a late answer still settles it', () => {
    expect(src).toMatch(/if \(!text \|\| latest\.current\?\.state === 'waiting'\) return;/);
    const timer = src.slice(src.indexOf('m.timer = setTimeout('), src.indexOf('}, CHAT_ACK_WAIT_MS);'));
    expect(timer).toMatch(/m\.state = 'late';/);
    expect(timer).toMatch(/setSending\(false\);\n\s*setNotice\(CHAT_NOT_SENT_YET\);/);
    // settle acts on a 'late' message too (only 'done' is final).
    expect(src).toMatch(/const settle = useCallback\(\(m: OnItsWay, refusal: string \| null\) => \{\n\s*if \(m\.state === 'done'\) return;/);
  });

  it('the same words sent again keep their clientId, so the server stores them once', () => {
    expect(src).toMatch(/const clientId = draft\.current\?\.text === text \? draft\.current\.clientId : crypto\.randomUUID\(\);/);
    expect(src).toMatch(/if \(draft\.current\?\.clientId === m\.clientId\) draft\.current = null;/);
  });

  it('a server with no acknowledgement: our own message coming back is the answer', () => {
    expect(src).toMatch(/if \(chatMessages\.some\(\(c\) => isOwnEcho\(c, me, m\.text, m\.seenIds\)\)\) settle\(m, null\);/);
  });

  it('nothing updates a chat that has closed', () => {
    expect(src).toMatch(/if \(!mounted\.current\) return;/);
    expect(src).toMatch(/return \(\) => \{\n\s*mounted\.current = false;\n\s*if \(latest\.current\?\.timer\) clearTimeout\(latest\.current\.timer\);/);
  });
});

describe('ChatPanel: the box, the sentence and the button', () => {
  const src = read(PANEL);

  it('sends through useChatSend; nothing else emits chat:send', () => {
    expect(src).toMatch(/const \{ send, sending, notice, clearNotice \} = useChatSend\(sessionId, scope, input, setInput\);/);
    expect(src).not.toMatch(/emit\('chat:send'/);
  });

  it('says why a message did not go out, beside the box, to a screen reader too', () => {
    expect(src).toMatch(/\{notice && \(\n\s*<p role="alert" data-testid="chat-send-notice"[^>]*>\{notice\}<\/p>\n\s*\)\}/);
    // Typing again (or an emoji) clears it.
    expect(src).toMatch(/const typeMessage = useCallback\(\(value: string\) => \{\n\s*setInput\(value\);\n\s*clearNotice\(\);/);
    expect(src).toMatch(/setInput=\{typeMessage\}/);
  });

  it('the send button waits while a message is on its way; the box stays usable (a phone keeps its keyboard)', () => {
    expect(src).toMatch(/disabled=\{!input\.trim\(\) \|\| sending\} aria-busy=\{sending \|\| undefined\} aria-label="Send message"/);
    const input = src.slice(src.indexOf('<input'), src.indexOf('/>', src.indexOf('<input')));
    expect(input).not.toMatch(/disabled/);
  });
});

describe('speed networking\'s chat is otherwise exactly as it was', () => {
  const src = read(PANEL);

  it('the same scope, gate, placeholders, length cap and history fetch', () => {
    expect(src).toMatch(/const scope: 'lobby' \| 'room' = phase === 'matched' \? 'room' : 'lobby';/);
    expect(src).toMatch(/const chatDisabled = !alwaysOpen && scope === 'lobby' && !hostPresent && !isHostOrCohost;/);
    expect(src).toMatch(/placeholder=\{scope === 'room' \? 'Message your room\.\.\.' : 'Message everyone\.\.\.'\}/);
    expect(src).toMatch(/maxLength=\{500\}/);
    expect(src).toMatch(/socket\.emit\('chat:request_history', \{ sessionId, matchId: currentMatchId \|\| undefined \}\);/);
    expect(src).toMatch(/if \(e\.key === 'Enter' && !e\.shiftKey\) \{\n\s*e\.preventDefault\(\);\n\s*handleSend\(\);/);
  });

  it('the live page and the meeting mount it as before', () => {
    expect(read(PAGE)).toMatch(/<ChatPanel sessionId=\{sessionId\} onClose=\{\(\) => setChatOpen\(false\)\} padBottomInset=\{!isHost\} \/>/);
    expect(read(ROOM)).toMatch(/<ChatPanel sessionId=\{sessionId\} onClose=\{\(\) => setChatOpen\(false\)\} alwaysOpen=\{!preStart\} padBottomInset=\{false\} \/>/);
  });
});

describe('the chat:send contract is the one main\'s server answers (shared, as on main)', () => {
  it('chat:send carries an optional clientId and an optional acknowledgement callback', () => {
    const events = read('shared/src/types/events.ts');
    expect(events).toMatch(/import type \{ ChatSendAck \} from '\.\/event-chat';/);
    expect(events).toMatch(/'chat:send': \(\n\s*data: \{ sessionId: string; message: string; scope: 'lobby' \| 'room'; clientId\?: string \},\n\s*ack\?: \(res: ChatSendAck\) => void,\n\s*\) => void;/);
  });

  it('the answer is a sent message (its id, and whether it was a repeat) or a refusal with its words', () => {
    const types = read('shared/src/types/event-chat.ts');
    expect(types).toMatch(/export type ChatSendAck =\n\s*\| \{ ok: true; id: string; duplicate: boolean \}\n\s*\| \{ ok: false; code: string; message: string \};/);
  });
});
