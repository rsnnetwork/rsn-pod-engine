// ─── The one place that says which settings feed the allow-list (7 Oct 2026) ──
//
// Three doors resolve an origin against the exact allow-list in client-origin.ts: the magic
// link, Google sign-in, and the links an applicant receives. Each built the same two-field
// config from `config` itself, so a third field (or a changed rule) would have to be found
// in three places. clientOriginConfig is that one place. The allow-list is untouched: its
// own tests are magic-link-origin.test.ts.

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../config', () => ({ default: { clientUrl: 'https://app.rsn.network', isDev: false }, __esModule: true }));

import config from '../../../config';
import { clientOriginConfig, resolveClientBaseUrl } from '../../../services/identity/client-origin';

const settings = config as unknown as Record<string, unknown>;
afterEach(() => {
  settings.clientUrl = 'https://app.rsn.network';
  settings.isDev = false;
  delete settings.jwtSecret;
});

describe('clientOriginConfig', () => {
  it('is the main app and the development flag, read from the config at the moment it is called', () => {
    expect(clientOriginConfig()).toEqual({ clientUrl: 'https://app.rsn.network', isDev: false });
    settings.clientUrl = 'https://staging.rsn.example';
    settings.isDev = true;
    expect(clientOriginConfig()).toEqual({ clientUrl: 'https://staging.rsn.example', isDev: true });
  });

  it('carries those two settings and nothing else, so nothing reaches the allow-list by accident', () => {
    settings.jwtSecret = 'a secret that must never travel with it';
    expect(Object.keys(clientOriginConfig()).sort()).toEqual(['clientUrl', 'isDev']);
  });

  it('feeds the allow-list as it is: our own sites are kept, anything else gives the main app', () => {
    expect(resolveClientBaseUrl('https://preview.rsn.network', clientOriginConfig())).toBe('https://preview.rsn.network');
    expect(resolveClientBaseUrl('https://evil.example', clientOriginConfig())).toBe('https://app.rsn.network');
    expect(resolveClientBaseUrl(undefined, clientOriginConfig())).toBe('https://app.rsn.network');
    // Localhost only in development.
    expect(resolveClientBaseUrl('http://localhost:5173', clientOriginConfig())).toBe('https://app.rsn.network');
    settings.isDev = true;
    expect(resolveClientBaseUrl('http://localhost:5173', clientOriginConfig())).toBe('http://localhost:5173');
  });
});

describe('every door that resolves an origin uses it, and keeps no copy of its own', () => {
  const read = (relative: string) => fs.readFileSync(path.join(__dirname, '../../../', relative), 'utf8');

  it.each([
    ['the magic link', 'services/identity/identity.service.ts'],
    ['Google sign-in', 'routes/auth.ts'],
    ['the links an applicant receives', 'services/join-request/applicant-links.ts'],
  ])('%s (%s)', (_door, file) => {
    const source = read(file);
    expect(source).toMatch(/clientOriginConfig\(\)/);
    expect(source).not.toMatch(/isDev:\s*config\.isDev/);
    expect(source).not.toMatch(/const ourSites/);
  });
});
