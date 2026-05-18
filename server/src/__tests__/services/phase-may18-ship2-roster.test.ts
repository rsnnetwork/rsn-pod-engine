// Stefan's 18 May test feedback — Ship #2 architectural fixes.
//
// Bug 12 / Bug 68 — cohort HCC empty + UI refresh stuck after action.
// Stefan's mandate: "the whole system must react instantly according to
// any action". One pattern fixes all of these: every server-side roster
// mutation broadcasts `roster:changed` to the session room. Every client
// refetches the snapshot, which now bundles hccParticipants directly so
// the HCC drawer never renders empty.
//
// Plus emitHostDashboardForce on cohost promote/demote — bypasses the
// 1-second coalesce so a newly-promoted cohost's HCC populates with
// zero perceptible delay.

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
function readShared(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../shared/src', rel),
    'utf8',
  );
}

describe('Stefan 18 May — Ship #2 architectural fixes', () => {
  describe('Snapshot bundles hccParticipants for self-hydrating HCC', () => {
    const snapshotSrc = readServer('services/session/session-state-snapshot.service.ts');

    it('SessionStateSnapshot declares hccParticipants array on the interface', () => {
      expect(snapshotSrc).toMatch(/hccParticipants:\s*Array</);
      // Includes role + globalRole + state — same shape buildHostParticipantsView emits.
      expect(snapshotSrc).toMatch(
        /role:\s*'host'\s*\|\s*'cohost'\s*\|\s*'participant'/,
      );
      expect(snapshotSrc).toMatch(
        /globalRole:\s*'user'\s*\|\s*'admin'\s*\|\s*'super_admin'/,
      );
    });

    it('buildSessionStateSnapshot calls buildHostParticipantsView and returns hccParticipants', () => {
      // Dynamic import keeps the snapshot service decoupled from the
      // orchestration module at import-time.
      expect(snapshotSrc).toMatch(
        /import\([^)]*orchestration\/handlers\/host-participants-view[^)]*\)/,
      );
      expect(snapshotSrc).toMatch(/buildHostParticipantsView\(\{/);
      // Returned in the snapshot composition.
      expect(snapshotSrc).toMatch(/hccParticipants,/);
    });
  });

  describe('roster:changed broadcast covers every roster mutation', () => {
    const orchSrc = readServer('services/orchestration/orchestration.service.ts');
    const actionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
    const eventsSrc = readShared('types/events.ts');

    it('shared event types declare roster:changed', () => {
      expect(eventsSrc).toMatch(
        /'roster:changed':[\s\S]{0,200}sessionId:\s*string;\s*cause:\s*string/,
      );
    });

    it('notifyPermissionsUpdated broadcasts roster:changed to sessionRoom', () => {
      const fnStart = orchSrc.indexOf('export async function notifyPermissionsUpdated');
      expect(fnStart).toBeGreaterThan(-1);
      const fn = orchSrc.slice(fnStart, fnStart + 2000);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*'roster:changed'/);
    });

    it('handleAssignCohost broadcasts roster:changed after the cohost:assigned emit', () => {
      const fnStart = actionsSrc.indexOf('export async function handleAssignCohost');
      const fnEnd = actionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = actionsSrc.slice(fnStart, fnEnd);
      // Both emits live in this handler; the roster:changed comes after
      // the cohost:assigned + permissions:updated pair. Widen the gap
      // since permissions:updated carries the capability list.
      expect(fn).toMatch(/emit\(\s*'cohost:assigned'/);
      expect(fn).toMatch(/emit\(\s*'roster:changed'[\s\S]{0,300}cohost_assigned/);
    });

    it('handleRemoveCohost broadcasts roster:changed after the cohost:removed emit', () => {
      const fnStart = actionsSrc.indexOf('export async function handleRemoveCohost');
      const fnEnd = actionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = actionsSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(
        /emit\(\s*'cohost:removed'[\s\S]{0,800}emit\(\s*'roster:changed'[\s\S]{0,200}cohost_removed/,
      );
    });

    it('handleHostRemoveParticipant (kick) broadcasts roster:changed', () => {
      const fnStart = actionsSrc.indexOf('export async function handleHostRemoveParticipant');
      const fnEnd = actionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = actionsSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(
        /emit\(\s*'roster:changed'[\s\S]{0,200}participant_kicked/,
      );
    });
  });

  describe('Cohost promote bypasses the dashboard coalesce', () => {
    const actionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
    const orchSrc = readServer('services/orchestration/orchestration.service.ts');

    it('host-actions deps interface declares the force variant', () => {
      expect(actionsSrc).toMatch(/emitHostDashboardForce\?:\s*\(sessionId:\s*string\)/);
      expect(actionsSrc).toMatch(/_emitHostDashboardForce\s*=\s*deps\.emitHostDashboardForce/);
    });

    it('orchestration wires emitHostDashboardForce into host-actions deps', () => {
      expect(orchSrc).toMatch(/emitHostDashboardForce:\s*\(sessionId\)\s*=>\s*emitHostDashboardForce/);
      expect(orchSrc).toMatch(/emitHostDashboardForce, injectMatchingFlowDeps/);
    });

    it('handleAssignCohost prefers the force variant when available', () => {
      const fnStart = actionsSrc.indexOf('export async function handleAssignCohost');
      const fnEnd = actionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = actionsSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(
        /if\s*\(_emitHostDashboardForce\)\s*await\s*_emitHostDashboardForce\(sessionId\)/,
      );
    });

    it('handleRemoveCohost prefers the force variant when available', () => {
      const fnStart = actionsSrc.indexOf('export async function handleRemoveCohost');
      const fnEnd = actionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = actionsSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(
        /if\s*\(_emitHostDashboardForce\)\s*await\s*_emitHostDashboardForce\(sessionId\)/,
      );
    });

    it('notifyPermissionsUpdated also uses the force variant via dynamic import', () => {
      const fnStart = orchSrc.indexOf('export async function notifyPermissionsUpdated');
      const fn = orchSrc.slice(fnStart, fnStart + 2000);
      expect(fn).toMatch(/emitHostDashboardForce/);
    });
  });

  describe('Client picks up roster:changed and the snapshot hccParticipants', () => {
    const socketSrc = readClient('hooks/useSessionSocket.ts');
    const storeSrc = readClient('stores/sessionStore.ts');
    const hccSrc = readClient('features/live/HostControlCenter.tsx');

    it('client subscribes to roster:changed and refetches the snapshot', () => {
      expect(socketSrc).toMatch(/'roster:changed'/);
      expect(socketSrc).toMatch(
        /socket\.on\(\s*'roster:changed'[\s\S]{0,200}fetchSessionStateSnapshot/,
      );
    });

    it('client store carries hccParticipants and hydrates it from the snapshot', () => {
      expect(storeSrc).toMatch(/hccParticipants:\s*Array</);
      expect(storeSrc).toMatch(
        /hccParticipants:[\s\S]{0,80}snapshot[\s\S]{0,30}hccParticipants/,
      );
      // reset() clears the array so a new session doesn't inherit the old roster.
      expect(storeSrc).toMatch(/hccParticipants:\s*\[\]/);
    });

    it('HCC falls back to snapshot hccParticipants when the live dashboard is empty', () => {
      // The rawParticipants resolver prefers the live event, then the
      // last non-empty snapshot of the event, then the snapshot bundle.
      expect(hccSrc).toMatch(/snapshotHccParticipants\s*=\s*useSessionStore/);
      expect(hccSrc).toMatch(/snapshotHccParticipants\s*\?\?\s*\[\]/);
    });
  });
});
