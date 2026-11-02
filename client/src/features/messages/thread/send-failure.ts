// client/src/features/messages/thread/send-failure.ts
// What a failed message send says (final fix wave CM3, 2 Nov 2026). Pure (no axios, store or router), so the server's
// jest runs it: server/src/__tests__/client/fw-send-message-failure.test.ts. A refusal the server words for members (a
// block, a closed account) is said in its words; a request that got no answer is the shared "Connection lost"; anything
// else is a plain sentence. Never the library's own text ("Network Error").
import { CONNECTION_LOST, gotNoAnswer, memberSentence } from '../../reason/errors';

export const SEND_FAILED = 'Your message was not sent. Please try again.';

export function sendFailureSentence(err: unknown): string {
  const failed = (typeof err === 'object' && err !== null ? err : {}) as {
    response?: { data?: { error?: { message?: unknown } } };
  };
  if (!failed.response) return gotNoAnswer(err) ? CONNECTION_LOST : SEND_FAILED;
  return memberSentence(failed.response.data?.error?.message) ?? SEND_FAILED;
}
