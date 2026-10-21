// ─── Where the links an applicant receives open (7 Oct 2026) ─────────────────
//
// A join request remembers the site it was made on, so the approval email and the
// reminders open the preview for someone who asked there. Two rules carry the safety:
// only one of our own sites that is NOT the main app is ever stored (the Origin header
// is the caller's to forge), and the stored value is checked again when a link is built,
// so anything that is not ours, now or at all, can only ever give the main app.

jest.mock('../../../config', () => {
  const cfg = { clientUrl: 'https://app.rsn.network', isDev: false };
  return { default: cfg, config: cfg, __esModule: true };
});

import config from '../../../config';
import { applicantBaseUrl, signInOriginFor } from '../../../services/join-request/applicant-links';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';

// Look-alikes and development-only sites. None may ever be stored or used.
const NOT_OURS = [
  'https://evil.example',
  'https://preview.rsn.network.evil.example',
  'https://preview.rsn.network@evil.example',
  'http://preview.rsn.network',
  'https://preview.rsn.network:8443',
  'https://rsn.network',
  'https://api.rsn.network',
  'https://something-rsnnetwork.vercel.app',
  'http://localhost:5173',
  'javascript:alert(1)',
  '//evil.example',
  'evil.example',
  'null',
];

const settings = config as unknown as { clientUrl: string; isDev: boolean };
afterEach(() => { settings.clientUrl = MAIN; settings.isDev = false; });

describe('signInOriginFor: what a join request remembers', () => {
  it('remembers the preview when the request came from it', () => {
    expect(signInOriginFor(PREVIEW)).toBe(PREVIEW);
    expect(signInOriginFor('HTTPS://Preview.RSN.Network')).toBe(PREVIEW);
  });

  it('remembers nothing for the main app: null already means the main app', () => {
    expect(signInOriginFor(MAIN)).toBeNull();
    expect(signInOriginFor(`${MAIN}/`)).toBeNull();
  });

  it('remembers nothing when there is no Origin', () => {
    expect(signInOriginFor(undefined)).toBeNull();
    expect(signInOriginFor('')).toBeNull();
  });

  it.each(NOT_OURS)('remembers nothing for %j, which is not ours', (origin) => {
    expect(signInOriginFor(origin)).toBeNull();
  });

  it('compares with the main app wherever it is configured to live', () => {
    settings.clientUrl = 'https://staging.rsn.example';
    expect(signInOriginFor('https://staging.rsn.example')).toBeNull();
    expect(signInOriginFor(PREVIEW)).toBe(PREVIEW);
    // The live app is one of ours, and here it is not the main app, so it is worth remembering.
    expect(signInOriginFor(MAIN)).toBe(MAIN);
    expect(signInOriginFor('https://evil.example')).toBeNull();
  });

  it('is not fooled by a main app configured with a path or a trailing slash', () => {
    for (const clientUrl of ['https://app.rsn.network/', 'https://app.rsn.network/app']) {
      settings.clientUrl = clientUrl;
      expect(signInOriginFor(MAIN)).toBeNull();
      expect(signInOriginFor('https://evil.example')).toBeNull();
      expect(signInOriginFor(PREVIEW)).toBe(PREVIEW);
    }
  });

  it('remembers localhost in development only, and only when it is not the main app', () => {
    expect(signInOriginFor('http://localhost:3000')).toBeNull();
    settings.isDev = true;
    expect(signInOriginFor('http://localhost:3000')).toBe('http://localhost:3000');
    settings.clientUrl = 'http://localhost:3000';
    expect(signInOriginFor('http://localhost:3000')).toBeNull();
  });
});

describe('applicantBaseUrl: where an applicant\'s own links open', () => {
  it('is the main app, exactly as configured, when the request remembers no site', () => {
    expect(applicantBaseUrl({})).toBe(MAIN);
    expect(applicantBaseUrl({ sign_in_origin: null })).toBe(MAIN);
    expect(applicantBaseUrl({ sign_in_origin: undefined })).toBe(MAIN);
    expect(applicantBaseUrl({ sign_in_origin: '' })).toBe(MAIN);
    settings.clientUrl = 'http://localhost:5173';
    expect(applicantBaseUrl({ sign_in_origin: null })).toBe('http://localhost:5173');
  });

  it('is the remembered site when it is one of ours', () => {
    expect(applicantBaseUrl({ sign_in_origin: PREVIEW })).toBe(PREVIEW);
  });

  it.each(NOT_OURS)('is the main app when the stored value is %j, which is not ours', (stored) => {
    expect(applicantBaseUrl({ sign_in_origin: stored })).toBe(MAIN);
  });

  it('checks the stored value again: a site that was ours when stored and no longer is gives the main app', () => {
    expect(applicantBaseUrl({ sign_in_origin: 'http://localhost:3000' })).toBe(MAIN);
    settings.isDev = true;
    expect(applicantBaseUrl({ sign_in_origin: 'http://localhost:3000' })).toBe('http://localhost:3000');
    settings.isDev = false;
    expect(applicantBaseUrl({ sign_in_origin: 'http://localhost:3000' })).toBe(MAIN);
  });
});
