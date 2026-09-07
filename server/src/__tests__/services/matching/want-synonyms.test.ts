import { expandWantTags } from '../../../services/matching/want-synonyms';

describe('expandWantTags', () => {
  it('adds high-confidence synonyms so related meaning matches (W4)', () => {
    const out = expandWantTags(['ai']);
    expect(out).toContain('ai');
    expect(out).toContain('machine learning');
    expect(out).toContain('ml');
  });

  it('expands a multi-word term via a cluster key inside it', () => {
    const out = expandWantTags(['senior ml engineer']);
    expect(out).toContain('senior ml engineer');
    expect(out).toContain('machine learning engineer');
  });

  it('keeps the original terms and dedupes case-insensitively', () => {
    const out = expandWantTags(['Founder', 'founder', 'manufacturing']);
    expect(out.filter(t => t === 'founder')).toHaveLength(1);
    expect(out).toContain('entrepreneur');
    expect(out).toContain('production'); // manufacturing cluster
  });

  it('does not treat "ai" as a substring of an unrelated word like "email"', () => {
    const out = expandWantTags(['email marketing']);
    // "email" must NOT pull in the AI cluster…
    expect(out).not.toContain('machine learning');
    // …but "marketing" is a real cluster hit.
    expect(out).toContain('growth');
  });

  it('returns [] for empty input', () => {
    expect(expandWantTags([])).toEqual([]);
    expect(expandWantTags([null, undefined, '  '])).toEqual([]);
  });
});
