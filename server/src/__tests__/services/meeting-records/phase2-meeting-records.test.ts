// Phase 2 (1 May 2026 spec) — meeting_records: stored, deterministic, never recalculated
//
// Stefan items 3+4: counts must be deterministic, stored, never derived from UI.
// "3 meetings → 15 mutual matches" and "Claus 6 → 4 after re-entering" both
// stemmed from recap counts being computed live from matches × ratings ×
// encounter_history at every render, with the encounter_history.mutual_meet_again
// field mutating as later rounds finalised.
//
// Fix: meeting_records (migration 054) stores one row per (session, round,
// user, partner). Written exactly once when a round's rating window closes,
// updated only when the partner's rating lands. is_mutual is a generated
// column, never recomputed at read time.
//
// Tests pin the architecture: migration creates the table with the right
// shape, service exports the three metrics, finalizeRoundRatings hooks in,
// submitRating hooks in, recap UI consumes the stored counts.

import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../../', rel), 'utf8');
}

describe('Phase 2 — meeting_records stored counts', () => {
  describe('migration 054_meeting_records', () => {
    const sql = readServer('db/migrations/054_meeting_records.sql');

    it('creates the meeting_records table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meeting_records/);
    });

    it('UNIQUE(session_id, round_number, user_id, partner_id) — one row per directed pair per round', () => {
      expect(sql).toMatch(/UNIQUE\(session_id, round_number, user_id, partner_id\)/);
    });

    it('CHECK(user_id != partner_id) — no self-meeting rows', () => {
      expect(sql).toMatch(/CHECK\(user_id\s*!=\s*partner_id\)/);
    });

    it('is_mutual is a GENERATED STORED column (never recomputed at read time)', () => {
      expect(sql).toMatch(/is_mutual[\s\S]*?GENERATED ALWAYS AS[\s\S]*?STORED/);
    });

    it('rating_given CHECK 1-5', () => {
      expect(sql).toMatch(/rating_given.*CHECK.*1 AND 5/);
    });

    it('indexes (user_id, session_id) for inbox queries', () => {
      expect(sql).toMatch(/idx_meeting_records_user[\s\S]*?\(user_id, session_id\)/);
    });

    it('backfills from existing matches × ratings via LATERAL pair expansion', () => {
      expect(sql).toMatch(/INSERT INTO meeting_records[\s\S]*?FROM matches m[\s\S]*?CROSS JOIN LATERAL/);
      expect(sql).toMatch(/ON CONFLICT \(session_id, round_number, user_id, partner_id\) DO NOTHING/);
    });

    it('backfill skips cancelled and scheduled matches', () => {
      expect(sql).toMatch(/WHERE m\.status NOT IN \('cancelled', 'scheduled'\)/);
    });
  });

  describe('meeting-records.service.ts surface', () => {
    const src = readServer('services/meeting-records/meeting-records.service.ts');

    it('exports recordMeeting (idempotent upsert)', () => {
      expect(src).toMatch(/export async function recordMeeting\(/);
      expect(src).toMatch(/ON CONFLICT \(session_id, round_number, user_id, partner_id\) DO UPDATE/);
    });

    it('exports upsertRatingForMeeting (writes both rater + partner rows)', () => {
      expect(src).toMatch(/export async function upsertRatingForMeeting\(/);
      // Updates the rater's row for meet_again_self
      const fnStart = src.indexOf('export async function upsertRatingForMeeting(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/meet_again_self = EXCLUDED\.meet_again_self/);
      // And the partner's row for meet_again_partner
      expect(fn).toMatch(/meet_again_partner = EXCLUDED\.meet_again_partner/);
    });

    it('exports the three deterministic metrics', () => {
      expect(src).toMatch(/export async function getUniquePeopleMet\(/);
      expect(src).toMatch(/export async function getTotalMeetings\(/);
      expect(src).toMatch(/export async function getMutualMatches\(/);
    });

    it('getMeetingCounts returns all three in one round-trip', () => {
      expect(src).toMatch(/export async function getMeetingCounts\(/);
      const fnStart = src.indexOf('export async function getMeetingCounts(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/COUNT\(DISTINCT partner_id\)/);
      expect(fn).toMatch(/COUNT\(\*\) FILTER \(WHERE is_mutual = TRUE\)/);
    });

    it('exports recordRoundMeetings for bulk write at round end', () => {
      expect(src).toMatch(/export async function recordRoundMeetings\(/);
    });

    it('refuses self-meeting rows defensively', () => {
      const fnStart = src.indexOf('export async function recordMeeting(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/userId === partnerId/);
    });
  });

  describe('finalizeRoundRatings writes meeting_records on round end', () => {
    const src = readServer('services/rating/rating.service.ts');

    it('imports recordRoundMeetings dynamically inside finalizeRoundRatings', () => {
      const fnStart = src.indexOf('export async function finalizeRoundRatings(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/import\(['"]\.\.\/meeting-records\/meeting-records\.service['"]\)/);
      expect(fn).toMatch(/recordRoundMeetings\(/);
    });

    it('passes participant_c_id to recordRoundMeetings (trio support)', () => {
      const fnStart = src.indexOf('export async function finalizeRoundRatings(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/participant_c_id/);
    });
  });

  describe('submitRating hooks meeting_records', () => {
    const src = readServer('services/rating/rating.service.ts');

    it('imports upsertRatingForMeeting after the rating insert', () => {
      const fnStart = src.indexOf('export async function submitRating(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/import\(['"]\.\.\/meeting-records\/meeting-records\.service['"]\)/);
      expect(fn).toMatch(/upsertRatingForMeeting\(/);
    });

    it('upserts the meeting record AFTER the encounter history update', () => {
      const fnStart = src.indexOf('export async function submitRating(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const ehIdx = fn.indexOf('upsertEncounterHistory(');
      const mrIdx = fn.indexOf('upsertRatingForMeeting(');
      expect(ehIdx).toBeGreaterThan(-1);
      expect(mrIdx).toBeGreaterThan(-1);
      expect(ehIdx).toBeLessThan(mrIdx);
    });
  });

  describe('getPeopleMet surfaces the deterministic counts', () => {
    const src = readServer('services/rating/rating.service.ts');

    it('reads from getMeetingCounts before falling back to derived', () => {
      const fnStart = src.indexOf('export async function getPeopleMet(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/getMeetingCounts\(/);
      expect(fn).toMatch(/uniquePeopleMet:/);
      expect(fn).toMatch(/totalMeetings:/);
      expect(fn).toMatch(/mutualMatches:/);
    });
  });

  describe('PeopleMet shared type extended with the three counts', () => {
    const src = readRepo('shared/src/types/match.ts');

    it('exports uniquePeopleMet, totalMeetings, mutualMatches as optional fields', () => {
      const ifaceStart = src.indexOf('export interface PeopleMet');
      const ifaceEnd = src.indexOf('}', ifaceStart);
      const iface = src.slice(ifaceStart, ifaceEnd);
      expect(iface).toMatch(/uniquePeopleMet\?\s*:/);
      expect(iface).toMatch(/totalMeetings\?\s*:/);
      expect(iface).toMatch(/mutualMatches\?\s*:/);
    });
  });

  describe('RecapPage UI uses the three metrics with proper labels', () => {
    const src = readRepo('client/src/features/sessions/RecapPage.tsx');

    it('renders People Met / Total Meetings / Mutual Matches cards', () => {
      expect(src).toMatch(/>People Met</);
      expect(src).toMatch(/>Total Meetings</);
      expect(src).toMatch(/>Mutual Matches</);
    });

    it('reads data.uniquePeopleMet / totalMeetings / mutualMatches with fallback', () => {
      expect(src).toMatch(/data\?\.uniquePeopleMet/);
      expect(src).toMatch(/data\?\.totalMeetings/);
      expect(src).toMatch(/data\?\.mutualMatches/);
    });
  });
});
