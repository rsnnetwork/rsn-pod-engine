// client/src/features/messages/compose-intent.ts
// "Message" means "write now" (12 Nov 2026, after the S5 prod smoke). A profile's Message, the offline sheet's "Send a
// message" on a profile's call button, and the other Message buttons open the chat with ?compose=1. Once the thread is
// there, the cursor goes in its message box, once, and the flag is dropped from the address, so Back or a refresh does
// not do it again. Opening a chat to read it (the inbox, a meeting's link, a notification) carries no flag, so a phone
// does not raise its keyboard over the messages. Pure on purpose: server/src/__tests__/client/shirley-s5-safety-calls.test.ts.
//
// iOS opens the keyboard only for a focus made inside a tap, and this one comes after a page change: there the cursor
// is placed in the box and the keyboard opens on the first tap in it (a platform limit).

export const COMPOSE_PARAM = 'compose';

/** The address that opens a conversation with someone to write to them now. */
export function writeToPath(userId: string): string {
  return `/messages/new/${encodeURIComponent(userId)}?${COMPOSE_PARAM}=1`;
}

/** Whether the address asks for the cursor in the message box. */
export function wantsCompose(params: URLSearchParams): boolean {
  return params.get(COMPOSE_PARAM) === '1';
}

export interface ComposeState {
  /** The address carries ?compose=1. */
  asked: boolean;
  /** Still on /messages/new/:userId while the inbox may turn it into the conversation's own address (which keeps the
   *  query, so the flag is used there). */
  redirectPending: boolean;
  /** The thread's header and box are drawn. */
  threadShown: boolean;
  /** Nothing can be written (a former member, someone I blocked): there is no box. */
  readOnly: boolean;
}

/** What to do with the flag now: nothing, wait for the thread, put the cursor in the box, or drop it unused. */
export function composeStep(s: ComposeState): 'none' | 'wait' | 'focus' | 'drop' {
  if (!s.asked) return 'none';
  if (s.redirectPending || !s.threadShown) return 'wait';
  return s.readOnly ? 'drop' : 'focus';
}
