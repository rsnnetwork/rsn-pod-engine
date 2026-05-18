// ─── Phase 3 — Host dashboard UI + sync ────────────────────────────────────
//
// Pins the architectural surfaces shipped in Phase 3:
//   3A — useSessionSocket consumes host:event_plan_generated +
//        host:event_plan_repaired and fires toasts via useToastStore
//   3B — GET /sessions/:id/plan endpoint exists, host-or-cohost auth,
//        returns aggregate per-round status; client renders EventPlanStrip
//   3C — every host mutation handler ends with a canonical-state emit
//        (sendMatchPreview for preview-phase actions, emitHostDashboard
//        for round-active actions)
//
// Server-side pins live in this file; client-side pins in
// client/src/__tests__/... are not part of the standard server jest run
// but a manual browser walk on staging is the closing verification.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

describe('Phase 3 — Host dashboard UI + sync', () => {
  describe('Sub-phase 3A — toast consumers wired in useSessionSocket.ts', () => {
    const src = readClient('hooks/useSessionSocket.ts');

    it('imports useToastStore', () => {
      expect(src).toMatch(/from\s+['"]@\/stores\/toastStore['"]/);
    });

    it('host:event_plan_generated registered in SOCKET_EVENTS list', () => {
      expect(src).toMatch(/'host:event_plan_generated'/);
    });

    it('host:event_plan_repaired registered in SOCKET_EVENTS list', () => {
      expect(src).toMatch(/'host:event_plan_repaired'/);
    });

    it('host:event_plan_generated listener fires a toast', () => {
      const startIdx = src.indexOf("socket.on('host:event_plan_generated'");
      expect(startIdx).toBeGreaterThan(-1);
      const slice = src.slice(startIdx, startIdx + 600);
      expect(slice).toMatch(/useToastStore\.getState\(\)\.addToast/);
      expect(slice).toMatch(/Event plan ready/);
    });

    it('host:event_plan_repaired listener fires an info toast with reason text', () => {
      const startIdx = src.indexOf("socket.on('host:event_plan_repaired'");
      expect(startIdx).toBeGreaterThan(-1);
      // Bug 18 (18 May Stefan) — listener body grew (eventPlanSummary
      // update on repair) so widen the slice past the new code.
      const slice = src.slice(startIdx, startIdx + 1800);
      expect(slice).toMatch(/useToastStore\.getState\(\)\.addToast/);
      expect(slice).toMatch(/Plan updated/);
      expect(slice).toMatch(/late_joiner/);
      expect(slice).toMatch(/left/);
      // Bug 18 also pins that the listener writes the new roundCount /
      // totalPairs back into the store so the headline summary stays in
      // sync with the per-round badges.
      expect(slice).toMatch(/setEventPlanSummary/);
    });

    it('sessionStore exposes setEventPlanSummary action', () => {
      const storeSrc = readClient('stores/sessionStore.ts');
      expect(storeSrc).toMatch(/setEventPlanSummary:\s*\(/);
      expect(storeSrc).toMatch(/eventPlanSummary:\s*\{/);
    });
  });

  describe('Sub-phase 3B — /sessions/:id/plan endpoint + EventPlanStrip', () => {
    describe('server endpoint', () => {
      const src = readServer('routes/sessions.ts');

      it('registers GET /:id/plan', () => {
        expect(src).toMatch(/router\.get\(\s*['"]\/:id\/plan['"]/);
      });

      it('uses authenticate middleware', () => {
        const routeStart = src.indexOf("'/:id/plan'");
        const routeEnd = src.indexOf('async (req', routeStart);
        const slice = src.slice(routeStart, routeEnd);
        expect(slice).toMatch(/authenticate/);
      });

      it('rejects non-host non-cohost non-admin with ForbiddenError', () => {
        const routeStart = src.indexOf("'/:id/plan'");
        const routeEnd = src.indexOf('export default router', routeStart);
        const slice = src.slice(routeStart, routeEnd);
        expect(slice).toMatch(/ForbiddenError/);
        expect(slice).toMatch(/host_user_id/);
      });

      it('returns aggregate per-round status with pairCount, byeCount, hasFallback', () => {
        const routeStart = src.indexOf("'/:id/plan'");
        const routeEnd = src.indexOf('export default router', routeStart);
        const slice = src.slice(routeStart, routeEnd);
        expect(slice).toMatch(/roundNumber/);
        expect(slice).toMatch(/pairCount/);
        expect(slice).toMatch(/byeCount/);
        expect(slice).toMatch(/hasFallback/);
      });

      it('includes every round 1..totalRounds even if not yet planned', () => {
        const routeStart = src.indexOf("'/:id/plan'");
        const routeEnd = src.indexOf('export default router', routeStart);
        const slice = src.slice(routeStart, routeEnd);
        expect(slice).toMatch(/for\s*\(\s*let\s+r\s*=\s*1\s*;\s*r\s*<=\s*totalRounds/);
        expect(slice).toMatch(/'unplanned'/);
      });
    });

    describe('client EventPlanStrip', () => {
      const src = readClient('features/live/EventPlanStrip.tsx');

      it('component file exists', () => {
        expect(src.length).toBeGreaterThan(0);
      });

      it('fetches /sessions/:id/plan via react-query', () => {
        expect(src).toMatch(/useQuery/);
        expect(src).toMatch(/api\.get\(`?\/sessions\/\$\{sessionId\}\/plan`?\)/);
      });

      it('refetches on host:event_plan_generated and host:event_plan_repaired', () => {
        expect(src).toMatch(/socket\.on\(['"]host:event_plan_generated['"]/);
        expect(src).toMatch(/socket\.on\(['"]host:event_plan_repaired['"]/);
        expect(src).toMatch(/queryClient\.invalidateQueries/);
      });

      it('renders status labels for each plan state', () => {
        ['completed', 'active', 'planned', 'cancelled', 'unplanned', 'mixed'].forEach(s => {
          expect(src).toMatch(new RegExp(`['"]${s}['"]`));
        });
      });
    });

    describe('HostControls renders EventPlanStrip when session has started', () => {
      const src = readClient('features/live/HostControls.tsx');

      it('imports EventPlanStrip', () => {
        expect(src).toMatch(/import\s+EventPlanStrip\s+from/);
      });

      it('renders <EventPlanStrip /> conditionally on sessionStarted', () => {
        expect(src).toMatch(/sessionStarted\s*&&\s*<EventPlanStrip\s+sessionId=\{sessionId\}\s*\/>/);
      });
    });
  });

  describe('Sub-phase 3C — host mutations end with canonical-state emit', () => {
    const matchingFlowSrc = readServer('services/orchestration/handlers/matching-flow.ts');
    const hostActionsSrc = readServer('services/orchestration/handlers/host-actions.ts');

    it('handleHostGenerateMatches ends with sendMatchPreview', () => {
      const fnStart = matchingFlowSrc.indexOf('export async function handleHostGenerateMatches(');
      const fnEnd = matchingFlowSrc.indexOf('\n// ─── Host Confirm Round', fnStart);
      const fn = matchingFlowSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/sendMatchPreview\(/);
    });

    it('handleHostRegenerateMatches ends with sendMatchPreview', () => {
      const fnStart = matchingFlowSrc.indexOf('export async function handleHostRegenerateMatches(');
      const fnEnd = matchingFlowSrc.indexOf('\n// ─── Host Force Match', fnStart);
      const fn = matchingFlowSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/sendMatchPreview\(/);
    });

    it('handleHostForceMatch ends with sendMatchPreview', () => {
      const fnStart = matchingFlowSrc.indexOf('export async function handleHostForceMatch(');
      const fnEnd = matchingFlowSrc.indexOf('\n// ─── Host Cancel Preview', fnStart);
      const fn = matchingFlowSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/sendMatchPreview\(/);
    });

    it('handleHostRemoveParticipant calls emitHostDashboard', () => {
      const fnStart = hostActionsSrc.indexOf('export async function handleHostRemoveParticipant(');
      const fnEnd = hostActionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = hostActionsSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/_emitHostDashboard\(/);
    });
  });
});
