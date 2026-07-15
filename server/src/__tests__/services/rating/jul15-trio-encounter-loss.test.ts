// ─── 15 Jul live test ("mn") — trio encounters were silently lost ───────────
//
// A TRIO is ONE match row holding THREE people, i.e. THREE pairs who actually
// met: a-b, a-c and b-c. finalizeSessionEncounters only ever read
// participant_a_id and participant_b_id, so the two pairs involving the third
// person were never recorded.
//
// Real evidence from session 655d23c0 ("mn"): Chief Developer met Waseem and
// jack in the rounds 1+4 trio and ended the event with NO encounter_history row
// for either pair. encounter_history is the cross-event "have these two already
// met" memory the matcher reads, so those pairs would be matched again in a
// later event as if they had never spoken.
//
// Second defect: ON CONFLICT DO NOTHING meant a pair who had met in an EARLIER
// event never had last_met_at / last_session_id refreshed when they met again.
// Ali Hamzaa <-> saif ali met twice during "mn" yet their row still pointed at
// the previous event ("t1", 14 Jul).
//
// NOTE ON times_met: this function is fire-and-forget from completeSession and
// its idempotency is documented + relied upon (round-lifecycle.ts). So the
// conflict branch must SET, never increment — an increment would double-count
// on any re-run. Counting unrated re-meets needs per-match tracking; out of
// scope here and deliberately not attempted.

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import * as ratingService from '../../../services/rating/rating.service';

/** The upsert calls finalizeSessionEncounters made, as sorted "a|b" pair keys. */
function upsertedPairs(): string[] {
  return mockQuery.mock.calls
    .filter(c => typeof c[0] === 'string' && /INSERT INTO encounter_history/.test(c[0]))
    .map(c => `${(c[1] as string[])[1]}|${(c[1] as string[])[2]}`)
    .sort();
}
function upsertSql(): string {
  const call = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && /INSERT INTO encounter_history/.test(c[0]));
  return call ? (call[0] as string) : '';
}

describe('15 Jul — finalizeSessionEncounters records every pair of a trio', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // 1st call = the SELECT over matches; every later call = an upsert.
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM matches/.test(sql)) {
        return Promise.resolve({
          rows: [
            // The rounds-1/4 shape from "mn": one trio + one pair.
            { participantAId: 'u-waseem', participantBId: 'u-jack', participantCId: 'u-chief', roundNumber: 1 },
            { participantAId: 'u-ali', participantBId: 'u-saif', participantCId: null, roundNumber: 1 },
          ],
        });
      }
      return Promise.resolve({ rows: [{ inserted: true }], rowCount: 1 });
    });
  });

  it('records all THREE pairs of a trio, not just participant a+b', async () => {
    await ratingService.finalizeSessionEncounters('session-mn');
    // Trio waseem+jack+chief => waseem|jack, waseem|chief, jack|chief (ordered
    // by id so the unique (user_a_id,user_b_id) constraint matches), plus the
    // ali+saif pair. Pre-fix only waseem|jack and ali|saif were written.
    expect(upsertedPairs()).toEqual([
      'u-ali|u-saif',
      'u-chief|u-jack',
      'u-chief|u-waseem',
      'u-jack|u-waseem',
    ]);
  });

  it('selects participant_c_id from matches (it cannot record what it never reads)', async () => {
    await ratingService.finalizeSessionEncounters('session-mn');
    const select = mockQuery.mock.calls.find(c => /FROM matches/.test(c[0] as string));
    expect(select![0]).toMatch(/participant_c_id/);
  });

  it('refreshes last_met_at + last_session_id when the pair already met in an earlier event', async () => {
    await ratingService.finalizeSessionEncounters('session-mn');
    const sql = upsertSql();
    expect(sql).toMatch(/ON CONFLICT \(user_a_id, user_b_id\) DO UPDATE/);
    expect(sql).toMatch(/last_session_id\s*=/);
    expect(sql).toMatch(/last_met_at\s*=/);
  });

  it('stays idempotent: the conflict branch must SET, never increment times_met', async () => {
    // completeSession fires this without awaiting and documents it as
    // idempotent; an increment here would double-count on a re-run.
    await ratingService.finalizeSessionEncounters('session-mn');
    const sql = upsertSql();
    const conflictBranch = sql.slice(sql.indexOf('ON CONFLICT'));
    expect(conflictBranch).not.toMatch(/times_met\s*=\s*.*times_met\s*\+/);
  });
});
