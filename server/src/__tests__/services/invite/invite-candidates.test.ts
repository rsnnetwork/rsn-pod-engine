// ─── Inviting from your connections: the candidates list and the batch (26 Oct 2026) ────────────────
//
// Stefan, inviting to a pod on 25 Oct: "I should be able to see all the users I'm friends with. I may have 400
// friends. I can't remember that he's called Claus." The old invite search read only event encounters, needed a
// typed name, returned 20 people, ignored blocks and sent one request per person. This is its server half:
//
//   listInviteCandidates  your connections (or an event's pod) with where each person stands against the pod or
//                         event, a page at a time, searched by name, title or company;
//   createInvitesBatch    up to 50 people in one call, one outcome each, the same person never invited twice.
//
// The database is a stand-in that answers by what the SQL asks for, so these tests read the SQL's rules and the
// code's decisions; the SQL itself is run against a real Postgres in the task report's smoke.

import { InviteType, InviteBatchInput } from '@rsn/shared';
import { inviteWorld, Answers } from '../../fixtures/invite-world';

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: unknown) => mockTransaction(cb),
  __esModule: true,
}));

jest.mock('../../../config', () => ({
  default: { clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001' },
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockSendInviteEmail = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  sendInviteEmail: (...args: unknown[]) => mockSendInviteEmail(...args),
  __esModule: true,
}));

const mockGetPodById = jest.fn();
const mockGetMemberRole = jest.fn();
jest.mock('../../../services/pod/pod.service', () => ({
  getPodById: (...args: unknown[]) => mockGetPodById(...args),
  getMemberRole: (...args: unknown[]) => mockGetMemberRole(...args),
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));

jest.mock('../../../services/circle/circle.service', () => ({
  isCircleMember: jest.fn(),
  joinCircle: jest.fn(),
  __esModule: true,
}));

// The invitee's bell is pushed through the live socket server; the entry point is not loaded here.
const mockEmit = jest.fn();
jest.mock('../../../index', () => ({
  io: { to: (room: string) => ({ emit: (...args: unknown[]) => mockEmit(room, ...args) }) },
}));

import { listInviteCandidates, createInvitesBatch } from '../../../services/invite/invite-candidates.service';
import { CONNECTION_SIGNALS_SQL } from '../../../services/people/connections.service';

const VIEWER = 'a0000000-0000-4000-8000-000000000001';
const HOST = 'a0000000-0000-4000-8000-000000000002';
const POD = 'c0000000-0000-4000-8000-000000000001';
const EVENT = 'd0000000-0000-4000-8000-000000000001';
const EVENT_POD = 'c0000000-0000-4000-8000-000000000002';
const uid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const flat = (text: unknown) => String(text).replace(/\s+/g, ' ').trim();
const member = { userId: VIEWER, role: 'member' };
const admin = { userId: VIEWER, role: 'admin' };

const podRow = (over: Record<string, unknown> = {}) => ({ id: POD, name: 'Reason circle', status: 'active', allowMemberInvites: false, ...over });
const eventRow = (over: Record<string, unknown> = {}) => ({
  id: EVENT, podId: EVENT_POD, title: 'Kickoff', status: 'scheduled', hostUserId: HOST, scheduledAt: null, config: {}, ...over,
});

/** A row of the candidates query, as Postgres hands it over. */
const candidateRow = (n: number, over: Record<string, unknown> = {}) => ({
  user_id: uid(n), display_name: `Person ${n}`, avatar_url: null, job_title: `Role ${n}`, company: `Company ${n}`,
  met: false, since: new Date('2026-10-20T10:00:00.000Z'), state: 'available', latest_invite_id: null, ...over,
});

/** The statements run so far that match. */
const statementsMatching = (pattern: RegExp) =>
  mockQuery.mock.calls.filter((call) => pattern.test(flat(call[0]))).map((call) => ({ sql: flat(call[0]), params: call[1] as unknown[] }));
const candidatesStatement = () => {
  const found = statementsMatching(/page AS \(/);
  expect(found).toHaveLength(1);
  return found[0];
};

// ─── The pieces every test draws on ───────────────────────────────────────────────────────────────
let cohosts: string[];
let candidateRows: unknown[];

const baseAnswers: Answers = (text) => {
  if (/FROM session_cohosts/.test(text)) return { rows: cohosts.length > 0 ? [{ '?column?': 1 }] : [] };
  if (/page AS \(/.test(text)) return { rows: candidateRows };
  return undefined;
};

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset();
  mockGetPodById.mockReset();
  mockGetMemberRole.mockReset();
  mockGetSessionById.mockReset();
  mockSendInviteEmail.mockReset();
  mockEmit.mockReset();
  cohosts = [];
  candidateRows = [];
  mockGetPodById.mockResolvedValue(podRow());
  mockGetMemberRole.mockResolvedValue('director');
  mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: VIEWER }));
  mockSendInviteEmail.mockResolvedValue(undefined);
  const world = inviteWorld({ answers: baseAnswers });
  mockQuery.mockImplementation(world.query);
  mockTransaction.mockImplementation(world.transaction);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Who may ask
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('who may list candidates: exactly who may send the invite', () => {
  const askForPod = (viewer = member) => listInviteCandidates(viewer, { podId: POD, source: 'connections', before: null, limit: 30 });
  const askForEvent = (viewer = member, source: 'connections' | 'pod' = 'connections') =>
    listInviteCandidates(viewer, { sessionId: EVENT, source, before: null, limit: 30 });

  it.each([
    ['the pod\'s director', 'director', false],
    ['the pod\'s host', 'host', false],
    ['a member, when the pod lets members invite', 'member', true],
  ])('for a pod: %s may', async (_who, role, allowMemberInvites) => {
    mockGetPodById.mockResolvedValue(podRow({ allowMemberInvites }));
    mockGetMemberRole.mockResolvedValue(role);
    await expect(askForPod()).resolves.toEqual({ items: [], nextBefore: null });
    expect(statementsMatching(/page AS \(/)).toHaveLength(1);
  });

  it('for a pod: an admin may, without being a member (the pod is not asked who the admin is)', async () => {
    mockGetMemberRole.mockResolvedValue(null);
    await expect(askForPod(admin)).resolves.toEqual({ items: [], nextBefore: null });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it.each([
    ['a member, when the pod keeps invites to its organisers', 'member', false, 'Only pod directors and hosts can send pod invites'],
    ['someone outside the pod, when members may invite', null, true, 'You must be a pod member to send invites'],
    ['someone outside the pod, when they may not', null, false, 'Only pod directors and hosts can send pod invites'],
  ])('for a pod: %s may not: 403, and not one person is looked up', async (_who, role, allowMemberInvites, message) => {
    mockGetPodById.mockResolvedValue(podRow({ allowMemberInvites }));
    mockGetMemberRole.mockResolvedValue(role);
    await expect(askForPod()).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN', message });
    expect(statementsMatching(/page AS \(/)).toHaveLength(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an archived pod cannot be invited to: 400, as the invite itself is refused', async () => {
    mockGetPodById.mockResolvedValue(podRow({ status: 'archived' }));
    await expect(askForPod()).rejects.toMatchObject({ statusCode: 400, code: 'POD_ARCHIVED' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a pod that does not exist is 404', async () => {
    const { NotFoundError } = await import('../../../middleware/errors');
    mockGetPodById.mockRejectedValue(new NotFoundError('Pod', POD));
    await expect(askForPod()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('for an event: the host may, and is not asked about co-hosts', async () => {
    mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: VIEWER }));
    await expect(askForEvent()).resolves.toEqual({ items: [], nextBefore: null });
    expect(statementsMatching(/session_cohosts/)).toHaveLength(0);
  });

  it('for an event: a co-host may', async () => {
    mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: HOST }));
    cohosts = [VIEWER];
    await expect(askForEvent()).resolves.toEqual({ items: [], nextBefore: null });
    expect(statementsMatching(/FROM session_cohosts WHERE session_id = \$1 AND user_id = \$2/)[0].params).toEqual([EVENT, VIEWER]);
  });

  it('for an event: an admin may, and is not asked about co-hosts', async () => {
    await expect(askForEvent(admin)).resolves.toEqual({ items: [], nextBefore: null });
    expect(statementsMatching(/session_cohosts/)).toHaveLength(0);
  });

  it('for an event: anyone else may not, even a member of its pod: 403, and not one person is looked up', async () => {
    mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: HOST }));
    cohosts = [];
    mockGetMemberRole.mockResolvedValue('member');
    await expect(askForEvent()).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(statementsMatching(/page AS \(/)).toHaveLength(0);
  });

  it.each(['completed', 'cancelled'])('a %s event cannot be invited to: 400', async (status) => {
    mockGetSessionById.mockResolvedValue(eventRow({ status, hostUserId: VIEWER }));
    await expect(askForEvent()).rejects.toMatchObject({ statusCode: 400 });
    expect(statementsMatching(/page AS \(/)).toHaveLength(0);
  });

  it('the pod list belongs to events: asked about a pod it is refused before any permission is read', async () => {
    await expect(listInviteCandidates(member, { podId: POD, source: 'pod', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(mockGetPodById).not.toHaveBeenCalled();
  });

  it('one target at a time: both ids, or neither, is refused', async () => {
    await expect(listInviteCandidates(member, { podId: POD, sessionId: EVENT, source: 'connections', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(listInviteCandidates(member, { source: 'connections', before: null, limit: 30 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Your connections
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('listInviteCandidates: your connections', () => {
  const ask = (over: Record<string, unknown> = {}) =>
    listInviteCandidates(member, { podId: POD, source: 'connections', before: null, limit: 30, ...over } as Parameters<typeof listInviteCandidates>[1]);

  it('reads "a connection" from the one definition the People page uses, asked about the member who is looking', async () => {
    await ask();
    const { sql, params } = candidatesStatement();
    expect(sql).toContain(flat(CONNECTION_SIGNALS_SQL));
    expect(sql).toMatch(/FROM people pe JOIN users u ON u\.id = pe\.person_id/);
    expect(params[0]).toBe(VIEWER);
  });

  it('leaves out the member themself, every account that is not active, and anyone blocked in either direction', async () => {
    await ask();
    const { sql } = candidatesStatement();
    expect(sql).toMatch(/u\.id <> \$1/);
    expect(sql).toMatch(/u\.status = 'active'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = u\.id\) OR \(b\.blocker_id = u\.id AND b\.blocked_id = \$1\)\)/);
  });

  it('newest first, older than the cursor, a page of people at a time; the state is worked out for the page only', async () => {
    await ask();
    const { sql } = candidatesStatement();
    expect(sql).toMatch(/\(\$2::timestamptz IS NULL OR pe\.since < \$2::timestamptz\)/);
    expect(sql).toMatch(/\(\$4::timestamptz IS NULL OR pe\.since = \$4::timestamptz\)/);
    expect(sql).toMatch(/ORDER BY pe\.since DESC, u\.id LIMIT \$3\)/);
    // The page is cut first; only then is each of its people looked up against the pod.
    expect(sql.indexOf('LIMIT $3')).toBeLessThan(sql.indexOf('LEFT JOIN LATERAL'));
    expect(sql).toMatch(/FROM page p LEFT JOIN LATERAL/);
  });

  it('asks for one more person than the page holds, with the cursor as given and the pod as the target', async () => {
    await ask();
    expect(candidatesStatement().params).toEqual([VIEWER, null, 31, null, POD]);
    mockQuery.mockClear();
    await ask({ limit: 10, before: '2026-10-01T09:30:00.000Z' });
    expect(candidatesStatement().params).toEqual([VIEWER, '2026-10-01T09:30:00.000Z', 11, null, POD]);
  });

  it('works out where each person stands against a POD from its members and its latest invite to that address', async () => {
    await ask();
    const { sql } = candidatesStatement();
    expect(sql).toMatch(/WHEN EXISTS \(SELECT 1 FROM pod_members pm WHERE pm\.pod_id = \$5 AND pm\.user_id = p\.user_id AND pm\.status = 'active'\) THEN 'member'/);
    expect(sql).toMatch(/WHERE i\.type = 'pod' AND i\.pod_id = \$5 AND i\.invitee_email = p\.email ORDER BY i\.created_at DESC LIMIT 1/);
    expect(sql).toMatch(/WHEN li\.live THEN 'invited' WHEN li\.declined THEN 'declined' ELSE 'available' END AS state/);
  });

  it('works out where each person stands against an EVENT from its participants (not the removed or those who left) and its invites', async () => {
    await listInviteCandidates(member, { sessionId: EVENT, source: 'connections', before: null, limit: 30 });
    const { sql, params } = candidatesStatement();
    expect(sql).toMatch(/WHEN EXISTS \(SELECT 1 FROM session_participants sp WHERE sp\.session_id = \$5 AND sp\.user_id = p\.user_id AND sp\.status NOT IN \('removed', 'left'\)\) THEN 'going'/);
    expect(sql).toMatch(/WHERE i\.type = 'session' AND i\.session_id = \$5 AND i\.invitee_email = p\.email/);
    expect(params[4]).toBe(EVENT);
  });

  it('an invite counts as pending only while it can still be accepted, and as declined only when the latest one was declined', async () => {
    await ask();
    const { sql } = candidatesStatement();
    expect(sql).toMatch(/\(i\.status = 'pending' AND \(i\.expires_at IS NULL OR i\.expires_at > NOW\(\)\)\) AS live/);
    expect(sql).toMatch(/\(i\.declined_at IS NOT NULL\) AS declined/);
  });

  it('shows each person as the People page does (met, or connected), with their card and the state, and the invite behind invited and declined', async () => {
    candidateRows = [
      candidateRow(1, { met: true, since: new Date('2026-10-20T10:00:00.123Z'), state: 'available', avatar_url: 'https://a/1.png' }),
      candidateRow(2, { state: 'member' }),
      candidateRow(3, { state: 'invited', latest_invite_id: 'inv-3' }),
      candidateRow(4, { state: 'declined', latest_invite_id: 'inv-4' }),
      candidateRow(5, { state: 'available', latest_invite_id: 'inv-old' }),
      candidateRow(6, { state: 'going' }),
    ];
    const page = await ask();
    expect(page.items[0]).toEqual({
      userId: uid(1), displayName: 'Person 1', avatarUrl: 'https://a/1.png', jobTitle: 'Role 1', company: 'Company 1',
      how: 'met', since: '2026-10-20T10:00:00.123Z', state: 'available',
    });
    expect(page.items.map((i) => [i.how, i.state, i.inviteId])).toEqual([
      ['met', 'available', undefined],
      ['connected', 'member', undefined],
      ['connected', 'invited', 'inv-3'],
      ['connected', 'declined', 'inv-4'],
      // An old invite behind a person who is simply available again is not offered.
      ['connected', 'available', undefined],
      ['connected', 'going', undefined],
    ]);
    expect('inviteId' in page.items[0]).toBe(false);
  });

  it('never returns an email, even when the database row carries one', async () => {
    candidateRows = [candidateRow(1, { email: 'secret@example.com', state: 'invited', latest_invite_id: 'inv-1' })];
    const page = await ask();
    expect(JSON.stringify(page)).not.toMatch(/@|secret|email/i);
    // ...and the query hands the address to the state lookup only: the final columns do not select it.
    const { sql } = candidatesStatement();
    const columns = sql.slice(sql.lastIndexOf('SELECT p.user_id'), sql.indexOf(' FROM page p'));
    expect(columns).not.toMatch(/email/);
  });

  it('pages the way the People page does: a full page and one more means a next page', async () => {
    candidateRows = [
      candidateRow(1, { since: new Date('2026-10-20T10:00:00Z') }),
      candidateRow(2, { since: new Date('2026-10-19T10:00:00Z') }),
      candidateRow(3, { since: new Date('2026-10-18T10:00:00Z') }),
    ];
    const page = await ask({ limit: 2 });
    expect(page.items.map((i) => i.userId)).toEqual([uid(1), uid(2)]);
    expect(page.nextBefore).toBe('2026-10-19T10:00:00.000Z');
  });

  it('...and never ends a page between two people with the same time', async () => {
    candidateRows = [
      candidateRow(1, { since: new Date('2026-10-20T10:00:00Z') }),
      candidateRow(2, { since: new Date('2026-10-19T10:00:00Z') }),
      candidateRow(3, { since: new Date('2026-10-18T10:00:00Z') }),
      candidateRow(4, { since: new Date('2026-10-18T10:00:00Z') }),
    ];
    const page = await ask({ limit: 3 });
    expect(page.items.map((i) => i.userId)).toEqual([uid(1), uid(2)]);
    expect(page.nextBefore).toBe('2026-10-19T10:00:00.000Z');
  });

  it('nobody yet is an empty list with no next page', async () => {
    await expect(ask()).resolves.toEqual({ items: [], nextBefore: null });
  });

  describe('searching by name, title or company', () => {
    it('no search text is no search clause', async () => {
      await ask({ q: undefined });
      mockQuery.mockClear();
      await ask({ q: '   ' });
      const { sql, params } = candidatesStatement();
      expect(sql).not.toMatch(/ILIKE/);
      expect(params).toHaveLength(5);
    });

    it('every word has to match, each against the name, the title or the company, so "Cla" finds Claus and "founder harbor" finds a founder at Harbor', async () => {
      await ask({ q: '  Founder   Harbor ' });
      const { sql, params } = candidatesStatement();
      expect(params.slice(5)).toEqual(['%Founder%', '%Harbor%']);
      expect(sql).toContain('(u.display_name ILIKE $6 OR u.first_name ILIKE $6 OR u.last_name ILIKE $6 OR u.job_title ILIKE $6 OR u.company ILIKE $6)'
        + ' AND (u.display_name ILIKE $7 OR u.first_name ILIKE $7 OR u.last_name ILIKE $7 OR u.job_title ILIKE $7 OR u.company ILIKE $7)');
    });

    it('a % or an _ typed is the character itself, and what was typed is never in the SQL text', async () => {
      await ask({ q: "100%_x'; DROP TABLE users; --" });
      const { sql, params } = candidatesStatement();
      expect(params[5]).toBe('%100\\%\\_x\';%');
      expect(sql).not.toMatch(/DROP TABLE/);
    });

    it('stops at six words', async () => {
      await ask({ q: 'a b c d e f g h' });
      expect(candidatesStatement().params).toHaveLength(5 + 6);
    });

    it('searches inside the person\'s connections only: the clause is added to the same query, not to a wider one', async () => {
      await ask({ q: 'cla' });
      const { sql } = candidatesStatement();
      expect(sql.indexOf('FROM people pe')).toBeLessThan(sql.indexOf('ILIKE'));
      expect(sql.indexOf('ILIKE')).toBeLessThan(sql.indexOf('LIMIT $3'));
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// An event's pod
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('listInviteCandidates: the people in an event\'s pod', () => {
  const ask = (over: Record<string, unknown> = {}) =>
    listInviteCandidates(member, { sessionId: EVENT, source: 'pod', before: null, limit: 30, ...over } as Parameters<typeof listInviteCandidates>[1]);

  it('lists the active members of the pod the event lives in, with the event as the target', async () => {
    await ask();
    const { sql, params } = candidatesStatement();
    expect(sql).toMatch(/FROM pod_members pm JOIN users u ON u\.id = pm\.user_id WHERE pm\.pod_id = \$6 AND pm\.status = 'active'/);
    expect(params.slice(0, 6)).toEqual([VIEWER, null, 31, null, EVENT, EVENT_POD]);
    expect(sql).not.toContain('signals AS');
  });

  it('leaves out the member themself, inactive accounts, and anyone blocked in either direction', async () => {
    await ask();
    const { sql } = candidatesStatement();
    expect(sql).toMatch(/u\.id <> \$1 AND u\.status = 'active'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = u\.id\) OR \(b\.blocker_id = u\.id AND b\.blocked_id = \$1\)\)/);
  });

  it('pages newest member first by the time they joined, with the same cursor rule', async () => {
    await ask();
    const { sql } = candidatesStatement();
    expect(sql).toMatch(/date_trunc\('milliseconds', pm\.joined_at\) AS since/);
    expect(sql).toMatch(/\(\$2::timestamptz IS NULL OR date_trunc\('milliseconds', pm\.joined_at\) < \$2::timestamptz\)/);
    expect(sql).toMatch(/\(\$4::timestamptz IS NULL OR date_trunc\('milliseconds', pm\.joined_at\) = \$4::timestamptz\)/);
    expect(sql).toMatch(/ORDER BY date_trunc\('milliseconds', pm\.joined_at\) DESC, u\.id LIMIT \$3\)/);
  });

  it('states each against the EVENT, and every one of them says pod', async () => {
    candidateRows = [
      candidateRow(1, { state: 'going', since: new Date('2026-10-02T10:00:00Z') }),
      candidateRow(2, { state: 'invited', latest_invite_id: 'inv-2', since: new Date('2026-10-01T10:00:00Z') }),
    ];
    const page = await ask();
    expect(candidatesStatement().sql).toMatch(/i\.type = 'session' AND i\.session_id = \$5/);
    expect(page.items.map((i) => [i.how, i.state, i.inviteId, i.since])).toEqual([
      ['pod', 'going', undefined, '2026-10-02T10:00:00.000Z'],
      ['pod', 'invited', 'inv-2', '2026-10-01T10:00:00.000Z'],
    ]);
  });

  it('is searched the same way', async () => {
    await ask({ q: 'cla' });
    const { sql, params } = candidatesStatement();
    expect(params[6]).toBe('%cla%');
    expect(sql).toContain('u.display_name ILIKE $7');
  });

  it('carries no email', async () => {
    candidateRows = [candidateRow(1, { email: 'secret@example.com' })];
    expect(JSON.stringify(await ask())).not.toMatch(/@|secret/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// The batch
// ═════════════════════════════════════════════════════════════════════════════════════════════════
interface Standing {
  email: string;
  active?: boolean;
  blocked?: boolean;
  connected?: boolean;
  inPod?: boolean;
  state?: string;
  latestInviteId?: string | null;
}

describe('createInvitesBatch', () => {
  let standings: Map<string, Standing>;
  let available: { ids: string[]; total: number };
  let allowance: { max: number; sent: number };
  let world: ReturnType<typeof inviteWorld>;

  const batchAnswers: Answers = (text, params) => {
    if (/WITH wanted AS/.test(text)) {
      const wanted = params[1] as string[];
      return {
        rows: wanted.filter((id) => standings.has(id)).map((id) => {
          const s = standings.get(id)!;
          return {
            user_id: id, email: s.email, active: s.active ?? true, blocked: s.blocked ?? false,
            connected: s.connected ?? true, in_pod: s.inPod ?? false, state: s.state ?? 'available', latest_invite_id: s.latestInviteId ?? null,
          };
        }),
      };
    }
    if (/ROW_NUMBER\(\) OVER/.test(text)) return { rows: [{ total: available.total, ids: available.ids }] };
    if (/max_invites_per_day/.test(text)) return { rows: [{ max_invites_per_day: allowance.max }] };
    if (/COUNT\(\*\) as count FROM invites/.test(text)) return { rows: [{ count: String(allowance.sent) }] };
    if (/display_name AS "displayName" FROM users/.test(text)) return { rows: [{ displayName: 'Host User' }] };
    if (/SELECT name FROM pods/.test(text)) return { rows: [{ name: 'Reason circle' }] };
    if (/SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions/.test(text)) {
      return { rows: [{ title: 'Kickoff', scheduled_at: null, host_user_id: HOST, config: {}, event_format: 'video_meeting' }] };
    }
    if (/INSERT INTO notifications/.test(text)) return { rows: [{ id: 'notification-1', created_at: '2026-10-26T09:00:00.000Z' }] };
    if (/FROM session_cohosts/.test(text)) return { rows: cohosts.length > 0 ? [{ '?column?': 1 }] : [] };
    return undefined;
  };

  beforeEach(() => {
    standings = new Map();
    available = { ids: [], total: 0 };
    allowance = { max: 100, sent: 0 };
    world = inviteWorld({ answers: batchAnswers });
    mockQuery.mockImplementation(world.query);
    mockTransaction.mockImplementation(world.transaction);
    mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: VIEWER }));
  });

  const person = (n: number, over: Partial<Standing> = {}) => {
    standings.set(uid(n), { email: `person${n}@example.com`, ...over });
    return uid(n);
  };
  const podBatch = (ids: string[], over: Record<string, unknown> = {}) =>
    createInvitesBatch(member, { type: 'pod', podId: POD, inviteeUserIds: ids, ...over } as InviteBatchInput);
  const eventBatch = (ids: string[], over: Record<string, unknown> = {}) =>
    createInvitesBatch(member, { type: 'session', sessionId: EVENT, inviteeUserIds: ids, ...over } as InviteBatchInput);
  const outcomes = (r: Awaited<ReturnType<typeof createInvitesBatch>>) => r.results.map((x) => [x.userId, x.outcome]);

  // ── Who may send ─────────────────────────────────────────────────────────────────────────────
  describe('who may send', () => {
    it('a person who may not invite to the pod is refused for the whole request, and nothing is read about the people or written', async () => {
      mockGetPodById.mockResolvedValue(podRow({ allowMemberInvites: false }));
      mockGetMemberRole.mockResolvedValue('member');
      person(1);
      await expect(podBatch([uid(1)])).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
      expect(statementsMatching(/WITH wanted AS/)).toHaveLength(0);
      expect(world.invites).toHaveLength(0);
    });

    it('a stranger to the event is refused the same way', async () => {
      mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: HOST }));
      person(1);
      await expect(eventBatch([uid(1)])).rejects.toMatchObject({ statusCode: 403 });
      expect(world.invites).toHaveLength(0);
    });

    it('a co-host may send event invites', async () => {
      mockGetSessionById.mockResolvedValue(eventRow({ hostUserId: HOST }));
      cohosts = [VIEWER];
      person(1);
      const result = await eventBatch([uid(1)]);
      expect(outcomes(result)).toEqual([[uid(1), 'invited']]);
      expect(world.invites[0].inviterId).toBe(VIEWER);
    });

    it('an archived pod and a finished event are refused with 400', async () => {
      mockGetPodById.mockResolvedValue(podRow({ status: 'archived' }));
      await expect(podBatch([uid(1)])).rejects.toMatchObject({ statusCode: 400, code: 'POD_ARCHIVED' });
      mockGetSessionById.mockResolvedValue(eventRow({ status: 'completed', hostUserId: VIEWER }));
      await expect(eventBatch([uid(1)])).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ── One outcome per person ───────────────────────────────────────────────────────────────────
  describe('one outcome for each person', () => {
    it('a connection who is available is invited, and the invite is a real one: for that pod and address, one use, seven days', async () => {
      const id = person(1);
      const result = await podBatch([id]);
      expect(result.results).toEqual([{ userId: id, outcome: 'invited', inviteId: 'invite-1' }]);
      expect(world.invites).toHaveLength(1);
      expect(world.invites[0]).toMatchObject({ type: 'pod', podId: POD, sessionId: null, email: 'person1@example.com', inviterId: VIEWER, status: 'pending' });
      expect(world.invites[0].maxUses).toBe(1);
      const hours = (world.invites[0].expiresAt!.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(167);
      expect(hours).toBeLessThanOrEqual(168);
    });

    it('an event invite belongs to the event, not its pod, and has no expiry of its own (it ends with the event)', async () => {
      const id = person(1);
      await eventBatch([id]);
      expect(world.invites[0]).toMatchObject({ type: 'session', sessionId: EVENT, podId: null, expiresAt: null });
    });

    it('someone who is already in the pod is already_member, and nothing is sent', async () => {
      const id = person(1, { state: 'member' });
      expect(outcomes(await podBatch([id]))).toEqual([[id, 'already_member']]);
      expect(world.invites).toHaveLength(0);
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
    });

    it('someone already going to the event is already_going', async () => {
      const id = person(1, { state: 'going' });
      expect(outcomes(await eventBatch([id]))).toEqual([[id, 'already_going']]);
      expect(world.invites).toHaveLength(0);
    });

    it('someone with a live invite is already_invited, and the answer names that invite', async () => {
      const id = person(1, { state: 'invited', latestInviteId: 'inv-live' });
      const result = await podBatch([id]);
      expect(result.results).toEqual([{ userId: id, outcome: 'already_invited', inviteId: 'inv-live' }]);
      expect(world.invites).toHaveLength(0);
    });

    it('someone who declined can be invited again: the organiser decides, the server does not hold a no against them', async () => {
      const id = person(1, { state: 'declined', latestInviteId: 'inv-old' });
      expect(outcomes(await podBatch([id]))).toEqual([[id, 'invited']]);
    });

    it('a mix of people gets one outcome each, in the order asked, and the counts add up', async () => {
      const ids = [person(1), person(2, { state: 'member' }), person(3, { state: 'invited' }), person(4, { blocked: true }), person(5)];
      const result = await podBatch(ids);
      expect(outcomes(result)).toEqual([
        [ids[0], 'invited'], [ids[1], 'already_member'], [ids[2], 'already_invited'], [ids[3], 'not_allowed'], [ids[4], 'invited'],
      ]);
      expect(result.counts).toEqual({ invited: 2, already_member: 1, already_going: 0, already_invited: 1, not_allowed: 1, failed: 0 });
      expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(ids.length);
    });

    it('the counts always list every outcome, zero included', async () => {
      expect((await podBatch([person(1)])).counts).toEqual({ invited: 1, already_member: 0, already_going: 0, already_invited: 0, not_allowed: 0, failed: 0 });
    });
  });

  // ── Who may be invited ───────────────────────────────────────────────────────────────────────
  describe('who may be invited', () => {
    it.each([
      ['someone blocked, in either direction', { blocked: true }],
      ['an account that is not active', { active: false }],
      ['someone who is not their connection and not in the event\'s pod', { connected: false, inPod: false }],
    ])('%s is not_allowed, and is neither invited nor emailed', async (_who, over) => {
      const id = person(1, over);
      expect(outcomes(await eventBatch([id]))).toEqual([[id, 'not_allowed']]);
      expect(world.invites).toHaveLength(0);
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
    });

    it('an id that is no member at all is not_allowed too: nothing tells it apart from a block', async () => {
      const unknown = uid(99);
      expect(outcomes(await podBatch([unknown]))).toEqual([[unknown, 'not_allowed']]);
    });

    it('the member themself is not_allowed', async () => {
      standings.set(VIEWER, { email: 'me@example.com' });
      expect(outcomes(await podBatch([VIEWER]))).toEqual([[VIEWER, 'not_allowed']]);
    });

    it('for an event, a member of its pod may be invited without being a connection', async () => {
      const id = person(1, { connected: false, inPod: true });
      expect(outcomes(await eventBatch([id]))).toEqual([[id, 'invited']]);
    });

    it('for a pod, being in some pod is not enough: only a connection may be invited', async () => {
      const id = person(1, { connected: false, inPod: true });
      expect(outcomes(await podBatch([id]))).toEqual([[id, 'not_allowed']]);
    });

    it('an admin may invite any active member who has not blocked them or been blocked', async () => {
      const stranger = person(1, { connected: false, inPod: false });
      const blocked = person(2, { connected: false, blocked: true });
      const result = await createInvitesBatch(admin, { type: 'pod', podId: POD, inviteeUserIds: [stranger, blocked] });
      expect(outcomes(result)).toEqual([[stranger, 'invited'], [blocked, 'not_allowed']]);
    });

    it('a member who is already in the pod says already_member even when they are not the sender\'s connection: the organiser can see its members anyway', async () => {
      const id = person(1, { connected: false, state: 'member' });
      expect(outcomes(await podBatch([id]))).toEqual([[id, 'already_member']]);
    });

    it('but a stranger\'s pending invite is not told to a sender who has no business with them', async () => {
      const id = person(1, { connected: false, state: 'invited', latestInviteId: 'inv-secret' });
      const result = await podBatch([id]);
      expect(result.results).toEqual([{ userId: id, outcome: 'not_allowed' }]);
    });

    it('asks who each person is, to the sender and to the pod, in one question for the whole batch', async () => {
      const ids = [person(1), person(2), person(3)];
      await eventBatch(ids);
      const asked = statementsMatching(/WITH wanted AS/);
      expect(asked).toHaveLength(1);
      expect(asked[0].sql).toContain(flat(CONNECTION_SIGNALS_SQL));
      expect(asked[0].sql).toMatch(/EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = w\.id\) OR \(b\.blocker_id = w\.id AND b\.blocked_id = \$1\)\) AS blocked/);
      expect(asked[0].params).toEqual([VIEWER, ids, EVENT_POD, EVENT]);
    });

    it('for a pod target nobody counts as "in the pod" for the sake of being allowed', async () => {
      await podBatch([person(1)]);
      expect(statementsMatching(/WITH wanted AS/)[0].params).toEqual([VIEWER, [uid(1)], null, POD]);
    });
  });

  // ── The same person twice ────────────────────────────────────────────────────────────────────
  describe('one invite per person, however it is asked', () => {
    it('the same id twice in one batch is one invite and one answer', async () => {
      const id = person(1);
      const result = await podBatch([id, id, id.toUpperCase()]);
      expect(result.results).toHaveLength(1);
      expect(world.invites).toHaveLength(1);
      expect(result.counts.invited).toBe(1);
      expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    });

    it('two batches at the same moment that both name the same person make one invite: the second is told, plainly, they are already invited', async () => {
      const id = person(1);
      const [first, second] = await Promise.all([podBatch([id]), podBatch([id])]);
      expect(world.invites).toHaveLength(1);
      const answers = [first.results[0].outcome, second.results[0].outcome].sort();
      expect(answers).toEqual(['already_invited', 'invited']);
      // The one who lost the race is pointed at the invite that exists.
      const loser = first.results[0].outcome === 'already_invited' ? first : second;
      expect(loser.results[0].inviteId).toBe(world.invites[0].id);
      expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    });

    it('two overlapping batches make one invite for each person who is in both', async () => {
      const [a, b, c] = [person(1), person(2), person(3)];
      const [first, second] = await Promise.all([podBatch([a, b]), podBatch([b, c])]);
      expect(world.invites.map((i) => i.email).sort()).toEqual(['person1@example.com', 'person2@example.com', 'person3@example.com']);
      expect(first.counts.invited + second.counts.invited).toBe(3);
      expect(first.counts.already_invited + second.counts.already_invited).toBe(1);
    });

    it('the harness does see the race: without the lock the same two batches make two invites', async () => {
      world = inviteWorld({ honourLocks: false, answers: batchAnswers });
      mockQuery.mockImplementation(world.query);
      mockTransaction.mockImplementation(world.transaction);
      const id = person(1);
      await Promise.all([podBatch([id]), podBatch([id])]);
      expect(world.invites).toHaveLength(2);
    });

    it('the lock is the one POST /invites takes: type, target and address', async () => {
      await podBatch([person(1)]);
      expect(world.log.filter((entry) => entry.startsWith('lock:'))).toEqual(['lock:pod:' + POD + ':person1@example.com']);
    });
  });

  // ── The daily allowance ──────────────────────────────────────────────────────────────────────
  describe('the daily allowance', () => {
    it('a member with none left is told so for the whole request, in a sentence, and nothing is written', async () => {
      allowance = { max: 5, sent: 5 };
      await expect(podBatch([person(1)])).rejects.toMatchObject({
        statusCode: 429, code: 'INVITE_LIMIT_REACHED', message: 'You can send up to 5 invites per day. Try again tomorrow.',
      });
      expect(world.invites).toHaveLength(0);
    });

    it('but a batch of people who are all already invited needs no allowance', async () => {
      allowance = { max: 5, sent: 5 };
      const id = person(1, { state: 'invited' });
      expect(outcomes(await podBatch([id]))).toEqual([[id, 'already_invited']]);
    });

    it('invites up to the allowance and reports the rest as failed', async () => {
      allowance = { max: 5, sent: 3 };
      const ids = [person(1), person(2), person(3), person(4)];
      const result = await podBatch(ids);
      expect(outcomes(result)).toEqual([[ids[0], 'invited'], [ids[1], 'invited'], [ids[2], 'failed'], [ids[3], 'failed']]);
      expect(world.invites).toHaveLength(2);
    });

    it('an admin has no allowance, and is not asked about it', async () => {
      allowance = { max: 1, sent: 1 };
      const ids = [person(1), person(2)];
      const result = await createInvitesBatch(admin, { type: 'pod', podId: POD, inviteeUserIds: ids });
      expect(result.counts.invited).toBe(2);
      expect(statementsMatching(/max_invites_per_day/)).toHaveLength(0);
    });
  });

  // ── What the people receive ──────────────────────────────────────────────────────────────────
  describe('what each person is sent', () => {
    it('each invited person gets the email, and the bell if they are a member, pushed live', async () => {
      const ids = [person(1), person(2)];
      await podBatch(ids);
      expect(mockSendInviteEmail).toHaveBeenCalledTimes(2);
      const sent = mockSendInviteEmail.mock.calls.map((c) => c[0]).sort();
      expect(sent).toEqual(['person1@example.com', 'person2@example.com']);
      expect(mockSendInviteEmail.mock.calls[0][1]).toMatchObject({ inviterName: 'Host User', type: 'pod', targetName: 'Reason circle' });
      expect(String(mockSendInviteEmail.mock.calls[0][1].inviteUrl)).toMatch(/^http:\/\/localhost:5173\/invite\/[A-Za-z0-9]{12}$/);
      const notified = statementsMatching(/^INSERT INTO notifications/).map((s) => s.params[0]);
      expect(notified.sort()).toEqual([...ids].sort());
      for (const id of ids) {
        expect(mockEmit).toHaveBeenCalledWith(`user:${id}`, 'notification:new', expect.objectContaining({ type: 'pod_invite', podId: POD }));
        expect(mockEmit).toHaveBeenCalledWith(`user:${id}`, 'entity:changed', { entities: [`user:${id}:notifications`, `user:${id}:invites`] });
      }
    });

    it('looks up the sender, the pod and the event once for the whole batch, and never looks a member up by address', async () => {
      await eventBatch([person(1), person(2), person(3)]);
      expect(statementsMatching(/display_name AS "displayName" FROM users/)).toHaveLength(1);
      expect(statementsMatching(/SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions/)).toHaveLength(1);
      expect(statementsMatching(/SELECT id FROM users WHERE email/)).toHaveLength(0);
    });

    it('an email that cannot be sent does not undo the invite', async () => {
      mockSendInviteEmail.mockRejectedValueOnce(new Error('mail provider is down'));
      const id = person(1);
      expect(outcomes(await podBatch([id]))).toEqual([[id, 'invited']]);
      expect(world.invites).toHaveLength(1);
    });

    it('a person who cannot be invited is sent nothing at all', async () => {
      await podBatch([person(1, { blocked: true }), person(2, { state: 'member' })]);
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
      expect(statementsMatching(/^INSERT INTO notifications/)).toHaveLength(0);
    });
  });

  // ── When something goes wrong for one person ─────────────────────────────────────────────────
  describe('when one invite cannot be made', () => {
    it('that person is failed and the others still go out', async () => {
      const [a, b, c] = [person(1), person(2), person(3)];
      const original = world.transaction;
      let calls = 0;
      mockTransaction.mockImplementation(async (cb: Parameters<typeof original>[0]) => {
        calls += 1;
        if (calls === 2) throw new Error('connection reset');
        return original(cb);
      });
      const result = await podBatch([a, b, c]);
      expect(outcomes(result)).toEqual([[a, 'invited'], [b, 'failed'], [c, 'invited']]);
      expect(result.counts).toMatchObject({ invited: 2, failed: 1 });
    });
  });

  // ── Everyone in the pod ──────────────────────────────────────────────────────────────────────
  describe('everyone in the pod (allPodMembers)', () => {
    it('invites the pod\'s members who are not going, invited or declined yet, after the people named', async () => {
      const named = person(1, { connected: true });
      const [m1, m2] = [person(2, { connected: false, inPod: true }), person(3, { connected: false, inPod: true })];
      available = { ids: [m1, m2], total: 2 };
      const result = await eventBatch([named], { allPodMembers: true });
      expect(outcomes(result)).toEqual([[named, 'invited'], [m1, 'invited'], [m2, 'invited']]);
      expect(result.remaining).toBe(0);
      expect(world.invites).toHaveLength(3);
    });

    it('asks for the pod members from the event\'s pod, leaving out those already named, with room for what is left of the 50', async () => {
      const named = person(1);
      await eventBatch([named], { allPodMembers: true });
      const asked = statementsMatching(/ROW_NUMBER\(\) OVER/);
      expect(asked).toHaveLength(1);
      expect(asked[0].params).toEqual([VIEWER, EVENT_POD, [named], 49, EVENT]);
      expect(asked[0].sql).toMatch(/pm\.pod_id = \$2 AND pm\.status = 'active'/);
      expect(asked[0].sql).toMatch(/u\.status = 'active'/);
      expect(asked[0].sql).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = u\.id\)/);
      expect(asked[0].sql).toMatch(/NOT \(u\.id = ANY\(\$3::uuid\[\]\)\)/);
      expect(asked[0].sql).toMatch(/ELSE 'available' END = 'available'/);
    });

    it('never invites more than 50 at a time, and says how many more could be: the organiser asks again for the rest', async () => {
      const members = Array.from({ length: 49 }, (_, i) => person(100 + i, { connected: false, inPod: true }));
      available = { ids: members, total: 120 };
      const named = person(1);
      const result = await eventBatch([named], { allPodMembers: true });
      expect(result.results).toHaveLength(50);
      expect(result.counts.invited).toBe(50);
      expect(result.remaining).toBe(120 - 49);
    });

    it('is only asked for when it is asked for', async () => {
      const result = await eventBatch([person(1)]);
      expect(statementsMatching(/ROW_NUMBER\(\) OVER/)).toHaveLength(0);
      expect(result.remaining).toBeUndefined();
    });

    it('is for events: asked of a pod, it is refused before anything is read', async () => {
      await expect(podBatch([person(1)], { allPodMembers: true })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(mockGetPodById).not.toHaveBeenCalled();
    });

    it('may name nobody: the pod is the list', async () => {
      const m1 = person(2, { connected: false, inPod: true });
      available = { ids: [m1], total: 1 };
      const result = await eventBatch([], { allPodMembers: true });
      expect(outcomes(result)).toEqual([[m1, 'invited']]);
    });

    it('naming nobody and not asking for the pod is refused', async () => {
      await expect(eventBatch([])).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    });

    it('more than 50 people named is refused before anything is read', async () => {
      const many = Array.from({ length: 51 }, (_, i) => uid(i + 1));
      await expect(podBatch(many)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(mockGetPodById).not.toHaveBeenCalled();
    });

    it('a pod invite with no pod, or an event invite with no event, is refused before anything is read', async () => {
      await expect(createInvitesBatch(member, { type: 'pod', inviteeUserIds: [uid(1)] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(createInvitesBatch(member, { type: 'session', inviteeUserIds: [uid(1)] })).rejects.toMatchObject({ statusCode: 400 });
      expect(mockGetPodById).not.toHaveBeenCalled();
      expect(mockGetSessionById).not.toHaveBeenCalled();
    });
  });

  // ── What comes back ──────────────────────────────────────────────────────────────────────────
  describe('what comes back', () => {
    it('names the pod or event it fanned out for, so the route can tell the right screens once', async () => {
      const pod = await podBatch([person(1)]);
      expect(pod.target).toEqual({ podId: POD, sessionId: null });
      const event = await eventBatch([person(2)]);
      expect(event.target).toEqual({ podId: EVENT_POD, sessionId: EVENT });
    });

    it('never carries an email, an invite code or a link', async () => {
      const result = await podBatch([person(1), person(2, { state: 'invited', latestInviteId: 'inv-9' })]);
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/@|example\.com|\/invite\//);
      expect(Object.keys(result.results[0]).sort()).toEqual(['inviteId', 'outcome', 'userId']);
    });

    it('is the invite type the sender asked for', async () => {
      await podBatch([person(1)]);
      await eventBatch([person(2)]);
      expect(world.invites.map((i) => i.type)).toEqual([InviteType.POD, InviteType.SESSION]);
    });
  });
});
