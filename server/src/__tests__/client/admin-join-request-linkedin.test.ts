// ─── The admin join-request screens when a request has no LinkedIn (21 Oct 2026) ─────
//
// LinkedIn is optional on the request form now ("Recommend LinkedIn, but let people add it later"), so a
// request can hold NULL, and older rows can hold an empty string. The queue and the page an admin reaches
// from the email both show the plain text "No LinkedIn" for those, never a link that goes nowhere, and only
// ever make a link of an http(s) address (the form used to accept any text that parsed as a URL, so an old
// row could hold a "javascript:" address). The answer to "why do you want to join" is labelled "Why REASON",
// and the approval question says REASON.
//
// These two screens are also on the live app, so what is pinned here must hold on both.
//
// The client has no test runner of its own, so, like the other files here, this reads the source; the one
// decision it makes (link or text) is a pure function, and that is run for real.

import * as fs from 'fs';
import * as path from 'path';
import { linkedinHref } from '../../../../client/src/features/admin/linkedin-href';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const QUEUE = read('features/admin/AdminJoinRequestsPage.tsx');
const ACTION = read('features/admin/AdminJoinRequestActionPage.tsx');

/** The source with its comments taken out, so a word in a comment is not read as something a person sees. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

describe('the admin queue', () => {
  it('knows a request can have no LinkedIn, and shows the text "No LinkedIn" instead of a link', () => {
    expect(QUEUE).toMatch(/linkedinUrl: string \| null;/);
    expect(QUEUE).toMatch(/linkedinHref\(r\.linkedinUrl\)/);
    expect(QUEUE).toMatch(/>No LinkedIn</);
    expect(QUEUE).not.toMatch(/href=\{r\.linkedinUrl\}/);
  });

  it('asks "Approve {name}\'s request to join REASON?"', () => {
    expect(QUEUE).toMatch(/`Approve \$\{reviewModal\.request\.fullName\}'s request to join REASON\?`/);
  });

  it('never shows the letters RSN to a person', () => {
    expect(withoutComments(QUEUE)).not.toMatch(/\bRSN\b/);
  });
});

describe('the page an admin reaches from the email', () => {
  it('shows the text "No LinkedIn" in the LinkedIn row, instead of leaving the row out or linking nowhere', () => {
    expect(ACTION).toMatch(/linkedinHref\(request\.linkedinUrl\)/);
    expect(ACTION).toMatch(/>No LinkedIn</);
    expect(ACTION).toMatch(/<Field\s+label="LinkedIn"/);
    expect(ACTION).not.toMatch(/href=\{request\.linkedinUrl\}/);
  });

  it('labels the answer "Why REASON"', () => {
    expect(ACTION).toMatch(/label="Why REASON"/);
    expect(ACTION).not.toMatch(/Why RSN/);
  });

  it('gives the label column room for "WHY REASON" on one line', () => {
    expect(ACTION).toMatch(/sm:w-24/);
    expect(ACTION).not.toMatch(/sm:w-20/);
  });

  it('never shows the letters RSN to a person', () => {
    expect(withoutComments(ACTION)).not.toMatch(/\bRSN\b/);
  });
});

describe('linkedinHref: what the admin screens open for a request', () => {
  it.each([
    ['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/in/jane-doe'],
    ['  https://www.linkedin.com/in/jane-doe  ', 'https://www.linkedin.com/in/jane-doe'],
    ['http://linkedin.com/in/jane-doe', 'http://linkedin.com/in/jane-doe'],
    ['HTTPS://LINKEDIN.COM/IN/JANE', 'HTTPS://LINKEDIN.COM/IN/JANE'],
  ])('opens %s', (stored, opened) => {
    expect(linkedinHref(stored)).toBe(opened);
  });

  it.each([
    ['no LinkedIn (NULL)', null],
    ['no LinkedIn (missing)', undefined],
    ['an empty string, as some older rows hold', ''],
    ['only spaces', '   '],
    ['a script', 'javascript:alert(1)'],
    ['a data address', 'data:text/html,hello'],
    ['an address with no scheme, which a link would read as a page on this site', 'linkedin.com/in/jane-doe'],
  ])('opens nothing for %s, so the screen says "No LinkedIn"', (_what, stored) => {
    expect(linkedinHref(stored)).toBeNull();
  });
});
