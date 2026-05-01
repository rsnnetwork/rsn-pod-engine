// Phase 6 — Platform-spec spec, 29 April 2026.
//
// Stefan's clarification: "Mutual matches" on the recap = distinct people
// met. "Want to meet again" = both-said-yes subset (separate stat).
// User's complaint pre-fix: "0 people met with 2 mutual matches" — the
// labels in the UI were computed from different sources than the email,
// and "people met" was an inflated count that included duplicate
// meetings (same partner met twice = 2 people met instead of 1).
//
// These tests pin Phase 6:
//   1. Client RecapPage participant stats use new Set(...) for distinct
//      people-met count (the "Mutual Matches" stat). Previously
//      data.connections.length leaked duplicates.
//   2. Labels match Stefan's terminology: "Mutual Matches" + "Want to
//      Meet Again".
//   3. Email recap labels match the UI labels (no UI/email divergence).
//   4. Host recap email shows "Matches Created / Successful: X / Y" via
//      the new optional matchesCreated field. Old callers fall back to
//      the single "Matches" line.
//   5. round-lifecycle.ts caller queries both COUNT(*) and the
//      status='completed' subset and passes both to the email.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

describe('Phase 6 — stats parity (Q8) + UI/email label alignment', () => {
  describe('client RecapPage participant stats use deterministic counts (superseded by Phase 2)', () => {
    const src = readClient('features/sessions/RecapPage.tsx');

    // Phase 2 (1 May 2026) supersedes Phase 6's labeling. The new strict
    // definitions are: People Met (distinct), Total Meetings (with repeats),
    // Mutual Matches (both said yes). All three come from the SAME server
    // aggregate (meeting_records) so they can never drift between renders.
    // The fallback path still derives via Set when the server omits them
    // (older sessions where the table didn't backfill yet).

    it('participant stats fall back to Set-based dedup when server omits uniquePeopleMet', () => {
      expect(src).toMatch(/new Set\(data\.connections\.map\(c\s*=>\s*c\.userId\)\)\.size/);
    });

    it('label says "People Met" (Phase 2: distinct partners)', () => {
      expect(src).toMatch(/>People Met</);
    });

    it('label says "Total Meetings" (Phase 2: includes repeats)', () => {
      expect(src).toMatch(/>Total Meetings</);
    });

    it('label says "Mutual Matches" (Phase 2: both said yes)', () => {
      expect(src).toMatch(/>Mutual Matches</);
    });
  });

  describe('email sendSessionRecapEmail labels match the UI', () => {
    const src = readServer('services/email/email.service.ts');

    it('HTML uses "Mutual Matches" label for the peopleMet field', () => {
      // The data property name stays peopleMet for back-compat; only the
      // rendered label changed. peopleMet is computed via COUNT(DISTINCT)
      // upstream in round-lifecycle.ts, so this is the distinct count.
      expect(src).toMatch(/data\.peopleMet[\s\S]+?>\s*Mutual Matches\s*</);
    });

    it('HTML uses "Want to Meet Again" label for the mutualConnections field', () => {
      expect(src).toMatch(/data\.mutualConnections[\s\S]+?>\s*Want to Meet Again\s*</);
    });

    it('plain-text version uses the same labels as HTML', () => {
      expect(src).toMatch(/Mutual Matches:\s*\$\{data\.peopleMet\}/);
      expect(src).toMatch(/Want to Meet Again:\s*\$\{data\.mutualConnections\}/);
    });
  });

  describe('host recap email shows Matches Created / Successful', () => {
    const src = readServer('services/email/email.service.ts');

    it('HostRecapEmailData interface declares optional matchesCreated', () => {
      expect(src).toMatch(/matchesCreated\?:\s*number/);
    });

    it('HTML renders "Matches Created / Successful" when matchesCreated is provided', () => {
      expect(src).toMatch(/data\.matchesCreated\s*!=\s*null[\s\S]+?Matches Created \/ Successful/);
    });

    it('HTML falls back to single "Matches" label when matchesCreated is absent', () => {
      expect(src).toMatch(/data\.matchesCreated\s*!=\s*null\s*\?[\s\S]+?:\s*['"]Matches['"]/);
    });

    it('plain-text version also splits matches when matchesCreated is provided', () => {
      expect(src).toMatch(/matchesLine[\s\S]+?Matches Created \/ Successful:\s*\$\{data\.matchesCreated\}\s*\/\s*\$\{data\.totalMatches\}/);
    });
  });

  describe('round-lifecycle caller passes both match counts to host recap', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');

    it('queries SUCCESSFUL match count (status=completed)', () => {
      expect(src).toMatch(/totalMatchesResult[\s\S]+?status\s*=\s*['"]completed['"]/);
    });

    it('queries CREATED match count (NOT IN cancelled/scheduled)', () => {
      expect(src).toMatch(/matchesCreatedResult[\s\S]+?NOT IN \(['"]cancelled['"]\s*,\s*['"]scheduled['"]\)/);
    });

    it('passes both totalMatches and matchesCreated to sendHostRecapEmail', () => {
      const emailCall = src.indexOf('emailService.sendHostRecapEmail');
      expect(emailCall).toBeGreaterThan(-1);
      const callBody = src.slice(emailCall, emailCall + 800);
      expect(callBody).toMatch(/totalMatches:\s*parseInt\(totalMatchesResult/);
      expect(callBody).toMatch(/matchesCreated:\s*parseInt\(matchesCreatedResult/);
    });
  });
});
