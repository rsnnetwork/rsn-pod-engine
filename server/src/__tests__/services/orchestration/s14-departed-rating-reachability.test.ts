// ─── S14 — departed members stay RATABLE + trio-aware no-show scan ─────────
//
// Live-test 2026-06-05 (Ali, 3 participants + host → trio every round)
// surfaced three symptoms with two root causes:
//
//   1. Trio leaver's rating Submit 403'd (had to Skip) — demoting a trio
//      leaver re-canonicalises the slots, so submitRating's "is the rater a
//      participant?" check no longer matched them.
//   2. Survivors got NO round-end form for the departed member — the SAME
//      slot-only check ran against toUserId.
//      → Fix: submitRating validates against slots ∪ departed_user_ids
//        (migration 066) in BOTH directions.
//   3. Browser-close + reopen landed in main with no rating form — the
//      late-return replay only looked at COMPLETED matches with the user in
//      the slots; a member departed from a still-ACTIVE trio matched neither.
//      → Fix: late-return query also matches $2 = ANY(departed_user_ids) on
//        active|completed, and the partner list unions departed ids.
//
// Plus the round-3 anomaly (match a911c69b: status='no_show', ended_at NULL,
// departed=[...]): detectNoShows was PAIR-ONLY — a trio with one absentee had
// the whole match marked no_show (zombie room, survivor ratings auto-excluded
// as no_show stats). Now: 2+ present → demote the absentee (recordDeparted:
// false — a no-show never met the room, so they belong in nobody's rating
// list); <2 present → terminal no_show as before.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

const ratingSrc = () => readServer('services/rating/rating.service.ts');
const pfSrc = () => readServer('services/orchestration/handlers/participant-flow.ts');
const rlSrc = () => readServer('services/orchestration/handlers/round-lifecycle.ts');
const matchingSrc = () => readServer('services/matching/matching.service.ts');

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S14 — submitRating reaches departed members in both directions', () => {
  it('the match lookup selects departed_user_ids', () => {
    const src = ratingSrc();
    expect(src).toMatch(/departed_user_ids\s+AS\s+"departedUserIds"/);
  });

  it('participant validation unions departed_user_ids into matchParticipants', () => {
    const src = ratingSrc();
    const start = src.indexOf('const matchParticipants');
    expect(start).toBeGreaterThan(-1);
    // The union loop sits between building the slot array and the rater check.
    const raterCheck = src.indexOf('matchParticipants.includes(input.fromUserId)') !== -1
      ? src.indexOf('matchParticipants.includes(input.fromUserId)')
      : src.indexOf('.includes(', start);
    const block = src.slice(start, raterCheck + 200);
    expect(block).toMatch(/departedUserIds/);
    expect(block).toMatch(/matchParticipants\.push\(departedId\)/);
  });

  it('the toUserId check uses the SAME departed-aware array (no second slot-only list)', () => {
    const src = ratingSrc();
    const unionIdx = src.indexOf('matchParticipants.push(departedId)');
    expect(unionIdx).toBeGreaterThan(-1);
    const after = src.slice(unionIdx);
    // No fresh slot-only participant array is rebuilt after the union.
    expect(after).not.toMatch(/const matchParticipants\s*=/);
    expect(after).toMatch(/matchParticipants\.includes\(/);
  });
});

describe('S14 — late-return rating replay covers departed-from-active members', () => {
  it('the late-return query matches departed_user_ids on active OR completed', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleJoinSession');
    expect(fn).toMatch(/\$2 = ANY\(departed_user_ids\)/);
    expect(fn).toMatch(/status IN \('active', 'completed'\)/);
  });

  it('the late-return partner list unions departed_user_ids minus self', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleJoinSession');
    const idx = fn.indexOf('const latePartnerIds');
    expect(idx).toBeGreaterThan(-1);
    const block = fn.slice(idx, idx + 500);
    expect(block).toMatch(/departed_user_ids/);
    expect(block).toMatch(/id !== userId/);
  });
});

describe('S14 — detectNoShows is trio-aware', () => {
  it('the scan reads all three slots (participantCId included)', () => {
    const fn = sliceFn(rlSrc(), 'export async function detectNoShows');
    expect(fn).toMatch(/match\.participantCId/);
  });

  it('2+ present → demote the absentee with recordDeparted: false; room continues', () => {
    const fn = sliceFn(rlSrc(), 'export async function detectNoShows');
    const idx = fn.indexOf('presentIds.length >= 2');
    expect(idx).toBeGreaterThan(-1);
    const branch = fn.slice(idx, fn.indexOf('} else if', idx));
    expect(branch).toMatch(/demoteParticipantFromMatch\([^)]*recordDeparted:\s*false/);
    expect(branch).toMatch(/match:participant_left/);
    // The continuing-room branch must NOT mark the whole match no_show.
    expect(branch).not.toMatch(/SET status = 'no_show'/);
  });

  it('the survivor bye_round no longer promises a new partner (WS2: no re-pair)', () => {
    const fn = sliceFn(rlSrc(), 'export async function detectNoShows');
    expect(fn).not.toMatch(/looking for a new partner/i);
  });
});

describe('S14 — demoteParticipantFromMatch recordDeparted option', () => {
  it('defaults to recording (existing leave/kick/grace callers unchanged)', () => {
    const fn = sliceFn(matchingSrc(), 'export async function demoteParticipantFromMatch');
    expect(fn).toMatch(/recordDeparted = options\.recordDeparted !== false/);
  });

  it('both UPDATE branches guard the departed append on recordDeparted', () => {
    const fn = sliceFn(matchingSrc(), 'export async function demoteParticipantFromMatch');
    const guarded = fn.match(/CASE WHEN \$\d::boolean\s*\n?\s*THEN array_append\(departed_user_ids/g) || [];
    expect(guarded.length).toBe(2);
    // No unguarded append remains.
    const appends = fn.match(/array_append\(departed_user_ids/g) || [];
    expect(appends.length).toBe(2);
  });
});
