// server/src/__tests__/services/identity/magic-link-emailed-link.test.ts
// 30 Sep 2026: magic-link-origin.test.ts proves the allow-list on its own. This
// proves the link that is actually EMAILED goes through it: a hostile clientUrl
// handed to the real sendMagicLink must still produce a link on our own site,
// with the live token and any invite code intact. Only what sendMagicLink
// touches is faked: the database, config, the logger and the email sender.
import { UserRole } from '@rsn/shared';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config', () => ({
  default: {
    magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.rsn.network',
    isDev: false,
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn(),
  __esModule: true,
}));

import * as identityService from '../../../services/identity/identity.service';
import { sendMagicLinkEmail } from '../../../services/email/email.service';

const MAIN_APP_LINK = /^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/;
const PREVIEW_LINK = /^https:\/\/preview\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/;

const member = {
  id: 'user-1',
  email: 'member@example.com',
  displayName: 'Member',
  role: UserRole.MEMBER,
  status: 'active',
  emailVerified: true,
  avatarUrl: null,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockQuery.mockResolvedValueOnce({ rows: [member], rowCount: 1 }); // getUserByEmail
  (sendMagicLinkEmail as jest.Mock).mockReset();
  (sendMagicLinkEmail as jest.Mock).mockResolvedValue(undefined);
});

/** Ask for a sign-in link as an existing member and return the link the email carries. */
async function emailedLink(requestedClientUrl: string | undefined, inviteCode?: string): Promise<string> {
  const result = await identityService.sendMagicLink(member.email, requestedClientUrl, inviteCode);
  expect(result).toEqual({ sent: true });
  expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
  const [to, link] = (sendMagicLinkEmail as jest.Mock).mock.calls[0] as [string, string];
  expect(to).toBe(member.email);
  return link;
}

describe('the sign-in link that is emailed', () => {
  it.each([
    'https://evil.example',
    'https://rsn-client-evil-rsnnetwork.vercel.app',
    'https://rsn.network.evil.example',
    'https://api.rsn.network',
  ])('opens the main app, not %s', async (requested) => {
    expect(await emailedLink(requested)).toMatch(MAIN_APP_LINK);
  });

  it('opens the main app when the page sent no address', async () => {
    expect(await emailedLink(undefined)).toMatch(MAIN_APP_LINK);
  });

  it('opens the preview site when that is where the member asked from', async () => {
    expect(await emailedLink('https://preview.rsn.network')).toMatch(PREVIEW_LINK);
  });

  it('still carries the invite code, on our own site', async () => {
    const link = await emailedLink('https://evil.example', 'ABC123');
    expect(link).toMatch(/^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}&inviteCode=ABC123$/);
  });
});
