// Everyone (10 Nov 2026): the browsable list of members. The database stand-in answers what Postgres would; the SQL
// is read for the rules it must hold (the real statement is run read-only against production before shipping).
import { readFileSync } from 'fs';
import { join } from 'path';
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import {
  listEveryone, likePattern, encodeCursor, decodeCursor, EVERYONE_PAGE, EVERYONE_PAGE_MAX,
} from '../../../services/people/everyone.service';
import { searchWord } from '../../../services/people/everyone.service';
import { PRIVATE_MEMBER_KEYS } from '../../../services/user/public-card';

const VIEWER = 'a0000000-0000-4000-8000-000000000001';
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
const sqlOf = () => flat(mockQuery.mock.calls[0][0]);
const paramsOf = () => mockQuery.mock.calls[0][1] as unknown[];

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n), display_name: `Person ${String(n).padStart(2, '0')}`, first_name: 'P', last_name: String(n), avatar_url: null,
  banner_updated_at: null, bio: null, company: null, job_title: null, industry: null, location: null, linkedin_url: null,
  languages: null, professional_role: null, expertise_text: null, what_i_can_help_with: null,
  sort_name: `person ${String(n).padStart(2, '0')}`, poke_status: null, poke_sent_by_owner: null, connected: false, met: false,
  ...extra,
});

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); });

describe('listEveryone: who is listed', () => {
  it('only active, onboarded members who kept "Show me in search and suggestions" on, never the viewer', async () => {
    await listEveryone(VIEWER);
    const sql = sqlOf();
    expect(sql).toMatch(/u\.id <> \$1/);
    expect(sql).toMatch(/u\.status = 'active'/);
    expect(sql).toMatch(/u\.onboarding_completed = true/);
    expect(sql).toMatch(/u\.profile_visible = true/);
  });

  it('leaves out anyone blocked, in either direction', async () => {
    await listEveryone(VIEWER);
    expect(sqlOf()).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = u\.id\) OR \(b\.blocker_id = u\.id AND b\.blocked_id = \$1\)\)/);
  });

  it('reads a request between the two in both directions, live ones only (pending or accepted)', async () => {
    await listEveryone(VIEWER);
    const sql = sqlOf();
    expect(sql).toMatch(/p2\.status IN \('pending', 'accepted'\)/);
    expect(sql).toMatch(/\(p2\.sender_id = \$1 AND p2\.recipient_id = u\.id\) OR \(p2\.sender_id = u\.id AND p2\.recipient_id = \$1\)/);
    expect(sql).toMatch(/pk\.status AS poke_status, \(pk\.sender_id = \$1\) AS poke_sent_by_owner/);
  });

  it('reads connections from the one shared definition', async () => {
    await listEveryone(VIEWER);
    expect(sqlOf()).toMatch(/WITH signals AS/);
    expect(sqlOf()).toMatch(/LEFT JOIN people pe ON pe\.person_id = u\.id/);
  });
});

describe('listEveryone: order and paging', () => {
  it('A to Z by lower-cased name with the id as tiebreak, on a keyset', async () => {
    await listEveryone(VIEWER);
    const sql = sqlOf();
    expect(sql).toMatch(/ORDER BY lower\(COALESCE\(u\.display_name, ''\)\), u\.id LIMIT \$5/);
    expect(sql).toMatch(/\(lower\(COALESCE\(u\.display_name, ''\)\), u\.id\) > \(\$3::text, \$4::uuid\)/);
  });

  it('asks for one more than a page and hands out a cursor only when there is more', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1), row(2), row(3)] });
    const first = await listEveryone(VIEWER, { limit: 2 });
    expect(paramsOf()[4]).toBe(3);
    expect(first.people.map((p) => p.id)).toEqual([id(1), id(2)]);
    expect(decodeCursor(first.nextCursor as string)).toEqual({ n: 'person 02', id: id(2) });

    mockQuery.mockResolvedValueOnce({ rows: [row(3)] });
    const second = await listEveryone(VIEWER, { limit: 2, cursor: first.nextCursor as string });
    const p = mockQuery.mock.calls[1][1] as unknown[];
    expect(p[2]).toBe('person 02');
    expect(p[3]).toBe(id(2));
    expect(second.people.map((x) => x.id)).toEqual([id(3)]);
    expect(second.nextCursor).toBeNull();
  });

  it('defaults to 30 and never more than 50', async () => {
    await listEveryone(VIEWER);
    expect(paramsOf()[4]).toBe(EVERYONE_PAGE + 1);
    mockQuery.mockClear();
    await listEveryone(VIEWER, { limit: 500 });
    expect(paramsOf()[4]).toBe(EVERYONE_PAGE_MAX + 1);
  });

  it('refuses a cursor that is not one of ours', async () => {
    await expect(listEveryone(VIEWER, { cursor: 'nonsense' })).rejects.toThrow(/no longer available/);
    const bad = Buffer.from(JSON.stringify({ n: 'x', id: 'not-a-uuid; DROP TABLE users;--' })).toString('base64url');
    await expect(listEveryone(VIEWER, { cursor: bad })).rejects.toThrow(/no longer available/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a cursor round-trips names with any characters', () => {
    const name = 'zoe "o\'brien" 100%';
    expect(decodeCursor(encodeCursor(name, id(9)))).toEqual({ n: name, id: id(9) });
  });
});

describe('listEveryone: search', () => {
  it('matches name, company, job title and role, case-insensitively', async () => {
    await listEveryone(VIEWER, { q: 'Acme' });
    const sql = sqlOf();
    for (const col of ['u.display_name', 'u.company', 'u.job_title', "array_to_string(u.professional_role, ' ')"]) {
      expect(sql).toContain(`${col} ILIKE $2::text`);
    }
    expect(paramsOf()[1]).toBe('%Acme%');
  });

  it('matches % and _ literally', () => {
    expect(likePattern('100%_a\\b')).toBe('%100\\%\\_a\\\\b%');
  });

  it('a blank search lists everyone', async () => {
    await listEveryone(VIEWER, { q: '   ' });
    expect(paramsOf()[1]).toBeNull();
  });
});

describe('listEveryone: what each row says', () => {
  it('request state per row, from the viewer side, and nothing for no request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row(1),
      row(2, { poke_status: 'pending', poke_sent_by_owner: true }),
      row(3, { poke_status: 'pending', poke_sent_by_owner: false }),
      row(4, { poke_status: 'accepted', poke_sent_by_owner: false, connected: true }),
    ] });
    const { people } = await listEveryone(VIEWER);
    expect(people.map((p) => [p.pokeStatus, p.pokeSentByOwner, p.relationship])).toEqual([
      [null, null, 'none'], ['pending', true, 'requested'], ['pending', false, 'incoming'], ['accepted', false, 'connected'],
    ]);
  });

  it('an old row: someone met at an event or in a 1:1 call is met; a conversation alone is connected', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1, { connected: true, met: true }), row(2, { connected: true })] });
    const { people } = await listEveryone(VIEWER);
    expect(people.map((p) => p.relationship)).toEqual(['met', 'connected']);
  });

  it('carries the public card only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1, { company: 'Acme', professional_role: ['Founder'] })] });
    const { people } = await listEveryone(VIEWER);
    expect(people[0].company).toBe('Acme');
    expect(people[0].professionalRole).toEqual(['Founder']);
    for (const key of Object.keys(people[0])) expect(PRIVATE_MEMBER_KEYS.has(key)).toBe(false);
    expect(sqlOf()).not.toMatch(/u\.email|who_i_want|my_intent|u\.phone/);
  });
});

describe('listEveryone: a NUL character is a 400, never a database error', () => {
  const NUL = String.fromCharCode(0);

  it('a cursor whose name holds one is refused before any SQL', async () => {
    const forged = Buffer.from(JSON.stringify({ n: `a${NUL}b`, id: id(1) })).toString('base64url');
    await expect(listEveryone(VIEWER, { cursor: forged })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a search word that holds one is refused by the route schema and by the service', async () => {
    expect(searchWord.safeParse(`a${NUL}b`).success).toBe(false);
    expect(searchWord.safeParse('Acme').success).toBe(true);
    await expect(listEveryone(VIEWER, { q: `a${NUL}b` })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('the route refuses a cursor that holds one too', () => {
    const route = readFileSync(join(__dirname, '../../../routes/people.ts'), 'utf8');
    expect(route).toContain("cursor: z.string().min(1).max(600).refine((c) => !c.includes('\\u0000')).optional()");
    expect(route).toContain('q: everyone.searchWord.optional()');
  });
});

describe('listEveryone: a declined request', () => {
  it('reads declined to its sender, and still none to the one who declined it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1, { declined_by_them: true }), row(2, { declined_by_them: false })] });
    const { people } = await listEveryone(VIEWER);
    expect(people.map((p) => p.relationship)).toEqual(['declined', 'none']);
    expect(sqlOf()).toMatch(/d\.sender_id = \$1 AND d\.recipient_id = u\.id AND d\.status = 'declined'/);
  });

  it('a live request or a connection outranks an old decline', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row(1, { declined_by_them: true, poke_status: 'pending', poke_sent_by_owner: true }),
      row(2, { declined_by_them: true, connected: true }),
    ] });
    const { people } = await listEveryone(VIEWER);
    expect(people.map((p) => p.relationship)).toEqual(['requested', 'connected']);
  });
});

describe('the supporting index', () => {
  it('migration 143 matches the ORDER BY expression and the WHERE of the list', () => {
    const sql = readFileSync(join(__dirname, '../../../db/migrations/143_everyone_name_index.sql'), 'utf8')
      .split(/\r?\n/).filter((l) => !l.startsWith('--')).join(' ');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_users_everyone_name\s+ON users \(\(lower\(COALESCE\(display_name, ''\)\)\), id\)/);
    expect(sql).toMatch(/WHERE status = 'active' AND onboarding_completed = true AND profile_visible = true;/);
    expect(sql).not.toMatch(/CONCURRENTLY|^\s*(BEGIN|COMMIT)/im);
  });
});
