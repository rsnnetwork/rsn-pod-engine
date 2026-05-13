// Phase L — 12 May item 6: unified control center based on role permissions.
//
// Stefan reported on 12 May that Shradha and Stefan saw different interfaces
// during the same live event. The proximate cause was Phase B (May 10) giving
// both `admin` and `super_admin` host UI, then Phase I (May 12) narrowing it
// to `super_admin` only — between those two commits the gate moved, so a
// build cached on Shradha's machine could disagree with the server.
//
// Post-Phase-I, the canonical isHost gate in the live event UI is:
//   isOriginalHost || isCohost || isSuperAdmin
//
// And the canonical server-side gate (canActAsHost / verifyHost) is:
//   pod_admin (= SUPER_ADMIN OR pod creator/director) OR event_host OR cohost
//
// The two gates have an INTENDED overlap for the personas RSN has today:
// - Stefan (super_admin) — passes both
// - Shradha & Raja (admin) — pass neither
// - Event host — passes both
// - Cohost — passes both
// - Pod creator/director who isn't event host — passes server, fails client.
//   This is a theoretical persona; on RSN today pod creators are also the
//   event host. If this changes, the client gate will need to widen.
//
// Phase L pins the post-Phase-I alignment so a future PR cannot widen one
// side without widening the other, and cannot reintroduce the May-10
// broad-admin form on either side.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase L — control center role consistency (item 6)', () => {
  describe('Client — LiveSessionPage canonical isHost form', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');

    it('declares isOriginalHost, isCohost, isSuperAdmin separately', () => {
      expect(src).toMatch(
        /const\s+isOriginalHost\s*=\s*session\?\.hostUserId\s*===\s*user\?\.id/,
      );
      expect(src).toMatch(/const\s+isCohost\s*=/);
      expect(src).toMatch(
        /const\s+isSuperAdmin\s*=\s*user\?\.role\s*===\s*['"]super_admin['"]/,
      );
    });

    it('isHost is exactly the canonical disjunction (no broad isAdmin)', () => {
      expect(src).toMatch(
        /const\s+isHost\s*=\s*isOriginalHost\s*\|\|\s*isCohost\s*\|\|\s*isSuperAdmin/,
      );
      // The broad isAdmin form (admin || super_admin) must NOT appear in
      // the isHost expression. It can still exist elsewhere on the page
      // for admin-only buttons, but does not fold into isHost.
      const isHostLine = src.match(/const\s+isHost\s*=[^;]+;/);
      expect(isHostLine).toBeTruthy();
      expect(isHostLine![0]).not.toMatch(/isAdmin/);
    });
  });

  describe('Client — HostControls + HostControlCenter mount gating', () => {
    const liveSrc = readClient('features/live/LiveSessionPage.tsx');
    const hostControlsSrc = readClient('features/live/HostControls.tsx');

    it('LiveSessionPage mounts HostControls only when isHost', () => {
      // The exact form: `{isHost && phase !== 'complete' && <HostControls`
      // The "phase !== 'complete'" extra guard is intentional — we hide host
      // UI after the event ends. The isHost gate is what guarantees
      // non-host roles never see the host UI on the live page.
      expect(liveSrc).toMatch(/\{\s*isHost\s+&&[\s\S]{0,80}<HostControls/);
    });

    it('HostControlCenter is only imported by HostControls (cannot bypass the isHost gate)', () => {
      // If any other component imports HostControlCenter directly, it could
      // render outside the isHost gate. Pin: HostControls is the sole
      // importer + renderer.
      expect(hostControlsSrc).toMatch(
        /import\s+HostControlCenter\s+from\s+['"][.\/]+HostControlCenter['"]/,
      );
      expect(hostControlsSrc).toMatch(/<HostControlCenter/);

      // Grep the client tree for any other importer.
      const clientRoot = nodePath.join(__dirname, '../../../../client/src');
      const matches: string[] = [];
      const walk = (dir: string) => {
        for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
          const full = nodePath.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name)) {
            const c = nodeFs.readFileSync(full, 'utf8');
            if (/import\s+HostControlCenter\s+from/.test(c)) matches.push(full);
          }
        }
      };
      walk(clientRoot);
      // Only one importer: HostControls.tsx.
      expect(matches.length).toBe(1);
      expect(matches[0].replace(/\\/g, '/')).toMatch(
        /features\/live\/HostControls\.tsx$/,
      );
    });
  });

  describe('Server — canActAsHost canonical shape (post-Phase-I)', () => {
    const src = readServer('services/roles/effective-role.service.ts');

    it('Layer 1 of getEffectiveRole gates strictly on SUPER_ADMIN, never broad admin', () => {
      const fnStart = src.indexOf('export async function getEffectiveRole');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

      const layerOneStart = fn.indexOf('Layer 1');
      const layerOneEnd = fn.indexOf('Layer 2', layerOneStart);
      const layerOne = fn.slice(layerOneStart, layerOneEnd);
      expect(layerOne).toMatch(/globalUserRole\s*===\s*UserRole\.SUPER_ADMIN/);
      expect(layerOne).not.toMatch(/hasRoleAtLeast\([^)]*UserRole\.ADMIN\)/);
    });

    it('canActAsHost accepts cohost and above (pod_admin | event_host | cohost)', () => {
      // The numeric ranking is the source of truth; cohost = 2, participant = 1.
      // canActAsHost returns allowed when actual rank >= cohost rank.
      expect(src).toMatch(
        /allowed:\s*ROLE_RANK\[role\]\s*>=\s*ROLE_RANK\.cohost/,
      );
      // Confirm the ranking pins the four tiers in the expected order.
      const rankingMatch = src.match(/const\s+ROLE_RANK[\s\S]+?\};/);
      expect(rankingMatch).toBeTruthy();
      const ranking = rankingMatch![0];
      expect(ranking).toMatch(/pod_admin:\s*4/);
      expect(ranking).toMatch(/event_host:\s*3/);
      expect(ranking).toMatch(/cohost:\s*2/);
      expect(ranking).toMatch(/participant:\s*1/);
    });
  });

  describe('Server — host REST routes share the same gate', () => {
    const src = readServer('routes/host.ts');

    it('verifyHostOrSuperAdmin exists and gates on SUPER_ADMIN (not broad ADMIN)', () => {
      // Phase I renamed verifyHostOrAdmin → verifyHostOrSuperAdmin and
      // narrowed the gate. If a future PR widens it back, Shradha would
      // again be able to call REST host endpoints — exactly the
      // pre-Phase-I desync that produced item 6's "different interface"
      // symptom.
      expect(src).toMatch(/verifyHostOrSuperAdmin/);
      expect(src).not.toMatch(/verifyHostOrAdmin\b/);
      // The function body checks for SUPER_ADMIN specifically. The current
      // shape is a NEGATIVE guard inside the helper:
      //   if (session.hostUserId !== req.user.userId
      //       && req.user.role !== UserRole.SUPER_ADMIN) return false;
      // Either === or !== form is acceptable; what matters is the
      // SUPER_ADMIN constant is the role being compared (never just
      // ADMIN).
      expect(src).toMatch(/role\s*(?:===|!==)\s*UserRole\.SUPER_ADMIN/);
      // Forbid the broad form anywhere in this file.
      expect(src).not.toMatch(/hasRoleAtLeast\([^)]*UserRole\.ADMIN\)/);
    });
  });

  describe('Alignment — client isHost shape matches server canActAsHost reachable set', () => {
    // This is the meta-pin for item 6: client and server agree on who
    // gets host UI for the three real personas (event host, cohost,
    // super_admin). The two test bodies above verify each side
    // individually; this one cross-checks the documented intent.
    it('client and server both accept event_host', () => {
      const clientSrc = readClient('features/live/LiveSessionPage.tsx');
      const serverSrc = readServer('services/roles/effective-role.service.ts');
      // Client: isOriginalHost == hostUserId match → contributes to isHost.
      expect(clientSrc).toMatch(/isOriginalHost\s*=\s*session\?\.hostUserId\s*===\s*user\?\.id/);
      // Server: sessions.host_user_id === userId → 'event_host'.
      expect(serverSrc).toMatch(
        /host_user_id\s*===\s*userId[\s\S]{0,100}return\s*['"]event_host['"]/,
      );
    });

    it('client and server both accept cohost', () => {
      const clientSrc = readClient('features/live/LiveSessionPage.tsx');
      const serverSrc = readServer('services/roles/effective-role.service.ts');
      expect(clientSrc).toMatch(/isCohost\s*=\s*!!user\?\.id\s*&&\s*cohosts\.has\(user\.id\)/);
      // Server: row in session_cohosts → 'cohost'.
      expect(serverSrc).toMatch(
        /SELECT\s+role\s+FROM\s+session_cohosts[\s\S]{0,200}return\s*['"]cohost['"]/i,
      );
    });

    it('client and server both accept super_admin (and only super_admin from the global tier)', () => {
      const clientSrc = readClient('features/live/LiveSessionPage.tsx');
      const serverSrc = readServer('services/roles/effective-role.service.ts');
      expect(clientSrc).toMatch(
        /isSuperAdmin\s*=\s*user\?\.role\s*===\s*['"]super_admin['"]/,
      );
      // Server: globalUserRole === SUPER_ADMIN → 'pod_admin' (highest tier).
      expect(serverSrc).toMatch(
        /globalUserRole\s*===\s*UserRole\.SUPER_ADMIN[\s\S]{0,100}return\s*['"]pod_admin['"]/,
      );
    });
  });
});
