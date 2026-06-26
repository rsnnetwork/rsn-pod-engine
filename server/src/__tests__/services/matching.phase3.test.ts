import fs from 'fs';
import path from 'path';

// Phase 3 guarantees — locked at source level (the repo's pin convention for
// "this wiring must not silently regress"). Behavioural coverage of the engine
// signals lives in matching.intent-signals/enhancement; these assert the
// templates-use-full-weights + manual-rooms-are-fenced architecture.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');

describe('Matching Phase 3 — configurable templates + manual/algorithm boundary', () => {
  describe('P3-1 — templates configure the FULL JSONB weight set', () => {
    it('migration 072 adds the weights JSONB column (+ policy/cooldown)', () => {
      const m = read('db/migrations/072_matching_templates_phase3.sql');
      expect(m).toMatch(/ADD COLUMN IF NOT EXISTS weights JSONB/);
      expect(m).toMatch(/matching_policy/);
      expect(m).toMatch(/cooldown_months/);
    });

    it('the template loader reads weights JSONB and merges over DEFAULT_WEIGHTS', () => {
      const s = read('services/matching/matching.service.ts');
      expect(s).toMatch(/t\.weights/);
      expect(s).toMatch(/\.\.\.DEFAULT_WEIGHTS,\s*\.\.\.\(t\.weights/);
      // legacy templates (no JSONB) still fall back to the 5-column mapping
      expect(s).toMatch(/t\.weight_interests/);
    });

    it('the admin template API accepts a weights object + policy + cooldown', () => {
      const a = read('routes/admin.ts');
      expect(a).toMatch(/weights: z\.record/);
      expect(a).toMatch(/matchingPolicy: z\.enum/);
      expect(a).toMatch(/cooldown_months/);
    });
  });

  describe('P3-3 — manual breakout rooms are fenced from the engine', () => {
    it('submitRating skips the learning loop (encounter_history) for manual rooms', () => {
      const r = read('services/rating/rating.service.ts');
      expect(r).toMatch(/COALESCE\(is_manual, FALSE\) AS "isManual"/);
      expect(r).toMatch(/if \(!\(match as any\)\.isManual\)/);
    });

    it('matching analytics excludes manual rooms (engine stats stay honest)', () => {
      const a = read('routes/admin.ts');
      const idx = a.indexOf('async function computeMatching');
      expect(idx).toBeGreaterThan(-1);
      const region = a.slice(idx, idx + 3000);
      expect(region).toMatch(/COALESCE\(is_manual, FALSE\) = FALSE/);
      expect(region).toMatch(/COALESCE\(m\.is_manual, FALSE\) = FALSE/);
    });
  });
});
