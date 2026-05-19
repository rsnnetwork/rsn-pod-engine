// Phase R + Phase S — UX polish on top of the 12 May campaign.
//
// Phase R: replace console.error stopgaps with the existing useToastStore
// surface so REST failures actually show up to the user. Affects:
//   • HostControlCenter — setVisibility / setMyActingAsHost handlers
//   • LiveSessionPage — join-as banner buttons + revert banner button
//
// Phase S: new REST endpoint for host-initiated per-event role switch.
// Caller must have host capability (verifyHostOrSuperAdmin); target
// cannot be the director (Phase P invariant) and cannot be self (use
// the self-toggle endpoint for that — clear redirect in the error).
// The HostControlCenter exposes a "Switch to participant" /
// "Switch to host" button per row.

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

describe('Phase R — toast notifications for REST failures', () => {
  it('HostControlCenter no longer has console.error stopgaps in REST handlers', () => {
    const src = readClient('features/live/HostControlCenter.tsx');
    expect(src).not.toMatch(/console\.error\(['"]host:set_visibility/);
    expect(src).not.toMatch(/console\.error\(['"]host:set_acting_as_host/);
  });

  it('HostControlCenter imports useToastStore and calls addToast on failure', () => {
    const src = readClient('features/live/HostControlCenter.tsx');
    expect(src).toMatch(/import\s+\{\s*useToastStore\s*\}\s+from\s+['"]@\/stores\/toastStore['"]/);
    expect(src).toMatch(/addToast\s*=\s*useToastStore/);
    // setVisibility catch block calls addToast (window widened for the
    // explanatory comment between catch and addToast).
    expect(src).toMatch(
      /catch[\s\S]{0,600}addToast\([^)]+visibility[^)]+['"]error['"]\)/i,
    );
    // setMyActingAsHost catch block calls addToast.
    expect(src).toMatch(
      /catch[\s\S]{0,600}addToast\([^)]+(role|participant|host)[^)]+['"]error['"]\)/i,
    );
  });

  it('LiveSessionPage imports useToastStore and calls addToast on join-as failures', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');
    expect(src).toMatch(/import\s+\{\s*useToastStore\s*\}\s+from\s+['"]@\/stores\/toastStore['"]/);
    expect(src).toMatch(/addToast\s*=\s*useToastStore/);
    // All three join-as-related catches use addToast (banner host,
    // banner participant, revert banner).
    const catchToasts = src.match(/catch[\s\S]{0,150}addToast\([^)]+['"]error['"]\)/g) || [];
    expect(catchToasts.length).toBeGreaterThanOrEqual(3);
  });

  it('LiveSessionPage no longer has console.error stopgaps for acting-as-host calls', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');
    expect(src).not.toMatch(/console\.error\([^)]*acting_as_host/i);
  });
});

describe('Phase S — host-initiated demote/promote endpoint', () => {
  describe('REST endpoint POST /sessions/:id/host/acting-as-host-for/:userId', () => {
    const src = readServer('routes/host.ts');

    it('declares the route with the per-user path param', () => {
      expect(src).toMatch(/['"]\/:id\/host\/acting-as-host-for\/:userId['"]/);
    });

    it('uses verifyHostOrSuperAdmin as the auth gate (caller must be host)', () => {
      const routeIdx = src.indexOf("'/:id/host/acting-as-host-for/:userId'");
      expect(routeIdx).toBeGreaterThan(-1);
      const block = src.slice(routeIdx, routeIdx + 1500);
      expect(block).toMatch(/verifyHostOrSuperAdmin\(req,\s*next\)/);
    });

    it('refuses with 403 when target === session.hostUserId (director invariant)', () => {
      const routeIdx = src.indexOf("'/:id/host/acting-as-host-for/:userId'");
      const block = src.slice(routeIdx, routeIdx + 1500);
      // Director cannot be demoted regardless of caller's role.
      expect(block).toMatch(/session\.hostUserId\s*===\s*targetUserId/);
      expect(block).toMatch(/ForbiddenError\([^)]*director\s+cannot\s+be\s+demoted/i);
    });

    it('refuses with 403 when target === caller (use self-toggle endpoint)', () => {
      const routeIdx = src.indexOf("'/:id/host/acting-as-host-for/:userId'");
      const block = src.slice(routeIdx, routeIdx + 1500);
      expect(block).toMatch(/targetUserId\s*===\s*callerUserId/);
      expect(block).toMatch(/ForbiddenError\([^)]*self-toggle/i);
    });

    it('delegates to sessionService.setActingAsHost with target userId + body value', () => {
      const routeIdx = src.indexOf("'/:id/host/acting-as-host-for/:userId'");
      const block = src.slice(routeIdx, routeIdx + 1500);
      expect(block).toMatch(
        /sessionService\.setActingAsHost\(\s*sessionId,\s*targetUserId,\s*req\.body\.value/,
      );
    });

    it('notifies the TARGET (not the caller) via permissions:updated', () => {
      const routeIdx = src.indexOf("'/:id/host/acting-as-host-for/:userId'");
      // Handler body is fairly long (two guards + setActingAsHost +
      // notify + res.json); widen the slice so the regex covers the
      // emitPermissionsUpdated call near the bottom.
      const block = src.slice(routeIdx, routeIdx + 3000);
      // Phase 5: notifyPermissionsUpdated wrapper deleted from
      // orchestration.service.ts; routes now call emitPermissionsUpdated
      // directly from server/src/realtime/fanout.ts (the helper still emits
      // the surviving permissions:updated socket event AND the entity-tag
      // fanout for queries).
      expect(block).toMatch(
        /emitPermissionsUpdated\(\s*sessionId,\s*targetUserId/,
      );
    });

    it('zod schema accepts { value: boolean | null } (same shape as self-toggle)', () => {
      expect(src).toMatch(
        /actingAsHostForSchema\s*=\s*z\.object\(\s*\{[\s\S]{0,100}value:\s*z\.union\(\[z\.boolean\(\),\s*z\.null\(\)\]\)/,
      );
    });
  });

  describe('HostControlCenter — RowActions consolidated cohost controls', () => {
    const src = readClient('features/live/HostControlCenter.tsx');

    // Bug K (15 May Ali) — pre-fix there were TWO buttons per row that
    // looked like the same action: "Make co-host" (permanent session_
    // cohosts grant) and "Switch to host" (per-event Phase M override).
    // Both granted host UI for THIS event (session_cohosts is per-
    // session anyway), so the duplication confused users. We consolidated
    // to the formal Make / Remove co-host path only. Admins keep the
    // per-event opt-in pathway through the Phase M banner on their own
    // row — director-initiated per-event role flips are no longer
    // possible (and weren't a real workflow anyway).
    //
    // Bug J (15 May Ali) — Make / Remove co-host + Kick are now disabled
    // for admin / super_admin targets with an explanatory tooltip;
    // admins manage their own per-event role through the Phase M
    // banner. handleAssignCohost / handleRemoveCohost /
    // handleHostRemoveParticipant enforce the same rule server-side via
    // refuseIfAdminTarget.

    it('does NOT declare the old setActingAsHostFor handler (consolidated away)', () => {
      expect(src).not.toMatch(/const\s+setActingAsHostFor\s*=/);
    });

    it('does NOT render the duplicate "Switch to participant" / "Switch to host" buttons in RowActions', () => {
      const rowActionsIdx = src.indexOf('function RowActions(');
      expect(rowActionsIdx).toBeGreaterThan(-1);
      const block = src.slice(rowActionsIdx);
      expect(block).not.toMatch(/Switch to participant/);
      expect(block).not.toMatch(/Switch to host/);
    });

    it('RowActions accepts targetIsAdmin and disables Make/Remove co-host + Kick for admin targets', () => {
      expect(src).toMatch(/targetIsAdmin:\s*boolean/);
      // Make co-host is gated by targetIsAdmin via the disabled prop.
      expect(src).toMatch(
        /onMakeCohost[\s\S]{0,200}disabled=\{targetIsAdmin\}/,
      );
      // Remove co-host is gated by targetIsAdmin via the disabled prop.
      expect(src).toMatch(
        /onRemoveCohost[\s\S]{0,200}disabled=\{targetIsAdmin\}/,
      );
      // Kick is gated by targetIsAdmin via the disabled prop.
      expect(src).toMatch(
        /onKick[\s\S]{0,200}disabled=\{targetIsAdmin\}/,
      );
    });

    it('RowActions surfaces an explanatory tooltip when blocked', () => {
      const rowActionsIdx = src.indexOf('function RowActions(');
      const block = src.slice(rowActionsIdx);
      // The shared tooltip string explains WHY the action is gated —
      // admins manage their own per-event role from the Phase M banner.
      expect(block).toMatch(
        /Admins manage their own per-event role[\s\S]{0,150}directors\s+can'?t\s+promote/i,
      );
    });

    it('ActionButton supports a disabled prop that strips the click handler and dims the button', () => {
      const fnIdx = src.indexOf('function ActionButton(');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = src.slice(fnIdx, fnIdx + 1500);
      expect(fn).toMatch(/disabled\s*\??:\s*boolean/);
      // The handler is short-circuited when disabled; the disabled
      // attribute is also forwarded to the DOM <button>.
      expect(fn).toMatch(/onClick=\{\s*disabled\s*\?\s*undefined\s*:\s*onClick\s*\}/);
      expect(fn).toMatch(/<button[\s\S]{0,200}disabled=\{disabled\}/);
    });
  });

  describe('Server — refuseIfAdminTarget defence-in-depth on admin promote/demote/kick', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');

    it('declares refuseIfAdminTarget helper that emits ADMIN_TARGET on platform admin or super_admin targets', () => {
      // Bug J (15 May Ali) — defence in depth. The HCC disables the
      // buttons client-side, but a forged socket frame would still
      // succeed without this gate.
      expect(src).toMatch(/async function refuseIfAdminTarget\(/);
      // Reads the global role from users.role.
      expect(src).toMatch(
        /SELECT\s+role[\s\S]{0,50}FROM\s+users\s+WHERE\s+id\s*=\s*\$1/i,
      );
      // Refuses on either tier.
      expect(src).toMatch(
        /targetRole\s*===\s*['"]admin['"]\s*\|\|\s*targetRole\s*===\s*['"]super_admin['"]/,
      );
      // Emits an error frame so the caller's UI can surface the refusal.
      expect(src).toMatch(/code:\s*['"]ADMIN_TARGET['"]/);
    });

    it('handleAssignCohost calls refuseIfAdminTarget with the session context', () => {
      // Bug 2 (18 May Stefan) — refuseIfAdminTarget now takes sessionId so
      // it can read the director and shortcircuit when the caller IS the
      // event director (supreme host carve-out).
      const fnStart = src.indexOf('export async function handleAssignCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/refuseIfAdminTarget\(socket,\s*sessionId,\s*userId\)/);
    });

    it('handleRemoveCohost calls refuseIfAdminTarget with the session context', () => {
      const fnStart = src.indexOf('export async function handleRemoveCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/refuseIfAdminTarget\(socket,\s*sessionId,\s*userId\)/);
    });

    it('handleHostRemoveParticipant calls refuseIfAdminTarget with the session context', () => {
      const fnStart = src.indexOf('export async function handleHostRemoveParticipant');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/refuseIfAdminTarget\(socket,\s*data\.sessionId,\s*data\.userId\)/);
    });
  });

  describe('Server — buildHostParticipantsView surfaces globalRole for HCC gating', () => {
    const src = readServer('services/orchestration/handlers/host-participants-view.ts');

    it('declares HostParticipantGlobalRole union with user | admin | super_admin', () => {
      expect(src).toMatch(
        /HostParticipantGlobalRole\s*=\s*['"]user['"]\s*\|\s*['"]admin['"]\s*\|\s*['"]super_admin['"]/,
      );
    });

    it('HostParticipantSummary includes globalRole alongside the per-event role', () => {
      expect(src).toMatch(/globalRole:\s*HostParticipantGlobalRole/);
    });

    it('SELECT pulls u.role::text as user_role and the mapper produces globalRole', () => {
      expect(src).toMatch(/u\.role::text AS user_role/);
      expect(src).toMatch(
        /globalRole[\s\S]{0,200}r\.user_role\s*===\s*['"]super_admin['"]/,
      );
    });
  });
});
