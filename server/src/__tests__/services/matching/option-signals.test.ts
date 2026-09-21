// ─── Option signals: the translation the tick-box flow depends on ────────────
//
// The deck says each answer "writes directly to a matching field". It cannot:
// the scorer reads WORDS, and Shradha's labels do not survive that trip. These
// tests pin the translation, so nobody can quietly put a label back where the
// matcher reads it and leave every new member unmatchable.

import {
  MEET_SIGNALS, OFFER_SIGNALS, INTENT_SIGNALS,
  industrySummary, offerSummary, roleTitlesFor, selfBuckets,
} from '../../../services/matching/option-signals';
import { designationsWanted, normalizeDesignation } from '../../../services/matching/intent-signals';
import { ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INTENTS, ONBOARDING_INDUSTRIES } from '@rsn/shared';
import type { MeetKey } from '@rsn/shared';

describe('every option has a translation', () => {
  it('covers all six kinds a member can ask to meet', () => {
    for (const o of ONBOARDING_MEET) expect(MEET_SIGNALS[o.key]).toBeDefined();
  });
  it('covers all six things a member can offer', () => {
    for (const o of ONBOARDING_OFFERS) expect(OFFER_SIGNALS[o.key]).toBeDefined();
  });
  it('covers all six reasons for being here', () => {
    for (const o of ONBOARDING_INTENTS) expect(INTENT_SIGNALS[o.key]).toBeDefined();
  });
});

describe('what the member wants reaches the right kind of person', () => {
  // The whole point: ticking "Investors & VCs" must make the scorer look for
  // investors, not for whatever the label happens to tokenise to.
  it.each(Object.entries(MEET_SIGNALS))('%s asks for exactly its own buckets', (_key, sig) => {
    const found = designationsWanted(sig.wantText).map(d => d.key);
    for (const bucket of sig.buckets) {
      // If this fails, the want text no longer asks for the kind of person the
      // member ticked, and everyone who ticks it becomes unmatchable.
      expect(found).toContain(bucket);
    }
  });

  it('never asks for candidates when the member wants a co-founder', () => {
    // "key talent" in the deck's own wording reads as someone who wants to BE
    // hired — the opposite of what the member meant.
    const text = INTENT_SIGNALS.find_cofounder_talent.reasonText!;
    expect(text).not.toMatch(/talent/i);
    expect(designationsWanted(text).map(d => d.key)).not.toContain('job_seeker');
  });

  it('a reason that says nothing about WHO produces no want text', () => {
    // "Grow my professional network" and "just exploring" describe no person.
    // Turned into a search they would match everybody.
    expect(INTENT_SIGNALS.grow_network.reasonText).toBeNull();
    expect(INTENT_SIGNALS.invited_exploring.reasonText).toBeNull();
  });
});

describe('what the member IS is recognised as that', () => {
  it.each(Object.entries(MEET_SIGNALS))('%s writes titles that read back as its buckets', (_key, sig) => {
    const buckets = sig.roleTitles.map(t => normalizeDesignation(t));
    for (const bucket of sig.buckets) {
      // If this fails, saying "I am a founder" no longer reads as one.
      expect(buckets).toContain(bucket);
    }
  });

  it('one tick for sales and marketing is understood as both', () => {
    const titles = roleTitlesFor(['sales_marketing_growth']);
    const buckets = titles.map(t => normalizeDesignation(t));
    expect(buckets).toContain('sales');
    expect(buckets).toContain('marketer');
  });

  it('a community builder is not filed as a generic manager', () => {
    expect(normalizeDesignation('Community builder')).toBe('community');
    expect(normalizeDesignation('Community Manager')).toBe('community');
    expect(normalizeDesignation('Event organiser')).toBe('community');
    expect(normalizeDesignation('Event organizer')).toBe('community');
  });

  it('offering investment makes you an investor to someone seeking one', () => {
    expect(selfBuckets([], ['investment'])).toContain('investor');
    expect(selfBuckets([], ['mentoring_advice'])).toContain('advisor');
  });
});

describe('what the member offers carries at least one real word', () => {
  // A stop-word-only phrase is invisible to the scorer. "Skills & services"
  // was exactly that, which is why it is not stored as written.
  it.each(Object.entries(OFFER_SIGNALS))('%s is more than stop words', (_key, sig) => {
    expect(sig.offerText.trim().length).toBeGreaterThan(0);
    const meaningful = sig.offerText.split(/[^a-z]+/i).filter(w => w.length >= 4 && !['with', 'from', 'your', 'that', 'this'].includes(w.toLowerCase()));
    expect(meaningful.length).toBeGreaterThan(0);
  });

  it('reads as one plain line on a profile', () => {
    expect(offerSummary(['mentoring_advice', 'investment'])).toBe('mentoring and advice, investment');
  });
});

describe('industries', () => {
  it('lists the fixed ones, and puts the member\'s own words first', () => {
    expect(industrySummary(['software_ai', 'finance_investing'], null)).toBe('software and AI, finance and investing');
    // Most people fall outside five industries, so what they typed is the only
    // thing we know about them and leads the line.
    expect(industrySummary(['other', 'software_ai'], 'marine logistics')).toBe('marine logistics, software and AI');
  });

  it('never exceeds the column it is written into', () => {
    const all = ONBOARDING_INDUSTRIES.map(o => o.key);
    expect(industrySummary(all, 'x'.repeat(200)).length).toBeLessThanOrEqual(100);
  });

  it('is empty when Other is ticked but nothing was typed', () => {
    expect(industrySummary(['other'], null)).toBe('');
    expect(industrySummary(['other'], '   ')).toBe('');
  });
});

describe('a tick-box member can be found by a tick-box member', () => {
  // The end-to-end promise of the whole flow, in one test: if Ana wants
  // founders and Bo says he is one, Ana's search has to reach Bo.
  const pairs: Array<[MeetKey, MeetKey]> = ONBOARDING_MEET.map(o => [o.key, o.key] as [MeetKey, MeetKey]);
  it.each(pairs)('wanting %s finds someone who says they are %s', (wantKey, selfKey) => {
    const wanted = designationsWanted(MEET_SIGNALS[wantKey].wantText).map(d => d.key);
    const theirBuckets = roleTitlesFor([selfKey]).map(t => normalizeDesignation(t));
    expect(wanted.some(w => theirBuckets.includes(w))).toBe(true);
  });

  it('and is not found by a search for something else', () => {
    const wantsInvestors = designationsWanted(MEET_SIGNALS.investors.wantText).map(d => d.key);
    const isDeveloper = roleTitlesFor(['developers_technical']).map(t => normalizeDesignation(t));
    expect(wantsInvestors.some(w => isDeveloper.includes(w))).toBe(false);
  });
});
