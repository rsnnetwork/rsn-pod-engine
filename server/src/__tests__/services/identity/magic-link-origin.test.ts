// server/src/__tests__/services/identity/magic-link-origin.test.ts
// 29 Sep 2026: a sign-in email must only ever open one of our own sites.
// Before this, POST /auth/magic-link accepted ANY http(s) clientUrl, so anyone
// could make RSN email a member a genuine sign-in link, carrying a live
// token, that opened on a site they controlled.
import { isAllowedClientOrigin, resolveClientBaseUrl } from '../../../services/identity/client-origin';

const prod = { clientUrl: 'https://app.rsn.network', isDev: false };
const dev = { clientUrl: 'http://localhost:5173', isDev: true };

describe('sign-in links only point at our own sites', () => {
  it.each([
    [undefined, 'https://app.rsn.network'],
    ['https://app.rsn.network', 'https://app.rsn.network'],
    ['https://preview.rsn.network', 'https://preview.rsn.network'],
  ])('keeps %s', (requested, expected) => {
    expect(resolveClientBaseUrl(requested, prod)).toBe(expected);
  });

  it.each([
    'https://evil.example',
    'https://rsn.network.evil.example',
    'https://evilrsn.network',
    'https://rsn.network',
    'https://api.rsn.network',
    'https://anything.rsn.network',
    'https://app.rsn.network:8443',
    'http://app.rsn.network',
    'https://rsn-client-evil-rsnnetwork.vercel.app',
    'https://anything.vercel.app',
    'javascript:alert(1)',
    'not a url',
    'http://localhost:5173',
  ])('falls back to the main app for %s', (requested) => {
    expect(resolveClientBaseUrl(requested, prod)).toBe('https://app.rsn.network');
  });

  it('drops any path, query or credentials from an allowed address', () => {
    expect(resolveClientBaseUrl('https://user:pw@preview.rsn.network/x?y=1', prod))
      .toBe('https://preview.rsn.network');
  });

  it('allows localhost only in development', () => {
    expect(resolveClientBaseUrl('http://localhost:5173', dev)).toBe('http://localhost:5173');
    expect(resolveClientBaseUrl('http://127.0.0.1:5173', dev)).toBe('http://127.0.0.1:5173');
  });

  it('keeps the configured app address even when it is not one of our rsn.network sites', () => {
    const vercelApp = { clientUrl: 'https://rsn-client.vercel.app', isDev: false };
    expect(resolveClientBaseUrl('https://rsn-client.vercel.app', vercelApp)).toBe('https://rsn-client.vercel.app');
    expect(resolveClientBaseUrl('https://other.vercel.app', vercelApp)).toBe('https://rsn-client.vercel.app');
    // Both answers above are the same string, so "kept" and "fell back" look
    // alike there. Pin the decision itself as well.
    expect(isAllowedClientOrigin(new URL('https://rsn-client.vercel.app'), vercelApp)).toBe(true);
    expect(isAllowedClientOrigin(new URL('https://other.vercel.app'), vercelApp)).toBe(false);
  });

  it('in development an address that is not ours still falls back to the configured app', () => {
    expect(resolveClientBaseUrl('https://evil.example', dev)).toBe('http://localhost:5173');
  });

  it('identity.service builds the emailed link through the allow-list, not its own parser', () => {
    // Source pin: the old local resolver accepted any origin. Comments stripped
    // so a mention in a comment cannot satisfy the pin.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '../../../services/identity/identity.service.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/from '\.\/client-origin'/);
    expect(src).not.toMatch(/function resolveClientBaseUrl/);
  });
});
