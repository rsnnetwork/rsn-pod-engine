// ─── Presence from a member's sockets (11 Nov 2026, Shirley Palmer's RSN 07) ─────────────────────────────
//
// What each of a member's connections says, turned into the three states (presence.service.ts) and pushed to their
// partners only when the state changes (presence-push.ts, coalesced over 300 ms so a connection's away-then-online is
// told once):
//   - a connection opening: the member's first live socket takes them from offline to away. Connecting no longer marks
//     anyone online: a phone reconnecting in the background read as online for a minute. The client says it is in front
//     of the person with a ping as soon as it connects, when it is.
//   - `presence:ping` (the tab is in front, every 25 s and on focus): online. Only the first ping after they were not
//     online is a change (SET NX); later ones only keep the key alive. Each ping re-arms a timer on this instance, so a
//     key that lapses without a word (a frozen tab) is still told, a little after the TTL.
//   - `presence:away` (the tab went to the background): away, once none of the member's other tabs is in front.
//   - the last socket closing: offline. A socket closing while others stay: away, if none of those is in front.
// A socket's own foreground flag (socket.data.foreground) is what its pings and aways last said; another instance
// reads it through fetchSockets. A connection that sends presence events in a burst is ignored past
// PRESENCE_EVENTS_PER_WINDOW in PRESENCE_WINDOW_MS, so one client cannot make a member's partners refetch in a loop.

import type { Server as SocketServer, Socket } from 'socket.io';
import { PRESENCE_TTL_SECONDS, clearActive, isActive, markActive } from './presence.service';
import { queuePresencePush } from './presence-push';
import logger from '../../config/logger';

export const PRESENCE_EVENTS_PER_WINDOW = 20;
export const PRESENCE_WINDOW_MS = 10_000;

const room = (userId: string) => `user:${userId}`;
const isForeground = (s: { id: string; data?: unknown }) =>
  (s.data as { foreground?: unknown } | undefined)?.foreground === true;

/** Timers, one per member pinging through this instance, that tell the partners when the key lapses unannounced. */
const lapseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function stopLapseTimer(userId: string): void {
  const t = lapseTimers.get(userId);
  if (t) clearTimeout(t);
  lapseTimers.delete(userId);
}

function armLapseTimer(userId: string): void {
  stopLapseTimer(userId);
  const t = setTimeout(() => {
    lapseTimers.delete(userId);
    void isActive(userId).then((active) => { if (active === false) queuePresencePush(userId); });
  }, (PRESENCE_TTL_SECONDS + 2) * 1000);
  t.unref?.();
  lapseTimers.set(userId, t);
}

/** At most PRESENCE_EVENTS_PER_WINDOW presence events per window from one connection; the rest are ignored. */
function presenceBudget(): () => boolean {
  let windowStart = Date.now();
  let used = 0;
  return () => {
    const t = Date.now();
    if (t - windowStart >= PRESENCE_WINDOW_MS) { windowStart = t; used = 0; }
    used += 1;
    return used <= PRESENCE_EVENTS_PER_WINDOW;
  };
}

/** The tab is in front of the member. */
export async function onPresencePing(socket: Pick<Socket, 'data'>, userId: string): Promise<void> {
  const wasForeground = socket.data.foreground === true;
  socket.data.foreground = true;
  const turned = await markActive(userId);
  if (turned !== null) armLapseTimer(userId);
  // Without Redis nothing is stamped: this socket coming to the front is the change.
  if (turned === true || (turned === null && !wasForeground)) queuePresencePush(userId);
}

/** The tab went to the background: away, unless another of the member's tabs is still in front. */
export async function onPresenceAway(io: SocketServer, socket: Pick<Socket, 'id' | 'data'>, userId: string): Promise<void> {
  socket.data.foreground = false;
  const sockets = await io.in(room(userId)).fetchSockets();
  if (sockets.some((s) => s.id !== socket.id && isForeground(s))) return;
  stopLapseTimer(userId);
  const was = await clearActive(userId);
  if (was !== false) queuePresencePush(userId);
}

/** A connection opened: the member's first one takes them from offline to away. */
export async function onPresenceConnect(io: SocketServer, userId: string): Promise<void> {
  const sockets = await io.in(room(userId)).fetchSockets();
  if (sockets.length === 1) queuePresencePush(userId);
}

/** A connection closed: offline when it was the last; away when none of those left is in front of the member. */
export async function onPresenceDisconnect(io: SocketServer, userId: string): Promise<void> {
  const remaining = await io.in(room(userId)).fetchSockets();
  if (remaining.length === 0) {
    stopLapseTimer(userId);
    await clearActive(userId);
    queuePresencePush(userId);
    return;
  }
  if (remaining.some(isForeground)) return;
  const was = await clearActive(userId);
  if (was !== false) {
    stopLapseTimer(userId);
    queuePresencePush(userId);
  }
}

/** Wire one member's connection: its first presence, its pings and aways. The disconnect is the caller's. */
export function watchPresence(io: SocketServer, socket: Socket, userId: string): void {
  socket.data.foreground = false;
  const allowed = presenceBudget();
  const guard = (what: string, work: () => Promise<void>) => {
    if (!allowed()) return;
    work().catch((err) => logger.warn({ err, userId }, `presence ${what} failed (non-fatal)`));
  };
  guard('connect', () => onPresenceConnect(io, userId));
  socket.on('presence:ping', () => guard('ping', () => onPresencePing(socket, userId)));
  socket.on('presence:away', () => guard('away', () => onPresenceAway(io, socket, userId)));
}

/** For tests: forget every lapse timer. */
export function resetPresenceTimers(): void {
  for (const t of lapseTimers.values()) clearTimeout(t);
  lapseTimers.clear();
}
