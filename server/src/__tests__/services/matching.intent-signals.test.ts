import {
  normalizeDesignation,
  designationAffinity,
  tokenizeTerms,
  termOverlap,
  intentAlignmentScore,
  avoidConflict,
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
