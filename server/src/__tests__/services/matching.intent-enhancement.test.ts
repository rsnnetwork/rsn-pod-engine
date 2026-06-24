import { MatchingEngineV1 } from '../../services/matching/matching.engine';
import { MatchingParticipant, MatchingConfig, MatchingWeights } from '@rsn/shared';

const engine = new MatchingEngineV1();
const base = (over: Partial<MatchingParticipant>): MatchingParticipant => ({
  userId: 'x', interests: [], reasonsToConnect: [], industry: null, company: null,
  languages: [], timezone: null, attributes: {}, ...over,
});
// Engine guards every signal with `if (weights.X)`, so a partial weight set is
// valid at runtime — cast for the test ergonomics.
const cfg = (weights: Partial<MatchingWeights>): MatchingConfig => ({
  weights: weights as MatchingWeights,
  hardConstraints: [], numberOfRounds: 1, avoidDuplicates: true, globalOptimize: true,
});

describe('matching engine — onboarding-intent enhancement', () => {
  it('rewards mutual intent + complementary designation', () => {
    const a = base({ userId: 'a', designation: 'founder', industry: 'saas', wantsToMeet: ['investors'] });
    const b = base({ userId: 'b', designation: 'investor', industry: 'fintech', wantsToMeet: ['founders'] });
    const r = engine.scorePair(a, b, cfg({ intentAlignment: 0.2, designationDiversity: 0.1 }), []);
    expect(r.reasonTags).toContain('mutual_intent');
    expect(r.reasonTags.some((t) => t.startsWith('designation:'))).toBe(true);
    expect(r.score).toBeGreaterThan(0.7);
  });

  it('drops the score on an avoid conflict (soft penalty)', () => {
    const a = base({ userId: 'a', avoid: ['sales'] });
    const b = base({ userId: 'b', reasonsToConnect: ['sales'] });
    const r = engine.scorePair(a, b, cfg({ avoidPenalty: 0.5 }), []);
    expect(r.reasonTags).toContain('avoid_conflict');
    expect(r.score).toBe(0); // only signal present; conflict zeroes it
  });

  it('does not penalise when there is no avoid conflict', () => {
    const a = base({ userId: 'a', avoid: ['sales'], designation: 'founder' });
    const b = base({ userId: 'b', designation: 'investor', industry: 'fintech' });
    const r = engine.scorePair(a, b, cfg({ avoidPenalty: 0.5 }), []);
    expect(r.reasonTags).not.toContain('avoid_conflict');
    expect(r.score).toBe(1);
  });

  it('is backward compatible: legacy weights produce no new reason tags', () => {
    const a = base({ userId: 'a', designation: 'founder', wantsToMeet: ['investors'], avoid: ['sales'] });
    const b = base({ userId: 'b', designation: 'investor', wantsToMeet: ['founders'], reasonsToConnect: ['sales'] });
    const r = engine.scorePair(a, b, cfg({ sharedInterests: 1 }), []);
    expect(r.reasonTags).not.toContain('mutual_intent');
    expect(r.reasonTags).not.toContain('avoid_conflict');
    expect(r.reasonTags.some((t) => t.startsWith('designation:'))).toBe(false);
  });

  // ── Phase 2 ──────────────────────────────────────────────────────────────
  it('per-event intention raises a relevant pair (event_intent tag)', () => {
    const a = base({ userId: 'a', eventIntention: 'meet investors' });
    const b = base({ userId: 'b', designation: 'investor', industry: 'fintech' });
    const r = engine.scorePair(a, b, cfg({ eventIntentionAlignment: 0.5 }), []);
    expect(r.reasonTags).toContain('event_intent');
    expect(r.score).toBeGreaterThan(0);
  });

  it('completeness dampens intent for thin profiles, leaves rich ones unchanged', () => {
    const b = base({ userId: 'b', designation: 'investor', industry: 'fintech' });
    const thin = engine.scorePair(
      base({ userId: 'a', designation: 'founder', wantsToMeet: ['investors'], completeness: 0.2 }),
      b, cfg({ intentAlignment: 0.5 }), [],
    );
    const rich = engine.scorePair(
      base({ userId: 'a', designation: 'founder', wantsToMeet: ['investors'], completeness: 1 }),
      b, cfg({ intentAlignment: 0.5 }), [],
    );
    expect(rich.score).toBeGreaterThan(thin.score);
  });

  it('no completeness set = no dampening (Phase 1 parity)', () => {
    const a = base({ userId: 'a', designation: 'founder', wantsToMeet: ['investors'] });
    const b = base({ userId: 'b', designation: 'investor', industry: 'fintech' });
    const withField = engine.scorePair({ ...a, completeness: 1 }, b, cfg({ intentAlignment: 0.5 }), []);
    const without = engine.scorePair(a, b, cfg({ intentAlignment: 0.5 }), []);
    expect(without.score).toBe(withField.score);
  });
});
