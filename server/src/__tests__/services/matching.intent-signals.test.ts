import {
  normalizeDesignation,
  designationAffinity,
  tokenizeTerms,
  termOverlap,
  intentAlignmentScore,
  avoidConflict,
  pairConfidence,
  profileCompleteness,
  eventIntentionScore,
  pairOpennessFactor,
  withinCooldown,
} from '../../services/matching/intent-signals';
import { MatchingParticipant } from '@rsn/shared';

const base = (over: Partial<MatchingParticipant>): MatchingParticipant => ({
  userId: 'x', interests: [], reasonsToConnect: [], industry: null, company: null,
  languages: [], timezone: null, attributes: {}, ...over,
});

describe('normalizeDesignation', () => {
  it('maps free-text titles to canonical buckets', () => {
    expect(normalizeDesignation('Co-Founder & CEO')).toBe('founder');
    expect(normalizeDesignation('Managing Partner at Acme Ventures')).toBe('investor');
    expect(normalizeDesignation('Angel Investor')).toBe('investor');
    expect(normalizeDesignation('Senior Software Engineer')).toBe('employee');
    expect(normalizeDesignation('Looking for a job')).toBe('job_seeker');
  });
  it('returns null for empty/unknown', () => {
    expect(normalizeDesignation('')).toBeNull();
    expect(normalizeDesignation(null)).toBeNull();
    expect(normalizeDesignation('Wizard')).toBeNull();
  });
});

describe('designationAffinity', () => {
  it('rewards complementary roles and is symmetric', () => {
    expect(designationAffinity('founder', 'investor')).toBe(1.0);
    expect(designationAffinity('investor', 'founder')).toBe(1.0);
    expect(designationAffinity('job_seeker', 'manager')).toBe(0.9);
  });
  it('mildly penalises identical designations', () => {
    expect(designationAffinity('founder', 'founder')).toBe(0.4);
    expect(designationAffinity('investor', 'investor')).toBe(0.3);
  });
  it('is neutral for unknown and slightly positive for different-but-unlisted', () => {
    expect(designationAffinity(null, 'founder')).toBe(0.5);
    expect(designationAffinity('manager', 'employee')).toBe(0.6);
  });
});

describe('tokenizeTerms + termOverlap', () => {
  it('matches singular/plural via substring', () => {
    expect(termOverlap(tokenizeTerms(['investors']), tokenizeTerms(['Angel Investor', 'VC']))).toBeGreaterThan(0);
  });
  it('returns 0 for no overlap', () => {
    expect(termOverlap(tokenizeTerms(['founders']), tokenizeTerms(['Software Engineer']))).toBe(0);
    expect(termOverlap([], ['investor'])).toBe(0);
  });
});

describe('intentAlignmentScore', () => {
  it('scores mutual want highest', () => {
    const founder = base({ userId: 'a', designation: 'founder', industry: 'saas', wantsToMeet: ['investors'] });
    const investor = base({ userId: 'b', designation: 'investor', industry: 'fintech', wantsToMeet: ['founders'] });
    const r = intentAlignmentScore(founder, investor);
    expect(r.aWantsB).toBeGreaterThan(0);
    expect(r.bWantsA).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThan(0.6);
  });
  it('is zero when neither wants the other', () => {
    const a = base({ userId: 'a', designation: 'founder', wantsToMeet: ['investors'] });
    const b = base({ userId: 'b', designation: 'founder', industry: 'saas' });
    expect(intentAlignmentScore(a, b).score).toBe(0);
  });
});

describe('avoidConflict', () => {
  it('detects an avoid term matching the other side identity', () => {
    const a = base({ userId: 'a', avoid: ['sales'] });
    const b = base({ userId: 'b', reasonsToConnect: ['sales'] });
    expect(avoidConflict(a, b)).toBe(true);
  });
  it('is false when there is no avoid conflict', () => {
    const a = base({ userId: 'a', avoid: ['sales'], designation: 'founder' });
    const b = base({ userId: 'b', designation: 'investor', industry: 'fintech' });
    expect(avoidConflict(a, b)).toBe(false);
  });
});

describe('pairConfidence (Phase 2)', () => {
  it('is the score at fallback 0 and drops 15% per level, clamped 0..1', () => {
    expect(pairConfidence(0.8, 0)).toBe(0.8);
    expect(pairConfidence(0.8, 1)).toBeCloseTo(0.68, 2);
    expect(pairConfidence(1, 4)).toBeCloseTo(0.4, 2);
    expect(pairConfidence(0, 0)).toBe(0);
    expect(pairConfidence(2, 0)).toBe(1);
  });
});

describe('profileCompleteness (Phase 2)', () => {
  it('is 0 for an empty profile and 1 for a full one', () => {
    expect(profileCompleteness(base({}))).toBe(0);
    expect(
      profileCompleteness(
        base({
          designation: 'founder', industry: 'saas', interests: ['x'],
          reasonsToConnect: ['y'], wantsToMeet: ['investors'], company: 'Acme',
        })
      )
    ).toBe(1);
  });
});

describe('eventIntentionScore (Phase 2)', () => {
  it('matches the per-event intent against the other identity', () => {
    const a = base({ eventIntention: 'meet investors' });
    const b = base({ designation: 'investor', industry: 'fintech' });
    expect(eventIntentionScore(a, b)).toBeGreaterThan(0);
    expect(eventIntentionScore(base({}), b)).toBe(0);
  });
});

describe('pairOpennessFactor (Phase 2)', () => {
  it('leans relevance for only_relevant, softens for very_open, neutral by default', () => {
    expect(pairOpennessFactor(base({}), base({}))).toBe(1);
    expect(pairOpennessFactor(base({ openness: 'only_relevant' }), base({ openness: 'only_relevant' }))).toBe(1.25);
    expect(pairOpennessFactor(base({ openness: 'very_open' }), base({ openness: 'very_open' }))).toBe(0.8);
  });
});

describe('withinCooldown (Phase 2)', () => {
  const now = 1_700_000_000_000;
  const monthsAgo = (m: number) => now - m * 30 * 24 * 60 * 60 * 1000;
  it('excludes pairs inside the window, allows older ones', () => {
    expect(withinCooldown(new Date(monthsAgo(2)), 12, now)).toBe(true);
    expect(withinCooldown(new Date(monthsAgo(14)), 12, now)).toBe(false);
    expect(withinCooldown(new Date(monthsAgo(0)), 12, now)).toBe(true);
  });
});
