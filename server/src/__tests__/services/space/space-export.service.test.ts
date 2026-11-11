// ─── An organiser's export: who may take it, what is read, and the access log (Shirley pilot S7; item 20, D6) ─────
// Who: a circle's owner and moderators, a pod's active director and hosts. Not a plain member, not a stranger, and not
// a platform admin who holds no such role. A private pod someone may not see answers its own 404. Fix round 1: an
// archived circle stays exportable by its owner and moderators; anyone else (a role-less admin too) gets 404 there.
// listArchivedCirclesIRan lists those circles for the Circles page. Each file is read and logged in one transaction, the organiser's role row held FOR SHARE, and the log row
// written before anything is handed back: a failed log write means no file. The reads never select an email, list
// only current members with active accounts and nobody blocked either way, and only the organiser's own posts.
// The SQL ran for real on PGlite for the task report; here the database is a stand-in that answers by statement.

const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: jest.fn(),
  transaction: (cb: (c: { query: typeof mockClientQuery }) => unknown) => cb({ query: mockClientQuery }),
  __esModule: true,
}));
const mockCanViewPod = jest.fn();
jest.mock('../../../services/pods/pod-access', () => ({ canViewPod: (...a: unknown[]) => mockCanViewPod(...a), __esModule: true }));

import {
  ARCHIVED_RUN_MAX, CIRCLE_EXPORT_REFUSED, EXPORT_LIMITS, POD_EXPORT_REFUSED, SPACE_EXPORT_ACTION, exportSpaceSection,
  listArchivedCirclesIRan,
} from '../../../services/space/space-export.service';
import { query } from '../../../db';
import { SPACE_EXPORT_SECTIONS, type SpaceExportSection, type SpaceKind } from '@rsn/shared';

const SPACE = 'c0000000-0000-4000-8000-000000000001';
const ME = 'a0000000-0000-4000-8000-000000000001';
const AT = new Date('2026-11-11T10:00:00Z');

interface World {
  exists?: boolean;
  archived?: boolean;
  role?: string | null;
  members?: number;
  auditFails?: boolean;
}

function world(w: World) {
  mockClientQuery.mockImplementation(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/^SELECT \(.*\) AS archived FROM (circles|pods) WHERE id = \$1$/.test(s.trim())) return { rows: w.exists === false ? [] : [{ archived: !!w.archived }] };
    if (/FOR SHARE$/.test(s.trim())) return { rows: w.role ? [{ role: w.role }] : [] };
    if (s.includes('INSERT INTO audit_log')) {
      if (w.auditFails) throw Object.assign(new Error('could not extend file'), { code: '53100' });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('AS joined_at') || s.includes('m.joined_at FROM')) {
      return { rows: Array.from({ length: w.members ?? 1 }, (_, i) => ({ name: `Member ${i}`, role: 'member', joined_at: AT })) };
    }
    if (s.includes('FROM circles c WHERE c.id = $1')) {
      return { rows: [{ name: 'Curious Humans', description: null, join_policy: 'closed', created_at: AT, members: 3, removed: 1 }] };
    }
    if (s.includes('FROM pods p WHERE p.id = $1')) {
      return { rows: [{ name: 'Curious 12', description: null, visibility: 'private', created_at: AT, pod_type: 'reason', status: 'active', rules: null, members: 2, former: 1 }] };
    }
    return { rows: [] };
  });
}
const run = () => mockClientQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());
const go = (kind: SpaceKind, section: SpaceExportSection = 'members', role = 'member') =>
  exportSpaceSection(kind, SPACE, section, { userId: ME, role }, AT);

beforeEach(() => {
  jest.clearAllMocks();
  mockCanViewPod.mockResolvedValue(true);
});

describe('who may export a circle', () => {
  it.each([['owner'], ['moderator']])('its %s: the file, logged first', async (role) => {
    world({ role });
    const file = await go('circle');
    expect(file.filename).toBe('reason-circle-members-2026-11-11.csv');
    const audit = mockClientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO audit_log'));
    expect(audit![1]).toEqual([ME, SPACE_EXPORT_ACTION, 'circle', SPACE, JSON.stringify({ section: 'members', rows: 1, role })]);
    // The log row is the last thing written in the transaction: nothing is read after it, and the file comes after it.
    expect(run()[run().length - 1]).toContain('INSERT INTO audit_log');
  });

  it.each([
    ['a plain member', 'member', 'member'],
    ['a stranger', null, 'member'],
    ['a super admin who holds no role in it', null, 'super_admin'],
    ['an admin who is a plain member of it', 'member', 'admin'],
  ])('%s: 403 in words, nothing read, nothing logged', async (_who, role, platformRole) => {
    world({ role });
    await expect(go('circle', 'members', platformRole)).rejects.toMatchObject({ statusCode: 403, message: CIRCLE_EXPORT_REFUSED });
    expect(run().some((s) => s.includes('INSERT INTO audit_log') || s.includes('joined_at'))).toBe(false);
  });

  it('a super admin who is one of its moderators may (the role decides, not the platform rank)', async () => {
    world({ role: 'moderator' });
    await expect(go('circle', 'space', 'super_admin')).resolves.toMatchObject({ filename: 'reason-circle-space-2026-11-11.csv' });
  });

  it('a missing circle: 404', async () => {
    world({ exists: false, role: 'owner' });
    await expect(go('circle')).rejects.toMatchObject({ statusCode: 404, message: "We couldn't find that circle." });
    // Found whether or not it is archived (fix round 1): only a missing circle is gone for everyone.
    expect(run()[0]).toBe('SELECT (archived_at IS NOT NULL) AS archived FROM circles WHERE id = $1');
  });

  it.each([['owner'], ['moderator']])('an ARCHIVED circle stays exportable by its %s, logged first, and says Archived', async (role) => {
    world({ archived: true, role });
    const file = await go('circle', 'space');
    expect(file.body).toContain('\r\nStatus,Archived\r\n');
    const audit = mockClientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO audit_log'));
    expect(audit![1]).toEqual([ME, SPACE_EXPORT_ACTION, 'circle', SPACE, JSON.stringify({ section: 'space', rows: file.rows, role })]);
  });

  it.each([
    ['a plain member', 'member', 'member'],
    ['a stranger', null, 'member'],
    ['a role-less super admin', null, 'super_admin'],
  ])('an archived circle answers %s 404, never 403 (its existence is not confirmed); nothing logged', async (_who, role, platformRole) => {
    world({ archived: true, role });
    await expect(go('circle', 'members', platformRole)).rejects.toMatchObject({ statusCode: 404, message: "We couldn't find that circle." });
    expect(run().some((s) => s.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it("a live circle's space.csv says Active", async () => {
    world({ role: 'owner' });
    expect((await go('circle', 'space')).body).toContain('\r\nStatus,Active\r\n');
  });

  it('the role row is held FOR SHARE, so a demotion waits until the file is written', async () => {
    world({ role: 'owner' });
    await go('circle');
    expect(run()[1]).toBe('SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR SHARE');
  });
});

describe('who may export a pod', () => {
  it.each([['director'], ['host']])('its active %s', async (role) => {
    world({ role });
    await expect(go('pod', 'events')).resolves.toMatchObject({ filename: 'reason-pod-events-2026-11-11.csv' });
    expect(run()[1]).toBe("SELECT role::text AS role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE");
  });

  it.each([
    ['a plain member', 'member', 'member'],
    ['a stranger to a public pod', null, 'member'],
    ['a super admin who is not in it', null, 'super_admin'],
  ])('%s: 403 in words', async (_who, role, platformRole) => {
    world({ role });
    await expect(go('pod', 'members', platformRole)).rejects.toMatchObject({ statusCode: 403, message: POD_EXPORT_REFUSED });
    expect(run().some((s) => s.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it('a private pod someone may not see: its own 404, before any transaction', async () => {
    mockCanViewPod.mockResolvedValueOnce(false);
    world({ role: null });
    await expect(go('pod')).rejects.toMatchObject({ statusCode: 404, message: "We couldn't find that pod." });
    expect(mockCanViewPod).toHaveBeenCalledWith(ME, SPACE, 'member');
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('removed or left (no active row): 403, as anyone without the role', async () => {
    world({ role: null });
    await expect(go('pod')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("the archived circles a member ran (the Circles page's way back to their export)", () => {
  it('lists only archived circles where the member is owner or moderator, newest archived first, bounded', async () => {
    (query as jest.Mock).mockResolvedValueOnce({ rows: [
      { id: 'c1', name: 'Curious Humans', archived_at: new Date('2026-11-10T09:00:00Z'), role: 'owner' },
      { id: 'c2', name: 'Old salon', archived_at: new Date('2026-10-01T09:00:00Z'), role: 'moderator' },
    ] });
    expect(await listArchivedCirclesIRan(ME)).toEqual([
      { id: 'c1', name: 'Curious Humans', archivedAt: '2026-11-10T09:00:00.000Z', myRole: 'owner' },
      { id: 'c2', name: 'Old salon', archivedAt: '2026-10-01T09:00:00.000Z', myRole: 'moderator' },
    ]);
    const [sql, params] = (query as jest.Mock).mock.calls[0];
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain("WHERE m.user_id = $1 AND m.role IN ('owner', 'moderator') AND c.archived_at IS NOT NULL");
    expect(flat).toContain(`ORDER BY c.archived_at DESC, c.id LIMIT ${ARCHIVED_RUN_MAX}`);
    expect(params).toEqual([ME]);
  });
});

describe('the access log decides', () => {
  it.each(SPACE_EXPORT_SECTIONS.map((s) => [s]))('%s: a failed log write refuses the file', async (section) => {
    world({ role: 'owner', auditFails: true });
    await expect(go('circle', section)).rejects.toThrow('could not extend file');
  });
});

describe('what each read takes, and what it never does', () => {
  const sqlOf = async (kind: SpaceKind, section: SpaceExportSection, pick: RegExp) => {
    world({ role: kind === 'circle' ? 'owner' : 'director' });
    await go(kind, section);
    const found = mockClientQuery.mock.calls.find((c) => pick.test(String(c[0]).replace(/\s+/g, ' ')));
    expect(found).toBeDefined();
    return { sql: String(found![0]).replace(/\s+/g, ' '), params: found![1] as unknown[] };
  };

  it.each([['circle'], ['pod']] as const)('%s members: name, role, joined; active accounts; current rows; nobody blocked either way; never an email', async (kind) => {
    const { sql, params } = await sqlOf(kind, 'members', /m\.joined_at FROM/);
    expect(sql).not.toMatch(/email|phone|timezone|intent|wants/i);
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = m.user_id) OR (b.blocker_id = m.user_id AND b.blocked_id = $2))');
    if (kind === 'pod') expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain(`LIMIT ${EXPORT_LIMITS.members + 1}`);
    expect(params).toEqual([SPACE, ME]);
  });

  it.each([['circle', 'circle_posts', 'circle_id'], ['pod', 'pod_posts', 'pod_id']] as const)(
    '%s posts: only the organiser\'s own, not deleted (a blocked member\'s post is never theirs)', async (kind, table, column) => {
      const { sql, params } = await sqlOf(kind, 'posts', new RegExp(`FROM ${table} p`));
      expect(sql).toContain(`WHERE p.${column} = $1 AND p.author_id = $2 AND p.deleted_at IS NULL`);
      expect(params).toEqual([SPACE, ME]);
    });

  it.each([['circle', 'circle_id'], ['pod', 'pod_id']] as const)('%s events: the ones the organiser may see, as counts', async (kind, column) => {
    const { sql } = await sqlOf(kind, 'events', /FROM sessions s/);
    expect(sql).toContain(`WHERE s.${column} = $1 AND`);
    expect(sql).toContain("(s.archived_at IS NULL AND (s.publication = 'published'");
    // What it selects (the visibility rule may look at an invite's address; nothing of anyone's is selected).
    expect(sql.slice(0, sql.indexOf('FROM sessions s'))).not.toMatch(/email|display_name|user_id AS/);
  });

  it('a circle names a private pod only to its active members', async () => {
    const { sql } = await sqlOf('circle', 'space', /FROM circle_pods cp JOIN pods p/);
    expect(sql).toContain("p.visibility::text NOT IN ('private', 'invite_only') OR EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active')");
  });

  it('a pod counts as former those who left or were removed, never a request turned down', async () => {
    const { sql } = await sqlOf('pod', 'space', /FROM pods p WHERE p\.id = \$1/);
    expect(sql).toContain("m.status = 'left' OR (m.status = 'removed' AND m.removal_kind IS DISTINCT FROM 'rejected')");
  });

  it('more members than one file holds: refused in words, not cut short', async () => {
    world({ role: 'owner', members: EXPORT_LIMITS.members + 1 });
    await expect(go('circle')).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/more members than one file can hold/) });
    expect(run().some((s) => s.includes('INSERT INTO audit_log'))).toBe(false);
  });
});
