// Regression tests for the match-status semantics refactor (Change 4.6).
//
// These tests assert that Change 4.5 behaviors are preserved AFTER the
// semantic fix to no_show/completed/cancelled/reassigned. The live-event
// scenario that motivated this fix: session 1e13d771 round 3 on 2026-04-17
// where 2 voluntary-leave matches were incorrectly marked no_show despite
// both participants submitting 5-star mutual ratings.

describe('match-status semantics refactor — regression for Change 4.5', () => {
  describe('state machine constants', () => {
    it('exports RATABLE_STATUSES including completed and reassigned', async () => {
      const { RATABLE_STATUSES } = await import('../../../types/match-status');
      expect(RATABLE_STATUSES).toContain('completed');
      expect(RATABLE_STATUSES).toContain('reassigned');
      expect(RATABLE_STATUSES).toContain('no_show');
      expect(RATABLE_STATUSES).not.toContain('cancelled'); // handled by 30s grace in rating.service
    });

    it('exports REAL_CONVERSATION_STATUSES for stats queries', async () => {
      const { REAL_CONVERSATION_STATUSES } = await import('../../../types/match-status');
      expect(REAL_CONVERSATION_STATUSES).toEqual(['completed', 'reassigned']);
    });

    it('exports CANCELLED_RATING_GRACE_MS = 30 seconds', async () => {
      const { CANCELLED_RATING_GRACE_MS } = await import('../../../types/match-status');
      expect(CANCELLED_RATING_GRACE_MS).toBe(30_000);
    });

    it('exports BLOCKS_FUTURE_REMATCH excluding no_show and cancelled', async () => {
      const { BLOCKS_FUTURE_REMATCH } = await import('../../../types/match-status');
      expect(BLOCKS_FUTURE_REMATCH).toContain('completed');
      expect(BLOCKS_FUTURE_REMATCH).toContain('reassigned');
      expect(BLOCKS_FUTURE_REMATCH).not.toContain('no_show');
      expect(BLOCKS_FUTURE_REMATCH).not.toContain('cancelled');
    });
  });

  describe('Change 4.5 commit cb66184 — ghost timer clearRoomTimers', () => {
    it('clearRoomTimers export still present on host-actions module', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/host-actions');
      expect(typeof mod.clearRoomTimers).toBe('function');
    });
  });

  describe('WS2 (27 May remaining work) — reassign flows removed for good', () => {
    // Change 4.5 (commit 7d3efb8) introduced the isolated-participants helper
    // for the auto-reassign ladder. WS2 inverted the product rule — a room
    // dropping below 2 ENDS for the survivor (rating → main), never re-pairs —
    // so the helper and its call sites were deleted. Pin the deletion: the
    // module must stay gone (a re-introduction means someone resurrected
    // re-pairing without revisiting the agreed spec).
    it('the isolated-participants module no longer exists', () => {
      const fs = require('fs');
      const path = require('path');
      const modulePath = path.join(__dirname, '../../../services/matching/isolated-participants.ts');
      expect(fs.existsSync(modulePath)).toBe(false);
    });
  });

  describe('no_show writes — only legitimate sites remain', () => {
    // This is a structural test: we assert that participant-flow and host-actions
    // no longer write status='no_show'. The only legitimate sites are in
    // round-lifecycle.ts:detectNoShows (2 writes for one/both absent).
    it('participant-flow.ts has zero status=no_show UPDATEs', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'),
        'utf8'
      );
      const matches = content.match(/status\s*=\s*'no_show'/g) || [];
      expect(matches.length).toBe(0);
    });

    it('host-actions.ts has zero status=no_show UPDATEs', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8'
      );
      const matches = content.match(/status\s*=\s*'no_show'/g) || [];
      expect(matches.length).toBe(0);
    });

    it('round-lifecycle.ts has exactly 2 legitimate status=no_show writes (detectNoShows)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/round-lifecycle.ts'),
        'utf8'
      );
      const matches = content.match(/status\s*=\s*'no_show'/g) || [];
      expect(matches.length).toBe(2);
    });
  });

  describe('Change 4.5 commit 3975009 — rating flow preserved', () => {
    it('rating service allowlist includes completed, active, no_show, scheduled, reassigned', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/rating/rating.service.ts'),
        'utf8'
      );
      // Verify the RATABLE array / allowlist contains all 5 expected statuses
      expect(content).toMatch(/'completed'.*'active'.*'no_show'.*'scheduled'.*'reassigned'|'completed',[\s\S]*?'active',[\s\S]*?'no_show',[\s\S]*?'scheduled',[\s\S]*?'reassigned'/);
    });

    it('rating service handles cancelled via 30s grace window', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/rating/rating.service.ts'),
        'utf8'
      );
      expect(content).toMatch(/CANCELLED_GRACE_MS|30_000|grace/i);
      expect(content).toMatch(/ended_at/);
    });
  });
});
