// ─── What an entity offers: the service (Shirley pilot S7, 11 Nov 2026; brief RSN 15) ────────────────────────────
// setEntityServices runs inside one transaction: the entity's row lock and the actor's admin right first (lockForAdmin,
// the same gate as every other entity edit), then one DELETE and one INSERT from arrays whatever the count (no N+1),
// then the entity's updated_at. A non-admin, a pending claimant, or an archived entity changes nothing. The website
// rule (https only, never javascript:) and the list rules are checked again here whatever the route did.

const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: jest.fn(),
  transaction: (cb: (c: { query: typeof mockClientQuery }) => unknown) => cb({ query: mockClientQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { query } from '../../../db';
import {
  SERVICE_WEBSITE_REFUSED, listEntityServices, normaliseServiceWebsite, setEntityServices, type ServiceInput,
} from '../../../services/entity/entity-services.service';

const ENTITY = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const mockQuery = query as unknown as jest.Mock;

/** The entity row (or none), the actor's link (or none); everything else answers no rows. */
function database(opts: { entity?: boolean; link?: { status: string; is_admin: boolean } | null; saved?: unknown[] }) {
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (/FROM entities WHERE id = \$1 AND archived_at IS NULL FOR UPDATE/.test(sql)) {
      return { rows: opts.entity === false ? [] : [{ name: 'Acme' }] };
    }
    if (/FROM entity_members m WHERE m\.entity_id = \$1 AND m\.user_id = \$2/.test(sql)) {
      return { rows: opts.link ? [{ status: opts.link.status, role: 'founder', title: null, requested_role: null, requested_title: null, is_admin: opts.link.is_admin }] : [] };
    }
    if (/SELECT category, description, website FROM entity_services/.test(sql)) return { rows: opts.saved ?? [] };
    return { rows: [], rowCount: 0 };
  });
}
const sqlRun = () => mockClientQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());

beforeEach(() => jest.clearAllMocks());

describe('normaliseServiceWebsite: https only, the entity website\'s other rules too', () => {
  it.each([
    ['acme.com', 'https://acme.com'],
    ['https://acme.com/services', 'https://acme.com/services'],
    ['HTTPS://Acme.com', 'HTTPS://Acme.com'],
    ['  acme.co.uk/x?y=1  ', 'https://acme.co.uk/x?y=1'],
    ['other-domain.org', 'https://other-domain.org'],
  ])('%s is %s', (typed, stored) => expect(normaliseServiceWebsite(typed)).toBe(stored));

  it.each([
    ['javascript:alert(1)'], ['http://acme.com'], ['data:text/html;base64,PHNjcmlwdD4='], ['vbscript:x'],
    ['https://u:p@acme.com'], ['https://localhost'], ['acme .com'], [''], ['https://' + 'a'.repeat(500) + '.com'],
  ])('%s is refused', (typed) => expect(normaliseServiceWebsite(typed)).toBeNull());
});

describe('setEntityServices', () => {
  const two: ServiceInput[] = [
    { category: 'coaching', description: 'For founders', website: 'https://acme.com/coaching' },
    { category: 'events', description: null, website: null },
  ];

  it('an active admin: lock, then one DELETE and one INSERT from arrays (positions in order), then the entity moves', async () => {
    database({ link: { status: 'active', is_admin: true }, saved: [{ category: 'coaching', description: 'For founders', website: 'https://acme.com/coaching' }] });
    const saved = await setEntityServices('u-admin', ENTITY, two, false);
    const run = sqlRun();
    expect(run[0]).toMatch(/FOR UPDATE$/);
    const del = run.findIndex((s) => s.startsWith('DELETE FROM entity_services WHERE entity_id = $1'));
    const ins = run.findIndex((s) => s.startsWith('INSERT INTO entity_services'));
    expect(del).toBeGreaterThan(1);
    expect(ins).toBe(del + 1);
    expect(run[ins]).toContain('FROM unnest($3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS s(category, description, website, ord)');
    expect(run[ins]).toContain('(s.ord - 1)::smallint');
    expect(mockClientQuery.mock.calls[ins][1]).toEqual([
      ENTITY, 'u-admin', ['coaching', 'events'], ['For founders', null], ['https://acme.com/coaching', null],
    ]);
    expect(run[ins + 1]).toBe('UPDATE entities SET updated_at = NOW() WHERE id = $1');
    expect(saved).toEqual([{ category: 'coaching', description: 'For founders', website: 'https://acme.com/coaching' }]);
    // One INSERT whatever the count: never a statement per service.
    expect(run.filter((s) => s.startsWith('INSERT')).length).toBe(1);
  });

  it('an empty list clears them: DELETE and no INSERT', async () => {
    database({ link: { status: 'active', is_admin: true } });
    await setEntityServices('u-admin', ENTITY, [], false);
    expect(sqlRun().some((s) => s.startsWith('DELETE FROM entity_services'))).toBe(true);
    expect(sqlRun().some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  it('a platform admin with no link to it may set them', async () => {
    database({ link: null });
    await expect(setEntityServices('u-staff', ENTITY, two, true)).resolves.toBeDefined();
  });

  it.each([
    ['a member who is not an admin', { status: 'active', is_admin: false }],
    ['a pending claimant flagged admin (rights count only on an active link)', { status: 'pending', is_admin: false }],
    ['someone removed', { status: 'removed', is_admin: false }],
    ['a stranger', null],
  ])('%s: 403, nothing deleted or written', async (_who, link) => {
    database({ link });
    await expect(setEntityServices('u-x', ENTITY, two, false)).rejects.toMatchObject({ statusCode: 403 });
    expect(sqlRun().some((s) => /^(DELETE|INSERT|UPDATE)/.test(s))).toBe(false);
  });

  it('an archived (or missing) entity: 404, nothing written', async () => {
    database({ entity: false, link: { status: 'active', is_admin: true } });
    await expect(setEntityServices('u-admin', ENTITY, two, false)).rejects.toMatchObject({ statusCode: 404 });
    expect(sqlRun().some((s) => /^(DELETE|INSERT|UPDATE)/.test(s))).toBe(false);
  });

  it('checks the list again: the same category twice, more than fifteen, a long description, a javascript: website', async () => {
    database({ link: { status: 'active', is_admin: true } });
    await expect(setEntityServices('u-admin', ENTITY, [two[0], { ...two[0] }], false)).rejects.toMatchObject({ statusCode: 400 });
    await expect(setEntityServices('u-admin', ENTITY, new Array(16).fill(two[1]), false)).rejects.toMatchObject({ statusCode: 400 });
    await expect(setEntityServices('u-admin', ENTITY, [{ category: 'legal', description: 'x'.repeat(281), website: null }], false))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(setEntityServices('u-admin', ENTITY, [{ category: 'legal', description: null, website: 'javascript:alert(1)' }], false))
      .rejects.toMatchObject({ statusCode: 400, message: SERVICE_WEBSITE_REFUSED });
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('a description of spaces is stored as nothing', async () => {
    database({ link: { status: 'active', is_admin: true } });
    await setEntityServices('u-admin', ENTITY, [{ category: 'legal', description: '   ', website: null }], false);
    const ins = mockClientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO entity_services'));
    expect(ins![1][3]).toEqual([null]);
  });
});

describe('listEntityServices', () => {
  it('reads the entity\'s list in its admins\' order, bounded', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ category: 'legal', description: null, website: null }] });
    expect(await listEntityServices(ENTITY)).toEqual([{ category: 'legal', description: null, website: null }]);
    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('WHERE entity_id = $1 ORDER BY position ASC, category ASC LIMIT 15');
    expect(mockQuery.mock.calls[0][1]).toEqual([ENTITY]);
  });
});
