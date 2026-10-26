// ─── An event that ends tells every page that shows it; a deleted chat message tells its readers ──
// (26 Oct 2026)
//
// Completing an event emitted no entity tags, so an open event page, a pod's events and Home/Sessions only
// flipped to "Ended" on a refetch. fanoutSessionCompleted tells everyone who could have the event open: its
// participants (those who already left included: the end-of-event sweep marks everyone left while this runs),
// its host and co-hosts, and its pod's active members. fanoutSessionChat tells the people who can read the chat
// when a message is taken down.
//
// The database is a fake that holds the event's people with their statuses and answers each arm of the
// audience statement by its predicate (participants by status / joined; pod members by status), so a
// predicate that drops people who left, or lets the wrong people in, fails here. The emit boundary is recorded.

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockWarn = jest.fn();
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockIo = { name: 'the socket server' };
let mockIoAvailable = true;
const mockEmitEntities = jest.fn(async () => {});
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => (mockEmitEntities as jest.Mock)(...a),
  getRealtimeIo: () => (mockIoAvailable ? mockIo : null),
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import { fanoutSessionCompleted, fanoutSessionChat } from '../../realtime/fanout';

const EVENT = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const POD = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';

type Participant = { id: string; status: string; joined: boolean };
const world = {
  podId: POD as string | null,
  eventExists: true,
  host: 'u-host',
  cohosts: [] as string[],
  participants: [] as Participant[],
  podMembers: [] as { id: string; status: string }[],
  failAudience: false,
};

function reset() {
  world.podId = POD;
  world.eventExists = true;
  world.host = 'u-host';
  world.cohosts = ['u-cohost'];
  world.participants = [
    { id: 'u-left-early', status: 'left', joined: true },        // left before the end (Stefan on 25 Oct)
    { id: 'u-still-here', status: 'in_lobby', joined: true },    // the sweep flips this one to left as we run
    { id: 'u-no-show', status: 'no_show', joined: false },       // registered, never came
    { id: 'u-registered', status: 'registered', joined: false }, // registered, never came
    { id: 'u-kicked-in', status: 'removed', joined: true },      // removed after joining
    { id: 'u-kicked-out', status: 'removed', joined: false },    // removed before ever joining
  ];
  world.podMembers = [
    { id: 'u-member', status: 'active' },
    { id: 'u-still-here', status: 'active' },  // in two groups: told once
    { id: 'u-invited', status: 'invited' },
    { id: 'u-gone', status: 'left' },
  ];
  world.failAudience = false;
}

/** The text of one UNION arm, from its FROM to the next UNION. */
const arm = (sql: string, table: string) => sql.match(new RegExp(`FROM ${table}\\b(.*?)(?=\\bUNION\\b|$)`, 's'))?.[1] ?? null;

function keep<T extends { status: string }>(rows: T[], where: string, extra?: (row: T) => boolean | undefined): T[] {
  return rows.filter((row) => {
    const special = extra?.(row);
    if (special !== undefined) return special;
    const notIn = where.match(/status NOT IN \(([^)]*)\)/);
    if (notIn) return !notIn[1].includes(`'${row.status}'`);
    const is = where.match(/status = '([a-z_]+)'/);
    if (is) return row.status === is[1];
    throw new Error(`the fake does not model this predicate: ${where.trim()}`);
  });
}

function audience(sql: string, params: unknown[]): string[] {
  const ids: string[] = [];
  const participants = arm(sql, 'session_participants');
  if (participants !== null && params[0] === EVENT) {
    const joinedOrNotRemoved = /\(joined_at IS NOT NULL OR status <> 'removed'\)/.test(participants);
    const joinedAndNotRemoved = /joined_at IS NOT NULL AND status <> 'removed'/.test(participants);
    ids.push(...keep(world.participants, participants, (p) => {
      if (joinedOrNotRemoved) return p.joined || p.status !== 'removed';
      if (joinedAndNotRemoved) return p.joined && p.status !== 'removed';
      return undefined;
    }).map((p) => p.id));
  }
  const cohosts = arm(sql, 'session_cohosts');
  if (cohosts !== null && /session_id = \$1/.test(cohosts) && params[0] === EVENT) ids.push(...world.cohosts);
  if (/SELECT host_user_id FROM sessions WHERE id = \$1/.test(sql) && params[0] === EVENT && world.eventExists) ids.push(world.host);
  const members = arm(sql, 'pod_members');
  if (members !== null && world.podId !== null && params[1] === world.podId) {
    ids.push(...keep(world.podMembers, members).map((m) => m.id));
  }
  return ids;
}

function armDatabase() {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ');
    if (/^SELECT pod_id FROM sessions WHERE id = \$1$/.test(flat.trim())) {
      return { rows: world.eventExists && params[0] === EVENT ? [{ pod_id: world.podId }] : [] };
    }
    if (world.failAudience) throw new Error('database is down');
    return { rows: audience(flat, params).map((user_id) => ({ user_id })) };
  });
}

/** Each recipient → the tags they were sent, from the recorded emits (one emit per recipient expected). */
function told(): Map<string, string[]> {
  const byUser = new Map<string, string[]>();
  for (const [io, userIds, entities] of mockEmitEntities.mock.calls as unknown as [unknown, string[], string[]][]) {
    expect(io).toBe(mockIo);
    for (const id of userIds) {
      expect(byUser.has(id)).toBe(false); // nobody is told twice
      byUser.set(id, entities);
    }
  }
  return byUser;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIoAvailable = true;
  reset();
  armDatabase();
});

describe('fanoutSessionCompleted', () => {
  it('tells the people who left early, those still there, the no-shows, the host, co-hosts and active pod members', async () => {
    await fanoutSessionCompleted(EVENT);
    expect([...told().keys()].sort()).toEqual([
      'u-cohost', 'u-host', 'u-kicked-in', 'u-left-early', 'u-member', 'u-no-show', 'u-registered', 'u-still-here',
    ].sort());
  });

  it('does not tell someone removed before they ever joined, an invited pod member, or one who left the pod', async () => {
    await fanoutSessionCompleted(EVENT);
    const recipients = told();
    for (const id of ['u-kicked-out', 'u-invited', 'u-gone']) expect(recipients.has(id)).toBe(false);
  });

  it('sends each person the event, its people, its chat, the pod\'s events and their own lists, in one emit', async () => {
    await fanoutSessionCompleted(EVENT);
    expect(told().get('u-left-early')).toEqual([
      `session:${EVENT}`, `session:${EVENT}:participants`, `session:${EVENT}:chat`, `pod:${POD}:sessions`,
      'user:u-left-early:sessions', 'user:u-left-early:pods',
    ]);
    expect(told().get('u-member')).toEqual([
      `session:${EVENT}`, `session:${EVENT}:participants`, `session:${EVENT}:chat`, `pod:${POD}:sessions`,
      'user:u-member:sessions', 'user:u-member:pods',
    ]);
  });

  it('an event with no pod sends no pod tag and asks for no pod members', async () => {
    world.podId = null;
    await fanoutSessionCompleted(EVENT);
    const tags = told().get('u-host')!;
    expect(tags.some((t) => t.startsWith('pod:'))).toBe(false);
    expect(told().has('u-member')).toBe(false);
  });

  it('does nothing when the event is gone, and nothing without a socket server', async () => {
    world.eventExists = false;
    await fanoutSessionCompleted(EVENT);
    expect(mockEmitEntities).not.toHaveBeenCalled();
    world.eventExists = true;
    mockIoAvailable = false;
    await fanoutSessionCompleted(EVENT);
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a database failure is logged and never thrown into the completion that called it', async () => {
    world.failAudience = true;
    await expect(fanoutSessionCompleted(EVENT)).resolves.toBeUndefined();
    expect(mockEmitEntities).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('fanoutSessionChat (a message taken down)', () => {
  it('tells the people who can read the chat, and the person who took it down, the chat tag only', async () => {
    await fanoutSessionChat(EVENT, 'u-admin');
    const recipients = told();
    expect([...recipients.keys()].sort()).toEqual(['u-admin', 'u-cohost', 'u-host', 'u-left-early', 'u-still-here'].sort());
    for (const tags of recipients.values()) expect(tags).toEqual([`session:${EVENT}:chat`]);
  });

  it('a database failure is logged, not thrown', async () => {
    world.failAudience = true;
    await expect(fanoutSessionChat(EVENT, 'u-admin')).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });
});
