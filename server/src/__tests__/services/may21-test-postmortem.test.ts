// May 21 RSN test post-mortem — source-pattern regression pins for the
// three architectural fixes shipped after the live test on 21 May 2026.
//
// Live test surfaced:
//   M1 — UI participant count desynced (8 actual → 5 visible). Root cause
//        was the 15 s disconnect timeout auto-marking users as LEFT, which
//        the snapshot filter (`status NOT IN ('left',...)`) then excluded.
//   M3 — Alex + Saif paired in 4 of 4 rounds; "already met" logic ignored
//        `participant_c_id` so 3-way matches never recorded that the third
//        person had met the other two.
//
// These tests assert the fix shape directly against the source so a
// future refactor can't silently revert the contract.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('May 21 test post-mortem — M1 + M3 architectural fixes', () => {
  // ─── M1 fix A — disconnect timeout no longer auto-marks users as LEFT ────
  describe('M1 — disconnect timeout drops LEFT transition', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');

    it('disconnect timeout block no longer calls transitionParticipant(..., LEFT)', () => {
      // Locate the disconnect-timeout block. The 15 s setTimeout body has
      // a clearly identifying comment ("Phase 2.7" prior, "M1 fix (21 May Ali)"
      // post). After the fix, the body between those landmarks MUST NOT
      // contain a LEFT transition call.
      const m1Idx = src.indexOf('M1 fix (21 May Ali)');
      expect(m1Idx).toBeGreaterThan(-1);
      const block = src.slice(m1Idx, m1Idx + 3000);
      // Inside the disconnect-timeout window, no LEFT transition fires.
      expect(block).not.toMatch(/transitionParticipant\([^)]*ParticipantState\.LEFT/);
      // And no plan-repair triggered with 'left' reason from inside this
      // window — they didn't actually leave.
      expect(block).not.toMatch(/maybeRepairFutureRounds\([^)]*'left'/);
    });

    it('Bug 36 host/cohost LEFT carve-out and its hcRow lookup are gone', () => {
      // The carve-out is now dead code; removed entirely.
      expect(src).not.toMatch(/Bug 36: skipping LEFT transition for host\/cohost on disconnect/);
      expect(src).not.toMatch(/isHostOrCohostDc/);
    });

    it('explicit session:leave handler STILL marks user LEFT (only auto-LEFT is removed)', () => {
      // Phase A1 marker for the explicit-leave handler. The fix only
      // removes AUTO-LEFT on disconnect timeout — explicit user action
      // still must transition to LEFT. Span is generous because the
      // marker comment and the call are separated by several lines of
      // imperative comments.
      expect(src).toMatch(/Phase A1[\s\S]{0,2000}ParticipantStatus\.LEFT/);
    });

    it('match-ending logic (terminal status via trio-aware demote) still runs after the dropped LEFT', () => {
      // WS2 (27 May remaining work) — the auto-reassign ladder was removed:
      // a room dropping below 2 now ENDS for the survivor (rating → main)
      // instead of re-pairing. The match-ending contract survives via
      // demoteParticipantFromMatch inside the shared match-end grace.
      const m1Idx = src.indexOf('M1 fix (21 May Ali)');
      const after = src.slice(m1Idx, m1Idx + 5000);
      // The terminal-status block must come AFTER the M1 comment block.
      expect(after).toMatch(/Determine terminal status based on actual conversation state/);
      // And the trio-aware match-ending demote.
      expect(after).toMatch(/demoteParticipantFromMatch/);
    });
  });

  // ─── M1 fix B — event-end sweep marks remaining participants LEFT ───────
  describe('M1 — completeSession sweeps remaining participants to LEFT', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');

    it('completeSession includes a session_participants sweep with COALESCE(left_at, NOW())', () => {
      const idx = src.indexOf('export async function completeSession');
      expect(idx).toBeGreaterThan(-1);
      // S18 widened 6500 → 9000: the early in-memory COMPLETED flip + its
      // comment block sit above the sweep now.
      const body = src.slice(idx, idx + 9000);
      // The sweep updates session_participants for the ending session.
      expect(body).toMatch(/UPDATE session_participants[\s\S]{0,400}left_at\s*=\s*COALESCE\(\s*left_at\s*,\s*NOW\(\)/);
      // Status set to 'left'.
      expect(body).toMatch(/SET\s+status\s*=\s*'left'/);
      // Only rows that aren't already in a terminal state.
      expect(body).toMatch(/status\s+NOT\s+IN\s*\(\s*'left'\s*,\s*'removed'\s*,\s*'no_show'\s*\)/);
      // Marker for the fix's intent.
      expect(body).toMatch(/M1 sweep \(21 May Ali\)/);
    });
  });

  // ─── M1 fix C — state machine clears left_at on non-terminal transitions ─
  describe('M1 — participant-state-machine clears left_at on rejoin', () => {
    const src = readServer('services/orchestration/state/participant-state-machine.ts');

    it('transitionParticipant clears left_at when toState is NOT LEFT/REMOVED', () => {
      // The fix adds an `else` to the LEFT/REMOVED branch with
      // `setClauses.push("left_at = NULL")`. Pin both halves of the
      // invariant.
      expect(src).toMatch(/toState\s*===\s*ParticipantState\.LEFT\s*\|\|\s*toState\s*===\s*ParticipantState\.REMOVED/);
      expect(src).toMatch(/setClauses\.push\(`left_at = NOW\(\)`\)/);
      expect(src).toMatch(/setClauses\.push\(`left_at = NULL`\)/);
      // The fix is intentional, with the 21 May post-mortem reference.
      expect(src).toMatch(/M1 fix \(21 May Ali\)/);
    });
  });

  // ─── M1 follow-up — SCHEDULED sessions get an ActiveSession too ─────────
  describe('M1 follow-up — pre-event lobby creates ActiveSession on first join', () => {
    const flow = readServer('services/orchestration/handlers/participant-flow.ts');
    const host = readServer('services/orchestration/handlers/host-actions.ts');

    it("'scheduled' is in the on-the-fly activeStatuses recovery list", () => {
      // Pre-fix the list was lobby_open/round_active/round_rating/
      // round_transition/closing_lobby — scheduled was excluded, so
      // pre-event lobbies had no presenceMap, no state machine, and
      // chat-handlers' gate always failed for non-host users.
      expect(flow).toMatch(/activeStatuses\s*=\s*\[\s*'scheduled'\s*,\s*'lobby_open'/);
    });

    it('handleStartSession preserves existing presenceMap when promoting SCHEDULED → LOBBY_OPEN', () => {
      // Otherwise users who joined the pre-event lobby would lose presence
      // the moment the host clicked Start. Pin the merge.
      const idx = host.indexOf('M1 follow-up (21 May Ali) — preserve presenceMap');
      expect(idx).toBeGreaterThan(-1);
      const block = host.slice(idx, idx + 2000);
      expect(block).toMatch(/presenceMap:\s*existing\?\.presenceMap\s*\?\?\s*new Map\(\)/);
      expect(block).toMatch(/participantStates:\s*existing\?\.participantStates/);
    });
  });

  // ─── M3 — already-met query reads participant_c_id and expands triples ──
  describe('M3 — excluded-pairs query covers 3-way matches', () => {
    const src = readServer('services/matching/matching.service.ts');

    it('the within-event exclusion query selects participant_c_id', () => {
      // Pin the column list. Without this column, 3-way matches go
      // unrecorded for the c-participant.
      expect(src).toMatch(/SELECT participant_a_id, participant_b_id, participant_c_id FROM matches/);
      // The TypeScript type for the result row also declares c.
      expect(src).toMatch(/participant_c_id:\s*string\s*\|\s*null/);
    });

    it('result expansion adds three pair tuples when participant_c_id is set', () => {
      // Search the M3-tagged block.
      const m3Idx = src.indexOf('M3 fix (21 May Ali)');
      expect(m3Idx).toBeGreaterThan(-1);
      // Window widened (June-14) — the excludedPairs query gained an explanatory
      // comment, pushing the .add() expansion lines past the old 2000 slice.
      const block = src.slice(m3Idx, m3Idx + 3500);
      // (a,b) always added.
      expect(block).toMatch(/excludedPairs\.add\(\s*pairKey\(r\.participant_a_id,\s*r\.participant_b_id\)\s*\)/);
      // (a,c) and (b,c) added when c is set.
      expect(block).toMatch(/if\s*\(\s*r\.participant_c_id\s*\)/);
      expect(block).toMatch(/excludedPairs\.add\(\s*pairKey\(r\.participant_a_id,\s*r\.participant_c_id\)\s*\)/);
      expect(block).toMatch(/excludedPairs\.add\(\s*pairKey\(r\.participant_b_id,\s*r\.participant_c_id\)\s*\)/);
    });
  });
});
