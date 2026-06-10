// ─── WS3/H5 (27 May remaining work) — "this conversation didn't work" ──────
//
// A no-show partner or a tech failure is not a 1-star conversation. The new
// option records a rating row (so the one-rating-per-match dedup and the
// rejoin replay treat the match as handled) flagged
// excluded_from_quality_stats — and EVERY quality average filters it out.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

describe('WS3/H5 — didnt-work rating is recorded but excluded from quality stats', () => {
  it('migration 067 adds the additive flag', () => {
    const sql = readServer('db/migrations/067_ratings_excluded_from_quality_stats.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS excluded_from_quality_stats BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it('the submit schema and insert carry the flag through', () => {
    expect(readServer('routes/ratings.ts')).toMatch(/didntWork: z\.boolean\(\)\.optional\(\)/);
    const svc = readServer('services/rating/rating.service.ts');
    expect(svc).toMatch(/excluded_from_quality_stats/);
    expect(svc).toMatch(/input\.didntWork === true/);
  });

  it('EVERY quality average excludes flagged ratings', () => {
    // The complete inventory of AVG(quality_score) consumers — each must
    // carry the exclusion. A new average added without it fails the count.
    const sites: Array<[string, number]> = [
      ['routes/admin.ts', 3],
      ['routes/sessions.ts', 1],
      ['services/rating/rating.service.ts', 1],
      ['services/matching/matching.service.ts', 1],
      ['services/orchestration/handlers/round-lifecycle.ts', 2],
    ];
    for (const [rel, expected] of sites) {
      const src = readServer(rel);
      const avgCount = (src.match(/AVG\((?:r\.)?quality_score\)/g) || []).length;
      const exclCount = (src.match(/excluded_from_quality_stats/g) || []).length;
      expect({ file: rel, avgCount }).toEqual({ file: rel, avgCount: expected });
      // Each averaging file must filter excluded ratings at least once per average.
      expect({ file: rel, enoughExclusions: exclCount >= expected }).toEqual({ file: rel, enoughExclusions: true });
    }
  });

  it('the client offers the option and sends the flag', () => {
    const src = readClient('features/live/RatingPrompt.tsx');
    expect(src).toMatch(/didntWork: true/);
    expect(src).toMatch(/didn&apos;t work/);
  });

  it('S12 — no_show/cancelled match ratings are AUTO-excluded (not just user-flagged)', () => {
    const svc = readServer('services/rating/rating.service.ts');
    expect(svc).toMatch(/input\.didntWork === true \|\| match\.status === 'no_show' \|\| match\.status === 'cancelled'/);
  });

  it('S12 — excluded scores are withheld from encounter_history and meeting_records surfaces', () => {
    const svc = readServer('services/rating/rating.service.ts');
    expect(svc).toMatch(/scoreForAggregates = rating\.excludedFromQualityStats \? null : input\.qualityScore/);
    // Both aggregate writers accept the withheld (null) score.
    expect(svc).toMatch(/qualityScore: number \| null/);
    expect(readServer('services/meeting-records/meeting-records.service.ts')).toMatch(/qualityScore: number \| null/);
  });
});

describe('S12 — remaining 27-May audit gaps closed', () => {
  it('A4 — client offers only the websocket transport (aligned with the pinned server)', () => {
    const src = readClient('lib/socket.ts');
    expect(src).toMatch(/transports: \['websocket'\]/);
    expect(src).not.toMatch(/'polling'/);
  });

  it('C1 — co-host toggle works for any acting host, not just the director', () => {
    const src = readClient('features/live/ParticipantList.tsx');
    expect(src).toMatch(/isOriginalHost \|\| isHost/);
  });

  it('C1 — the Host Control Center opener is no longer gated on sessionStarted', () => {
    const src = readClient('features/live/HostControls.tsx');
    const idx = src.indexOf('Open Host Control Center');
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, idx - 500), idx);
    expect(before).not.toMatch(/sessionStarted && \(/);
  });

  it('kicked users attempting a socket rejoin get an explicit eviction, not silence', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');
    expect(src).toMatch(/REMOVED_FROM_EVENT/);
    const idx = src.indexOf("'REMOVED_FROM_EVENT'");
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/session:evicted/);
  });
});
