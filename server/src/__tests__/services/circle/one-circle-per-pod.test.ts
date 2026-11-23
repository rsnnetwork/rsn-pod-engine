// ─── A pod belongs to one circle (Stefan, 22 Nov 2026: "Can a pod belong to several circles?" "no") ─────────────
// attachPod refuses a pod that is already in another circle that is not archived, naming that circle (409
// POD_IN_OTHER_CIRCLE), with the pod's row locked while it checks and writes, so two circles cannot both take it at
// once. A pod in an archived circle, or already in this one, may still be attached (the second changes nothing). The
// attach picker leaves out every pod that is in another circle that is not archived.

const mockQuery = jest.fn();
const mockClientSql: string[] = [];
let mockInTransaction = false;
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: async (cb: Function) => {
    mockInTransaction = true;
    try {
      return await cb({
        query: (...a: unknown[]) => { mockClientSql.push(String(a[0]).replace(/\s+/g, ' ').trim()); return mockQuery(...a); },
      });
    } finally { mockInTransaction = false; }
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import * as fs from 'fs';
import * as path from 'path';
import { ErrorCodes } from '@rsn/shared';
import { attachPod } from '../../../services/circle/circle.service';
import { ATTACH_EMPTY, attachNoMatch } from '../../../../../client/src/features/circles/circle-logic';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
beforeEach(() => { mockQuery.mockReset(); mockClientSql.length = 0; });

function world(f: { circle?: boolean; pod?: boolean; runs?: boolean; otherCircle?: string | null }) {
  const inserts: unknown[][] = [];
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = flat(sql);
    if (!mockInTransaction) throw new Error(`outside the transaction: ${text}`);
    if (text.startsWith('SELECT id FROM circles')) return { rows: f.circle === false ? [] : [{ id: 'c1' }] };
    if (text.startsWith('SELECT p.id, EXISTS')) return { rows: f.pod === false ? [] : [{ id: 'p1', runs: !!f.runs }] };
    if (text.startsWith('SELECT c.name FROM circle_pods')) return { rows: f.otherCircle ? [{ name: f.otherCircle }] : [] };
    if (text.startsWith('INSERT INTO circle_pods')) { inserts.push(params); return { rowCount: 1, rows: [] }; }
    throw new Error(`unmodelled: ${text}`);
  });
  return inserts;
}

async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e) {
    const err = e as { statusCode?: number; code?: string; message?: string; details?: unknown };
    return { status: err.statusCode, code: err.code, message: err.message, details: err.details };
  }
  return null;
}

describe('attachPod: a pod belongs to one circle', () => {
  it('attaches a pod in no other circle, inside one transaction with the pod row locked', async () => {
    const inserts = world({ runs: true });
    await expect(attachPod('c1', 'p1', 'u1', false)).resolves.toBeUndefined();
    expect(inserts).toEqual([['c1', 'p1', 'u1']]);
    expect(mockClientSql.find((s) => s.startsWith('SELECT p.id, EXISTS'))).toMatch(/FOR UPDATE OF p$/);
    const order = mockClientSql.map((s) => s.slice(0, 30));
    expect(order.findIndex((s) => s.startsWith('SELECT c.name'))).toBeLessThan(order.findIndex((s) => s.startsWith('INSERT')));
  });

  it('refuses a pod already in another circle that is not archived, naming it, and writes nothing', async () => {
    const inserts = world({ runs: true, otherCircle: 'Founders' });
    expect(await refusal(attachPod('c1', 'p1', 'u1', false))).toEqual({
      status: 409,
      code: ErrorCodes.POD_IN_OTHER_CIRCLE,
      message: 'This pod is already in Founders. A pod can be in one circle, so take it out of Founders first.',
      details: { circleName: 'Founders' },
    });
    expect(inserts).toEqual([]);
  });

  it('a platform admin is held to the same rule', async () => {
    world({ otherCircle: 'Founding Circle' });
    expect((await refusal(attachPod('c1', 'p1', 'admin', true)))?.code).toBe(ErrorCodes.POD_IN_OTHER_CIRCLE);
  });

  it('only counts other circles that are not archived, and never this one', async () => {
    world({ runs: true });
    await attachPod('c1', 'p1', 'u1', false);
    const check = mockClientSql.find((s) => s.startsWith('SELECT c.name FROM circle_pods'));
    expect(check).toContain('cp.pod_id = $1 AND cp.circle_id <> $2 AND c.archived_at IS NULL');
  });

  it('keeps the earlier refusals: a missing circle or pod is 404, someone who does not run the pod is 403', async () => {
    world({ circle: false });
    expect((await refusal(attachPod('c1', 'p1', 'u1', false)))?.status).toBe(404);
    world({ pod: false });
    expect((await refusal(attachPod('c1', 'p1', 'u1', false)))?.status).toBe(404);
    world({ runs: false });
    expect((await refusal(attachPod('c1', 'p1', 'u1', false)))?.status).toBe(403);
  });
});

describe('the attach picker lists no pod that is in another circle', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../services/circle/circle-join.service.ts'), 'utf8');
  it('excludes a pod linked here or to any circle that is not archived', () => {
    const start = src.indexOf('export async function listAttachablePods');
    const block = flat(src.slice(start, src.indexOf('return { items', start)));
    expect(block).toContain(
      'AND NOT EXISTS (SELECT 1 FROM circle_pods cp JOIN circles oc ON oc.id = cp.circle_id WHERE cp.pod_id = p.id AND (cp.circle_id = $1 OR oc.archived_at IS NULL))',
    );
  });
});

describe('the picker says why a pod in another circle is not there', () => {
  it('with no search, and with a search that finds nothing', () => {
    expect(ATTACH_EMPTY).toBe('You have no other pods to attach. Pods you direct or host that are not in a circle yet are listed here, since a pod can be in one circle.');
    expect(attachNoMatch('Founding')).toBe('None of your pods matches “Founding”. A pod already in a circle is not listed, since a pod can be in one circle.');
    const sheet = fs.readFileSync(path.join(__dirname, '../../../../../client/src/features/circles/AttachPodSheet.tsx'), 'utf8');
    expect(sheet).toContain('{q ? attachNoMatch(q) : ATTACH_EMPTY}');
  });
});
