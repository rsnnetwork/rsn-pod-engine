// ─── A new pod made inside a main pod (22 Nov 2026) ───────────────────────────────────────────────────────────────
//
// createPod with parentPodId writes the pod, its director and its link to the main pod in ONE transaction, after the
// main pod's row is locked and read again: one level only and never an archived pod, so a refusal leaves nothing
// behind and no other request can put the main pod inside another meanwhile. A pod made without one is written as
// before, with parent_pod_id NULL and no main pod read.

const statements: Array<[string, unknown[]]> = [];
let mainRow: Record<string, unknown> | null;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

function answer(sql: string, params: unknown[] = []) {
  const s = flat(sql);
  statements.push([s, params]);
  if (s.startsWith('SELECT id, name, status, parent_pod_id FROM pods WHERE id = ANY')) return { rows: mainRow ? [mainRow] : [] };
  if (s.startsWith('SELECT parent_pod_id, COUNT(*)::int AS cnt FROM pods')) return { rows: [] };
  if (s.startsWith('INSERT INTO pods')) return { rows: [{ id: params[0], name: params[1], parentPodId: params[11] }] };
  if (s.startsWith('INSERT INTO pod_members')) return { rows: [], rowCount: 1 };
  throw new Error(`unmodelled: ${s.slice(0, 120)}`);
}

jest.mock('../../../db', () => ({
  query: (sql: string, params: unknown[]) => Promise.resolve(answer(sql, params)),
  transaction: (cb: (c: { query: (s: string, p: unknown[]) => unknown }) => unknown) =>
    cb({ query: (sql: string, params: unknown[]) => Promise.resolve(answer(sql, params)) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { createPod } from '../../../services/pod/pod.service';
import { NESTING_REFUSAL } from '../../../services/pod/nested-pods-rules';

const MAIN = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';

beforeEach(() => {
  statements.length = 0;
  mainRow = { id: MAIN, name: 'Founders', status: 'active', parent_pod_id: null };
});

describe('createPod inside a main pod', () => {
  it('locks the main pod first, then writes the pod with its link and its director', async () => {
    const pod = await createPod('dir', { name: 'Design', parentPodId: MAIN });
    expect(pod).toMatchObject({ name: 'Design', parentPodId: MAIN });
    const order = statements.map(([s]) => s.split(' ').slice(0, 3).join(' '));
    expect(order[0]).toBe('SELECT id, name,');
    expect(statements[0][0]).toMatch(/FOR UPDATE$/);
    const insert = statements.find(([s]) => s.startsWith('INSERT INTO pods'))!;
    expect(insert[0]).toContain('allow_member_invites, parent_pod_id)');
    expect(insert[1][11]).toBe(MAIN);
    expect(statements.findIndex(([s]) => s.startsWith('INSERT INTO pods'))).toBeGreaterThan(0);
    expect(statements.some(([s]) => s.startsWith('INSERT INTO pod_members'))).toBe(true);
  });

  it('inside a pod that is itself inside another: refused (409) and nothing is written', async () => {
    mainRow = { id: MAIN, name: 'Founders', status: 'active', parent_pod_id: 'grand' };
    await expect(createPod('dir', { name: 'Design', parentPodId: MAIN }))
      .rejects.toMatchObject({ statusCode: 409, code: 'POD_NESTING_REFUSED', message: NESTING_REFUSAL.parentIsInner('Founders') });
    expect(statements.some(([s]) => s.startsWith('INSERT'))).toBe(false);
  });

  it('inside an archived pod, or one that is gone: refused, nothing written', async () => {
    mainRow = { id: MAIN, name: 'Founders', status: 'archived', parent_pod_id: null };
    await expect(createPod('dir', { name: 'Design', parentPodId: MAIN })).rejects.toMatchObject({ statusCode: 409 });
    mainRow = null;
    await expect(createPod('dir', { name: 'Design', parentPodId: MAIN })).rejects.toMatchObject({ statusCode: 404 });
    expect(statements.some(([s]) => s.startsWith('INSERT'))).toBe(false);
  });

  it('a pod made without a main pod reads none and stands alone', async () => {
    await createPod('dir', { name: 'Plain' });
    expect(statements.some(([s]) => s.includes('FOR UPDATE'))).toBe(false);
    expect(statements.find(([s]) => s.startsWith('INSERT INTO pods'))![1][11]).toBeNull();
  });
});
