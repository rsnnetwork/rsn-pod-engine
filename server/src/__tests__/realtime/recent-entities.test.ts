// ─── A socket that joins is told what changed for its member in the last minute (fix wave 2, 2 Nov 2026) ─────────────
//
// A page's first reads start before its socket has joined the member's room. A change made in between went out on
// entity:changed to a room the socket was not in yet, and the page kept what it had read (T19's Script E 5b). The
// client's fix (CX1) read every tagged query again on the first connect, which roughly doubled every page load
// (measured: 242 → 393 requests for one member in n1-t11) and pushed busy members past production's 100 a minute.
// Now emitEntities remembers, for a minute, the tags it sent each member, and a socket that joins is sent those tags at
// once on the same entity:changed event: the page reads again exactly what changed, and nothing else.

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { emitEntities } from '../../realtime/emit';
import {
  RECENT_ENTITIES_MAX_MEMBERS, RECENT_ENTITIES_MAX_PER_USER, RECENT_ENTITIES_MS, clearRecentEntities, recentEntities,
  rememberEntities, replayRecentEntities,
} from '../../realtime/recent-entities';
import logger from '../../config/logger';

function fakeIo() {
  const sent: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = { to: (room: string) => ({ emit: (event: string, payload: unknown) => { sent.push({ room, event, payload }); } }) };
  return { io: io as never, sent };
}

beforeEach(() => clearRecentEntities());

describe('emitEntities remembers what it told each member, for a minute', () => {
  it('each recipient keeps the tags they were sent, once each, newest last', async () => {
    const { io } = fakeIo();
    await emitEntities(io, ['u-ana', 'u-bo'], ['meeting:m1', 'user:u-ana:meetings']);
    await emitEntities(io, ['u-ana'], ['meeting:m1', 'dm-conversation:c1']);
    expect(recentEntities('u-ana')).toEqual(['user:u-ana:meetings', 'meeting:m1', 'dm-conversation:c1']);
    expect(recentEntities('u-bo')).toEqual(['meeting:m1', 'user:u-ana:meetings']);
    expect(recentEntities('u-cy')).toEqual([]);
  });

  it('forgets after RECENT_ENTITIES_MS (a minute)', async () => {
    jest.useFakeTimers();
    try {
      const { io } = fakeIo();
      await emitEntities(io, ['u-ana'], ['meeting:m1']);
      expect(RECENT_ENTITIES_MS).toBe(60_000);
      jest.advanceTimersByTime(RECENT_ENTITIES_MS - 1);
      expect(recentEntities('u-ana')).toEqual(['meeting:m1']);
      jest.advanceTimersByTime(2);
      expect(recentEntities('u-ana')).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps at most RECENT_ENTITIES_MAX_PER_USER sends per member (a runaway member cannot grow it)', async () => {
    const { io } = fakeIo();
    for (let i = 0; i < RECENT_ENTITIES_MAX_PER_USER + 50; i++) await emitEntities(io, ['u-ana'], [`pod:p${i}`]);
    const kept = recentEntities('u-ana');
    expect(kept).toHaveLength(RECENT_ENTITIES_MAX_PER_USER);
    expect(kept[kept.length - 1]).toBe(`pod:p${RECENT_ENTITIES_MAX_PER_USER + 49}`);
  });

  it('a send that reached nobody (no socket server) is not remembered', async () => {
    await emitEntities(null, ['u-ana'], ['meeting:m1']);
    expect(recentEntities('u-ana')).toEqual([]);
  });

  // Fix round 1 (re-review Minor 3): the whole memory is bounded, not only each member's share of it.
  it('keeps at most RECENT_ENTITIES_MAX_MEMBERS members, forgetting the one told longest ago first', () => {
    for (let i = 0; i < RECENT_ENTITIES_MAX_MEMBERS + 3; i++) rememberEntities([`u-${i}`], ['pod:p1']);
    expect(recentEntities('u-0')).toEqual([]);
    expect(recentEntities('u-2')).toEqual([]);
    expect(recentEntities('u-3')).toEqual(['pod:p1']);
    expect(recentEntities(`u-${RECENT_ENTITIES_MAX_MEMBERS + 2}`)).toEqual(['pod:p1']);
    // Telling a member again makes them the newest: they are kept over others told since.
    rememberEntities(['u-3'], ['pod:p2']);
    rememberEntities(['u-new'], ['pod:p1']);
    expect(recentEntities('u-3')).toEqual(['pod:p1', 'pod:p2']);
    expect(recentEntities('u-4')).toEqual([]);
  });

  // Fix round 1 (re-review Minor 2): remembering can never cut off the fanout to the rest of the recipients.
  it('a failure while remembering is logged and every recipient is still told', async () => {
    const { io, sent } = fakeIo();
    const mod = jest.requireActual('../../realtime/recent-entities') as { rememberEntities: unknown };
    const spy = jest.spyOn(mod as { rememberEntities: (...a: unknown[]) => void }, 'rememberEntities')
      .mockImplementation(() => { throw new Error('boom'); });
    try {
      await emitEntities(io, ['u-a', 'u-b', 'u-c'], ['pod:p1']);
    } finally {
      spy.mockRestore();
    }
    expect(sent.map((x) => x.room)).toEqual(['user:u-a', 'user:u-b', 'user:u-c']);
    expect(jest.mocked(logger.warn)).toHaveBeenCalled();
  });
});

describe('a socket that joins is sent what changed for its member in the last minute', () => {
  const socketFor = () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    return { emitted, socket: { emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); } } };
  };

  it("on the same entity:changed event every client already follows, marked as a replay (production's client reads only entities)", async () => {
    const { io } = fakeIo();
    await emitEntities(io, ['u-max'], ['meeting:m1', 'user:u-max:meetings']);
    const { socket, emitted } = socketFor();
    replayRecentEntities(socket, 'u-max');
    expect(emitted).toEqual([{ event: 'entity:changed', payload: { entities: ['meeting:m1', 'user:u-max:meetings'], replayed: true } }]);
  });

  it('nothing recent, or no member: nothing is sent', () => {
    const { socket, emitted } = socketFor();
    replayRecentEntities(socket, 'u-max');
    replayRecentEntities(socket, null);
    expect(emitted).toEqual([]);
  });

  it('the connection handler joins the member room first, then replays inside a guard, so a throw never leaves the connection without its handlers (source pin)', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '../../services/orchestration/orchestration.service.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/if \(userId\) socket\.join\(`user:\$\{userId\}`\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*try \{\s*replayRecentEntities\(socket, userId\);\s*\} catch \(err\) \{\s*logger\.warn\(/);
    expect(src.indexOf('replayRecentEntities(socket, userId)')).toBeLessThan(src.indexOf("wrapHandler('session:join'"));
  });
});
