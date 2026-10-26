// ─── Who runs an event ───────────────────────────────────────────────────────
//
// One definition, shared by the "message everyone" rule, the progress screen's access check and the
// worker's progress fan-out: the event's host, its co-hosts, the active director or host of its pod,
// and any platform admin.

import { jest } from '@jest/globals';
import { UserRole } from '@rsn/shared';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import {
  getEventOrganiserAccess,
  resolveEventOrganiserIds,
} from '../../../services/post-event-message/event-organisers';

const SESSION = 'aaaabbbb-0000-0000-0000-000000000001';
const USER = 'user-1';

function accessRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    status: 'completed',
    host_user_id: 'someone-else',
    is_cohost: false,
    is_pod_organiser: false,
    time_zone: null,
    ...over,
  };
}

beforeEach(() => mockQuery.mockReset());

describe('getEventOrganiserAccess', () => {
  it('is null for an event that does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getEventOrganiserAccess(USER, UserRole.MEMBER, SESSION)).resolves.toBeNull();
  });

  it('reads the relationship in one parameterised query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accessRow()] });
    await getEventOrganiserAccess(USER, UserRole.MEMBER, SESSION);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(params).toEqual([SESSION, USER]);
    expect(sql).not.toContain(SESSION);
    expect(sql).not.toContain(USER);
    // Co-hosts and the pod's ACTIVE director or host. A left or removed director no longer runs anything.
    expect(sql).toMatch(/FROM session_cohosts/);
    expect(sql).toMatch(/pm\.role IN \('director', 'host'\)/);
    expect(sql).toMatch(/pm\.status = 'active'/);
  });

  it('the event\'s host is an organiser, whatever their account role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accessRow({ host_user_id: USER })] });
    const access = await getEventOrganiserAccess(USER, UserRole.MEMBER, SESSION);
    expect(access).toMatchObject({ isHost: true, isOrganiser: true, isAdmin: false });
  });

  it('a co-host is an organiser', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accessRow({ is_cohost: true })] });
    expect(await getEventOrganiserAccess(USER, UserRole.MEMBER, SESSION)).toMatchObject({
      isHost: false, isCohost: true, isOrganiser: true,
    });
  });

  it('a pod\'s active director or host is an organiser of the pod\'s events (Claus on 25 Oct)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accessRow({ is_pod_organiser: true })] });
    expect(await getEventOrganiserAccess(USER, UserRole.MEMBER, SESSION)).toMatchObject({
      isPodOrganiser: true, isOrganiser: true,
    });
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('a platform %s is an organiser of every event', async (role) => {
    mockQuery.mockResolvedValueOnce({ rows: [accessRow()] });
    expect(await getEventOrganiserAccess(USER, role, SESSION)).toMatchObject({ isAdmin: true, isOrganiser: true });
  });

  it.each([UserRole.MEMBER, UserRole.PRO, UserRole.HOST, UserRole.FOUNDING_MEMBER, UserRole.FREE])(
    'a plain %s with no tie to the event is not an organiser',
    async (role) => {
      mockQuery.mockResolvedValueOnce({ rows: [accessRow()] });
      expect(await getEventOrganiserAccess(USER, role, SESSION)).toMatchObject({ isOrganiser: false, isAdmin: false });
    },
  );

  it('carries the event\'s status and the person\'s own time zone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accessRow({ status: 'lobby_open', time_zone: 'Europe/Berlin' })] });
    expect(await getEventOrganiserAccess(USER, UserRole.MEMBER, SESSION)).toMatchObject({
      status: 'lobby_open', timeZone: 'Europe/Berlin',
    });
  });
});

describe('resolveEventOrganiserIds', () => {
  it('lists the host, co-hosts and the pod\'s active directors and hosts once each', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'host' }, { user_id: 'cohost' }, { user_id: 'director' }, { user_id: 'host' }, { user_id: null }],
    });
    const ids = await resolveEventOrganiserIds(SESSION);
    expect(new Set(ids)).toEqual(new Set(['host', 'cohost', 'director']));
    expect(ids).toHaveLength(3);
    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(params).toEqual([SESSION]);
    expect(sql).toMatch(/session_cohosts/);
    expect(sql).toMatch(/pm\.status = 'active'/);
  });

  it('is empty for an event with nobody on record', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await resolveEventOrganiserIds(SESSION)).toEqual([]);
  });
});
