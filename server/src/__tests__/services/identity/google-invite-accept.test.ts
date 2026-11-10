// ─── The first Google sign-in with an invite code accepts it as the invite page does (Part 2 Task 4, fix round 1) ───
//
// findOrCreateGoogleUser used to apply a new account's invite itself: it wrote the new account over the invite's
// accepter (accepted_by_user_id, unconditionally) and inserted the event place directly, past registerParticipant, so
// past the invitation-only rule, the guest rule and admitted_via, and it never compared the invite's address with the
// Google address. A forwarded invite code was a credential. Now the new account goes through acceptInvite (bound to the
// address, the pod and event gates, the accepter kept if someone accepted first), and a refusal never stops the sign-in.
// The magic-link and sign-in-code paths carry the code in the link and the client calls the same accept: they never
// applied an invite themselves (checked by reading the service).

import * as fs from 'fs';
import * as path from 'path';

const created: { id?: string } = {};
const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('SELECT id, status, use_count, max_uses, expires_at, inviter_id FROM invites WHERE code = $1')) {
    return { rows: [{ id: 'invite-1', status: 'pending', use_count: 0, max_uses: 1, expires_at: null, inviter_id: 'host-1' }], rowCount: 1 };
  }
  if (s.startsWith('INSERT INTO users')) { created.id = params[0] as string; return { rows: [], rowCount: 1 }; }
  if (s.includes('FROM users WHERE email = $1')) return { rows: [], rowCount: 0 };
  if (s.includes('FROM users WHERE id = $1')) {
    return { rows: [{ id: created.id, email: 'ana@example.com', displayName: 'Ana', role: 'member', status: 'active', emailVerified: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config', () => ({
  default: {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'x', magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001',
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({ sendMagicLinkEmail: jest.fn(), __esModule: true }));
jest.mock('../../../services/onboarding/enrichment.repo', () => ({ saveEnrichedCandidate: jest.fn(), setEnrichmentState: jest.fn(), __esModule: true }));
jest.mock('../../../services/onboarding/avatar.service', () => ({
  hasAvatar: jest.fn().mockResolvedValue(false), tryGravatar: jest.fn().mockResolvedValue(false), __esModule: true,
}));
const mockAccept = jest.fn();
jest.mock('../../../services/invite/invite.service', () => ({ acceptInvite: (...a: unknown[]) => mockAccept(...a), __esModule: true }));

import { findOrCreateGoogleUser } from '../../../services/identity/identity.service';

const wrote = (pattern: RegExp) => mockQuery.mock.calls.some((c) => pattern.test(String(c[0]).replace(/\s+/g, ' ')));

beforeEach(() => {
  mockQuery.mockClear();
  mockAccept.mockReset();
  created.id = undefined;
});

describe('a new account signing in with Google and an invite code', () => {
  it('accepts the invite through acceptInvite, bound to the Google address, and writes no place or accepter itself', async () => {
    mockAccept.mockResolvedValue({ registeredFor: { sessionId: 'event-1' } });
    const tokens = await findOrCreateGoogleUser({ email: 'Ana@Example.com', name: 'Ana' }, 'CODE123');
    expect(tokens.accessToken).toBeTruthy();
    expect(mockAccept).toHaveBeenCalledWith('CODE123', created.id, 'ana@example.com');
    expect(wrote(/^INSERT INTO session_participants/)).toBe(false);
    expect(wrote(/^INSERT INTO pod_members/)).toBe(false);
    expect(wrote(/^UPDATE invites/)).toBe(false);
  });

  it('a refused invite (another address, an invitation-only event, a full event) never stops the sign-in', async () => {
    mockAccept.mockRejectedValue(Object.assign(new Error('This invite was sent to someone else.'), { statusCode: 403, code: 'IDENTITY_MISMATCH' }));
    const tokens = await findOrCreateGoogleUser({ email: 'mallory@example.com', name: 'M' }, 'CODE123');
    expect(tokens.accessToken).toBeTruthy();
    expect(wrote(/^INSERT INTO session_participants/)).toBe(false);
    expect(wrote(/^UPDATE invites/)).toBe(false);
  });

  it('without an invite code nothing is accepted', async () => {
    // The registration gate needs an approved request or a pending invite for the address when no code is sent.
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await findOrCreateGoogleUser({ email: 'ana@example.com' }).catch(() => undefined);
    expect(mockAccept).not.toHaveBeenCalled();
  });
});

describe('the other first-sign-in paths never apply an invite themselves', () => {
  it('identity.service has no direct place, pod or accepter write for an invite left anywhere', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../services/identity/identity.service.ts'), 'utf8');
    expect(src).not.toMatch(/INSERT INTO session_participants/);
    expect(src).not.toMatch(/INSERT INTO pod_members/);
    expect(src).not.toMatch(/accepted_by_user_id = \$/);
    // The magic link only carries the code in the link it sends; the client's invite page accepts it (acceptInvite).
    expect(src).toContain("if (inviteCode) params.set('inviteCode', inviteCode);");
  });
});
