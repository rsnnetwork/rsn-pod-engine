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
      // notifyPermissionsUpdated call near the bottom.
      const block = src.slice(routeIdx, routeIdx + 3000);
      expect(block).toMatch(
        /orchestrationService\.notifyPermissionsUpdated\(\s*sessionId,\s*targetUserId/,
      );
    });

    it('zod schema accepts { value: boolean | null } (same shape as self-toggle)', () => {
      expect(src).toMatch(
        /actingAsHostForSchema\s*=\s*z\.object\(\s*\{[\s\S]{0,100}value:\s*z\.union\(\[z\.boolean\(\),\s*z\.null\(\)\]\)/,
      );
    });
  });

  describe('HostControlCenter — Switch to participant / Switch to host buttons', () => {
    const src = readClient('features/live/HostControlCenter.tsx');

    it('declares setActingAsHostFor handler that posts to the per-user REST endpoint', () => {
      expect(src).toMatch(/const\s+setActingAsHostFor\s*=/);
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/acting-as-host-for\/\$\{targetUserId\}[`'"]\s*,\s*\{\s*value\s*\}/,
      );
    });

    it('optimistic local update + revert on failure', () => {
      const fnStart = src.indexOf('const setActingAsHostFor');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\n  };', fnStart) + 5;
      const fn = src.slice(fnStart, fnEnd);
      // Captures previous, applies new, reverts in catch.
      expect(fn).toMatch(/const\s+prev\s*=\s*actingAsHostOverrides\[targetUserId\]/);
      expect(fn).toMatch(/setActingAsHostOverrides\(next\)/);
      expect(fn).toMatch(/setActingAsHostOverrides\(reverted\)/);
      // Toast on failure (Phase R).
      expect(fn).toMatch(/addToast\([^)]+['"]error['"]\)/);
    });

    it('RowActions component receives the new onDemoteToParticipant + onPromoteToHost callbacks', () => {
      expect(src).toMatch(/onDemoteToParticipant:\s*\(\)\s*=>\s*void/);
      expect(src).toMatch(/onPromoteToHost:\s*\(\)\s*=>\s*void/);
      expect(src).toMatch(/actingAsHostValue:\s*boolean\s*\|\s*undefined/);
    });

    it('RowActions renders "Switch to participant" for cohorts (acting as host)', () => {
      // The render condition: isCohost && actingAsHostValue !== false →
      // show the demote button. Otherwise (participant) → show promote.
      const rowActionsIdx = src.indexOf('function RowActions(');
      expect(rowActionsIdx).toBeGreaterThan(-1);
      const block = src.slice(rowActionsIdx, src.length);
      expect(block).toMatch(/isCohost\s*&&\s*actingAsHostValue\s*!==\s*false/);
      expect(block).toMatch(/Switch to participant/);
      expect(block).toMatch(/Switch to host/);
    });
  });
});
