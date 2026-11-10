// server/src/__tests__/services/user/social-links.test.ts
// The links beside LinkedIn (10 Nov 2026, Stefan: "There should also be website next to linkedin link, and perhaps other
// social media too"): the one rule for what may be typed and stored, the public card carrying the four addresses, and the
// route, service and migration that store them. SQL here is read as text; the real statement is run read-only by the probe.
import * as fs from 'fs';
import * as path from 'path';
import { PROFILE_LINK_MAX, normaliseProfileUrl, parseProfileUrl } from '@rsn/shared';
import { toPublicMember } from '../../../services/user/public-card';

const SERVER = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8').replace(/\r\n/g, '\n');

describe('normaliseProfileUrl', () => {
  it('blank is no link', () => {
    for (const blank of ['', '   ', '\n\t']) {
      for (const kind of ['website', 'instagram', 'x', 'facebook'] as const) expect(normaliseProfileUrl(kind, blank)).toBeNull();
    }
    expect(parseProfileUrl('website', '  ')).toEqual({ ok: true, url: null });
    expect(parseProfileUrl('website', null)).toEqual({ ok: true, url: null });
  });

  it('a website with no scheme gets https, and a bare address has no trailing slash', () => {
    expect(normaliseProfileUrl('website', 'example.com')).toBe('https://example.com');
    expect(normaliseProfileUrl('website', '  www.example.com/about  ')).toBe('https://www.example.com/about');
    expect(normaliseProfileUrl('website', 'http://example.com')).toBe('http://example.com');
    expect(normaliseProfileUrl('website', 'https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(normaliseProfileUrl('website', 'example.com:8080/x')).toBe('https://example.com:8080/x');
  });

  it('refuses every scheme but http and https, and anything that is not a plain address', () => {
    for (const bad of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'mailto:a@b.com', 'ftp://example.com', 'file:///etc/passwd',
      'https://user:pass@example.com', 'https://user@example.com', 'not a link', 'localhost', 'https://nodot', '//example.com', '/path', 'https://',
    ]) {
      expect({ bad, ok: parseProfileUrl('website', bad).ok }).toEqual({ bad, ok: false });
      expect(normaliseProfileUrl('website', bad)).toBeNull();
    }
  });

  it('refuses 301 characters and accepts 300', () => {
    const long = (n: number) => `https://example.com/${'a'.repeat(n - 'https://example.com/'.length)}`;
    expect(PROFILE_LINK_MAX).toBe(300);
    expect(parseProfileUrl('website', long(300))).toEqual({ ok: true, url: long(300) });
    expect(parseProfileUrl('website', long(301))).toEqual({ ok: false });
    // Short typed, long once https:// is put in front.
    expect(parseProfileUrl('website', `example.com/${'a'.repeat(300 - 'example.com/'.length)}`)).toEqual({ ok: false });
  });

  it('Instagram, X and Facebook take only their own host, with www. or m. in front', () => {
    expect(normaliseProfileUrl('instagram', 'instagram.com/x')).toBe('https://instagram.com/x');
    expect(normaliseProfileUrl('instagram', 'https://www.instagram.com/some.one/')).toBe('https://www.instagram.com/some.one/');
    expect(normaliseProfileUrl('x', 'x.com/jane')).toBe('https://x.com/jane');
    expect(normaliseProfileUrl('x', 'https://twitter.com/jane')).toBe('https://twitter.com/jane');
    expect(normaliseProfileUrl('x', 'https://mobile.x.com/jane')).toBeNull();
    expect(normaliseProfileUrl('facebook', 'm.facebook.com/jane')).toBe('https://m.facebook.com/jane');
    expect(normaliseProfileUrl('facebook', 'fb.com/jane')).toBe('https://fb.com/jane');
    expect(normaliseProfileUrl('facebook', 'https://www.fb.com/jane')).toBe('https://www.fb.com/jane');
  });

  it('refuses a lookalike or another platform for a platform field', () => {
    for (const [kind, bad] of [
      ['instagram', 'evil.com/instagram.com'],
      ['instagram', 'https://evil.com/?u=instagram.com'],
      ['instagram', 'instagram.com.evil.com/x'],
      ['instagram', 'notinstagram.com/x'],
      ['instagram', 'facebook.com/jane'],
      ['x', 'evilx.com/jane'],
      ['x', 'x.com.evil.io/jane'],
      ['facebook', 'facebook.evil.com/jane'],
      ['facebook', 'instagram.com/jane'],
    ] as const) {
      expect({ kind, bad, ok: parseProfileUrl(kind, bad).ok }).toEqual({ kind, bad, ok: false });
    }
  });
});

describe('toPublicMember carries the four links', () => {
  it('passes them through, and null when blank or missing', () => {
    const card = toPublicMember({
      id: 'u1', websiteUrl: 'https://example.com', instagramUrl: 'https://instagram.com/x', xUrl: 'https://x.com/x', facebookUrl: 'https://facebook.com/x',
    });
    expect(card).toMatchObject({ websiteUrl: 'https://example.com', instagramUrl: 'https://instagram.com/x', xUrl: 'https://x.com/x', facebookUrl: 'https://facebook.com/x' });
    const none = toPublicMember({ id: 'u2', websiteUrl: '', xUrl: null });
    expect(none).toMatchObject({ websiteUrl: null, instagramUrl: null, xUrl: null, facebookUrl: null });
  });

  it('a member whose row predates the migration (no value for any of the new columns) still gets a card', () => {
    expect(toPublicMember({ id: 'old' })).toMatchObject({ websiteUrl: null, instagramUrl: null, xUrl: null, facebookUrl: null });
  });
});

describe('the profile save and read paths', () => {
  const route = () => read('routes/users.ts');
  const identity = () => read('services/identity/identity.service.ts');

  it('the update route checks each link with the shared rule and says the field\'s own sentence', () => {
    expect(route()).toMatch(/const profileLink = \(kind: ProfileLinkKind\) => z\.string\(\)\.max\(PROFILE_LINK_MAX\)\.nullable\(\)\.optional\(\)\.transform/);
    expect(route()).toMatch(/parseProfileUrl\(kind, value\)/);
    expect(route()).toMatch(/message: PROFILE_LINK_HELP\[kind\]/);
    for (const [field, kind] of [['websiteUrl', 'website'], ['instagramUrl', 'instagram'], ['xUrl', 'x'], ['facebookUrl', 'facebook']]) {
      expect(route()).toContain(`${field}: profileLink('${kind}'),`);
    }
  });

  it('saving writes the four columns and still emits the user and pod entity tags', () => {
    expect(identity()).toContain("websiteUrl: 'website_url'");
    expect(identity()).toContain("instagramUrl: 'instagram_url'");
    expect(identity()).toContain("xUrl: 'x_url'");
    expect(identity()).toContain("facebookUrl: 'facebook_url'");
    const put = route().slice(route().indexOf("'/me',\n  authenticate,\n  photoInBodyLimit"));
    expect(put.slice(0, put.indexOf("'/me/banner'"))).toMatch(/fanoutPodEntities[\s\S]*fanoutUserEntity\(req\.user!\.userId\)/);
  });

  it('the owner\'s own read (getUserById, behind GET /users/:id, GET /auth/me and your card) selects the four columns', () => {
    const fn = identity().slice(identity().indexOf('export async function getUserById'), identity().indexOf('export async function getUserByEmail'));
    expect(fn).toContain('website_url AS "websiteUrl"');
    expect(fn).toContain('instagram_url AS "instagramUrl"');
    expect(fn).toContain('x_url AS "xUrl"');
    expect(fn).toContain('facebook_url AS "facebookUrl"');
  });
});

describe('migration 133', () => {
  const sql = () => fs.readFileSync(path.join(SERVER, 'db/migrations/133_user_social_links.sql'), 'utf8').replace(/\r\n/g, '\n');
  const code = () => sql().split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('adds the four columns with IF NOT EXISTS and no transaction control of its own', () => {
    for (const col of ['website_url', 'instagram_url', 'x_url', 'facebook_url']) expect(code()).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col} TEXT`));
    expect(code()).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END|ABORT)\b\s*;/im);
    expect(code()).not.toMatch(/DROP\s/i);
  });

  it('limits each to 300 characters with a named constraint that a rerun skips', () => {
    expect(code()).toMatch(/pg_constraint/);
    expect(code()).toMatch(/'users_' \|\| col \|\| '_length_check'/);
    expect(code()).toMatch(/CHECK \(%I IS NULL OR char_length\(%I\) <= 300\)/);
    for (const col of ['website_url', 'instagram_url', 'x_url', 'facebook_url']) expect(code()).toContain(`'${col}'`);
  });
});
