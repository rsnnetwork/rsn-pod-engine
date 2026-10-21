// ─── Email Service Tests ─────────────────────────────────────────────────────

// Mock config before importing
jest.mock('../../config', () => ({
  __esModule: true,
  default: {
    resendApiKey: '', // No API key = dev mode, emails are skipped
    emailFrom: 'noreply@rsn.network',
    magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173',
  },
}));

jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
}));

import * as emailService from '../../services/email/email.service';
import { query } from '../../db';
import logger from '../../config/logger';

describe('Email Service', () => {
  describe('sendSessionRecapEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      await expect(
        emailService.sendSessionRecapEmail('test@example.com', 'Test User', {
          sessionTitle: 'Test Event',
          peopleMet: 5,
          mutualConnections: 2,
          avgRating: 4.2,
          recapUrl: 'http://localhost:5173/sessions/123/recap',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('sendHostRecapEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      await expect(
        emailService.sendHostRecapEmail('host@example.com', 'Host User', {
          sessionTitle: 'Test Event',
          totalParticipants: 10,
          totalRounds: 5,
          totalMatches: 25,
          avgEventRating: 4.1,
          mutualConnectionsCount: 8,
          recapUrl: 'http://localhost:5173/sessions/123/recap',
        })
      ).resolves.not.toThrow();
    });

    it('should handle zero avg rating gracefully', async () => {
      await expect(
        emailService.sendHostRecapEmail('host@example.com', 'Host', {
          sessionTitle: 'Empty Event',
          totalParticipants: 0,
          totalRounds: 0,
          totalMatches: 0,
          avgEventRating: 0,
          mutualConnectionsCount: 0,
          recapUrl: 'http://localhost:5173/sessions/456/recap',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('sendMagicLinkEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      // In dev mode (no resendApiKey), it just logs to console
      await expect(
        emailService.sendMagicLinkEmail('user@example.com', 'http://localhost:5173/auth/verify?token=abc')
      ).resolves.not.toThrow();
    });
  });

  // 13 Aug 2026: "New user has no idea what RSN is when landing after clicking
  // an invite link." Claus wanted it fixed in the email, not the UI.
  // 21 Oct 2026 (the client, 19 Oct: "call it REASON everywhere"): the subject, the opening and the
  // description name REASON in capitals. The tagline under the logo, "Connect with Reason", stays as it is.
  describe('buildInviteEmail says what REASON is', () => {
    it('a platform invite explains REASON and what happens next, in the html AND the plain text', () => {
      const { subject, html, text } = emailService.buildInviteEmail({
        inviterName: 'Stefan', type: 'platform', inviteUrl: 'http://localhost:5173/invite/ABC123',
      });
      expect(subject).toBe('Stefan invited you to REASON');
      expect(html).toMatch(/Stefan<\/strong> invited you to REASON\./);
      expect(text).toMatch(/^Stefan invited you to REASON\./);
      expect(html).toContain('REASON is a private network where people meet for a stated reason');
      expect(text).toContain('REASON is a private network where people meet for a stated reason');
      expect(html).toMatch(/private network where people meet for a stated reason/i);
      expect(html).toMatch(/who you are looking for/i);
      expect(html).toMatch(/takes a few minutes/i);
      expect(html).toContain('http://localhost:5173/invite/ABC123');
      expect(text).toMatch(/private network/i);
      expect(text).toMatch(/takes a few minutes/i);
      expect(text).toContain('Accept Invite: http://localhost:5173/invite/ABC123');
    });

    it('a circle invite reads as an invitation to a circle', () => {
      const { html, text } = emailService.buildInviteEmail({
        inviterName: 'Claus', type: 'circle', targetName: 'Nordic Founders', inviteUrl: 'http://x/invite/1',
      });
      expect(html).toMatch(/invited you to join a circle — <strong>Nordic Founders<\/strong>/);
      expect(text).toMatch(/invited you to join a circle — Nordic Founders/);
    });

    it('a pod invite says what REASON is but does not promise a sign-up conversation to someone who may already be in', () => {
      const { subject, html, text } = emailService.buildInviteEmail({
        inviterName: 'Stefan', type: 'pod', targetName: 'Founding Circle', inviteUrl: 'http://localhost:5173/invite/ABC123',
      });
      expect(subject).toBe('Stefan invited you to Founding Circle');
      expect(html).toContain('Founding Circle');
      expect(html).toMatch(/private network/i);
      expect(html).not.toMatch(/takes a few minutes/i);
      expect(text).not.toMatch(/takes a few minutes/i);
    });

    it('never injects raw html from a member-controlled name into the script/style context', () => {
      // The name is interpolated inside a <strong>; keep the existing shape
      // (no new template surface) — this pins that the builder still wraps it.
      const { html } = emailService.buildInviteEmail({
        inviterName: 'Stefan', type: 'session', targetName: 'Raw Speed Networking', inviteUrl: 'http://x/invite/1',
      });
      expect(html).toMatch(/<strong>Stefan<\/strong> has invited you to join an event — <strong>Raw Speed Networking<\/strong> on REASON\./);
    });

    it.each(['platform', 'pod', 'session', 'circle'] as const)('a %s invite names the product REASON, and "Reason" only in the tagline', (type) => {
      const { subject, html, text } = emailService.buildInviteEmail({
        inviterName: 'Stefan', type, ...(type === 'platform' ? {} : { targetName: 'Founding Circle' }), inviteUrl: 'http://x/invite/1',
      });
      const withoutTagline = html.replace('Connect with Reason', '');
      for (const words of [subject, withoutTagline, text]) expect(words).not.toMatch(/\bReason\b/);
      expect(html).toContain('Connect with Reason');
    });
  });

  describe('sendInviteEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      await expect(
        emailService.sendInviteEmail('invited@example.com', {
          inviterName: 'Test Host',
          type: 'session',
          targetName: 'My Event',
          inviteUrl: 'http://localhost:5173/invite/abc123',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('sendJoinRequestConfirmationEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      await expect(
        emailService.sendJoinRequestConfirmationEmail('applicant@example.com', 'Jane Doe')
      ).resolves.not.toThrow();
    });
  });

  describe('sendJoinRequestWelcomeEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      await expect(
        emailService.sendJoinRequestWelcomeEmail('approved@example.com', 'Jane Doe', 'http://localhost:5173/login')
      ).resolves.not.toThrow();
    });
  });

  describe('sendJoinRequestDeclineEmail', () => {
    it('should not throw when no email provider is configured', async () => {
      await expect(
        emailService.sendJoinRequestDeclineEmail('declined@example.com', 'John Doe')
      ).resolves.not.toThrow();
    });
  });

  describe('isEmailTypeEnabled', () => {
    it('should return enabled status from database row', async () => {
      (query as jest.Mock).mockResolvedValueOnce({
        rows: [{ enabled: false }],
      });

      const result = await emailService.isEmailTypeEnabled('poke_request');

      expect(result).toBe(false);
      expect(query).toHaveBeenCalledWith(
        'SELECT enabled FROM email_config WHERE email_type = $1',
        ['poke_request']
      );
    });

    it('should return true (fail-open) when email_type row does not exist', async () => {
      (query as jest.Mock).mockResolvedValueOnce({
        rows: [],
      });

      const result = await emailService.isEmailTypeEnabled('unknown_type');

      expect(result).toBe(true);
    });

    it('should return true (fail-open) and log warning when query rejects', async () => {
      const testError = new Error('Database connection failed');
      (query as jest.Mock).mockRejectedValueOnce(testError);

      const result = await emailService.isEmailTypeEnabled('poke_request');

      expect(result).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: testError, emailType: 'poke_request' },
        'email_config lookup failed — defaulting to enabled'
      );
    });
  });
});

// ─── 11 Sep 2026 (Ali): "the template must have a border and a beautiful UI,
// more engaging". One shell for every email: the brand band, a red accent
// strip, a bordered card, the footer linking to the app.
//
// 22 Sep 2026 (Shradha): the mark in that band was a WHITE sheep. The brand
// mark is the black one, and it is unreadable on navy, so the band went light
// and carried the black lockup.
//
// 21 Oct 2026 (the client, 19 Oct): "the whole email header should be white" and
// "call it REASON everywhere". The band is white and the lockup is the REASON one
// (reason-logo.png). email-reason-brand.test.ts renders every email against this;
// this block pins the shell itself.
describe('the shared email shell', () => {
  it('opens on a white band with the REASON lockup and a red strip, in a bordered card', () => {
    const { html } = emailService.buildInviteEmail({
      inviterName: 'Stefan', inviteeName: 'Ali', type: 'platform', inviteUrl: 'http://localhost:5173/invite/ABC123',
    } as any);
    expect(html).toContain('http://localhost:5173/reason-logo.png');   // the black sheep + REASON lockup
    expect(html).toContain('alt="REASON"');
    expect(html).toMatch(/width="160" height="35"/);                  // 1056 by 228, scaled to 160 wide
    expect(html).toMatch(/background:#ffffff;padding:28px/);          // a white band, the whole header
    expect(html).toMatch(/height:4px;background:#DE322E/);            // the accent strip
    expect(html).toMatch(/border:1px solid #dfe3ea/);                 // the card border
    expect(html).toMatch(/Connect with Reason/);
    expect(html).toContain('href="http://localhost:5173"');           // footer link to the app
    // The old grey band and the old lockup are gone, and so are the white silhouette and the navy band.
    expect(html).not.toContain('#f4f5f8');
    expect(html).not.toContain('/rsn-logo.png');
    expect(html).not.toContain('height="auto"');
    expect(html).not.toContain('rsn-sheep-white-email.png');
    expect(html).not.toMatch(/background:#1a1a2e;padding:28px/);
  });

  it('the white sheep is gone from every email, not just the one built here', () => {
    // Fifteen emails share emailCardOpen(), but any of them could hard-code its
    // own mark. Read the source rather than building all fifteen.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../services/email/email.service.ts'), 'utf8',
    ) as string;
    expect(src).not.toContain('rsn-sheep-white-email');
    // And the band the mark sits on is declared once, white.
    expect(src.match(/background:#ffffff;padding:28px/g) ?? []).toHaveLength(1);
    expect(src).not.toContain('background:#f4f5f8');
  });
});
