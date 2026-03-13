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

import * as emailService from '../../services/email/email.service';

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
});
