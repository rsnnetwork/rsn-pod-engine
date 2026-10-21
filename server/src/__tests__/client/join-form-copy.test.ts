// ─── The request form says REASON, drops "Tell us about yourself", and LinkedIn is optional ─────
// (21 Oct 2026)
//
// The client's 19 Oct feedback on the request-to-join form: "Remove the sentences here, the 'tell us
// about yourself' one", "LinkedIn should not be required. Recommend LinkedIn, but let people add it
// later." And the product is called REASON wherever a person reads it.
//
// The client has no test runner of its own, so, like the other files here, this reads the source. What
// the form DOES (the address it sends, an empty box sending nothing, the errors) is run for real in
// join-form-linkedin.test.ts and in the headed smoke of the screen. The two admin screens that show a
// request are in admin-join-request-linkedin.test.ts: they are on the live app too.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const FORM = read('features/auth/RequestToJoinPage.tsx');

/** The source with its comments taken out, so a word in a comment is not read as something a person sees. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Every .tsx file under dir. */
function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

describe('the request-to-join form', () => {
  it('shows the REASON lockup, about 44px tall and centred, in place of the old RSN logo', () => {
    const logo = FORM.match(/<img[^>]*reason-logo\.png[^>]*>/)?.[0] ?? '';
    expect(logo).toMatch(/src="\/reason-logo\.png"/);
    expect(logo).toMatch(/alt="REASON"/);
    expect(logo).toMatch(/\bh-11\b/); // 2.75rem = 44px
    expect(logo).toMatch(/\bmx-auto\b/);
    expect(FORM).not.toMatch(/rsn-logo\.png/);
  });

  it('says "REASON is invite-only." and nothing more: the "Tell us about yourself" sentences are gone', () => {
    expect(FORM).toMatch(/>REASON is invite-only\.<\/p>/);
    expect(FORM).not.toMatch(/Tell us about yourself/i);
    expect(FORM).not.toMatch(/great fit for the/i);
  });

  it('keeps "Why do you want to join REASON?" as a required question of at most 1000 characters, with no placeholder', () => {
    const area = FORM.match(/<textarea[\s\S]*?\/>/)?.[0] ?? '';
    expect(area).not.toBe('');
    expect(area).not.toMatch(/placeholder/);
    expect(area).toMatch(/required:/);
    expect(area).toMatch(/maxLength:\s*\{\s*value:\s*1000/);
    expect(FORM).toMatch(/>Why do you want to join REASON\?<\/label>/);
  });

  it('labels the LinkedIn box "(optional)", with the recommendation under it, and does not require it', () => {
    expect(FORM).toMatch(/>LinkedIn profile \(optional\)<\/label>/);
    expect(FORM).toMatch(/Recommended\. You can also add it later\./);
    const field = FORM.match(/register\('linkedinUrl'[\s\S]*?\}\)\}/)?.[0] ?? '';
    expect(field).not.toBe('');
    expect(field).not.toMatch(/required/);
    expect(FORM).not.toMatch(/LinkedIn profile is required/);
    expect(FORM).toMatch(/linkedin\.com\/in\//); // the prefix the box shows stays
  });

  it('ties each of those labels to its box, so the question can be found by its words', () => {
    expect(FORM).toMatch(/<label htmlFor="join-linkedin"/);
    expect(FORM).toMatch(/id="join-linkedin"/);
    expect(FORM).toMatch(/<label htmlFor="join-reason"/);
    expect(FORM).toMatch(/id="join-reason"/);
  });

  it('uses the one clean-up that the tests run, and reports a bad address in the server\'s own words', () => {
    expect(FORM).toMatch(/from '\.\/linkedin-link'/);
    expect(FORM).toMatch(/normalizeLinkedinInput/);
    expect(FORM).toMatch(/LINKEDIN_LINK_HELP/);
    // The old clean-up put "https://linkedin.com/in/" in front of anything, including a whole address.
    expect(FORM).not.toMatch(/https:\/\/linkedin\.com\/in\/\$\{/);
  });

  it('keeps the text boxes at 16px on a phone, so iPhone Safari does not zoom the page when one is focused', () => {
    const area = FORM.match(/<textarea[\s\S]*?\/>/)?.[0] ?? '';
    expect(area).toMatch(/\btext-base\b/);
    expect(area).toMatch(/\bsm:text-sm\b/);
    const input = FORM.match(/<input[\s\S]*?\/>/)?.[0] ?? '';
    expect(input).toMatch(/\btext-base\b/);
    expect(input).toMatch(/\bsm:text-sm\b/);
  });

  it('says the application is reviewed by the REASON team, and thanks them for their interest in REASON', () => {
    expect(FORM).toMatch(/Your application will be reviewed by the REASON team\. You(&apos;|')ll receive an email with the outcome\./);
    expect(FORM).toMatch(/Thank you for your interest in REASON\. We(&apos;|')ll review your application and get back to you by email\./);
  });

  it('goes back to REASON', () => {
    expect(FORM).toMatch(/<ArrowLeft[^>]*\/> Back to REASON/);
  });

  it('never shows the letters RSN to a person', () => {
    expect(withoutComments(FORM)).not.toMatch(/\bRSN\b/);
  });
});

describe('the whole client', () => {
  it('has no "Tell us about yourself" anywhere', () => {
    const offenders = tsxFiles(CLIENT_SRC).filter((file) => /Tell us about yourself/i.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(CLIENT_SRC, f))).toEqual([]);
  });
});
