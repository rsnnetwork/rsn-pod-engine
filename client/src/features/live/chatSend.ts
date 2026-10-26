// ─── Sending a live event's chat message, and what becomes of the typed words (fix round 2, 26 Oct 2026) ───
//
// The words stay in the box until the server says the message went out: its acknowledgement of chat:send
// (ChatSendAck, S5) or, from a server that sends none, the message coming back to us on chat:message. A refusal
// keeps the words and says why, instead of the box emptying as the message leaves (a refused message was lost).
// Pure, no React: the server's jest reads it (server/src/__tests__/client/chat-send-ack.test.ts).

/** How long the box waits for the server's answer before saying the message has not gone out yet, in ms. */
export const CHAT_ACK_WAIT_MS = 8_000;

/** Said when no answer came in time. The message can still go out: the socket sends it when it is back. */
export const CHAT_NOT_SENT_YET = "Your message hasn't gone out yet. Check your connection, then send it again.";

/** Said for a refusal that carries no words of its own. */
export const CHAT_NOT_SENT = "That message couldn't be sent. Try again.";

/**
 * What the box holds once a message has gone out: nothing, when it still holds just what was sent; what was typed
 * after it, when the person carried on typing; and their words untouched, when they rewrote them meanwhile.
 */
export function textAfterSent(current: string, sent: string): string {
  if (current === sent) return '';
  if (current.startsWith(sent)) return current.slice(sent.length).trimStart();
  return current;
}

/**
 * Our own message coming back on chat:message, from a server that sends no acknowledgement: from us, with the
 * words we sent (the server trims them, as we do), and not one we already had before sending.
 */
export function isOwnEcho(
  msg: { id: string; userId: string; message: string },
  me: string | undefined,
  text: string,
  seenIds: ReadonlySet<string>,
): boolean {
  return !!me && msg.userId === me && msg.message === text && !seenIds.has(msg.id);
}
