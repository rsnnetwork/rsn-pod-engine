// What a member is told when a REASON request fails. Pure on purpose (no axios, store or router), so a
// test can run it: server/src/__tests__/client/reason-m1-data-layer.test.ts.
//
// The copy is keyed on the HTTP status. The server's own text is passed on only where it is a business
// refusal written for members ("They declined your earlier request..."), and only when it is safe to show.

const CONNECTION_LOST = 'Connection lost. Check your internet and try again.';
const SLOW_DOWN = 'Slow down a moment, then try again.';
// The server's own 404 text carries the raw id ("User with id <uuid> not found"), so it is never shown.
const PERSON_GONE = 'This person is no longer available.';

const LONGEST_SENTENCE = 200;
// Six or more hex digits (dashes allowed) with at least one number: a UUID, or the start of one.
const ID_LIKE = /(?:^|[^0-9a-z])(?=[0-9a-f-]*\d)[0-9a-f][0-9a-f-]{5,}(?![0-9a-z])/i;
// The code calls a meeting request a "poke". Members never hear that word (poke.service.ts, 22 Sep 2026).
const CODE_WORD = /\bpok(?:e|es|ed|ing)\b/i;

interface FailedRequest {
  response?: { status?: number; data?: { error?: { message?: unknown; details?: unknown } } };
}

/** The server's sentence, trimmed, if it is short, free of ids and in words a member would use. */
function memberSentence(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const sentence = text.trim();
  if (!sentence || sentence.length > LONGEST_SENTENCE) return null;
  return ID_LIKE.test(sentence) || CODE_WORD.test(sentence) ? null : sentence;
}

/** Validation details are { field: [messages] }. The first message of the first field that has one. */
function firstDetail(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  for (const messages of Object.values(details)) {
    if (!Array.isArray(messages)) continue;
    const first = messages.find((m): m is string => typeof m === 'string' && m.trim() !== '');
    if (first !== undefined) return first;
  }
  return undefined;
}

/** One sentence for a failed request. `fallback` is what the caller says when the server's words are not fit to show. */
export function errorMessage(err: unknown, fallback: string): string {
  const response = (err as FailedRequest | null | undefined)?.response;
  // No answer at all: the network dropped or the request timed out.
  if (!response) return CONNECTION_LOST;
  const error = response.data?.error;
  switch (response.status) {
    case 429:
      return SLOW_DOWN;
    case 404:
      return PERSON_GONE;
    case 400:
      // A 400 that carries details is a validation failure: its generic message ("Validation failed")
      // is never shown, even when no detail line is fit to show either.
      if (error?.details != null) return memberSentence(firstDetail(error.details)) ?? fallback;
      return memberSentence(error?.message) ?? fallback;
    case 403:
    case 409:
      return memberSentence(error?.message) ?? fallback;
    default:
      return fallback;
  }
}
