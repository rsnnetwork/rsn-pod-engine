// ─── The sign-in page tells the server where Google should bring you back ────
// (7 Oct 2026)
//
// Ali signed in with Google on the preview and landed on the live app. The server now
// brings Google sign-in back to the site it started on, and takes that site from ?origin=
// on the address the sign-in page sends the browser to (or, failing that, from the Referer).
// The client has no test runner of its own, so, like the other files here, this reads the
// source: it pins that the Google button names the site it is on, and nothing else about
// the button changes.
//
// What the server does with the value is pinned in routes/google-sign-in-origin.test.ts:
// it only honours its own sites, so a page cannot send anyone elsewhere by lying here.

import * as fs from 'fs';
import * as path from 'path';

const LOGIN = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/auth/LoginPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The Google button's click handler: from its declaration to the closing of its arrow function. */
function googleHandler(source: string): string {
  const start = source.indexOf('const handleGoogleLogin = () => {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n  };', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('the Google button on the sign-in page', () => {
  const handler = googleHandler(LOGIN);

  it('sends the origin of the page it is on as ?origin= (set on the address, so it is URL-encoded)', () => {
    expect(handler).toMatch(/googleUrl\.searchParams\.set\('origin', window\.location\.origin\)/);
  });

  it('names the site before it sends the browser away, and sends it to the address it built', () => {
    const named = handler.indexOf("searchParams.set('origin'");
    const leaves = handler.indexOf('window.location.href = googleUrl.toString()');
    expect(named).toBeGreaterThan(-1);
    expect(leaves).toBeGreaterThan(named);
  });

  it('still starts from /auth/google on the API and keeps its invite code parameter, sent only when there is one', () => {
    expect(handler).toMatch(/new URL\(`\$\{API_URL\}\/auth\/google`, window\.location\.origin\)/);
    expect(handler).toMatch(/if \(inviteCodeValue\) \{\s*googleUrl\.searchParams\.set\('inviteCode', inviteCodeValue\);\s*\}/);
  });

  it('takes the origin from the page itself, never from the address bar\'s query or anything the member typed', () => {
    const originLines = handler.split('\n').filter((line) => /'origin'/.test(line));
    expect(originLines).toHaveLength(1);
    expect(originLines[0]).not.toMatch(/params|inviteCode|redirect|location\.search|getValues|data\./);
  });

  it('the email-link sign-in on the same page still names the site too (the existing behaviour this matches)', () => {
    expect(LOGIN).toMatch(/login\(data\.email, window\.location\.origin, inviteCodeValue \|\| undefined\)/);
  });
});
