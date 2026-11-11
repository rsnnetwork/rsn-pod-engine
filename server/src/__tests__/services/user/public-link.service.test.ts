// ─── A member's public profile link (Shirley pilot S6, D5) ───────────────────────────────────────────────────────────
// Opt-in, revocable, a random token never derived from the member's id. The page shows the public card only, and every
// link that opens nothing answers the same 404 as a token that never existed.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
const mockBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({ areBlocked: (...a: unknown[]) => mockBlocked(...a), __esModule: true }));
const mockGetUser = jest.fn();
jest.mock('../../../services/identity/identity.service', () => ({ getUserById: (...a: unknown[]) => mockGetUser(...a), __esModule: true }));

import * as fs from 'fs';
import * as path from 'path';
import {
  LINK_NOT_AVAILABLE, NO_LINK_TO_REPLACE, ONLY_MEMBERS_SHARE, PUBLIC_TOKEN_SHAPE, createPublicLink, getMyPublicLink,
  getPublicProfile, newPublicToken, regeneratePublicLink, revokePublicLink,
} from '../../../services/user/public-link.service';
import { PRIVATE_MEMBER_KEYS } from '../../../services/user/public-card';

const MEMBER = 'a0000000-0000-4000-8000-0000000000a1';
const VIEWER = 'b0000000-0000-4000-8000-0000000000b2';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const NEW = new Date('2026-11-11T10:00:00Z');

const member = {
  id: MEMBER, email: 'shirley@example.com', phone: '+44 1', timezone: 'Europe/London', displayName: 'Shirley Palmer',
  firstName: 'Shirley', lastName: 'Palmer', avatarUrl: null, bannerUrl: null, bio: 'Curious about humans.',
  company: 'Curious Humans', jobTitle: 'Founder', industry: 'Community', location: 'London',
  linkedinUrl: 'https://www.linkedin.com/in/shirley', websiteUrl: null, instagramUrl: null, xUrl: null, facebookUrl: null,
  languages: ['en'], professionalRole: ['Founder'], expertiseText: 'Community building', whatICanHelpWith: 'Hosting circles',
  whoIWantToMeet: 'SECRET-WANT', whyIWantToMeet: 'SECRET-WHY', myIntent: 'SECRET-INTENT', interests: ['SECRET-INTEREST'],
  status: 'active', profileVisible: true, role: 'member',
};

const sqlOf = (i = 0) => String(mockQuery.mock.calls[i][0]).replace(/\s+/g, ' ');

beforeEach(() => {
  jest.clearAllMocks();
  mockBlocked.mockResolvedValue(false);
  mockGetUser.mockResolvedValue(member);
});

describe('the token', () => {
  it('is 22 base64url characters (128 random bits), fresh every time, and never the member\'s id', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newPublicToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(PUBLIC_TOKEN_SHAPE);
      expect(t).not.toContain(MEMBER.slice(0, 8));
    }
  });
});

describe('the owner\'s link', () => {
  it('reads none while there is none, and the link with its path when there is one', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token: null, created_at: null, profile_visible: true }] });
    expect(await getMyPublicLink(MEMBER)).toEqual({ link: null, paused: null });
    mockQuery.mockResolvedValueOnce({ rows: [{ token: TOKEN, created_at: NEW, profile_visible: true }] });
    expect(await getMyPublicLink(MEMBER)).toEqual({
      link: { token: TOKEN, path: `/p/${TOKEN}`, createdAt: NEW.toISOString() }, paused: null,
    });
  });

  it('says the link is paused while the member is hidden from search', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token: TOKEN, created_at: NEW, profile_visible: false }] });
    expect((await getMyPublicLink(MEMBER)).paused).toBe('hidden');
  });

  it('make keeps a link that exists (a double press answers the same link), only for an active member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token: TOKEN, created_at: NEW, profile_visible: true }] });
    const state = await createPublicLink(MEMBER);
    expect(state.link?.token).toBe(TOKEN);
    const sql = sqlOf();
    expect(sql).toContain('SET public_profile_token = COALESCE(public_profile_token, $2)');
    expect(sql).toContain("WHERE id = $1 AND status = 'active' AND account_kind = 'member'");
    expect(mockQuery.mock.calls[0][1][0]).toBe(MEMBER);
    expect(mockQuery.mock.calls[0][1][1]).toMatch(PUBLIC_TOKEN_SHAPE);
  });

  it('make is refused to an event guest or an account that is not active (no row written)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(createPublicLink(MEMBER)).rejects.toMatchObject({ statusCode: 403, message: ONLY_MEMBERS_SHARE });
  });

  it('a new link replaces the old token outright, and is refused when there is no link to replace', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token: 'ZZZZZZZZZZZZZZZZZZZZZZ', created_at: NEW, profile_visible: true }] });
    expect((await regeneratePublicLink(MEMBER)).link?.token).toBe('ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(sqlOf()).toContain('SET public_profile_token = $2, public_profile_token_created_at = NOW()');
    expect(sqlOf()).toContain('AND public_profile_token IS NOT NULL');
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(regeneratePublicLink(MEMBER)).rejects.toMatchObject({ statusCode: 409, code: 'PUBLIC_LINK_NONE', message: NO_LINK_TO_REPLACE });
  });

  it('a token that some member already holds (never, in practice) is drawn again, not failed', async () => {
    mockQuery
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [{ token: TOKEN, created_at: NEW, profile_visible: true }] });
    expect((await createPublicLink(MEMBER)).link?.token).toBe(TOKEN);
    expect(mockQuery.mock.calls[0][1][1]).not.toBe(mockQuery.mock.calls[1][1][1]);
  });

  it('turning it off clears the token and its time', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token: null, created_at: null, profile_visible: true }] });
    expect(await revokePublicLink(MEMBER)).toEqual({ link: null, paused: null });
    expect(sqlOf()).toContain('SET public_profile_token = NULL, public_profile_token_created_at = NULL WHERE id = $1');
  });
});

describe('the page a link opens', () => {
  const found = () => mockQuery.mockResolvedValueOnce({ rows: [{ id: MEMBER }] });

  it('is the public card only: no id, nothing private, plus what they can bring', async () => {
    found();
    const card = await getPublicProfile(TOKEN, null);
    expect(card).not.toHaveProperty('id');
    for (const k of PRIVATE_MEMBER_KEYS) expect(card).not.toHaveProperty(k);
    expect(JSON.stringify(card)).not.toMatch(/SECRET-|shirley@example\.com|status|role/);
    expect(card).toMatchObject({ displayName: 'Shirley Palmer', company: 'Curious Humans', canBring: 'Hosting circles' });
    expect(Object.keys(card).sort()).toEqual([
      'avatarUrl', 'bannerUrl', 'bio', 'canBring', 'company', 'displayName', 'expertiseText', 'facebookUrl', 'firstName',
      'industry', 'instagramUrl', 'jobTitle', 'languages', 'lastName', 'linkedinUrl', 'location', 'professionalRole',
      'websiteUrl', 'whatICanHelpWith', 'xUrl',
    ]);
  });

  it('finds its member only by a live token on an active, visible member account', async () => {
    found();
    await getPublicProfile(TOKEN, null);
    expect(sqlOf()).toBe(
      "SELECT id FROM users WHERE public_profile_token = $1 AND status = 'active' AND account_kind = 'member' AND profile_visible = TRUE LIMIT 1",
    );
    expect(mockQuery.mock.calls[0][1]).toEqual([TOKEN]);
  });

  it('a malformed token is looked up nowhere, and answers the one 404', async () => {
    for (const bad of ['', 'short', `${TOKEN}x`, 'AbCdEfGhIjKlMnOpQrSt/v', "' OR 1=1 --xxxxxxxxxxx"]) {
      await expect(getPublicProfile(bad, null)).rejects.toMatchObject({ statusCode: 404, message: LINK_NOT_AVAILABLE });
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an unknown, revoked or replaced token, a closed, guest or hidden account: the same 404 (the lookup finds no row)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const err = await getPublicProfile(TOKEN, null).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404, code: 'PROFILE_NOT_FOUND', message: LINK_NOT_AVAILABLE });
  });

  it('a signed-in reader with a block either way gets that same 404, and is never shown the card', async () => {
    found();
    mockBlocked.mockResolvedValueOnce(true);
    const err = await getPublicProfile(TOKEN, VIEWER).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404, code: 'PROFILE_NOT_FOUND', message: LINK_NOT_AVAILABLE });
    expect(mockBlocked).toHaveBeenCalledWith(VIEWER, MEMBER);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('a signed-out reader is asked about no block; a signed-in one with none sees the card', async () => {
    found();
    await getPublicProfile(TOKEN, null);
    expect(mockBlocked).not.toHaveBeenCalled();
    found();
    await expect(getPublicProfile(TOKEN, VIEWER)).resolves.toMatchObject({ firstName: 'Shirley' });
  });
});

describe('where the token is read', () => {
  // The token must reach nobody but its owner: no profile read, list or export may carry it. getUserById's column list
  // is what every profile read (owner, admin, another member) starts from, so it must never name the column, and only
  // the files that write or look it up may.
  const SRC = path.join(__dirname, '../../..');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full);
    return /\.(ts|sql)$/.test(e.name) ? [full] : [];
  });

  it('only the link service, the migration and the account close and reopen name the column', () => {
    const naming = files(SRC).filter((f) => fs.readFileSync(f, 'utf8').includes('public_profile_token'))
      .map((f) => path.relative(SRC, f).replace(/\\/g, '/')).sort();
    expect(naming).toEqual([
      'db/migrations/151_public_profile_link.sql',
      'services/identity/account-access.ts',
      'services/identity/identity.service.ts',
      'services/user/public-link.service.ts',
    ]);
  });

  it('the close and the reopen only ever clear it', () => {
    for (const f of ['services/identity/account-access.ts', 'services/identity/identity.service.ts']) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      const uses = text.match(/public_profile_token\w*\s*(=\s*\w+)?/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) expect(use).toMatch(/= NULL$/);
    }
  });
});
