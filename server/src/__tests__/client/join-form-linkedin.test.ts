// ─── The request form's LinkedIn box (21 Oct 2026) ───────────────────────────
//
// LinkedIn is optional on the form, and what is typed into the box is turned into the one address the
// server stores: https://www.linkedin.com/in/<name>. The old clean-up put "https://linkedin.com/in/" in
// front of anything that did not start with http, so "linkedin.com/in/jane-doe" became
// "https://linkedin.com/in/linkedin.com/in/jane-doe" and the form said it was fine; a pasted address with
// a query string or a trailing slash went through as it was.
//
// The client has no test runner of its own, but this module is plain TypeScript with no imports, so these
// run the real code that ships (not a copy of it). The last block runs the same addresses through the
// server's check: the two are separate implementations and must never disagree about an address.

import { normalizeLinkedinInput, LINKEDIN_LINK_HELP } from '../../../../client/src/features/auth/linkedin-link';
import { canonicalLinkedinProfileUrl, LINKEDIN_PROFILE_HELP } from '../../services/join-request/linkedin-profile-url';

const JANE = 'https://www.linkedin.com/in/jane-doe';

describe('normalizeLinkedinInput: whatever a person types for a profile ends up as the one address', () => {
  it.each([
    ['a bare name', 'jane-doe'],
    ['a bare name with a capital letter', 'Jane-Doe', 'https://www.linkedin.com/in/Jane-Doe'],
    ['a bare name with the @ people put in front', '@jane-doe'],
    ['a bare name with a trailing slash', 'jane-doe/'],
    ['the part the box shows in front, typed again', 'in/jane-doe'],
    ['the part the box shows in front, with a slash', '/in/jane-doe'],
    ['www. and no scheme', 'www.linkedin.com/in/jane-doe'],
    ['no www. and no scheme', 'linkedin.com/in/jane-doe'],
    ['no scheme, with a trailing slash', 'linkedin.com/in/jane-doe/'],
    ['what the live form used to send', 'https://linkedin.com/in/jane-doe'],
    ['already the stored shape', JANE],
    ['http', 'http://www.linkedin.com/in/jane-doe'],
    ['another country, with a query string', 'https://uk.linkedin.com/in/jane-doe?x=1'],
    ['a share link from the phone app', 'https://www.linkedin.com/in/jane-doe?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app'],
    ['a trailing slash after a full address', 'https://www.linkedin.com/in/jane-doe/'],
    ['a page under the profile', 'https://www.linkedin.com/in/jane-doe/details/experience/'],
    ['spaces around it', '   jane-doe  '],
    ['a pasted line with a newline', 'https://www.linkedin.com/in/jane-doe\n'],
  ])('%s', (_what, typed, expected = JANE) => {
    expect(normalizeLinkedinInput(typed)).toBe(expected);
  });

  it('turns a name with letters outside A to Z into the encoded form a browser copies', () => {
    expect(normalizeLinkedinInput('josé-garcía-123')).toBe('https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123');
  });

  it('answers an empty string for an empty box, so the form sends no address at all', () => {
    expect(normalizeLinkedinInput('')).toBe('');
    expect(normalizeLinkedinInput('   ')).toBe('');
    expect(normalizeLinkedinInput('\n\t')).toBe('');
  });

  it.each([
    ['another site', 'https://example.com/not-a-linkedin-profile'],
    ['a bare web address', 'example.com'],
    ['a name with a dot (the box takes a name, or a whole address)', 'jane.doe'],
    ['two words', 'jane doe'],
    ['a LinkedIn page that is not a person', 'https://www.linkedin.com/company/acme'],
    ['the LinkedIn home page', 'linkedin.com'],
    ['/in/ with no name', 'linkedin.com/in/'],
    ['a host that only ends like LinkedIn', 'https://evil-linkedin.com/in/jane-doe'],
    ['LinkedIn as the start of another host', 'linkedin.com.evil.example/in/jane-doe'],
    ['a script', 'javascript:alert(1)'],
    ['another scheme', 'ftp://linkedin.com/in/jane-doe'],
    ['a character a name never holds', 'jane+doe'],
    ['only punctuation', '---'],
  ])('answers null, which the form reports, for %s', (_what, typed) => {
    expect(normalizeLinkedinInput(typed)).toBeNull();
  });

  it('says what to enter in the same sentence the server uses', () => {
    expect(LINKEDIN_LINK_HELP).toBe('Enter your LinkedIn profile link, for example linkedin.com/in/your-name');
    expect(LINKEDIN_LINK_HELP).toBe(LINKEDIN_PROFILE_HELP);
  });
});

describe('the form and the server never disagree about an address', () => {
  // Every one has a host, so both implementations read it the same way. A bare name is the form's own
  // convenience: the server only takes an address.
  it.each([
    'https://linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane-doe',
    'http://www.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane-doe/',
    'https://www.linkedin.com/in/jane-doe?utm_source=share',
    'https://uk.linkedin.com/in/jane-doe?x=1',
    'https://www.linkedin.com/in/jane-doe#about',
    'https://www.linkedin.com/in/jane-doe/details/experience/',
    'www.linkedin.com/in/jane-doe',
    'linkedin.com/in/jane-doe',
    '  linkedin.com/in/jane-doe  ',
    'HTTPS://WWW.LINKEDIN.COM/IN/Jane-Doe',
    'https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123',
    'https://www.linkedin.com/in/josé-garcía-123',
    'https://example.com/not-a-linkedin-profile',
    'https://example.com/in/jane-doe',
    'https://www.linkedin.com/company/acme',
    'https://www.linkedin.com/in/',
    'https://www.linkedin.com/in',
    'https://www.linkedin.com/',
    'https://evil-linkedin.com/in/jane-doe',
    'https://linkedin.com.evil.example/in/jane-doe',
    'https://linkedin.com@evil.example/in/jane-doe',
    'https://evil.example/in/jane-doe?next=linkedin.com',
    'javascript:alert(1)',
    'ftp://linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane doe',
    'https://www.linkedin.com/in/jane+doe',
    'https://www.linkedin.com/in/---',
  ])('%s', (typed) => {
    expect(normalizeLinkedinInput(typed)).toBe(canonicalLinkedinProfileUrl(typed));
  });
});
