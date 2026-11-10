// ─── A draft's fan-outs reach only the people who run it (Part 2 Task 2, fix round 1) ──────────────────
//
// fanoutSessionEntities (session:<id>, its participants, the pod's events) and the event-list audience
// (resolveSessionListAudience, behind fanoutSessionListEntities) leave out the pod and circle arms while the event is a
// draft, and read its host, co-hosts and the platform admins instead. For a published event the organiser arms are
// empty and the statement answers exactly the people it always did. Which rows each arm returns on real Postgres was
// run in the task's probe; this file holds the shape and that the rows read are the rows told.

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => ({ to: () => ({ emit: jest.fn() }) }),
  __esModule: true,
}));

import { fanoutSessionEntities, resolveSessionListAudience } from '../../realtime/fanout';

const SESSION = '5e550000-0000-4000-8000-0000000000f1';
const POD = '9d000000-0000-4000-8000-0000000000f2';
const flat = (sql: string) => sql.replace(/\s+/g, ' ');
const DRAFT = "EXISTS (SELECT 1 FROM sessions dr WHERE dr.id = $1 AND dr.publication = 'draft')";

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [{ user_id: 'u-host' }, { user_id: 'u-admin' }] });
  mockEmitEntities.mockClear();
});

function expectDraftAware(sql: string): void {
  // The pod arm and the circle arm answer nothing while the event is a draft.
  expect(sql).toMatch(/FROM pod_members WHERE pod_id = COALESCE\(\$2, '00000000-0000-0000-0000-000000000000'::uuid\) AND status NOT IN \('removed', 'declined'\) AND NOT EXISTS \(SELECT 1 FROM sessions dr WHERE dr\.id = \$1 AND dr\.publication = 'draft'\)/);
  expect(sql).toMatch(/WHERE cs\.id = \$1 AND .* AND cs\.publication <> 'draft'/);
  // And its organisers answer only then.
  expect(sql).toContain("SELECT host_user_id FROM sessions WHERE id = $1 AND publication = 'draft' AND host_user_id IS NOT NULL");
  expect(sql).toContain(`SELECT user_id FROM session_cohosts WHERE session_id = $1 AND ${DRAFT}`);
  expect(sql).toContain(`SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND ${DRAFT}`);
}

describe('a draft\'s fan-outs', () => {
  it('fanoutSessionEntities reads a draft-aware audience and tells exactly the people it read', async () => {
    await fanoutSessionEntities(POD, SESSION);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expectDraftAware(flat(sql));
    expect(params).toEqual([SESSION, POD]);
    expect(mockEmitEntities).toHaveBeenCalledWith(
      expect.anything(), ['u-host', 'u-admin'],
      [`session:${SESSION}`, `session:${SESSION}:participants`, `pod:${POD}:sessions`],
    );
  });

  it('the event-list audience is draft-aware too, and still reads the host for a published event', async () => {
    await expect(resolveSessionListAudience(POD, SESSION)).resolves.toEqual(['u-host', 'u-admin']);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expectDraftAware(flat(sql));
    expect(flat(sql)).toContain('SELECT host_user_id FROM sessions WHERE id = $1 AND host_user_id IS NOT NULL');
  });
});
