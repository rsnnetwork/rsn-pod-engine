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
