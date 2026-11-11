// A message is sent as the member who pressed Send, or not at all (Shirley Palmer follow-up, 11 Nov 2026).
//
// A send can take seconds (a picture or a voice note uploads first). If that member signs out, or another member signs
// in on the same tab, while it is on its way, the post would go out under whoever is signed in by then: the first
// member's words posted as the second member. So the sender is fixed when Send is pressed; a member change aborts the
// upload and the post (AbortController), and the post is checked against the sender once more just before it leaves
// (here) and when its token is attached (lib/api.ts, `sentAs`). Pure, so the server's jest runs it with stand-ins.

/** The send was stopped because the signed-in member changed: nothing was posted, and nobody is told it failed. */
export class SenderChangedError extends Error {
  constructor() {
    super('The signed-in member changed while the message was on its way.');
    this.name = 'SenderChangedError';
  }
}

export const isSenderChanged = (err: unknown): boolean =>
  err instanceof SenderChangedError || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'SenderChangedError');

export interface SendAsDeps<V, A, R> {
  /** Who is signed in now, or null. */
  memberNow: () => string | null;
  /** Call `changed` when the member changes or signs out; answers a way to stop listening. */
  watchMember: (changed: () => void) => () => void;
  /** The upload before the post (a picture, a voice note), or null. Stops when `signal` aborts. */
  prepare: (vars: V, signal: AbortSignal) => Promise<A | null>;
  /** The post itself, as `sentAs`. Stops when `signal` aborts. */
  post: (attachment: A | null, sentAs: string, signal: AbortSignal) => Promise<R>;
}

export async function sendAsMember<V, A, R>(vars: V, deps: SendAsDeps<V, A, R>): Promise<R> {
  const sentAs = deps.memberNow();
  if (!sentAs) throw new SenderChangedError();
  const controller = new AbortController();
  const stop = deps.watchMember(() => controller.abort());
  const changed = () => controller.signal.aborted || deps.memberNow() !== sentAs;
  try {
    const attachment = await deps.prepare(vars, controller.signal);
    if (changed()) throw new SenderChangedError();
    return await deps.post(attachment, sentAs, controller.signal);
  } catch (err) {
    if (changed()) throw new SenderChangedError();
    throw err;
  } finally {
    stop();
  }
}
