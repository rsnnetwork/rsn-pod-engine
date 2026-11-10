// ─── One loader for "these two must never meet" (10 Nov 2026 spec, Part 2 Task 5, fix round 1) ──────────────
//
// generateSingleRound (the live engine) and hardExclusionPairs (the room checker's context, for the board and live
// repairs) read the same loader, so they cannot disagree. These pin that the loader makes exactly the reads the
// engine made before it existed (invites, then blocks, then reports), returns the engine's tokens, and fails the
// engine's way everywhere: invites or blocks failing throws, a reports read failing is logged and skipped.

import * as fs from 'fs';
import * as path from 'path';

const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() },
}));

const seen: string[] = [];
const fail = { on: null as RegExp | null };
jest.mock('../../../db', () => ({
  __esModule: true,
  query: jest.fn(async (raw: string) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    seen.push(sql);
    if (fail.on?.test(sql)) throw new Error('read failed');
    if (/FROM invites/.test(sql)) {
      return { rows: [{ inviter_id: 'host', accepted_by_user_id: 'ann' }, { inviter_id: null, accepted_by_user_id: 'bob' }] };
    }
    if (/FROM user_blocks/.test(sql)) return { rows: [{ blocker_id: 'cat', blocked_id: 'ann' }] };
    if (/FROM violations/.test(sql)) return { rows: [{ reporter_id: 'dan', reported_user_id: 'bob' }] };
    throw new Error(`unexpected SQL: ${sql}`);
  }),
}));

import { loadHardExclusions } from '../../../services/matching/hard-exclusions';
import { hardExclusionPairs } from '../../../services/matching/constraint-context';

const people = ['ann', 'bob', 'cat', 'dan', 'host'];

beforeEach(() => {
  seen.length = 0;
  fail.on = null;
  mockWarn.mockClear();
});

describe('loadHardExclusions', () => {
  it('reads invites, then blocks, then reports, and returns the engine\'s tokens', async () => {
    expect(await loadHardExclusions('ev', people)).toEqual({
      inviterInvitee: ['host:ann'],
      blocked: ['cat:ann', 'dan:bob'],
    });
    expect(seen.map((s) => s.match(/FROM (\w+)/)![1])).toEqual(['invites', 'user_blocks', 'violations']);
    expect(seen[0]).toBe("SELECT inviter_id, accepted_by_user_id FROM invites WHERE session_id = $1 AND accepted_by_user_id IS NOT NULL AND status = 'accepted'");
  });

  it('with fewer than two people asks no reports (as the engine did)', async () => {
    await loadHardExclusions('ev', ['ann']);
    expect(seen.some((s) => /FROM violations/.test(s))).toBe(false);
  });

  it('a failed reports read is logged and skipped: matching carries on with the blocks and invites', async () => {
    fail.on = /FROM violations/;
    expect(await loadHardExclusions('ev', people)).toEqual({ inviterInvitee: ['host:ann'], blocked: ['cat:ann'] });
    expect(mockWarn).toHaveBeenCalledWith(expect.anything(), 'getViolationPairsForUsers failed — matching continues without violation exclusion');
  });

  it('a failed invites or blocks read throws', async () => {
    fail.on = /FROM invites/;
    await expect(loadHardExclusions('ev', people)).rejects.toThrow('read failed');
    fail.on = /FROM user_blocks/;
    await expect(loadHardExclusions('ev', people)).rejects.toThrow('read failed');
  });
});

describe('the room checker reads the same pairs, the same way', () => {
  it('hardExclusionPairs is the loader\'s pairs, whichever way round', async () => {
    const pairs = await hardExclusionPairs('ev', people);
    expect([...pairs].sort()).toEqual(['ann:cat', 'ann:host', 'bob:dan']);
  });

  it('and degrades as the engine does when the reports read fails', async () => {
    fail.on = /FROM violations/;
    expect([...(await hardExclusionPairs('ev', people))].sort()).toEqual(['ann:cat', 'ann:host']);
    fail.on = /FROM invites/;
    await expect(hardExclusionPairs('ev', people)).rejects.toThrow('read failed');
  });

  it('no second copy of the reads: neither the engine nor the checker queries these tables itself', () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../services/matching', rel), 'utf8');
    for (const file of ['matching.service.ts', 'constraint-context.ts']) {
      expect(read(file)).not.toMatch(/FROM invites|FROM user_blocks|FROM violations|getBlockedPairsForUsers/);
    }
    expect(read('matching.service.ts')).toMatch(/const \{ inviterInvitee: inviterInviteePairs, blocked: blockedPairs \} = await loadHardExclusions\(sessionId, participantIds\);/);
  });
});
