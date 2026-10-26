// ─── Event chat (26 Oct 2026) ────────────────────────────────────────────────
// An event's chat is written to the database as it is sent and kept as long as the event exists. The live
// event carries it on the socket (chat:message, chat:history); the completed event's page reads it back
// a page at a time (GET /api/sessions/:id/chat).

/** Lobby: said to the whole event. Room: said in a breakout room and read only by the people it reached. */
export type EventChatScope = 'lobby' | 'room';

/** One message as the event's chat page returns it. */
export interface EventChatMessage {
  id: string;
  /** Null when the account is closed or gone: show the name with no link to a profile. */
  senderId: string | null;
  /** The name the message was sent with, or "Former member" when the account is no longer active. */
  senderName: string;
  senderIsHost: boolean;
  scope: EventChatScope;
  content: string;
  createdAt: string;
  /** How many people reacted with each reaction ('heart', 'clap', 'thumbs_up'). */
  reactions: Record<string, number>;
}

/**
 * A page of an event's chat, oldest to newest within the page. The first page is the newest messages;
 * nextCursor (`<epochMs>_<id>`) asks for the page before it, and is null when there is none.
 */
export interface EventChatPage {
  messages: EventChatMessage[];
  nextCursor: string | null;
}

/** A message as the live event's socket carries it (chat:message, chat:history): the shape production's client reads. */
export interface LiveChatMessage {
  id: string;
  userId: string;
  displayName: string;
  message: string;
  timestamp: string;
  scope: EventChatScope;
  isHost: boolean;
  /** A room message: the breakout room it was said in. */
  roomId?: string;
  /** Each reaction, with the ids of the people who reacted with it. */
  reactions: Record<string, string[]>;
}

/**
 * The answer to a chat:send that carries an acknowledgement callback. A client that sends none (production's)
 * is told of a refusal by an `error` event instead. `duplicate` is true when the message's clientId had been
 * stored already: nothing is sent again.
 */
export type ChatSendAck =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; code: string; message: string };
