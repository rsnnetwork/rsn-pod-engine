// ─── A profile's Communities (Shirley pilot S3, brief RSN 14) ────────────────────────────────────────────────────
// The rules that decide which spaces a viewer is shown and which button each row gets. The SQL itself ran for real on
// PGlite against every migration (the S3 report); here it is pinned by what it must say, and the service by what it
// does with the rows the database answers.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
const mockBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({ areBlocked: (...a: unknown[]) => mockBlocked(...a), __esModule: true }));

import {
  COMMUNITIES_OFFSET_MAX, COMMUNITIES_PAGE, COMMUNITIES_PAGE_MAX, COMMUNITIES_SQL, actionFor, getOwnCommunitiesPreview,
  getProfileCommunities, hiddenReason,
} from '../../../services/people/communities.service';
import { AppError, NotFoundError } from '../../../middleware/errors';

const VIEWER = 'a0000000-0000-4000-8000-000000000001';
const TARGET = 'b0000000-0000-4000-8000-000000000002';
const SQL = COMMUNITIES_SQL.replace(/\s+/g, ' ');

type Target = { status: string; account_kind: string | null; profile_visible: boolean; show_communities: boolean };
const OPEN_TARGET: Target = { status: 'active', account_kind: 'member', profile_visible: true, show_communities: true };

interface TestRow {
  kind: 'circle' | 'pod'; id: string; name: string; role: string; access: 'open' | 'approval' | 'members';
  viewer_member: boolean; viewer_pending: boolean; viewer_removed: boolean; has_rules: boolean; total: number;
}
function row(o: Partial<TestRow> = {}): TestRow {
  return {
    kind: 'pod', id: 'p1', name: 'Curious 12', role: 'member', access: 'open',
    viewer_member: false, viewer_pending: false, viewer_removed: false, has_rules: false, total: 1, ...o,
  };
}

function arm(o: { blocked?: boolean; target?: Target | null; rows?: unknown[] } = {}) {
  mockQuery.mockReset();
  mockBlocked.mockResolvedValue(!!o.blocked);
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM users WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: o.target === null ? [] : [o.target ?? OPEN_TARGET] });
    if (sql === COMMUNITIES_SQL) return Promise.resolve({ rows: o.rows ?? [] });
    return Promise.reject(new Error(`unexpected query: ${sql.slice(0, 80)}`));
  });
}
const listCalls = () => mockQuery.mock.calls.filter(([sql]) => sql === COMMUNITIES_SQL);

describe('the SQL: which spaces a viewer may be shown', () => {
  it('a circle only when it is open, or the viewer is in it; never an archived one', () => {
    expect(SQL).toContain("JOIN circles c ON c.id = cm.circle_id AND c.archived_at IS NULL");
    expect(SQL).toContain("WHERE cm.user_id = $2 AND (c.join_policy = 'open' OR vm.user_id IS NOT NULL)");
    expect(SQL).toContain('LEFT JOIN circle_members vm ON vm.circle_id = c.id AND vm.user_id = $1');
  });

  it("a pod only while active, the person's own row active, and discoverable or shared with the viewer (active)", () => {
    expect(SQL).toContain("JOIN pods p ON p.id = pm.pod_id AND p.status::text = 'active'");
    expect(SQL).toContain("WHERE pm.user_id = $2 AND pm.status::text = 'active'");
    expect(SQL).toContain("AND (p.visibility::text IN ('public', 'public_with_approval') OR vm.status::text = 'active')");
    // An old 'invite_only' row is private: it is neither of the two discoverable settings, so only a member sees it.
    expect(SQL).not.toMatch(/invite_only/);
  });

  it("reads the viewer's waiting ask, removal and the pod's rules; counts every row; organisers first; one page", () => {
    expect(SQL).toContain("r.user_id = $1 AND r.status = 'pending'");
    expect(SQL).toContain('FROM circle_removals x WHERE x.circle_id = c.id AND x.user_id = $1');
    expect(SQL).toContain("vm.removal_kind = 'removed'");
    expect(SQL).toContain("p.join_config->>'rulesText'");
    expect(SQL).toContain("p.join_config->>'agreementText'");
    expect(SQL).toContain('count(*) OVER ()::int AS total');
    expect(SQL).toMatch(/ORDER BY CASE WHEN role IN \('owner', 'director'\) THEN 0 WHEN role IN \('moderator', 'host'\) THEN 1 ELSE 2 END, kind, lower\(name\), id/);
    expect(SQL).toContain('LIMIT $3 OFFSET $4');
  });

  it('every value is a parameter: nothing a member types is put into the text', () => {
    expect(SQL).not.toMatch(/\$\{/);
  });
});

describe('the button each row gets (actionFor)', () => {
  const r = (o: Parameters<typeof row>[0]) => row(o);
  it('in it: open, whatever the space', () => {
    expect(actionFor(r({ viewer_member: true, access: 'members' }), false)).toBe('open');
    expect(actionFor(r({ viewer_member: true, access: 'approval', viewer_pending: true }), false)).toBe('open');
  });
  it('an approval pod: request, or pending while their ask waits; a removed person may ask again (S2)', () => {
    expect(actionFor(r({ access: 'approval' }), false)).toBe('request');
    expect(actionFor(r({ access: 'approval', viewer_pending: true }), false)).toBe('pending');
    expect(actionFor(r({ access: 'approval', viewer_removed: true }), false)).toBe('request');
  });
  it('an open circle or a Public open pod: join, never for someone an organiser removed (admins exempt)', () => {
    expect(actionFor(r({ access: 'open' }), false)).toBe('join');
    expect(actionFor(r({ kind: 'circle', access: 'open' }), false)).toBe('join');
    expect(actionFor(r({ access: 'open', viewer_removed: true }), false)).toBe('none');
    expect(actionFor(r({ kind: 'circle', access: 'open', viewer_removed: true }), false)).toBe('none');
    expect(actionFor(r({ access: 'open', viewer_removed: true }), true)).toBe('join');
    // A waiting ask on a space that is open now is let in by joining.
    expect(actionFor(r({ access: 'open', viewer_pending: true }), false)).toBe('join');
  });
  it('a members-only row for someone not in it gets nothing (the SQL never sends one)', () => {
    expect(actionFor(r({ access: 'members' }), false)).toBe('none');
  });
});

describe('getProfileCommunities', () => {
  it('your own id is a 400 (your own read is the preview), and nothing is read', async () => {
    arm();
    await expect(getProfileCommunities(VIEWER, 'member', VIEWER)).rejects.toBeInstanceOf(AppError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a block either way is the unknown-member 404, before the person is even read', async () => {
    arm({ blocked: true, rows: [row()] });
    await expect(getProfileCommunities(VIEWER, 'member', TARGET)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockBlocked).toHaveBeenCalledWith(VIEWER, TARGET);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an unknown, closed, suspended or banned account is the same 404', async () => {
    for (const target of [null, { ...OPEN_TARGET, status: 'deactivated' }, { ...OPEN_TARGET, status: 'suspended' }, { ...OPEN_TARGET, status: 'banned' }]) {
      arm({ target, rows: [row()] });
      await expect(getProfileCommunities(VIEWER, 'member', TARGET)).rejects.toBeInstanceOf(NotFoundError);
      expect(listCalls()).toHaveLength(0);
    }
  });

  it('nothing, and no list read, when they turned the setting off, are hidden from search, or are an event guest', async () => {
    for (const target of [
      { ...OPEN_TARGET, show_communities: false },
      { ...OPEN_TARGET, profile_visible: false },
      { ...OPEN_TARGET, account_kind: 'event_guest' },
    ]) {
      arm({ target, rows: [row()] });
      const out = await getProfileCommunities(VIEWER, 'member', TARGET);
      expect(out).toEqual({ items: [], total: 0, nextOffset: null });
      // Never says why to anyone else.
      expect(out).not.toHaveProperty('hidden');
      expect(listCalls()).toHaveLength(0);
    }
  });

  it('reads the page for this viewer and this person, and maps each row with its button', async () => {
    arm({ rows: [
      row({ kind: 'circle', id: 'c1', name: 'Curious Humans', role: 'owner', access: 'open', total: 3 }),
      row({ id: 'p1', name: 'Curious 12', role: 'director', access: 'approval', has_rules: true, total: 3 }),
      row({ id: 'p2', name: 'Human Edge', role: 'member', access: 'members', viewer_member: true, total: 3 }),
    ] });
    const out = await getProfileCommunities(VIEWER, 'member', TARGET);
    expect(listCalls()[0][1]).toEqual([VIEWER, TARGET, COMMUNITIES_PAGE, 0]);
    expect(out.total).toBe(3);
    expect(out.nextOffset).toBeNull();
    expect(out.items).toEqual([
      { kind: 'circle', id: 'c1', name: 'Curious Humans', role: 'owner', access: 'open', action: 'join', hasJoinRules: false },
      { kind: 'pod', id: 'p1', name: 'Curious 12', role: 'director', access: 'approval', action: 'request', hasJoinRules: true },
      { kind: 'pod', id: 'p2', name: 'Human Edge', role: 'member', access: 'members', action: 'open', hasJoinRules: false },
    ]);
    // Only these keys leave the server: no member counts, no ids of anyone else, no visibility words.
    for (const item of out.items) expect(Object.keys(item).sort()).toEqual(['access', 'action', 'hasJoinRules', 'id', 'kind', 'name', 'role']);
  });

  it('an unknown role reads as member', async () => {
    arm({ rows: [row({ role: 'weird' })] });
    expect((await getProfileCommunities(VIEWER, 'member', TARGET)).items[0].role).toBe('member');
  });

  it('pages: 50 spaces come 8, then on from the offset; the size is clamped to 1..50 and the offset to 0..1000', async () => {
    arm({ rows: Array.from({ length: 8 }, (_, i) => row({ id: `p${i}`, total: 50 })) });
    let out = await getProfileCommunities(VIEWER, 'member', TARGET);
    expect(out.items).toHaveLength(8);
    expect(out.nextOffset).toBe(8);
    arm({ rows: Array.from({ length: 42 }, (_, i) => row({ id: `q${i}`, total: 50 })) });
    out = await getProfileCommunities(VIEWER, 'member', TARGET, { limit: 50, offset: 8 });
    expect(listCalls()[0][1]).toEqual([VIEWER, TARGET, 50, 8]);
    expect(out.nextOffset).toBeNull();
    arm({ rows: [] });
    await getProfileCommunities(VIEWER, 'member', TARGET, { limit: 5000, offset: 999999 });
    expect(listCalls()[0][1]).toEqual([VIEWER, TARGET, COMMUNITIES_PAGE_MAX, COMMUNITIES_OFFSET_MAX]);
    arm({ rows: [] });
    await getProfileCommunities(VIEWER, 'member', TARGET, { limit: 0, offset: -3 });
    expect(listCalls()[0][1]).toEqual([VIEWER, TARGET, 1, 0]);
  });

  it('a platform admin sees exactly what a member sees (the same read), and only a removal no longer holds them back', async () => {
    arm({ rows: [row({ access: 'open', viewer_removed: true })] });
    expect((await getProfileCommunities(VIEWER, 'member', TARGET)).items[0].action).toBe('none');
    arm({ rows: [row({ access: 'open', viewer_removed: true })] });
    expect((await getProfileCommunities(VIEWER, 'super_admin', TARGET)).items[0].action).toBe('join');
    expect(listCalls()[0][1]).toEqual([VIEWER, TARGET, COMMUNITIES_PAGE, 0]);
  });
});

describe('getOwnCommunitiesPreview (as a member with no connection sees them)', () => {
  it('reads as a viewer who is in nothing (NULL), so only discoverable spaces come back, and says nothing is hidden', async () => {
    arm({ rows: [row({ access: 'approval' })] });
    const out = await getOwnCommunitiesPreview(TARGET);
    expect(listCalls()[0][1]).toEqual([null, TARGET, COMMUNITIES_PAGE, 0]);
    expect(out.items[0].action).toBe('request');
    expect(out.hidden).toBeNull();
    expect(mockBlocked).not.toHaveBeenCalledWith(TARGET, TARGET);
  });

  it('tells the member themselves why their list is empty: the setting, or hidden from search', async () => {
    arm({ target: { ...OPEN_TARGET, show_communities: false } });
    expect(await getOwnCommunitiesPreview(TARGET)).toEqual({ items: [], total: 0, nextOffset: null, hidden: 'setting_off' });
    arm({ target: { ...OPEN_TARGET, profile_visible: false } });
    expect(await getOwnCommunitiesPreview(TARGET)).toEqual({ items: [], total: 0, nextOffset: null, hidden: 'hidden_from_search' });
    expect(listCalls()).toHaveLength(0);
  });

  it('the setting wins over hidden from search when both are off; a guest has none and no reason', () => {
    expect(hiddenReason({ account_kind: 'member', profile_visible: false, show_communities: false })).toBe('setting_off');
    expect(hiddenReason({ account_kind: 'event_guest', profile_visible: true, show_communities: true })).toBe('guest');
    expect(hiddenReason({ account_kind: 'member', profile_visible: true, show_communities: true })).toBeNull();
  });

  it('a missing account is a 404', async () => {
    arm({ target: null });
    await expect(getOwnCommunitiesPreview(TARGET)).rejects.toBeInstanceOf(NotFoundError);
  });
});
