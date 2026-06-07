// Deterministic proof for the 2026-06-08 "People Met 0 for a room-leaver" bug.
// A trio (A,B,C) where C departed within seconds (C in departed_user_ids, slots
// re-canonicalised to the A,B pair). recordRoundMeetings must still write
// meeting_records for C ↔ A and C ↔ B — C was in the room, however briefly —
// so the recap headline (uniquePeopleMet) matches the round list.
//
// Unit-level (mocked db) so it can't be defeated by full-event finalize timing.
import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../db', () => ({ query: mockQuery }));

describe('recordRoundMeetings — a departed room member still gets meeting records', () => {
  beforeEach(() => mockQuery.mockReset());

  it('writes records for every pair among slots ∪ departed_user_ids', async () => {
    // The SELECT ratings query (first call per match) → no ratings submitted.
    // Every other call is an INSERT (recordMeeting). Default them to empty.
    mockQuery.mockResolvedValue({ rows: [] });

    const { recordRoundMeetings } = await import('../../services/meeting-records/meeting-records.service');

    const A = 'aaaaaaaa-0000-0000-0000-000000000001';
    const B = 'bbbbbbbb-0000-0000-0000-000000000002';
    const C = 'cccccccc-0000-0000-0000-000000000003'; // the leaver, demoted into departed
    const res = await recordRoundMeetings('sess-1', 1, [
      { id: 'match-1', participantAId: A, participantBId: B, participantCId: null, departedUserIds: [C] },
    ]);

    // 3 people in the room ⇒ 3×2 = 6 directed edges, INCLUDING C's.
    expect(res.recorded).toBe(6);

    // Collect every recordMeeting INSERT (skip the SELECT ratings calls).
    const inserts = mockQuery.mock.calls
      .map((c) => c as [string, unknown[]])
      .filter(([sql]) => /INSERT INTO meeting_records/.test(sql))
      .map(([, params]) => ({ user: params[3], partner: params[4] }));

    const has = (u: string, p: string) => inserts.some((e) => e.user === u && e.partner === p);

    // C (the leaver) must have a row for EACH roommate — this is "People Met" for C.
    expect(has(C, A)).toBe(true);
    expect(has(C, B)).toBe(true);
    // And the survivors must list C as someone they met.
    expect(has(A, C)).toBe(true);
    expect(has(B, C)).toBe(true);
    // C's distinct partners = 2 ⇒ uniquePeopleMet would be 2, never 0.
    const cPartners = new Set(inserts.filter((e) => e.user === C).map((e) => e.partner));
    expect(cPartners.size).toBe(2);
  });

  it('a pair with no departures is unchanged (2 edges, no phantom rows)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { recordRoundMeetings } = await import('../../services/meeting-records/meeting-records.service');
    const A = 'aaaaaaaa-0000-0000-0000-000000000001';
    const B = 'bbbbbbbb-0000-0000-0000-000000000002';
    const res = await recordRoundMeetings('sess-2', 1, [
      { id: 'm', participantAId: A, participantBId: B, participantCId: null, departedUserIds: [] },
    ]);
    expect(res.recorded).toBe(2);
  });
});
