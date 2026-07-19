// ─── Circles (REASON v1 Phase 3a, 19 Jul 2026) ───────────────────────────────
//
// Pins the architecture rules: nesting cycle/depth rejection, transactional
// counters that can't double-count, idempotent join/leave, archived circles
// invisible, and the route-level authz (admin gates pinned via source).

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import {
  createCircle, joinCircle, leaveCircle, archiveCircle, getCircleDetail,
  MAX_NESTING_DEPTH,
} from '../../../services/circle/circle.service';

beforeEach(() => mockQuery.mockReset());

describe('nesting integrity', () => {
  it('rejects a circle that would contain itself (cycle)', async () => {
    // c1's ancestor chain leads back to c1.
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/SELECT parent_circle_id/.test(sql)) {
        const id = (params as string[])[0];
        // c2's parent is c1 — so making c1's parent c2 is a cycle.
        return Promise.resolve({ rows: [{ parent_circle_id: id === 'c2' ? 'c1' : null }] });
      }
      if (/SELECT id FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1' }] });
      return Promise.resolve({ rows: [] });
    });
    const { updateCircle } = await import('../../../services/circle/circle.service');
    await expect(updateCircle('c1', { parentCircleId: 'c2' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it(`rejects nesting deeper than ${MAX_NESTING_DEPTH} levels`, async () => {
    // Chain c1 <- c2 <- c3 <- c4: making something a child of c4 exceeds depth.
    const parents: Record<string, string | null> = { c4: 'c3', c3: 'c2', c2: 'c1', c1: null };
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/SELECT parent_circle_id/.test(sql)) {
        const id = (params as string[])[0];
        return Promise.resolve({ rows: [{ parent_circle_id: parents[id] ?? null }] });
      }
      return Promise.resolve({ rows: [{ id: 'x' }] });
    });
    await expect(createCircle('admin', { name: 'Too Deep', parentCircleId: 'c4' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('membership counters (transactional, never double-counted)', () => {
  function armJoin(insertedRows: number) {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1' }] });
      if (/INSERT INTO circle_members/.test(sql)) return Promise.resolve({ rowCount: insertedRows, rows: [] });
      if (/DELETE FROM circle_members/.test(sql)) return Promise.resolve({ rowCount: insertedRows, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
  }

  it('first join inserts AND increments member_count', async () => {
    armJoin(1);
    await joinCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /member_count = member_count \+ 1/.test(c[0] as string))).toBe(true);
  });

  it('a double-join is a no-op: ON CONFLICT insert misses → counter untouched', async () => {
    armJoin(0);
    await joinCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /member_count = member_count \+ 1/.test(c[0] as string))).toBe(false);
  });

  it('leaving without being a member never decrements', async () => {
    armJoin(0);
    await leaveCircle('c1', 'u1');
    expect(mockQuery.mock.calls.some(c => /member_count = GREATEST/.test(c[0] as string))).toBe(false);
  });

  it('the decrement clamps at zero (GREATEST guard in SQL)', async () => {
    armJoin(1);
    await leaveCircle('c1', 'u1');
    const dec = mockQuery.mock.calls.find(c => /member_count = GREATEST/.test(c[0] as string));
    expect(dec).toBeTruthy();
    expect(dec![0]).toMatch(/GREATEST\(member_count - 1, 0\)/);
  });
});

describe('archive semantics', () => {
  it('archive sets archived_at, never DELETEs', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    await archiveCircle('c1');
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /SET archived_at = NOW\(\)/.test(s))).toBe(true);
    expect(sqls.some(s => /DELETE FROM circles/.test(s))).toBe(false);
  });

  it('detail of an archived circle is a 404 (reads filter archived_at)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(getCircleDetail('c-archived', 'u1')).rejects.toMatchObject({ statusCode: 404 });
    const detailSql = mockQuery.mock.calls[0][0] as string;
    expect(detailSql).toMatch(/archived_at IS NULL/);
  });
});

describe('route authz matrix (source pins)', () => {
  const fs = jest.requireActual('fs') as typeof import('fs');
  const path = jest.requireActual('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../../routes/circles.ts'), 'utf8',
  ).replace(/\r\n/g, '\n'); // CRLF-agnostic (the 15 Jul lesson)

  it('create, update, archive, attach and detach are ALL admin-gated', () => {
    for (const route of ["router.post('/',", "router.patch('/:id',", "'/:id/archive'", "'/:id/pods'", "'/:id/pods/:podId'"]) {
      const i = src.indexOf(route);
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 200);
      expect(block).toMatch(/requireRole\(UserRole\.ADMIN\)/);
    }
  });

  it('join, leave and reads are authenticated but NOT role-gated (open join default)', () => {
    for (const route of ["'/:id/join'", "'/:id/leave'", "router.get('/',", "router.get('/:id',"]) {
      const i = src.indexOf(route);
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 200);
      expect(block).toMatch(/authenticate/);
      expect(block).not.toMatch(/requireRole/);
    }
  });
});
