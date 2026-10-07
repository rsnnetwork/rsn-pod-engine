// ─── The sign-in page explains a Google sign-in that has to start again ──────
// (7 Oct 2026)
//
// A Google sign-in only finishes in the browser that started it. When the server refuses a callback
// (the cookie that ties it to the browser is missing or is another sign-in's, or the state is missing or
// not ours) it sends the browser to /login?error=google_try_again. The page turns ?error= codes into
// sentences, and shows a code it has no sentence for exactly as it is, so without an entry here the
// person would read "google_try_again". The client has no test runner of its own, so, like the other
// files here, this reads the source: it pins the sentence for that code, and that every sentence that
// was there before is still there, word for word.
//
// What the server does to earn that redirect is pinned in routes/google-sign-in-browser-binding.test.ts.

import * as fs from 'fs';
import * as path from 'path';

const LOGIN = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/auth/LoginPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The page's table of ?error= codes and their sentences, read from the source. */
function errorMessages(source: string): Record<string, string> {
  const start = source.indexOf('const ERROR_MESSAGES: Record<string, string> = {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n};', start);
  expect(end).toBeGreaterThan(start);
  const table: Record<string, string> = {};
  for (const line of source.slice(start, end).split('\n').slice(1)) {
    const entry = line.match(/^\s*(\w+): '(.*)',$/);
    if (entry) table[entry[1]] = entry[2];
  }
  return table;
}

describe('the sign-in page\'s ?error= sentences', () => {
  const messages = errorMessages(LOGIN);

  it('says what happened when a Google sign-in did not finish in the browser that started it', () => {
    expect(messages.google_try_again).toBe('Google sign-in did not finish in this browser. Please try again.');
  });

  it('keeps every sentence that was there, word for word, and adds only that one', () => {
    expect(messages).toEqual({
      google_auth_failed: 'Google sign-in failed. Please try again.',
      google_try_again: 'Google sign-in did not finish in this browser. Please try again.',
      INVALID_INVITE: 'The invite code is invalid or expired.',
      REGISTRATION_BLOCKED: 'You need an approved join request to sign up. Please request to join first.',
      ACCOUNT_CLOSED: 'This account was closed. Ask to join again, and you can sign in as soon as you are approved.',
      USER_SUSPENDED: 'This account is suspended. Please contact the RSN team if you think this is a mistake.',
    });
  });

  it('is plain words, with nothing a member would not recognise', () => {
    expect(messages.google_try_again).not.toMatch(/session|token|nonce|cookie|oauth|state\b|error|invalid/i);
  });

  it('is shown for the code in the address, and a code with no sentence is shown as it is (which is why the entry matters)', () => {
    expect(LOGIN).toMatch(/urlError \? \(ERROR_MESSAGES\[urlError\] \|\| urlError\) : null/);
  });
});
