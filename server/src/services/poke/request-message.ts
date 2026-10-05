// ─── How long a meeting request's message may be ─────────────────────────────
//
// A request's message is a note, a blank line and REASON's reason. Three places have
// to agree on how long it may be: the route that takes it in (routes/pokes.ts), the
// cleaning that stores it (cleanRequestMessage in poke.service.ts) and the wording
// that has to fit (the reason budget in platform-match.service.ts). They all read
// this one number, so the reason budget can never drift from what is stored.
//
// It counts UTF-16 units, which is what `string.length`, `slice` and zod's `max` count.
//
// A module of its own, with no imports, rather than an export of poke.service.ts: the
// tests that stand in for poke.service (it sends email and emits to sockets) replace
// the whole module, and a constant read from there would be undefined in them.

export const REQUEST_MESSAGE_MAX = 500;
