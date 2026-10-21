// "Your connections" (21 Oct 2026): everyone the member is connected to or has met, one row per person, newest
// first, a page at a time. The database stand-in answers what Postgres would; the SQL is read for the rules it
// must hold, and the paging is run.
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { listConnections } from '../../../services/people/connections.service';

const VIEWER = 'a0000000-0000-4000-8000-000000000001';
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (iso: string) => new Date(iso);

/** A row as the query returns it. */
const row = (n: number, since: string, met = false) => ({
  user_id: id(n), display_name: `Person ${n}`, avatar_url: null, job_title: `Role ${n}`, company: null, met, since: at(since),
});

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
const sqlOf = (call = 0) => flat(mockQuery.mock.calls[call][0]);
const paramsOf = (call = 0) => mockQuery.mock.calls[call][1] as unknown[];

beforeEach(() => mockQuery.mockReset());

describe('listConnections: what counts as a connection', () => {
  beforeEach(() => mockQuery.mockResolvedValue({ rows: [] }));

  it('connected: a meeting request accepted in either direction, or a conversation between the two', async () => {
    await listConnections(VIEWER, { limit: 30, before: null });
    const sql = sqlOf();
    expect(sql).toMatch(/FROM user_pokes p WHERE \(p\.sender_id = \$1 OR p\.recipient_id = \$1\) AND p\.status = 'accepted'/);
    expect(sql).toMatch(/FROM dm_conversations c WHERE \(?c\.user_a_id = \$1 OR c\.user_b_id = \$1\)?/);
  });

  it('met: an event meeting (an accepted request seeds a row with no meeting in it, and that row is not one), or a 1:1 meeting both joined', async () => {
    await listConnections(VIEWER, { limit: 30, before: null });
    const sql = sqlOf();
    // The Human Profile's own reading of a meeting (person-brief.service.ts).
    expect(sql).toMatch(/FROM encounter_history e WHERE \(e\.user_a_id = \$1 OR e\.user_b_id = \$1\) AND \(e\.times_met > 0 OR e\.last_session_id IS NOT NULL\)/);
    expect(sql).toMatch(/c\.meeting_joined_a_at IS NOT NULL AND c\.meeting_joined_b_at IS NOT NULL/);
  });

  it('one row per person: met if they ever met, at the latest date of anything between them, to the millisecond a cursor can carry', async () => {
    await listConnections(VIEWER, { limit: 30, before: null });
    const sql = sqlOf();
    expect(sql).toMatch(/bool_or\(met\) AS met/);
    expect(sql).toMatch(/date_trunc\('milliseconds', MAX\(at\)\) AS since/);
    expect(sql).toMatch(/GROUP BY person_id/);
  });

  it('leaves out the member themself, anyone blocked in either direction, and every account that is not active', async () => {
    await listConnections(VIEWER, { limit: 30, before: null });
    const sql = sqlOf();
    expect(sql).toMatch(/u\.id <> \$1/);
    expect(sql).toMatch(/u\.status = 'active'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = u\.id\) OR \(b\.blocker_id = u\.id AND b\.blocked_id = \$1\)\)/);
  });

  it('newest first, older than the cursor when there is one, a page of people at a time', async () => {
    await listConnections(VIEWER, { limit: 30, before: null });
    const sql = sqlOf();
    expect(sql).toMatch(/\(\$2::timestamptz IS NULL OR pe\.since < \$2::timestamptz\)/);
    expect(sql).toMatch(/ORDER BY pe\.since DESC, u\.id LIMIT \$3$/);
    // The filters come before the grouping is read, and the limit counts people.
    expect(sql.indexOf('GROUP BY person_id')).toBeLessThan(sql.indexOf('ORDER BY pe.since DESC'));
  });

  it('asks about the member who is looking, with the cursor as given, and one more person than the page holds', async () => {
    await listConnections(VIEWER, { limit: 30, before: null });
    expect(paramsOf()).toEqual([VIEWER, null, 31, null]);
    mockQuery.mockClear();
    await listConnections(VIEWER, { limit: 10, before: '2026-10-01T09:30:00.000Z' });
    expect(paramsOf()).toEqual([VIEWER, '2026-10-01T09:30:00.000Z', 11, null]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('listConnections: the answer', () => {
  it('nobody yet is an empty list with no next page', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(listConnections(VIEWER, { limit: 30, before: null })).resolves.toEqual({ items: [], nextBefore: null });
  });

  it('carries each person\'s card and how the two know each other, newest first as the database sorted them', async () => {
    mockQuery.mockResolvedValue({ rows: [
      { user_id: id(1), display_name: 'Sarah Chen', avatar_url: 'https://a/s.png', job_title: 'Founder', company: 'Harbor', met: true, since: at('2026-10-20T08:00:00.123Z') },
      { user_id: id(2), display_name: 'Omar Haq', avatar_url: null, job_title: null, company: null, met: false, since: at('2026-10-19T08:00:00.000Z') },
    ] });
    expect(await listConnections(VIEWER, { limit: 30, before: null })).toEqual({
      items: [
        { userId: id(1), displayName: 'Sarah Chen', avatarUrl: 'https://a/s.png', jobTitle: 'Founder', company: 'Harbor', how: 'met', since: '2026-10-20T08:00:00.123Z' },
        { userId: id(2), displayName: 'Omar Haq', avatarUrl: null, jobTitle: null, company: null, how: 'connected', since: '2026-10-19T08:00:00.000Z' },
      ],
      nextBefore: null,
    });
  });

  it('a full page and nothing more: no next page', async () => {
    mockQuery.mockResolvedValue({ rows: [row(1, '2026-10-20T10:00:00Z'), row(2, '2026-10-19T10:00:00Z')] });
    const page = await listConnections(VIEWER, { limit: 2, before: null });
    expect(page.items.map((i) => i.userId)).toEqual([id(1), id(2)]);
    expect(page.nextBefore).toBeNull();
  });

  it('more than a page: the page holds the limit, and the next one starts after its last person', async () => {
    mockQuery.mockResolvedValue({ rows: [row(1, '2026-10-20T10:00:00Z'), row(2, '2026-10-19T10:00:00Z'), row(3, '2026-10-18T10:00:00Z')] });
    const page = await listConnections(VIEWER, { limit: 2, before: null });
    expect(page.items.map((i) => i.userId)).toEqual([id(1), id(2)]);
    expect(page.nextBefore).toBe('2026-10-19T10:00:00.000Z');
  });
});

// The cursor is a time and the next page asks for people BEFORE it, so a page that ended between two people with
// the same time would lose the second one for good.
describe('listConnections: a page never ends between two people with the same time', () => {
  it('people who share the time of the first person past the page wait for the next page, all together', async () => {
    mockQuery.mockResolvedValue({ rows: [
      row(1, '2026-10-20T10:00:00Z'), row(2, '2026-10-19T10:00:00Z'), row(3, '2026-10-18T10:00:00Z'), row(4, '2026-10-18T10:00:00Z'),
    ] });
    const page = await listConnections(VIEWER, { limit: 3, before: null });
    expect(page.items.map((i) => i.userId)).toEqual([id(1), id(2)]);
    expect(page.nextBefore).toBe('2026-10-19T10:00:00.000Z');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('...and the next page, asked for before that time, is where they are', async () => {
    mockQuery.mockResolvedValue({ rows: [row(3, '2026-10-18T10:00:00Z'), row(4, '2026-10-18T10:00:00Z')] });
    const next = await listConnections(VIEWER, { limit: 3, before: '2026-10-19T10:00:00.000Z' });
    expect(next.items.map((i) => i.userId)).toEqual([id(3), id(4)]);
    expect(next.nextBefore).toBeNull();
  });

  it('more people than a page at one moment: the page is all of them, read in one more question, and the next starts before that moment', async () => {
    const moment = '2026-10-18T10:00:00.000Z';
    mockQuery
      .mockResolvedValueOnce({ rows: [row(1, moment), row(2, moment), row(3, moment)] })
      .mockResolvedValueOnce({ rows: [row(1, moment), row(2, moment), row(3, moment), row(4, moment)] });
    const page = await listConnections(VIEWER, { limit: 2, before: '2026-10-21T00:00:00.000Z' });
    expect(page.items.map((i) => i.userId)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(page.nextBefore).toBe(moment);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    // The same question, for that one moment only: the member, the cursor, a bounded count, and the moment.
    expect(sqlOf(1)).toBe(sqlOf(0));
    expect(sqlOf(1)).toMatch(/\(\$4::timestamptz IS NULL OR pe\.since = \$4::timestamptz\)/);
    const [viewer, before, cap, when] = paramsOf(1);
    expect([viewer, before, when]).toEqual([VIEWER, '2026-10-21T00:00:00.000Z', moment]);
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(2);
  });
});
