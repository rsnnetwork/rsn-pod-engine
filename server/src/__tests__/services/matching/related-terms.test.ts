// 15 Sep 2026: related means the same stem, a short ending, or (long words)
// the same first seven letters. A word inside another word is not the same.
import { isRelatedTerm, stemTerm } from '../../../services/matching/intent-signals';

describe('stemTerm', () => {
  it('strips one ending', () => {
    expect(stemTerm('developers')).toBe('develop');
    expect(stemTerm('development')).toBe('develop');
    expect(stemTerm('programming')).toBe('programm');
    expect(stemTerm('investors')).toBe('invest');
    expect(stemTerm('investment')).toBe('invest');
    expect(stemTerm('industries')).toBe('industry');
    expect(stemTerm('react')).toBe('react');
    expect(stemTerm('reactive')).toBe('reactive');
    expect(stemTerm('sales')).toBe('sale');
    expect(stemTerm('saas')).toBe('saas');
  });
});

describe('isRelatedTerm', () => {
  it.each([
    ['developer', 'development'], ['developers', 'developer'], ['programmer', 'programming'],
    ['investor', 'investors'], ['manufacturer', 'manufacturing'], ['react', 'reactjs'], ['designer', 'design'],
  ])('%s ~ %s', (a, b) => { expect(isRelatedTerm(a, b)).toBe(true); expect(isRelatedTerm(b, a)).toBe(true); });

  it.each([
    ['react', 'reactive'], ['react', 'reaction'], ['develop', 'devops'], ['sales', 'salesforce'], ['art', 'artificial'], ['data', 'database'],
  ])('%s is not %s', (a, b) => { expect(isRelatedTerm(a, b)).toBe(false); expect(isRelatedTerm(b, a)).toBe(false); });
});
