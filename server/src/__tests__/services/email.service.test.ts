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
