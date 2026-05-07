// ─── Phase 7A — Server architectural fixes for Stefan's 7th May feedback ───
//
// Pins the four server-side fixes that close real bugs from today's tests:
//
//   7A.1 — Stale-state escalation. Reconciler escalates DISCONNECTED users
//          older than 90s with no active match to LEFT, fires future-rounds
//          repair. Closes Stefan #2 (stefan@avivson.com sat in DISCONNECTED
//          for 10 minutes, never matched).
//
//   7A.2 — Pre-plan host/cohort exclusion. generateSessionSchedule now
//          accepts excludeUserIds and is called with getAllHostIds() from
//          handleHostStart. Closes Stefan #8 (host included in matches via
//          pre-plan path bug introduced by Phase 2.5A).
//
//   7A.3 — Single-source mutual stats. getPeopleMet derives both the
//          mutualMatches count AND the mutualConnections list from
//          meeting_records (canonical aggregate). Closes Stefan #5
//          (count card and list could drift when encounter_history lagged).
//
//   7A.4 — Atomic move-to-room. handleHostMoveToRoom's three DB writes
//          (end-current, end-target, insert-new) wrapped in one transaction.
//          LiveKit room created first (fail-fast). Closes Stefan #9 partial.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase 7A — Server architectural fixes for 7th May feedback', () => {
  describe('7A.1 — Stale-state escalation in reconciler', () => {
    const src = readServer('services/orchestration/state/participant-state-machine.ts');

    it('reconcileSessionStates queries DISCONNECTED users older than 90s with no active match', () => {
      const fnStart = src.indexOf('export async function reconcileSessionStates(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/sp\.status\s*=\s*'disconnected'/);
      expect(fn).toMatch(/sp\.joined_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'90 seconds'/);
      expect(fn).toMatch(/NOT EXISTS[\s\S]+?status\s*=\s*'active'/);
    });

    it('stale users are transitioned to LEFT via the chokepoint', () => {
      const fnStart = src.indexOf('export async function reconcileSessionStates(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/transitionParticipant\([\s\S]+?ParticipantState\.LEFT/);
    });

    it('escalation fires repairFutureRounds when escalated count > 0', () => {
      const fnStart = src.indexOf('export async function reconcileSessionStates(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/staleEscalated\s*>\s*0[\s\S]+?repairFutureRounds/);
    });

    it('reconciler return shape includes staleEscalated count', () => {
      const fnStart = src.indexOf('export async function reconcileSessionStates(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/staleEscalated:\s*number/);
      expect(fn).toMatch(/return\s*\{[\s\S]+?staleEscalated[\s\S]+?\}/);
    });
  });

  describe('7A.2 — Pre-plan host/cohort exclusion', () => {
    const matchingSrc = readServer('services/matching/matching.service.ts');
    const hostActionsSrc = readServer('services/orchestration/handlers/host-actions.ts');

    it('generateSessionSchedule signature accepts excludeUserIds', () => {
      expect(matchingSrc).toMatch(
        /export async function generateSessionSchedule\([\s\S]+?excludeUserIds\?:\s*string\[\]/,
      );
    });

    it('generateSessionSchedule applies excludeUserIds to the participants query', () => {
      const fnStart = matchingSrc.indexOf('export async function generateSessionSchedule(');
      const fnEnd = matchingSrc.indexOf('\n}\n', fnStart);
      const fn = matchingSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/sp\.user_id\s*!=\s*ALL\(\$2::uuid\[\]\)/);
    });

    it('handleHostStart calls generateSessionSchedule with getAllHostIds()', () => {
      const fnStart = hostActionsSrc.indexOf('export async function handleHostStart(');
      const fnEnd = hostActionsSrc.indexOf('\n// ─── Host Start Round', fnStart);
      const fn = hostActionsSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/getAllHostIds\(/);
      expect(fn).toMatch(/generateSessionSchedule\([^)]+,[^)]+,\s*planExcludeIds\)/);
    });
  });

  describe('7A.3 — Single-source mutual stats', () => {
    const src = readServer('services/rating/rating.service.ts');

    it('getPeopleMet queries mutualPartnerIds from meeting_records', () => {
      const fnStart = src.indexOf('export async function getPeopleMet(');
      const fnEnd = src.indexOf('\n// ─── Get Encounter History', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/SELECT\s+DISTINCT\s+partner_id\s+FROM\s+meeting_records/);
      expect(fn).toMatch(/is_mutual\s*=\s*TRUE/);
      expect(fn).toMatch(/mutualPartnerIds/);
    });

    it('mutualConnections list is filtered by mutualPartnerIds (not connection.mutualMeetAgain)', () => {
      const fnStart = src.indexOf('export async function getPeopleMet(');
      const fnEnd = src.indexOf('\n// ─── Get Encounter History', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/connections\.filter\(c\s*=>\s*mutualPartnerIds\.has\(c\.userId\)\)/);
    });

    it('legacy fallback path (when meeting_records read fails) still works', () => {
      const fnStart = src.indexOf('export async function getPeopleMet(');
      const fnEnd = src.indexOf('\n// ─── Get Encounter History', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/Falling back to derived counts/);
    });
  });

  describe('7A.4 — Atomic move-to-room', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');

    it('LiveKit room creation runs BEFORE the transaction (fail-fast)', () => {
      const fnStart = src.indexOf('export async function handleHostMoveToRoom(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      const liveKitIdx = fn.indexOf('videoService.createMatchRoom(');
      const transactionIdx = fn.indexOf('await transaction(async (client)');
      expect(liveKitIdx).toBeGreaterThan(-1);
      expect(transactionIdx).toBeGreaterThan(-1);
      expect(liveKitIdx).toBeLessThan(transactionIdx);
    });

    it('end-current + end-target + insert-new wrapped in one transaction', () => {
      const fnStart = src.indexOf('export async function handleHostMoveToRoom(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      const transactionStart = fn.indexOf('await transaction(async (client)');
      const transactionEnd = fn.indexOf('});', transactionStart);
      const insideTx = fn.slice(transactionStart, transactionEnd);
      // Both UPDATE statements + the INSERT live inside the transaction
      const updateCount = (insideTx.match(/client\.query\(\s*`?UPDATE matches SET status = 'completed'/g) || []).length;
      expect(updateCount).toBeGreaterThanOrEqual(2);
      expect(insideTx).toMatch(/client\.query[\s\S]+?INSERT INTO matches/);
    });

    it('catch block surfaces PARTICIPANT_ALREADY_MATCHED on unique-violation rollback', () => {
      const fnStart = src.indexOf('export async function handleHostMoveToRoom(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/PARTICIPANT_ALREADY_MATCHED/);
      expect(fn).toMatch(/MATCH_CREATION_FAILED/);
    });

    it('partner-bye notification fires AFTER the transaction commits', () => {
      const fnStart = src.indexOf('export async function handleHostMoveToRoom(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      const txEnd = fn.indexOf('});', fn.indexOf('await transaction(async (client)'));
      const afterTx = fn.slice(txEnd);
      expect(afterTx).toMatch(/match:return_to_lobby/);
    });
  });
});
