// ─── A pod can be attached to several circles (Stefan, 23 Nov 2026: "I think a pod can be in several circles… be
// attached to several circles", which replaces his 22 Nov "one circle" answer) ──────────────────────────────────────
// attachPod never looks at the other circles a pod is in: it checks the circle, the pod and that the caller may
// attach it, then links it (attaching it to the same circle twice changes nothing). The attach picker leaves out only
// the pods already in this circle, and it says plainly when a search finds nothing.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: async (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
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
const seen: string[] = [];
beforeEach(() => { mockQuery.mockReset(); seen.length = 0; });

function world(f: { circle?: boolean; pod?: boolean; runs?: boolean }) {
  const inserts: unknown[][] = [];
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = flat(sql);
    seen.push(text);
    if (text.startsWith('SELECT id FROM circles')) return { rows: f.circle === false ? [] : [{ id: 'c1' }] };
    if (text.startsWith('SELECT p.id, EXISTS')) return { rows: f.pod === false ? [] : [{ id: 'p1', runs: !!f.runs }] };
    if (text.startsWith('INSERT INTO circle_pods')) { inserts.push(params); return { rowCount: 1, rows: [] }; }
    throw new Error(`unmodelled: ${text}`);
  });
  return inserts;
}

async function status(p: Promise<unknown>) {
  try { await p; } catch (e) { return (e as { statusCode?: number }).statusCode; }
  return null;
}

describe('attachPod: a pod can be in several circles', () => {
  it('links the pod without asking which other circles it is in', async () => {
    const inserts = world({ runs: true });
    await expect(attachPod('c1', 'p1', 'u1', false)).resolves.toBeUndefined();
    expect(inserts).toEqual([['c1', 'p1', 'u1']]);
    expect(seen.some((s) => /circle_pods/.test(s) && s.startsWith('SELECT'))).toBe(false);
    expect(seen.find((s) => s.startsWith('INSERT INTO circle_pods'))).toContain('ON CONFLICT DO NOTHING');
  });

  it('a platform admin attaches any pod', async () => {
    const inserts = world({ runs: false });
    await attachPod('c1', 'p1', 'admin', true);
    expect(inserts).toEqual([['c1', 'p1', 'admin']]);
  });

  it('keeps the refusals: a missing circle or pod is 404, someone who does not run the pod is 403', async () => {
    world({ circle: false });
    expect(await status(attachPod('c1', 'p1', 'u1', false))).toBe(404);
    world({ pod: false });
    expect(await status(attachPod('c1', 'p1', 'u1', false))).toBe(404);
    world({ runs: false });
    expect(await status(attachPod('c1', 'p1', 'u1', false))).toBe(403);
  });

  it('the one-circle refusal is gone everywhere', () => {
    expect((ErrorCodes as Record<string, string>).POD_IN_OTHER_CIRCLE).toBeUndefined();
    const svc = fs.readFileSync(path.join(__dirname, '../../../services/circle/circle.service.ts'), 'utf8');
    expect(svc).not.toMatch(/one circle|POD_IN_OTHER_CIRCLE/);
  });
});

describe('the attach picker', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../services/circle/circle-join.service.ts'), 'utf8');
  it('leaves out only the pods already in this circle', () => {
    const start = src.indexOf('export async function listAttachablePods');
    const block = flat(src.slice(start, src.indexOf('return { items', start)));
    expect(block).toContain('AND NOT EXISTS (SELECT 1 FROM circle_pods cp WHERE cp.circle_id = $1 AND cp.pod_id = p.id)');
    expect(block).not.toContain('archived_at');
  });

  it('says what is listed, and that a search found nothing, without any one-circle rule', () => {
    expect(ATTACH_EMPTY).toBe('You have no other pods to attach. Pods you direct or host are listed here.');
    expect(attachNoMatch('Founding')).toBe('None of your pods matches “Founding”.');
    const sheet = fs.readFileSync(path.join(__dirname, '../../../../../client/src/features/circles/AttachPodSheet.tsx'), 'utf8');
    expect(sheet).toContain('{q ? attachNoMatch(q) : ATTACH_EMPTY}');
  });
});
