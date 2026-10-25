// ─── The link on the bell row that announces a meeting request ───────────────
//
// sendPoke writes one bell row per request, linking to `/messages?poke=<request id>`
// (4 Sep 2026: the id rides in the link so the bell can answer the request in place).
// Three places have to agree on that shape: sendPoke, which writes it; the accept and
// decline paths, which mark the row read once the request is answered; and
// GET /notifications, which reads the id back out of the link to say where the
// request stands (25 Oct 2026: the bell kept offering Accept on a request answered on
// the Messages card). Production's bell parses the same shape (NotificationBell's
// extractPokeId), so it must never change.
//
// A module of its own, with no imports, for the reason request-message.ts gives: the
// tests that stand in for poke.service replace that whole module.

const PREFIX = '/messages?poke=';

/** The link a request's bell row carries. */
export function requestBellLink(pokeId: string): string {
  return `${PREFIX}${pokeId}`;
}

/**
 * A POSIX pattern (Postgres `substring(... FROM pattern)` and JavaScript alike) that matches a
 * request's bell link and captures the request id. The id must be a whole UUID, so the captured
 * text can always be cast to uuid: a looser pattern would let a malformed link fail the cast and
 * take the whole bell down with it.
 */
export const REQUEST_BELL_LINK_PATTERN =
  '^/messages\\?poke=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$';
