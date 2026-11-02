// ─── What changed for each member in the last minute (fix wave 2, 2 Nov 2026) ───────────────────────────────────────
//
// A page's first reads start before its socket has joined the member's room (user:<id>). A change made in between is
// sent on entity:changed to a room the socket is not in yet, so the page would keep what it read until a reload (the
// late-joiner race, CLAUDE.md section 3; T19's Script E 5b). emitEntities remembers, for RECENT_ENTITIES_MS, the tags
// it sent each member, and the connection handler sends a socket that joins those tags at once, on the same
// entity:changed event and payload every client follows. The page then reads again exactly what changed, instead of
// every read it made before its socket connected (the client's own rule, which doubled every page load).
//
// In memory, per server process: production runs one instance. With several instances behind the Redis adapter, a
// socket would be replayed only what its own instance sent; the client still re-reads everything after a reconnect.
// Bounded: at most RECENT_ENTITIES_MAX_PER_USER sends per member, each forgotten after a minute, and members with
// nothing recent are dropped by a sweep that runs at most once a window.

/** How long a send is remembered. The client trusts the replay for reads that started in the last half of it. */
export const RECENT_ENTITIES_MS = 60_000;
/** The most sends remembered per member: the newest are kept. */
export const RECENT_ENTITIES_MAX_PER_USER = 200;

interface Sent { at: number; entities: string[] }
const recent = new Map<string, Sent[]>();
let lastSweep = 0;

function fresh(list: Sent[], now: number): Sent[] {
  const from = list.findIndex((s) => now - s.at < RECENT_ENTITIES_MS);
  return from === -1 ? [] : list.slice(from);
}

/** Forget every member whose sends are all older than the window (at most once a window). */
function sweep(now: number): void {
  if (now - lastSweep < RECENT_ENTITIES_MS) return;
  lastSweep = now;
  for (const [userId, list] of recent) {
    const kept = fresh(list, now);
    if (kept.length === 0) recent.delete(userId);
    else recent.set(userId, kept);
  }
}

/** Note that `entities` were just sent to this member. */
export function rememberEntities(userId: string, entities: string[], now: number = Date.now()): void {
  if (!userId || entities.length === 0) return;
  sweep(now);
  const list = fresh(recent.get(userId) ?? [], now);
  list.push({ at: now, entities: [...entities] });
  recent.set(userId, list.length > RECENT_ENTITIES_MAX_PER_USER ? list.slice(-RECENT_ENTITIES_MAX_PER_USER) : list);
}

/** The tags sent to this member in the last minute, each once, in the order they were last sent. */
export function recentEntities(userId: string, now: number = Date.now()): string[] {
  const list = fresh(recent.get(userId) ?? [], now);
  const order = new Map<string, number>();
  let i = 0;
  for (const sent of list) for (const tag of sent.entities) { order.delete(tag); order.set(tag, i++); }
  return [...order.keys()];
}

/** Send a socket that has just joined its member's room what changed for that member in the last minute. */
export function replayRecentEntities(socket: { emit: (event: string, payload: unknown) => unknown }, userId: string | null | undefined): void {
  if (!userId) return;
  const entities = recentEntities(userId);
  if (entities.length > 0) socket.emit('entity:changed', { entities });
}

/** For tests. */
export function clearRecentEntities(): void {
  recent.clear();
  lastSweep = 0;
}
