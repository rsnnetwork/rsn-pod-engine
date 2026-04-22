// T1-5 — Effective Role Resolver + permissions:updated + host transfer
//
// Pre-fix: 4 independent role systems checked separately in 8+ functions.
// Pod directors couldn't host sessions they created. Co-host assignments
// didn't update the recipient's UI in real time. No way to transfer host
// role mid-session.
//
// Post-fix:
//   1. effective-role.service.ts — single function `getEffectiveRole`
//      collapses all four role layers into one of 5 enum values.
//   2. verifyHost (host-actions.ts) refactored to use the resolver — pod
//      directors now pass the host check for sessions in their pod.
//   3. handleAssignCohost / handleRemoveCohost emit permissions:updated
//      to the affected user's personal room so UI re-renders immediately.
//   4. New handlePromoteCohost transfers host ownership to a co-host.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../..', rel), 'utf8');
}

describe('T1-5 — effective-role.service', () => {
  const src = readSource('services/roles/effective-role.service.ts');

  describe('public surface', () => {
    it('exports EffectiveRole type with 5 values', () => {
      expect(src).toMatch(/export type EffectiveRole\s*=[\s\S]+?'pod_admin'[\s\S]+?'event_host'[\s\S]+?'cohost'[\s\S]+?'participant'[\s\S]+?'unauthorized'/);
    });

    it('exports getEffectiveRole(userId, globalRole, ctx) → Promise<EffectiveRole>', () => {
      expect(src).toMatch(/export async function getEffectiveRole\([\s\S]+?\):\s*Promise<EffectiveRole>/);
    });

    it('exports requireEffectiveRole helper (throws ForbiddenError)', () => {
      expect(src).toMatch(/export async function requireEffectiveRole\(/);
      expect(src).toMatch(/throw new ForbiddenError\(/);
    });

    it('exports canActAsHost convenience', () => {
      expect(src).toMatch(/export async function canActAsHost\([\s\S]+?\):\s*Promise<\{\s*allowed:\s*boolean[\s\S]+?effectiveRole:\s*EffectiveRole\s*\}>/);
    });
  });

  describe('resolution layers', () => {
    it('layer 1 — global ADMIN/SUPER_ADMIN short-circuit to pod_admin', () => {
      expect(src).toMatch(/hasRoleAtLeast\(globalUserRole as UserRole,\s*UserRole\.ADMIN\)/);
      expect(src).toMatch(/return ['"]pod_admin['"]/);
    });

    it('layer 2 — pod creator OR pod_members.role=director maps to pod_admin', () => {
      expect(src).toMatch(/p\.created_by\s*=\s*\$2|created_by === userId/);
      expect(src).toMatch(/member_role\s*===\s*['"]director['"]/);
    });

    it('layer 3 — sessions.host_user_id maps to event_host', () => {
      // Query selects host_user_id from sessions; match either parameterised
      // form (the implementation uses $1 for sessionId).
      expect(src).toMatch(/SELECT host_user_id FROM sessions/);
      expect(src).toMatch(/return ['"]event_host['"]/);
    });

    it('layer 4 — session_cohosts entry maps to cohost', () => {
      expect(src).toMatch(/FROM session_cohosts WHERE session_id = \$1 AND user_id = \$2/);
      expect(src).toMatch(/return ['"]cohost['"]/);
    });

    it('layer 5 — session_participants (non-removed) maps to participant', () => {
      expect(src).toMatch(/FROM session_participants[\s\S]+?status NOT IN \('removed', 'left', 'no_show'\)/);
      expect(src).toMatch(/return ['"]participant['"]/);
    });

    it('default — no layer matches → unauthorized', () => {
      expect(src).toMatch(/return ['"]unauthorized['"]/);
    });
  });

  describe('canActAsHost convenience', () => {
    it('returns allowed=true for pod_admin, event_host, AND cohost', () => {
      // Uses ROLE_RANK[role] >= ROLE_RANK.cohost which is 2
      // pod_admin=4, event_host=3, cohost=2 — all pass
      // participant=1, unauthorized=0 — fail
      expect(src).toMatch(/ROLE_RANK\[role\]\s*>=\s*ROLE_RANK\.cohost/);
    });
  });
});

describe('T1-5 — verifyHost uses the resolver', () => {
  const src = readSource('services/orchestration/handlers/host-actions.ts');

  it('verifyHost imports + calls canActAsHost', () => {
    const fnStart = src.indexOf('export async function verifyHost(');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/canActAsHost\(userId,\s*userRole,\s*sessionId\)/);
  });

  it('uses effective-role.service.ts (path is correct)', () => {
    // Either static import OR dynamic await import — accept both
    expect(src).toMatch(/['"]\.\.\/\.\.\/roles\/effective-role\.service['"]/);
  });
});

describe('T1-5 — permissions:updated socket event', () => {
  const src = readSource('services/orchestration/handlers/host-actions.ts');

  it('handleAssignCohost emits permissions:updated to the new co-host', () => {
    const fnStart = src.indexOf('export async function handleAssignCohost(');
    const fnEnd = src.indexOf('export async function handleRemoveCohost(', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(['"]permissions:updated['"]/);
    expect(fn).toMatch(/effectiveRole:\s*['"]cohost['"]/);
  });

  it('handleRemoveCohost emits permissions:updated downgrade', () => {
    const fnStart = src.indexOf('export async function handleRemoveCohost(');
    const fnEnd = src.indexOf('export async function handlePromoteCohost(', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(['"]permissions:updated['"]/);
    expect(fn).toMatch(/effectiveRole:\s*['"]participant['"]/);
    expect(fn).toMatch(/capabilities:\s*\[\]/);
  });
});

describe('T1-5 — host transfer (handlePromoteCohost)', () => {
  const src = readSource('services/orchestration/handlers/host-actions.ts');

  it('exports handlePromoteCohost', () => {
    expect(src).toMatch(/export async function handlePromoteCohost\(/);
  });

  it('only the original sessions.host_user_id can transfer', () => {
    const fnStart = src.indexOf('export async function handlePromoteCohost(');
    const fnEnd = src.indexOf('}\n\n// ', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/session\.hostUserId !== hostId/);
    expect(fn).toMatch(/Only the original host can transfer/);
  });

  it('verifies target is currently a co-host (NOT_COHOST error otherwise)', () => {
    const fnStart = src.indexOf('export async function handlePromoteCohost(');
    const fnEnd = src.indexOf('}\n\n// ', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/FROM session_cohosts WHERE session_id = \$1 AND user_id = \$2/);
    expect(fn).toMatch(/NOT_COHOST/);
  });

  it('updates sessions.host_user_id and removes the cohost row', () => {
    const fnStart = src.indexOf('export async function handlePromoteCohost(');
    const fnEnd = src.indexOf('}\n\n// ', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/UPDATE sessions SET host_user_id = \$1 WHERE id = \$2/);
    expect(fn).toMatch(/DELETE FROM session_cohosts WHERE session_id = \$1 AND user_id = \$2/);
  });

  it('updates in-memory ActiveSession.hostUserId so verifyHost sees new state', () => {
    const fnStart = src.indexOf('export async function handlePromoteCohost(');
    const fnEnd = src.indexOf('}\n\n// ', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/activeSession\.hostUserId\s*=\s*cohostUserId/);
  });

  it('broadcasts host:transferred to session room', () => {
    const fnStart = src.indexOf('export async function handlePromoteCohost(');
    const fnEnd = src.indexOf('}\n\n// ', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(['"]host:transferred['"]/);
    expect(fn).toMatch(/newHostId:\s*cohostUserId/);
  });

  it('emits permissions:updated to BOTH old and new host', () => {
    const fnStart = src.indexOf('export async function handlePromoteCohost(');
    const fnEnd = src.indexOf('}\n\n// ', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/io\.to\(userRoom\(cohostUserId\)\)\.emit\(['"]permissions:updated['"]/);
    expect(fn).toMatch(/io\.to\(userRoom\(hostId\)\)\.emit\(['"]permissions:updated['"]/);
  });
});

describe('T1-5 — orchestration.service registers host:promote_cohost', () => {
  it('imports handlePromoteCohost', () => {
    const src = readSource('services/orchestration/orchestration.service.ts');
    expect(src).toMatch(/handlePromoteCohost,/);
  });

  it("wraps host:promote_cohost in wrapHandler", () => {
    const src = readSource('services/orchestration/orchestration.service.ts');
    expect(src).toMatch(/wrapHandler\(['"]host:promote_cohost['"],\s*socket,\s*handlePromoteCohost\)/);
  });
});
