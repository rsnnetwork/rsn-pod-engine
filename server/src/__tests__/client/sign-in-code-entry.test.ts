// server/src/__tests__/client/sign-in-code-entry.test.ts
//
// 1 Nov 2026 (30 Oct review, 8.4 and 5d). Stefan could not sign in because he expected a password, and a signed-out
// member who followed a meeting link landed on Home after signing in. The sign-in page now says no password is
// needed; the waiting screen takes the 6-digit code from the email (POST /auth/magic-link/code); and the page a
// signed-out visit was going to is kept through sign-in by link, code or Google. The pure parts run here; the rest
// is read from the source, as its neighbours in this folder do. The headed walk is e2e/tests/n1-t4-signin-code.spec.ts.

import * as fs from 'fs';
import * as path from 'path';
import { digitsOf, codeErrorMessage, CODE_LENGTH } from '../../../../client/src/features/auth/sign-in-code';
import { safeReturnPath, signInPathFor } from '../../../../client/src/features/auth/return-path';

const root = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const apiError = (code: string, extra: object = {}) => ({ response: { data: { error: { code, message: 'server words', ...extra } } } });

describe('the code a member types or pastes', () => {
  it('keeps only digits, at most six, so "123 456", "123-456" and a pasted sentence all work', () => {
    expect(CODE_LENGTH).toBe(6);
    expect(digitsOf('123 456')).toBe('123456');
    expect(digitsOf('123-456')).toBe('123456');
    expect(digitsOf('Your code: 042517.')).toBe('042517');
    expect(digitsOf('1234567890')).toBe('123456');
    expect(digitsOf('')).toBe('');
  });
});

describe('what a refused code says, in plain sentences', () => {
  it('a wrong code says how many tries are left', () => {
    expect(codeErrorMessage(apiError('AUTH_SIGN_IN_CODE_WRONG', { details: { attemptsLeft: 3 } })))
      .toBe('That code is not right. You can try 3 more times.');
    expect(codeErrorMessage(apiError('AUTH_SIGN_IN_CODE_WRONG', { details: { attemptsLeft: 1 } })))
      .toBe('That code is not right. You can try 1 more time.');
    expect(codeErrorMessage(apiError('AUTH_SIGN_IN_CODE_WRONG'))).toBe('That code is not right. Check the newest email and try again.');
  });

  it('a locked, expired or used code says to send a new email', () => {
    expect(codeErrorMessage(apiError('AUTH_SIGN_IN_LOCKED')))
      .toBe('That code was entered wrongly too many times, so it and the link no longer work. Send a new email to get a fresh code.');
    expect(codeErrorMessage(apiError('AUTH_SIGN_IN_CODE_EXPIRED'))).toBe('This code has expired. Send a new email to get a fresh code.');
    expect(codeErrorMessage(apiError('AUTH_MAGIC_LINK_USED'))).toBe('This code has already been used. Send a new email to get a fresh code.');
  });

  it('a closed or suspended account, the address limit and a bad code keep their own sentences', () => {
    expect(codeErrorMessage(apiError('ACCOUNT_CLOSED'))).toMatch(/^This account was closed\./);
    expect(codeErrorMessage(apiError('USER_SUSPENDED'))).toMatch(/^This account is suspended\./);
    expect(codeErrorMessage(apiError('RATE_LIMIT_EXCEEDED'))).toBe('Too many codes tried. Please wait 15 minutes, then try again.');
    expect(codeErrorMessage(apiError('VALIDATION_ERROR'))).toBe('Enter the 6-digit code from the email.');
  });

  it('anything else (the network, a fault) is a sentence too, never a code or "Network Error"', () => {
    expect(codeErrorMessage(new Error('Network Error'))).toBe('We could not check that code. Please try again.');
    expect(codeErrorMessage(apiError('INTERNAL_ERROR'))).toBe('We could not check that code. Please try again.');
  });
});

describe('the page to come back to after sign-in', () => {
  it('is a path on this site only', () => {
    expect(safeReturnPath('/meet/abc?scheduled=1&kind=video')).toBe('/meet/abc?scheduled=1&kind=video');
    expect(safeReturnPath('/sessions/123')).toBe('/sessions/123');
    for (const bad of [null, undefined, '', 'meet/x', '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)',
      '/login', '/login?redirect=/x', '/welcome', '/auth/verify?token=1', `/${'a'.repeat(600)}`]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
  });

  it('a signed-out visit to a protected page goes to sign-in carrying that page; Home needs nothing carried', () => {
    expect(signInPathFor('/meet/abc', '?scheduled=1&kind=video')).toBe('/login?redirect=%2Fmeet%2Fabc%3Fscheduled%3D1%26kind%3Dvideo');
    expect(signInPathFor('/sessions/1', '')).toBe('/login?redirect=%2Fsessions%2F1');
    expect(signInPathFor('/', '')).toBe('/login');
  });

  it('ProtectedRoute sends a signed-out visit to that sign-in address (not /welcome, whose redirect drops the query)', () => {
    const guard = read('components/layout/ProtectedRoute.tsx');
    expect(guard).toMatch(/if \(!user\) return <Navigate to=\{signInPathFor\(location\.pathname, location\.search\)\} replace \/>;/);
  });

  it('the sign-in page keeps only a safe path, and sends it with the email so the link carries it to another tab or device', () => {
    const login = read('features/auth/LoginPage.tsx');
    expect(login).toMatch(/const returnPath = safeReturnPath\(params\.get\('redirect'\)\);/);
    expect(login).toMatch(/login\(data\.email, window\.location\.origin, inviteCodeValue \|\| undefined, returnPath \?\? undefined\)/);
    expect(read('stores/authStore.ts')).toMatch(/api\.post\('\/auth\/magic-link', \{ email, clientUrl, inviteCode, redirect \}\)/);
  });

  it('the verify page lands on the invite first, then the path in its own link, then the one this tab kept, then Home', () => {
    const verify = read('features/auth/VerifyPage.tsx');
    expect(verify).toMatch(/const inviteCode = params\.get\('inviteCode'\)/);
    // What this tab kept is read (and forgotten) every time, so it cannot steer a later sign-in in the same tab.
    expect(verify).toMatch(/const kept = takeReturnPath\(\);/);
    expect(verify).toMatch(/inviteCode \? `\/invite\/\$\{inviteCode\}` : \(safeReturnPath\(params\.get\('redirect'\)\) \?\? kept \?\? '\/'\)/);
  });
});

describe('the sign-in page and its waiting screen', () => {
  it('says no password is needed, in the words the review asked for', () => {
    expect(read('features/auth/LoginPage.tsx')).toContain("No password needed — we'll email you a link and a code.");
  });

  it('the code field fills itself from the email on a phone, takes digits, and is a 44px target at 16px', () => {
    const entry = read('features/auth/SignInCodeEntry.tsx');
    expect(entry).toMatch(/autoComplete="one-time-code"/);
    expect(entry).toMatch(/inputMode="numeric"/);
    expect(entry).toMatch(/className="[^"]*\bmin-h-\[52px\][^"]*\btext-\[22px\]/);
    expect(entry).toMatch(/setValue\('code', digitsOf\(/);
  });

  it('a refusal is said where the field is, read out by screen readers', () => {
    const entry = read('features/auth/SignInCodeEntry.tsx');
    expect(entry).toMatch(/role="alert"/);
    expect(entry).toMatch(/codeErrorMessage\(err\)/);
  });

  it('offers Send a new email (with a short wait between sends) and Try a different email, both 44px', () => {
    const panel = read('features/auth/CheckEmailPanel.tsx');
    expect(panel).toMatch(/onClick=\{resend\}\s+disabled=\{wait > 0 \|\| resending\}\s+className="[^"]*\bmin-h-\[44px\]/);
    expect(panel).toMatch(/'Send a new email'/);
    expect(panel).toMatch(/onClick=\{onDifferentEmail\} className="[^"]*\bmin-h-\[44px\]/);
  });

  it('signing in with the code installs the session the way the link does, then opens the page the member was going to', () => {
    expect(read('stores/authStore.ts')).toMatch(/verifyCode: async \(email: string, code: string\) => \{\s*const \{ data \} = await api\.post\('\/auth\/magic-link\/code', \{ email, code \}\);\s*const \{ accessToken, refreshToken \} = data\.data;\s*installTokens\(accessToken, refreshToken\);\s*await get\(\)\.checkSession\(\);/);
    expect(read('features/auth/LoginPage.tsx')).toMatch(/navigate\(takeReturnPath\(\) \?\? '\/', \{ replace: true \}\)/);
  });
});

describe('the app icons and link previews (index.html)', () => {
  const html = fs.readFileSync(path.join(root, '../index.html'), 'utf8');
  it('links a manifest, a square apple-touch-icon, and a link-preview picture', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />');
    expect(html).toMatch(/<meta property="og:image" content="https:\/\/app\.rsn\.network\/og-image\.png" \/>/);
    expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image" \/>/);
  });

  it('the manifest names REASON and lists square icons, a maskable one among them', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '../public/manifest.webmanifest'), 'utf8'));
    expect(manifest.name).toBe('REASON');
    const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of icons) {
      const file = fs.readFileSync(path.join(root, '../public', icon.src));
      const [w, h] = icon.sizes.split('x').map(Number);
      expect({ width: file.readUInt32BE(16), height: file.readUInt32BE(20) }).toEqual({ width: w, height: h });
    }
  });
});
