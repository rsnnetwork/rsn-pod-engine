// ─── Workstream 2, slice 2 — kick semantics + REMOVED ban + trio departed ──
//
// Agreed spec (docs/superpowers/plans/2026-06-03-27may-remaining-work.md):
//   - Kick = removed from event + banned from re-entry; their active match
//     ENDS immediately (no grace — kick is decisive); the SURVIVOR auto-rates
//     ('partner_no_return') → main room; the kicked person gets NO form.
//   - registerParticipant must reject status='removed' — pre-fix the
//     re-register UPDATE path resurrected kicked users to 'registered'.
//   - Trio: one member departs (leave / pull-back / grace expiry / kick) →
//     the remaining 2 CONTINUE to normal round end, where they rate each
//     other + THE DEPARTED. demote re-canonicalises slots so the departed id
//     was lost from the match row — the additive matches.departed_user_ids
//     column preserves it for round-end rating reachability only (never
//     read by matching/presence).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('WS2 — kick ends the active match for the survivor', () => {
  const fn = () => sliceFn(
    readServer('services/orchestration/handlers/host-actions.ts'),
    'export async function handleHostRemoveParticipant',
  );

  it('kick demotes the kicked user from their active match (trio-aware)', () => {
    expect(fn()).toMatch(/demoteParticipantFromMatch/);
    // All three slots are checked when finding the match.
    expect(fn()).toMatch(/participant_c_id/);
  });

  it('the survivor goes through the shared early-end flow (rating → main, no re-pair)', () => {
    expect(fn()).toMatch(/endRoomEarlyForSurvivors\(/);
  });

  it('the kicked user gets NO rating form', () => {
    // The survivor flow targets the survivors; nothing opens a window for
    // the kicked id.
    expect(fn()).not.toMatch(/emitRatingWindowOnce\(io,\s*data\.userId/);
  });

  it('canonical location clears for the ended room (Ship C ordering preserved)', () => {
    expect(fn()).toMatch(/clearCanonicalBreakoutByMatch|clearCanonicalLocationToMain/);
  });

  it('kick is immediate — no grace timer in the kick path', () => {
    expect(fn()).not.toMatch(/scheduleMatchEndGrace/);
    expect(fn()).not.toMatch(/setTimeout/);
  });
});

describe('WS2 — kicked users cannot re-register (REMOVED ban)', () => {
  it('registerParticipant rejects status=removed before the re-register UPDATE', () => {
    const src = readServer('services/session/session.service.ts');
    const fn = sliceFn(src, 'export async function registerParticipant');
    const banIdx = fn.indexOf("'removed'");
    expect(banIdx).toBeGreaterThan(-1);
    expect(fn).toMatch(/REMOVED_FROM_EVENT/);
    // The ban must fire BEFORE the resurrect-to-registered UPDATE.
    const updateIdx = fn.indexOf("SET status = 'registered'");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(fn.indexOf('REMOVED_FROM_EVENT')).toBeLessThan(updateIdx);
  });
});

describe('WS2 — trio departed members are rated at round end', () => {
  it('migration 066 adds matches.departed_user_ids (additive, rating-only)', () => {
    const sql = readServer('db/migrations/066_matches_departed_user_ids.sql');
    expect(sql).toMatch(/ALTER TABLE matches ADD COLUMN IF NOT EXISTS departed_user_ids UUID\[\]/);
    expect(sql).toMatch(/DEFAULT '\{\}'/);
  });

  it('demoteParticipantFromMatch appends the leaver to departed_user_ids in BOTH branches', () => {
    const src = readServer('services/matching/matching.service.ts');
    const fn = sliceFn(src, 'export async function demoteParticipantFromMatch');
    const appends = fn.match(/array_append\(departed_user_ids/g) || [];
    // Trio-survives branch AND the terminal branch (a 3→2→1 double-leave
    // must preserve BOTH departed ids on the terminal row so the lone
    // survivor's form covers both).
    expect(appends.length).toBeGreaterThanOrEqual(2);
  });

  it('getMatchesByRound and getMatchById expose departedUserIds', () => {
    const src = readServer('services/matching/matching.service.ts');
    const selects = src.match(/departed_user_ids AS "departedUserIds"/g) || [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('endRound rating partner lists include the departed (raters stay slot-members only)', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');
    const fnStart = src.indexOf('export async function endRound');
    const fn = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 1));
    expect(fn).toMatch(/departedUserIds/);
    // Departed ids feed the display-name batch too.
    expect(fn).toMatch(/ratingParticipantIds|departed/);
  });

  it('the survivor early-end form covers ALL departed members of the match (3→2→1 case)', () => {
    // endRoomEarlyForSurvivors merges the caller's departed id with the
    // match row's departed_user_ids so a double-leave survivor rates both.
    const src = readServer('services/orchestration/handlers/room-end-early.ts');
    expect(src).toMatch(/departed_user_ids/);
  });
});
