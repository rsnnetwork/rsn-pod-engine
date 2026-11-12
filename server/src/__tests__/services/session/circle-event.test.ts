// ─── An event for a whole circle, without a database (T13, 1 Nov 2026; L20, L21) ─────────────────────────
//
// Always runs. The real-Postgres behaviour is circle-event.sql.test.ts (opt-in); this file holds the shapes that
// must not drift: production's create body touches no circle and writes NULL for both new columns; a circle event
// is checked (404 archived, 403 in a sentence), private by default, rung in one INSERT … SELECT of event_invite to
// active members but the creator, never emailed; the audience fragment's circle arm; and the circle-event fanout.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  // An edit that can move the event link saves the row and the link in one transaction (review M4).
  transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: (...args: unknown[]) => mockQuery(...args) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockGetPodById = jest.fn();
const mockGetMemberRole = jest.fn();
jest.mock('../../../services/pod/pod.service', () => ({
  getPodById: (...args: unknown[]) => mockGetPodById(...args),
  getMemberRole: (...args: unknown[]) => mockGetMemberRole(...args),
  __esModule: true,
}));
const mockEmail = jest.fn();
jest.mock('../../../services/email/email.service', () => new Proxy({}, {
  get: (_t, name) => (name === '__esModule' ? true : (...args: unknown[]) => { mockEmail(name, ...args); return Promise.resolve(); }),
}));
const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
const mockSocketEmit = jest.fn();
const mockIo = { to: jest.fn(() => ({ emit: mockSocketEmit })) };
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

// The event link (migration 154) is its own service with its own tests (event-link.test.ts): here it answers at once, so
// these statements stay the circle's own.
const mockEnsureEventLink = jest.fn().mockResolvedValue({ name: 'rsn', number: 1, tail: 'k7m2q9' });
jest.mock('../../../services/session/event-link.service', () => ({
  ...jest.requireActual('../../../services/session/event-link.service'),
  ensureEventLink: (...args: unknown[]) => mockEnsureEventLink(...args),
  ensureEventLinkIn: () => Promise.resolve({ parts: { name: 'rsn', number: 1, tail: 'k7m2q9' }, changed: false }),
}));
// The call code likewise: its own tests are call-link.test.ts.
jest.mock('../../../services/session/call-link.service', () => ({
  ...jest.requireActual('../../../services/session/call-link.service'),
  ensureCallCode: () => Promise.resolve('k7m2x9q4ra'),
}));

import { PodType, UserRole } from '@rsn/shared';
import { createSession, updateSession } from '../../../services/session/session.service';
import { eventAudienceSql, canSeeEvent, canRegister, type EventAccessFacts } from '../../../services/session/event-access';
import { activeMemberSql } from '../../../services/users/active-member';
import {
  fanoutCircleEvent, resolveSessionListAudience, CIRCLE_EVENT_FANOUT_BATCH,
} from '../../../realtime/fanout';

const POD_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CIRCLE_ID = '33333333-3333-4333-8333-333333333333';
const DIRECTOR = 'user-director';
const CIRCLE = { id: CIRCLE_ID, name: 'Founding Circle' };

const base = {
  podId: POD_ID, title: 'Founders evening', scheduledAt: '2026-11-08T18:00:00.000Z', format: 'speed_networking' as const,
  config: { numberOfRounds: 3, roundDurationSeconds: 480, maxParticipants: 25 },
};

/** The circle row, whether this person runs it, and every other statement echoes a session row. */
function arm(world: { circle?: typeof CIRCLE | null; manager?: boolean; session?: Record<string, unknown> } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT id, name FROM circles WHERE id = \$1 AND archived_at IS NULL/.test(sql)) {
      return { rows: world.circle ? [world.circle] : [], rowCount: world.circle ? 1 : 0 };
    }
    if (/SELECT name FROM circles WHERE id = \$1/.test(sql)) {
      return { rows: world.circle ? [{ name: world.circle.name }] : [], rowCount: 1 };
    }
    // Shirley pilot S2: the manager gate reads the person's own owner or moderator row (never the circle's maker).
    if (/FROM circle_members m\s+WHERE m\.circle_id = \$1 AND m\.user_id = \$2 AND m\.role IN \('owner', 'moderator'\)/.test(sql)) {
      return { rows: world.manager ? [{ '?column?': 1 }] : [], rowCount: world.manager ? 1 : 0 };
    }
    if (/INSERT INTO notifications/.test(sql)) {
      return { rows: [{ id: 'n1', user_id: 'member-a', body: 'Founders evening', created_at: new Date() }], rowCount: 1 };
    }
    if (/FROM circle_members cm/.test(sql)) return { rows: [{ user_id: 'member-a' }, { user_id: DIRECTOR }], rowCount: 2 };
    return { rows: [world.session ?? { id: SESSION_ID, podId: POD_ID, hostUserId: DIRECTOR, status: 'scheduled', config: {} }], rowCount: 1 };
  });
}

const sqlSent = () => mockQuery.mock.calls.map(([sql]) => String(sql));
const call = (pattern: RegExp) => mockQuery.mock.calls.find(([sql]) => pattern.test(String(sql))) as [string, unknown[]] | undefined;
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

beforeEach(() => {
  mockQuery.mockReset();
  mockEmitEntities.mockClear();
  mockSocketEmit.mockClear();
  mockEmail.mockClear();
  mockGetPodById.mockResolvedValue({ id: POD_ID, name: 'Pod', status: 'active', podType: PodType.SPEED_NETWORKING });
  mockGetMemberRole.mockResolvedValue('director');
});

describe('production\'s create body (no circleId)', () => {
  it('reads no circle, rings nobody, and writes NULL visibility and NULL circle', async () => {
    arm();
    await createSession(DIRECTOR, base, UserRole.MEMBER);
    const insert = call(/INSERT INTO sessions/)!;
    expect(insert[0]).toMatch(/visibility, circle_id,/);
    expect(insert[1].slice(8, 10)).toEqual([null, null]);
    // Part 2 Task 2: production's body sends no lifecycle fields, so the event is published at once, as today.
    expect(insert[1].slice(10, 12)).toEqual(['published', null]);
    // Part 3 Task 1: production's body sends no zone, so the event takes the host's own when real, else UTC.
    expect(insert[1].slice(12)).toEqual(['UTC']);
    expect(sqlSent().some((sql) => /circles|circle_members|INSERT INTO notifications/.test(sql))).toBe(false);
  });
});

describe('a circle event on create', () => {
  it('an archived or unknown circle is a 404 and nothing is written', async () => {
    arm({ circle: null });
    await expect(createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID }, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 404 });
    expect(call(/INSERT INTO sessions/)).toBeUndefined();
  });

  it('someone who does not run the circle is refused 403 in a sentence that names it', async () => {
    arm({ circle: CIRCLE, manager: false });
    await expect(createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID }, UserRole.MEMBER)).rejects.toMatchObject({
      statusCode: 403, code: 'AUTH_FORBIDDEN', message: 'Only the people who run Founding Circle can schedule an event for it.',
    });
    expect(call(/INSERT INTO sessions/)).toBeUndefined();
  });

  it('the pod rule still comes first: a manager who does not run the pod is refused by it', async () => {
    arm({ circle: CIRCLE, manager: true });
    mockGetMemberRole.mockResolvedValue('member');
    await expect(createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID }, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });
    expect(call(/INSERT INTO sessions/)).toBeUndefined();
  });

  it('a manager\'s event names the circle and is private unless a visibility is sent', async () => {
    arm({ circle: CIRCLE, manager: true });
    await createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID }, UserRole.MEMBER);
    expect(call(/INSERT INTO sessions/)![1].slice(8, 10)).toEqual(['private', CIRCLE_ID]);
    mockQuery.mockClear();
    await createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID, visibility: 'public' }, UserRole.MEMBER);
    expect(call(/INSERT INTO sessions/)![1].slice(8, 10)).toEqual(['public', CIRCLE_ID]);
  });

  it('rings active members but the creator in one INSERT … SELECT of event_invite, pushes the bell, and sends no email', async () => {
    arm({ circle: CIRCLE, manager: true });
    await createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID }, UserRole.MEMBER);
    const bells = mockQuery.mock.calls.filter(([sql]) => /INSERT INTO notifications/.test(String(sql)));
    expect(bells).toHaveLength(1);
    const [sql, params] = bells[0] as [string, unknown[]];
    const id = call(/INSERT INTO sessions/)![1][0];
    expect(sql).toMatch(/SELECT cm\.user_id, 'event_invite', \$3, s\.title, \$4\s+FROM circle_members cm/);
    expect(sql).toContain(activeMemberSql('u'));
    expect(sql).toMatch(/cm\.user_id <> \$5/);
    expect(params).toEqual([CIRCLE_ID, id, 'New event in Founding Circle', `/sessions/${id}`, DIRECTOR]);
    expect(mockIo.to).toHaveBeenCalledWith('user:member-a');
    expect(mockSocketEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({
      type: 'event_invite', title: 'New event in Founding Circle', link: `/sessions/${id}`,
    }));
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['member-a'], ['user:member-a:notifications']);
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it('a platform admin needs no manager row', async () => {
    arm({ circle: CIRCLE, manager: false });
    await createSession(DIRECTOR, { ...base, circleId: CIRCLE_ID }, UserRole.ADMIN);
    expect(call(/INSERT INTO sessions/)![1].slice(8, 10)).toEqual(['private', CIRCLE_ID]);
  });
});

describe('a circle on edit (PUT)', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: SESSION_ID, podId: POD_ID, hostUserId: DIRECTOR, status: 'scheduled', config: {}, visibility: null, circleId: null, ...over,
  });

  it('naming a circle on an event that follows its pod makes it private and rings the members', async () => {
    arm({ circle: CIRCLE, manager: true, session: event() });
    await updateSession(SESSION_ID, DIRECTOR, { circleId: CIRCLE_ID }, UserRole.MEMBER);
    const [sql, params] = call(/UPDATE sessions SET/)!;
    expect(sql).toMatch(/circle_id = \$1, visibility = \$2 WHERE id = \$3/);
    expect(params).toEqual([CIRCLE_ID, 'private', SESSION_ID]);
    expect(call(/INSERT INTO notifications/)).toBeDefined();
  });

  it('a host who does not run the circle cannot name it, and nothing is written', async () => {
    arm({ circle: CIRCLE, manager: false, session: event() });
    await expect(updateSession(SESSION_ID, DIRECTOR, { circleId: CIRCLE_ID }, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });
    expect(call(/UPDATE sessions SET/)).toBeUndefined();
  });

  it('clearing keeps the visibility and rings nobody; only a manager of that circle may', async () => {
    arm({ circle: CIRCLE, manager: true, session: event({ circleId: CIRCLE_ID, visibility: 'private' }) });
    await updateSession(SESSION_ID, DIRECTOR, { circleId: null }, UserRole.MEMBER);
    expect(call(/UPDATE sessions SET/)![1]).toEqual([null, SESSION_ID]);
    expect(call(/INSERT INTO notifications/)).toBeUndefined();
    mockQuery.mockReset();
    arm({ circle: CIRCLE, manager: false, session: event({ circleId: CIRCLE_ID, visibility: 'private' }) });
    await expect(updateSession(SESSION_ID, DIRECTOR, { circleId: null }, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('production\'s edit body (no circleId) never reads a circle', async () => {
    arm({ session: event({ circleId: CIRCLE_ID, visibility: 'private' }) });
    await updateSession(SESSION_ID, DIRECTOR, { title: 'Renamed' }, UserRole.MEMBER);
    expect(sqlSent().some((sql) => /circles|circle_members/.test(sql))).toBe(false);
    expect(call(/UPDATE sessions SET/)![1]).toEqual(['Renamed', SESSION_ID]);
  });
});

describe('the audience fragment', () => {
  it('adds the circle\'s active members, only for an event that names a circle and has its own visibility', () => {
    const sql = eventAudienceSql('s', '$2');
    expect(sql).toContain("ea_m.pod_id = s.pod_id AND ea_m.user_id = $2 AND ea_m.status = 'active'");
    expect(sql).toContain('s.circle_id IS NOT NULL AND s.visibility IS NOT NULL');
    expect(sql).toContain('ea_cm.circle_id = s.circle_id AND ea_cm.user_id = $2');
    expect(sql).toContain(activeMemberSql('ea_cu'));
  });

  it('a circle member in the audience of a private event sees and registers without joining the pod', () => {
    const facts: EventAccessFacts = {
      visibility: 'private', podId: POD_ID, podVisibility: 'private', isHost: false, isCohost: false, isPodOrganiser: false,
      inAudience: true, isInvited: false, participantStatus: null, accountActive: true, myRequest: null, outsideClosedCircle: false,
      publication: 'published', archived: false, registrationOpensAt: null, eventTimezone: null, isPodAdmin: false, placesHeld: 0,
      admissionMode: null, entitled: false, entitledVia: null, capacity: null, placesTaken: 0, waitlistPosition: null, waitlistAhead: 0, eventStatus: 'scheduled',
    };
    expect(canSeeEvent(facts, UserRole.MEMBER)).toBe(true);
    expect(canRegister(facts, UserRole.MEMBER)).toEqual({ ok: true, addToPod: false });
    expect(canSeeEvent({ ...facts, accountActive: false }, UserRole.MEMBER)).toBe(false);
  });
});

describe('the fanout', () => {
  it('every helper that tells an event\'s people includes its circle\'s active members', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await resolveSessionListAudience(POD_ID, SESSION_ID);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM circle_members cm\s+JOIN sessions cs ON cs\.circle_id = cm\.circle_id/);
    expect(sql).toContain(activeMemberSql('cu'));
    expect(sql).toMatch(/WHERE cs\.id = \$1/);
    expect(params).toEqual([SESSION_ID, POD_ID]);
  });

  it('the circle-event fanout tells each active member, the creator and the actor their own tags, in batches', async () => {
    const members = Array.from({ length: CIRCLE_EVENT_FANOUT_BATCH + 5 }, (_, i) => ({ user_id: `m${i}` }));
    mockQuery.mockResolvedValue({ rows: members, rowCount: members.length });
    await fanoutCircleEvent(CIRCLE_ID, SESSION_ID, 'actor');
    await settle();
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain(activeMemberSql('u'));
    expect(sql).toMatch(/SELECT created_by FROM circles WHERE id = \$1/);
    expect(mockEmitEntities).toHaveBeenCalledTimes(members.length + 1);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['m3'], [
      `circle:${CIRCLE_ID}`, `session:${SESSION_ID}`, 'user:m3:sessions',
    ]);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['actor'], expect.arrayContaining(['user:actor:sessions']));
  });
});
