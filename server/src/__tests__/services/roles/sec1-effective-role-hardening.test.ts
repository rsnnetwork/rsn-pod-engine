// SEC-1 (2026-06-13 audit C1) — defense in depth in getEffectiveRole.
//
// The acting_as_host opt-in (TRUE) promotes a bare participant to the
// 'cohost' floor so canActAsHost accepts them. That escalation must only
// apply to platform admins / super_admins. A TRUE override on any other row
// is poisoned data (it could be written via the formerly un-gated REST
// endpoint, or by the old instance during a deploy overlap) and must be
// ignored. Opt-out (FALSE) is a de-escalation and stays honoured for
// everyone; a formal co-host (session_cohosts) keeps 'cohost' independently
// of the override, so neutralizing it never strips a legitimate co-host.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: any[]) => mockQuery(...a),
}));

import { getEffectiveRole, canActAsHost } from '../../../services/roles/effective-role.service';

interface Fixture {
  actingAsHost: boolean | null;
  hostUserId: string | null;
  isCohost?: boolean;
  participant?: boolean;
}

function wireDb(f: Fixture): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/acting_as_host\s+FROM\s+session_participants/i.test(sql)) {
      return { rows: [{ acting_as_host: f.actingAsHost }] };
    }
    if (/host_user_id\s+FROM\s+sessions/i.test(sql)) {
      return { rows: [{ host_user_id: f.hostUserId }] };
    }
    if (/pod_id\s+FROM\s+sessions/i.test(sql)) {
      return { rows: [{ pod_id: null }] };
    }
    if (/FROM\s+session_cohosts/i.test(sql)) {
      return { rows: f.isCohost ? [{ role: 'co_host' }] : [] };
    }
    if (/status\s+FROM\s+session_participants/i.test(sql)) {
      return { rows: f.participant === false ? [] : [{ status: 'in_lobby' }] };
    }
    return { rows: [] };
  });
}

const SID = 'sess-1';
const ME = 'user-1';
const OTHER = 'someone-else';

beforeEach(() => {
  mockQuery.mockReset();
});

describe('SEC-1 — getEffectiveRole acting_as_host hardening', () => {
  it('IGNORES a TRUE override for a plain member (poisoned row) → participant', async () => {
    wireDb({ actingAsHost: true, hostUserId: OTHER });
    const role = await getEffectiveRole(ME, 'member', { sessionId: SID });
    expect(role).toBe('participant');
  });

  it('canActAsHost is FALSE for a member with a poisoned TRUE override', async () => {
    wireDb({ actingAsHost: true, hostUserId: OTHER });
    const { allowed } = await canActAsHost(ME, 'member', SID);
    expect(allowed).toBe(false);
  });

  it('HONOURS a TRUE override for a platform ADMIN → cohost (opt-in floor)', async () => {
    wireDb({ actingAsHost: true, hostUserId: OTHER });
    const role = await getEffectiveRole(ME, 'admin', { sessionId: SID });
    expect(role).toBe('cohost');
  });

  it('SUPER_ADMIN still resolves to pod_admin with a TRUE override', async () => {
    wireDb({ actingAsHost: true, hostUserId: OTHER });
    const role = await getEffectiveRole(ME, 'super_admin', { sessionId: SID });
    expect(role).toBe('pod_admin');
  });

  it('opt-out (FALSE) is still honoured for a member → participant', async () => {
    wireDb({ actingAsHost: false, hostUserId: OTHER });
    const role = await getEffectiveRole(ME, 'member', { sessionId: SID });
    expect(role).toBe('participant');
  });

  it('a formal co-host keeps cohost even with the override neutralized', async () => {
    wireDb({ actingAsHost: true, hostUserId: OTHER, isCohost: true });
    const role = await getEffectiveRole(ME, 'member', { sessionId: SID });
    expect(role).toBe('cohost');
  });
});
