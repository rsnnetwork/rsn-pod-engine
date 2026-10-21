// ─── The LinkedIn address on a join request (21 Oct 2026) ────────────────────
//
// LinkedIn is optional on the request form. When an address IS given it must be a LinkedIn profile
// (linkedin.com/in/<name>) and it is stored in one shape, https://www.linkedin.com/in/<name>, however it was
// typed: with or without www., with http, a trailing slash, a query string, another country's subdomain.
// Anything else is refused: the field is shown to admins as a link, so it must never be someone else's site.

import { canonicalLinkedinProfileUrl, LINKEDIN_PROFILE_HELP } from '../../../services/join-request/linkedin-profile-url';

const SLUG = 'https://www.linkedin.com/in/jane-doe';

describe('canonicalLinkedinProfileUrl: what is accepted, and the one shape it is stored in', () => {
  it.each([
    ['what the live form sends', 'https://linkedin.com/in/jane-doe', SLUG],
    ['already in the stored shape', SLUG, SLUG],
    ['www.', 'https://www.linkedin.com/in/jane-doe', SLUG],
    ['http://', 'http://www.linkedin.com/in/jane-doe', SLUG],
    ['http:// without www.', 'http://linkedin.com/in/jane-doe', SLUG],
    ['a trailing slash', 'https://www.linkedin.com/in/jane-doe/', SLUG],
    ['several trailing slashes', 'https://www.linkedin.com/in/jane-doe///', SLUG],
    ['a query string', 'https://www.linkedin.com/in/jane-doe?utm_source=share&utm_medium=member_ios', SLUG],
    ['a fragment', 'https://www.linkedin.com/in/jane-doe#about', SLUG],
    ['another country (uk.)', 'https://uk.linkedin.com/in/jane-doe?x=1', SLUG],
    ['the mobile site (m.)', 'https://m.linkedin.com/in/jane-doe', SLUG],
    ['a page under the profile', 'https://www.linkedin.com/in/jane-doe/details/experience/', SLUG],
    ['no scheme', 'linkedin.com/in/jane-doe', SLUG],
    ['no scheme, with www.', 'www.linkedin.com/in/jane-doe', SLUG],
    ['spaces around it', '   https://www.linkedin.com/in/jane-doe  ', SLUG],
    ['a newline after it (a pasted line)', 'https://www.linkedin.com/in/jane-doe\n', SLUG],
    ['capitals in the scheme, host and path word', 'HTTPS://WWW.LINKEDIN.COM/IN/jane-doe', SLUG],
  ])('%s', (_what, typed, stored) => {
    expect(canonicalLinkedinProfileUrl(typed)).toBe(stored);
  });

  it('keeps the name exactly as it was written, capitals and the trailing id included', () => {
    expect(canonicalLinkedinProfileUrl('https://www.linkedin.com/in/Ali-Hamza-b0650a281/')).toBe('https://www.linkedin.com/in/Ali-Hamza-b0650a281');
  });

  it('keeps a name with letters outside A to Z, in the encoded form a browser copies', () => {
    expect(canonicalLinkedinProfileUrl('https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123')).toBe('https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123');
    expect(canonicalLinkedinProfileUrl('https://www.linkedin.com/in/josé-garcía-123')).toBe('https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123');
  });
});

describe('canonicalLinkedinProfileUrl: what is refused', () => {
  it.each([
    ['another site', 'https://example.com/not-a-linkedin-profile'],
    ['another site that has an /in/ path', 'https://example.com/in/jane-doe'],
    ['a LinkedIn page that is not a person', 'https://www.linkedin.com/company/acme'],
    ['a LinkedIn page with an /in/ lookalike', 'https://www.linkedin.com/pub/in/jane-doe'],
    ['the LinkedIn home page', 'https://www.linkedin.com/'],
    ['/in/ with no name', 'https://www.linkedin.com/in/'],
    ['/in with nothing after it', 'https://www.linkedin.com/in'],
    ['an empty name between slashes', 'https://www.linkedin.com/in//jane-doe'],
    ['a host that only ends like LinkedIn', 'https://evil-linkedin.com/in/jane-doe'],
    ['LinkedIn as the start of another host', 'https://linkedin.com.evil.example/in/jane-doe'],
    ['LinkedIn in the query of another site', 'https://evil.example/in/jane-doe?next=linkedin.com'],
    ['LinkedIn as the user name of another site', 'https://linkedin.com@evil.example/in/jane-doe'],
    ['a script', 'javascript:alert(1)'],
    ['a script that names LinkedIn', 'javascript://linkedin.com/in/jane-doe%0Aalert(1)'],
    ['a data address', 'data:text/html,<script>alert(1)</script>'],
    ['another scheme', 'ftp://linkedin.com/in/jane-doe'],
    ['a bare name (the form turns it into an address; an address is what the server takes)', 'jane-doe'],
    ['words', 'not a url'],
    ['a space inside the name', 'https://www.linkedin.com/in/jane doe'],
    ['a newline inside the name', 'https://www.linkedin.com/in/jane\ndoe'],
    ['a character a name never holds', 'https://www.linkedin.com/in/jane+doe'],
    ['a name made only of punctuation', 'https://www.linkedin.com/in/---'],
    ['nothing at all', ''],
    ['only spaces', '   '],
  ])('%s', (_what, typed) => {
    expect(canonicalLinkedinProfileUrl(typed)).toBeNull();
  });

  it('says what to enter in one plain sentence, with an example', () => {
    expect(LINKEDIN_PROFILE_HELP).toBe('Enter your LinkedIn profile link, for example linkedin.com/in/your-name');
  });
});
