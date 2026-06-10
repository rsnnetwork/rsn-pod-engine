// Stefan's super-admin host policy (9 Jun). Only Stefan is super_admin; he is
// ALWAYS a host on every event (director or not), sees all host controls, is
// counted as a host + excluded from matching, and can NEVER be demoted — not
// even by the event director. Admins (Ali, Shradha, Tommy now) join as ordinary
// participants and are promoted to co-host to get controls.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const serverSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('Super-admin host policy (Stefan 9 Jun)', () => {
  const hostActions = serverSrc('services/orchestration/handlers/host-actions.ts');
  const matchingSvc = serverSrc('services/matching/matching.service.ts');
  const matchingFlow = serverSrc('services/orchestration/handlers/matching-flow.ts');
  const live = clientSrc('features/live/LiveSessionPage.tsx');

  it('client: a super_admin always sees host controls (baseIsHost includes isSuperAdmin)', () => {
    expect(live).toMatch(/const\s+isSuperAdmin\s*=\s*\(user as any\)\?\.role\s*===\s*'super_admin'/);
    expect(live).toMatch(/baseIsHost\s*=\s*isOriginalHost\s*\|\|\s*isCohost\s*\|\|\s*isSuperAdmin/);
  });

  it('server: getAllHostIds folds in super_admin session participants', () => {
    const fnStart = hostActions.indexOf('export async function getAllHostIds');
    const fn = hostActions.slice(fnStart, hostActions.indexOf('\nexport ', fnStart + 1));
    expect(fn).toMatch(/u\.role\s*=\s*'super_admin'/);
    expect(fn).toMatch(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*sp\.user_id/i);
    expect(fn).toMatch(/superAdminResult\.rows\.map/);
  });

  it('server: repairFutureRounds excludes super_admins from the matchable pool', () => {
    // Bug (10 Jun audit): repairFutureRounds hand-built its host-exclusion list
    // from director + cohosts + acting_as_host overrides and never queried
    // super_admins, so a late join/leave repair re-made Stefan matchable and
    // could pair him into a breakout — violating the 9-Jun always-host policy.
    // The host set MUST mirror getAllHostIds: director + cohosts + super_admins,
    // with NO acting_as_host overrides (the self-select picker was removed 23 May).
    const fnStart = matchingSvc.indexOf('export async function repairFutureRounds(');
    const fnEnd = matchingSvc.indexOf('async function getExistingRounds', fnStart);
    const fn = matchingSvc.slice(fnStart, fnEnd);
    expect(fn).toMatch(/u\.role\s*=\s*'super_admin'/);
    expect(fn).toMatch(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*sp\.user_id/i);
    // The removed 23-May override logic must not creep back in.
    expect(fn).not.toMatch(/acting_as_host/);
  });

  it('server: the host dashboard eligible-count query excludes the full host set, not just the director', () => {
    // Bug (10 Jun audit): emitHostDashboardImmediate's eligible-count query
    // excluded only the director (`sp.user_id != $2`), so cohosts and
    // super_admins in the main room inflated the "Match People: N eligible"
    // label even though the real matching path (getAllHostIds →
    // getEligibleParticipants) excludes them. The count must derive from the
    // same full host set, resolved once and reused for the dashboard audience.
    const fnStart = matchingFlow.indexOf('async function emitHostDashboardImmediate');
    const fn = matchingFlow.slice(fnStart);
    const q = fn.slice(fn.indexOf('const eligibleRows'), fn.indexOf('presentMainRoomCount'));
    expect(q).toMatch(/!=\s*ALL\(\$2::uuid\[\]\)/);
    // getAllHostIds must be resolved BEFORE the eligible query so the count and
    // the dashboard audience share one host set.
    const hostResolveIdx = fn.indexOf('getAllHostIds');
    expect(hostResolveIdx).toBeGreaterThan(-1);
    expect(hostResolveIdx).toBeLessThan(fn.indexOf('const eligibleRows'));
  });

  it('server: a super_admin can never be demoted/kicked, even by the director', () => {
    // refuseIfAdminTarget checks super_admin BEFORE the director shortcut, so the
    // director carve-out cannot override it.
    const idx = hostActions.indexOf('async function refuseIfAdminTarget');
    const fn = hostActions.slice(idx, hostActions.indexOf('\n}', idx + 1));
    const saIdx = fn.indexOf("targetRole === 'super_admin'");
    const dirIdx = fn.indexOf('host_user_id === callerUserId');
    expect(saIdx).toBeGreaterThan(-1);
    expect(dirIdx).toBeGreaterThan(-1);
    expect(saIdx).toBeLessThan(dirIdx); // super_admin refusal precedes the director carve-out
    expect(fn).toMatch(/SUPER_ADMIN_TARGET/);
  });
});
