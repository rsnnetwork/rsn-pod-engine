// ─── One LinkedIn profile address, whichever form asked for it (21 Oct 2026) ──────────────────
//
// The final review of 21 Oct: the live request form puts "https://linkedin.com/in/" in front of anything
// typed without http, so "linkedin.com/in/jane-doe" reaches the server as
// https://linkedin.com/in/linkedin.com/in/jane-doe. Both server normalisers (the join request's and
// onboarding v2's) read the first /in/ segment as the name and stored https://www.linkedin.com/in/linkedin.com:
// the person's name was lost. There is now one helper in @rsn/shared, used by both, which reads past a
// LinkedIn address where the name should be.
//
// The stored form, settled here: https://www.linkedin.com/in/<name>, the name with the capitals it was
// written with, and any letter outside A to Z percent-encoded as UTF-8 with capital hex digits, which is what
// a browser copies from its address bar. However the name was typed (raw, encoded, in lower-case hex, with its
// accents written as separate marks) it is stored once, the same way.

import { LINKEDIN_PROFILE_HELP, linkedinProfileUrl } from '@rsn/shared';
import { canonicalLinkedinProfileUrl, LINKEDIN_PROFILE_HELP as JOIN_HELP } from '../../services/join-request/linkedin-profile-url';

const JANE = 'https://www.linkedin.com/in/jane-doe';

describe('the live join form\'s address with a LinkedIn address inside it', () => {
  it.each([
    ['linkedin.com/in/jane-doe, typed into the live form', 'https://linkedin.com/in/linkedin.com/in/jane-doe'],
    ['www.linkedin.com/in/jane-doe', 'https://linkedin.com/in/www.linkedin.com/in/jane-doe'],
    ['another country, uk.linkedin.com/in/jane-doe', 'https://linkedin.com/in/uk.linkedin.com/in/jane-doe'],
    ['the mobile site, m.linkedin.com/in/jane-doe', 'https://linkedin.com/in/m.linkedin.com/in/jane-doe'],
    ['a capital L, as a phone keyboard writes it', 'https://linkedin.com/in/Linkedin.com/in/jane-doe'],
    ['with a share query', 'https://linkedin.com/in/linkedin.com/in/jane-doe?utm_source=share&utm_medium=member_ios'],
    ['with a fragment', 'https://linkedin.com/in/linkedin.com/in/jane-doe#about'],
    ['with a page under the profile', 'https://linkedin.com/in/linkedin.com/in/jane-doe/details/experience'],
    ['with a trailing slash', 'https://linkedin.com/in/linkedin.com/in/jane-doe/'],
    ['nested twice', 'https://linkedin.com/in/linkedin.com/in/www.linkedin.com/in/jane-doe'],
  ])('%s keeps the person\'s name', (_what, sent) => {
    expect(linkedinProfileUrl(sent)).toBe(JANE);
  });

  it('keeps the capitals of the name inside it', () => {
    expect(linkedinProfileUrl('https://linkedin.com/in/linkedin.com/in/Ali-Hamza-b0650a281')).toBe('https://www.linkedin.com/in/Ali-Hamza-b0650a281');
  });

  it.each([
    ['only a LinkedIn address where the name should be', 'https://linkedin.com/in/linkedin.com'],
    ['a LinkedIn address, then nothing', 'https://linkedin.com/in/www.linkedin.com/in/'],
    ['a LinkedIn address, then a company page', 'https://linkedin.com/in/linkedin.com/company/acme'],
    ['a LinkedIn address, then the home page', 'https://linkedin.com/in/linkedin.com/'],
  ])('refuses %s: there is no name to keep', (_what, sent) => {
    expect(linkedinProfileUrl(sent)).toBeNull();
  });
});

describe('every way of writing one profile is stored as one address', () => {
  it.each([
    ['the stored form itself', JANE],
    ['no www.', 'https://linkedin.com/in/jane-doe'],
    ['http', 'http://www.linkedin.com/in/jane-doe'],
    ['no protocol', 'linkedin.com/in/jane-doe'],
    ['no protocol, with www.', 'www.linkedin.com/in/jane-doe'],
    ['another country', 'https://uk.linkedin.com/in/jane-doe'],
    ['the mobile site', 'https://m.linkedin.com/in/jane-doe'],
    ['a trailing slash', 'https://www.linkedin.com/in/jane-doe/'],
    ['several trailing slashes', 'https://www.linkedin.com/in/jane-doe///'],
    ['a query', 'https://www.linkedin.com/in/jane-doe?trk=public_profile'],
    ['a fragment', 'https://www.linkedin.com/in/jane-doe#experience'],
    ['a page under the profile', 'https://www.linkedin.com/in/jane-doe/details/experience/'],
    ['spaces around it', '  linkedin.com/in/jane-doe  '],
    ['a newline after it', 'https://www.linkedin.com/in/jane-doe\n'],
    ['capitals in the protocol, the host and "in"', 'HTTPS://WWW.LINKEDIN.COM/IN/jane-doe'],
    ['a protocol-relative address', '//www.linkedin.com/in/jane-doe'],
  ])('%s', (_what, typed) => {
    expect(linkedinProfileUrl(typed)).toBe(JANE);
  });

  it('keeps the capitals the name was written with (LinkedIn reads a name in any case)', () => {
    expect(linkedinProfileUrl('https://de.linkedin.com/in/Jane-Doe/')).toBe('https://www.linkedin.com/in/Jane-Doe');
    expect(linkedinProfileUrl('LINKEDIN.COM/IN/JANE-DOE')).toBe('https://www.linkedin.com/in/JANE-DOE');
  });

  it.each([
    ['typed as it reads', 'https://www.linkedin.com/in/josé-garcía-123'],
    ['as a browser copies it', 'https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123'],
    ['encoded with lower-case hex', 'https://www.linkedin.com/in/jos%c3%a9-garc%c3%ada-123'],
    ['with each accent as a separate mark', 'https://www.linkedin.com/in/josé-garcía-123'],
  ])('a name with letters outside A to Z, %s, is stored encoded as a browser copies it', (_what, typed) => {
    expect(linkedinProfileUrl(typed)).toBe('https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123');
  });

  it('keeps names in other scripts, encoded', () => {
    expect(linkedinProfileUrl('linkedin.com/in/jörg-müller-123')).toBe('https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller-123');
    expect(linkedinProfileUrl('linkedin.com/in/王伟-123')).toBe(`https://www.linkedin.com/in/${encodeURIComponent('王伟-123')}`);
  });

  it('a name of 2 to 100 characters, as LinkedIn allows', () => {
    expect(linkedinProfileUrl('linkedin.com/in/ab')).toBe('https://www.linkedin.com/in/ab');
    expect(linkedinProfileUrl(`linkedin.com/in/${'a'.repeat(100)}`)).toBe(`https://www.linkedin.com/in/${'a'.repeat(100)}`);
  });
});

describe('what is refused', () => {
  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['null', null],
    ['undefined', undefined],
    ['a bare name (an address is what is taken)', 'jane-doe'],
    ['words', 'not a url'],
    ['another site', 'https://example.com/in/jane-doe'],
    ['another site with LinkedIn in its query', 'https://evil.example/in/jane-doe?next=linkedin.com'],
    ['a host that only ends like LinkedIn', 'https://evil-linkedin.com/in/jane-doe'],
    ['a host that only starts like LinkedIn', 'https://linkedin.com.evil.example/in/jane-doe'],
    ['a host that is not LinkedIn at all', 'https://notlinkedin.com/in/jane-doe'],
    ['LinkedIn with a dot at the end of the host', 'https://www.linkedin.com./in/jane-doe'],
    ['a company page', 'https://www.linkedin.com/company/acme'],
    ['a school page', 'https://www.linkedin.com/school/acme'],
    ['an /in/ further down the path', 'https://www.linkedin.com/pub/in/jane-doe'],
    ['the home page', 'https://www.linkedin.com/'],
    ['/in/ with no name', 'https://www.linkedin.com/in/'],
    ['/in with nothing after it', 'https://www.linkedin.com/in'],
    ['an empty name between slashes', 'https://www.linkedin.com/in//jane-doe'],
    ['a port', 'https://www.linkedin.com:8080/in/jane-doe'],
    ['the https port, written out', 'https://www.linkedin.com:443/in/jane-doe'],
    ['a port, with no protocol', 'linkedin.com:443/in/jane-doe'],
    ['a user name', 'https://jane@www.linkedin.com/in/jane-doe'],
    ['a user name and a password', 'https://jane:secret@www.linkedin.com/in/jane-doe'],
    ['LinkedIn as the user name of another site', 'https://linkedin.com@evil.example/in/jane-doe'],
    ['a script', 'javascript:alert(1)'],
    ['a script that names LinkedIn', 'javascript:alert(1)//linkedin.com/in/jane-doe'],
    ['a data address', 'data:text/html,<script>alert(1)</script>'],
    ['another protocol', 'ftp://linkedin.com/in/jane-doe'],
    ['a space in the name', 'https://www.linkedin.com/in/jane doe'],
    ['a newline in the name', 'https://www.linkedin.com/in/jane\ndoe'],
    ['an encoded space in the name', 'https://www.linkedin.com/in/jane%20doe'],
    ['an encoded slash in the name', 'https://www.linkedin.com/in/jane%2Fdoe'],
    ['broken encoding', 'https://www.linkedin.com/in/jane%zz'],
    ['markup', 'https://www.linkedin.com/in/<script>'],
    ['a character a name never holds', 'https://www.linkedin.com/in/jane+doe'],
    ['a name that starts with punctuation', 'https://www.linkedin.com/in/-jane'],
    ['only punctuation', 'https://www.linkedin.com/in/---'],
    ['a one-letter name', 'linkedin.com/in/x'],
    ['a name over 100 characters', `linkedin.com/in/${'a'.repeat(101)}`],
    ['more than 500 characters in all', `https://www.linkedin.com/in/jane-doe?${'x'.repeat(500)}`],
  ])('%s', (_what, typed) => {
    expect(linkedinProfileUrl(typed)).toBeNull();
  });
});

describe('one helper, one sentence', () => {
  it('the request to join runs exactly this helper', () => {
    expect(canonicalLinkedinProfileUrl).toBe(linkedinProfileUrl);
  });

  it('says what to enter in one plain sentence, with an example, wherever an address is refused', () => {
    expect(LINKEDIN_PROFILE_HELP).toBe('Enter your LinkedIn profile link, for example linkedin.com/in/your-name');
    expect(JOIN_HELP).toBe(LINKEDIN_PROFILE_HELP);
  });

  it('is plain code with no imports, so the browser could run it too', () => {
    const fs: typeof import('fs') = require('fs');
    const path: typeof import('path') = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../../../shared/src/linkedin/profile-url.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
