// server/src/__tests__/client/chat-waits-for-the-room.test.ts
// The live event's chat waits for the server to let the page in (2 Nov 2026, T19's product note).
//
// The server takes a chat message only from a socket in the event's room (chat-handlers.ts: "You are not in this
// event."), and it lets the socket in when it answers the page's join, with session:state (participant-flow.ts sends
// it only after socket.join). The live page drew its chat box before that answer, so a message typed at once (a slow
// phone, a slow network) was refused with "You are not in this event." though the person was in it. Now:
//   - the session store knows when the page is in the event's room (inEventRoom: session:state sets it, a reconnect
//     attempt and a new event page clear it);
//   - until then the box can be typed in, but Send and Enter send nothing, the placeholder says "Joining the chat…",
//     and a typed message says it can go in a moment; the words stay in the box;
//   - a refusal of a page not yet in (code NOT_IN_SESSION, a connection just back) says a human sentence, and the
//     words stay in the box as for any refusal.
// Fix round 1 (review F3): session:state is a sign of admission the server does not always send (it is skipped when
// the state snapshot fails), so the wait is bounded: Send is let through CHAT_JOIN_WAIT_MS after the page sent its join
// even with no answer, and a refusal then is the "still joining" sentence above, with the words kept.
import * as fs from 'fs';
import * as path from 'path';
import {
  CHAT_JOIN_WAIT_MS, CHAT_JOINING, CHAT_NOT_SENT, CHAT_STILL_JOINING, chatJoinWaitLeft, chatRefusal, chatWaitsForRoom,
} from '../../../../client/src/features/live/chatSend';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('a refused message says a human sentence', () => {
  it('a page not yet in the event\'s room is told it is still joining, not that it is not in the event', () => {
    expect(chatRefusal({ code: 'NOT_IN_SESSION', message: 'You are not in this event.' })).toBe(CHAT_STILL_JOINING);
    expect(CHAT_STILL_JOINING).toBe("You're still joining the event. Send your message again in a moment.");
  });

  it('every other refusal says the server\'s own words, or a plain sentence when it has none', () => {
    expect(chatRefusal({ code: 'RATE_LIMIT_EXCEEDED', message: 'You are sending messages a little fast.' })).toBe('You are sending messages a little fast.');
    expect(chatRefusal({ code: 'VALIDATION_ERROR', message: '' })).toBe(CHAT_NOT_SENT);
  });

  it('the sentences are short and carry no technical words', () => {
    for (const line of [CHAT_STILL_JOINING, CHAT_JOINING]) {
      expect(line).not.toMatch(/ack|socket|error|code|timeout|server|session|room/i);
      expect(line.length).toBeLessThan(90);
    }
  });
});

describe('the store knows when the page is in the event\'s room', () => {
  const store = read('client/src/stores/sessionStore.ts');
  const socket = read('client/src/hooks/useSessionSocket.ts');

  it('starts outside, and a new event page starts outside again', () => {
    expect(store).toMatch(/inEventRoom: boolean;/);
    expect(store).toMatch(/sessionStateLoaded: false,\n\s*inEventRoom: false,/);
    expect(store).toMatch(/reset: \(\) => set\(\{[\s\S]*?inEventRoom: false,[\s\S]*?\}\),/);
    expect(store).toMatch(/setInEventRoom: \(inEventRoom\) => set\(\{ inEventRoom \}\),/);
  });

  it('session:state (sent only to a socket the server let in) puts it inside; a reconnect attempt takes it out', () => {
    expect(socket).toMatch(/socket\.on\('session:state', \(data: any\) => \{\n(\s*\/\/.*\n)*\s*store\.setInEventRoom\(true\);/);
    expect(socket).toMatch(/const onReconnectAttempt = \(\) => \{\n(\s*\/\/.*\n)*\s*store\.setInEventRoom\(false\);/);
  });

  it('the server sends session:state only after letting the socket into the event\'s room', () => {
    const flow = read('server/src/services/orchestration/handlers/participant-flow.ts');
    const join = flow.indexOf('socket.join(sessionRoom(data.sessionId));');
    expect(join).toBeGreaterThan(0);
    expect(flow.indexOf("socket.emit('session:state'", join)).toBeGreaterThan(join);
    const chat = read('server/src/services/orchestration/handlers/chat-handlers.ts');
    expect(chat).toMatch(/if \(!rooms\.has\(sessionRoom\(sessionId\)\)\) \{\n\s*refuse\('NOT_IN_SESSION', 'You are not in this event\.'\);/);
  });
});

describe('the chat box waits for the room', () => {
  const panel = read('client/src/features/live/ChatPanel.tsx');

  it('Send and Enter send nothing until the page is in; the words stay in the box', () => {
    expect(panel).toMatch(/const handleSend = useCallback\(\(\) => \{\n\s*if \(!joining\) send\(\);/);
    expect(panel).toMatch(/disabled=\{!input\.trim\(\) \|\| sending \|\| joining\}/);
    // The box itself is never disabled: typing (and a phone's keyboard) carries on while the page joins.
    const input = panel.slice(panel.indexOf('<input'), panel.indexOf('/>', panel.indexOf('<input')));
    expect(input).not.toMatch(/disabled/);
  });

  it('says it is joining: in the placeholder, and beside the box once something is typed', () => {
    expect(panel).toContain("placeholder={joining ? 'Joining the chat…' :");
    expect(panel).toMatch(/\{joining && input\.trim\(\) && !notice && \(\n\s*<p aria-live="polite" data-testid="chat-joining"[^>]*>\{CHAT_JOINING\}<\/p>/);
    expect(CHAT_JOINING).toBe('Joining the chat. Your message can go in a moment.');
  });
});

describe('fix round 1: the wait for the room is bounded', () => {
  const sent = 1_000_000;

  it('waits while the join is unanswered, but no longer than CHAT_JOIN_WAIT_MS (about 5 s) after it was sent', () => {
    expect(CHAT_JOIN_WAIT_MS).toBe(5_000);
    expect(chatWaitsForRoom(false, sent, sent)).toBe(true);
    expect(chatWaitsForRoom(false, sent, sent + 4_999)).toBe(true);
    // session:state never came: Send is let through at the bound, and the server's refusal (if any) is the safety net.
    expect(chatWaitsForRoom(false, sent, sent + 5_000)).toBe(false);
    expect(chatWaitsForRoom(false, sent, sent + 60_000)).toBe(false);
  });

  it("the room's state ends the wait at once; with no join sent yet (no connection) it waits", () => {
    expect(chatWaitsForRoom(true, sent, sent)).toBe(false);
    expect(chatWaitsForRoom(true, null, sent)).toBe(false);
    expect(chatWaitsForRoom(false, null, sent + 60_000)).toBe(true);
  });

  it('says how long is left, so the panel wakes once at the bound and not on a timer', () => {
    expect(chatJoinWaitLeft(sent, sent)).toBe(5_000);
    expect(chatJoinWaitLeft(sent, sent + 4_000)).toBe(1_000);
    expect(chatJoinWaitLeft(sent, sent + 9_000)).toBe(0);
  });

  it('the first join the page sends starts the wait, later ones (a tab back in front) do not move it; a reconnect attempt clears it', () => {
    const socket = read('client/src/hooks/useSessionSocket.ts');
    const joins = socket.match(/socket\.emit\('session:join', \{ sessionId \}\);/g) ?? [];
    expect(joins.length).toBeGreaterThan(0);
    // One stamp per join: before it on connect and on return to the front, just after the resync on a reconnect.
    expect(socket.match(/store\.noteJoinSent\(\);/g)).toHaveLength(joins.length);
    expect(socket.match(/store\.noteJoinSent\(\);\s*socket\.emit\('session:join', \{ sessionId \}\);/g)).toHaveLength(joins.length - 1);
    const reconnect = socket.slice(socket.indexOf('const onReconnect = () => {'), socket.indexOf('const onReconnectAttempt'));
    expect(reconnect).toMatch(/socket\.emit\('session:join', \{ sessionId \}\);[\s\S]*?store\.noteJoinSent\(\);/);
    expect(socket).toMatch(/const onReconnectAttempt = \(\) => \{\n(\s*\/\/.*\n)*\s*store\.setInEventRoom\(false\);\n\s*store\.setJoinSentAt\(null\);/);
    const store = read('client/src/stores/sessionStore.ts');
    expect(store).toMatch(/joinSentAt: number \| null;/);
    expect(store).toMatch(/reset: \(\) => set\(\{[\s\S]*?joinSentAt: null,[\s\S]*?\}\),/);
    expect(store).toMatch(/noteJoinSent: \(\) => set\(\(s\) => \(s\.joinSentAt === null \? \{ joinSentAt: Date\.now\(\) \} : \{\}\)\),/);
  });

  it('the panel asks chatWaitsForRoom, and wakes once when the bound passes', () => {
    const panel = read('client/src/features/live/ChatPanel.tsx');
    expect(panel).toMatch(/const joining = chatWaitsForRoom\(inEventRoom, joinSentAt, now\);/);
    expect(panel).toMatch(/const t = setTimeout\(\(\) => setNow\(Date\.now\(\)\), chatJoinWaitLeft\(joinSentAt, Date\.now\(\)\)\);\s*return \(\) => clearTimeout\(t\);/);
  });
});
