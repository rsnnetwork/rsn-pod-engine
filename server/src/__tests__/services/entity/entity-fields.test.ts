// ─── Entity fields as they are stored (21 Oct 2026) ──────────────────────────
// A name is one name however it was spaced, optional text that says nothing is null, and a website
// is always a web address: the client renders it as a link, so a `javascript:` address must never
// reach the database.

import { blankToNull, characterCount, normaliseName, normaliseWebsite } from '../../../services/entity/entity-fields';

describe('normaliseName', () => {
  it.each([
    ['Acme Ltd', 'Acme Ltd'],
    ['  Acme Ltd  ', 'Acme Ltd'],
    ['Acme    Ltd', 'Acme Ltd'],
    ['\tAcme\n Ltd\r\n', 'Acme Ltd'],
    ['Ærø Fonden', 'Ærø Fonden'],
  ])('stores %j as %j', (typed, stored) => {
    expect(normaliseName(typed)).toBe(stored);
  });
});

// Final review, 21 Oct 2026: the name limits are counted as the database counts them.
describe('characterCount', () => {
  it.each([
    ['Acme', 4],
    ['Ærø', 3],
    ['😀', 1],
    ['𠀀', 1],
    ['😀😀', 2],
    ['Acme 🚀', 6],
  ])('%j has %i characters', (text, count) => {
    expect(characterCount(text)).toBe(count);
  });

  it('is not a string\'s length, which counts an emoji or a CJK Extension B character twice', () => {
    expect('😀'.length).toBe(2);
    expect('𠀀'.length).toBe(2);
  });
});

describe('blankToNull', () => {
  it('trims, and makes a blank answer null', () => {
    expect(blankToNull('  Berlin ')).toBe('Berlin');
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull('')).toBeNull();
    expect(blankToNull(null)).toBeNull();
  });

  it('keeps the lines inside a longer answer', () => {
    expect(blankToNull('  We build boats.\n\nAnd sails.  ')).toBe('We build boats.\n\nAnd sails.');
  });
});

describe('normaliseWebsite', () => {
  it.each([
    ['acme.com', 'https://acme.com'],
    ['www.acme.co.uk/about', 'https://www.acme.co.uk/about'],
    ['  acme.com  ', 'https://acme.com'],
    ['//acme.com', 'https://acme.com'],
    ['acme.com:8080/jobs', 'https://acme.com:8080/jobs'],
    ['http://acme.com', 'http://acme.com'],
    ['https://acme.com/team?x=1#top', 'https://acme.com/team?x=1#top'],
    ['HTTPS://Acme.com', 'HTTPS://Acme.com'],
    ['https://例え.jp', 'https://例え.jp'],
  ])('takes %j as %j', (typed, stored) => {
    expect(normaliseWebsite(typed)).toBe(stored);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(document.cookie)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:hello@acme.com',
    'ftp://acme.com',
    'file:///etc/passwd',
    'acme',
    'localhost',
    'http://localhost:3000',
    'https://user:secret@acme.com',
    'acme .com',
    'https://acme.com/a b',
    'https://',
    '',
    '   ',
  ])('refuses %j', (typed) => {
    expect(normaliseWebsite(typed)).toBeNull();
  });
});
