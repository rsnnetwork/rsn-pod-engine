// ─── Email Service ───────────────────────────────────────────────────────────
// Handles sending emails via Resend (production) or console logging (dev).

import { Resend } from 'resend';
import config from '../../config';
import logger from '../../config/logger';

let resend: Resend | null = null;

function getResendClient(): Resend {
  if (!resend) {
    if (!config.resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }
    resend = new Resend(config.resendApiKey);
  }
  return resend;
}

export async function sendMagicLinkEmail(
  to: string,
  magicLinkUrl: string
): Promise<void> {
  const subject = 'Sign in to RSN';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(99,102,241,0.2);">
          <h1 style="color:#818cf8;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Raw Speed Networking</p>
          
          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Click the button below to sign in to your account. This link expires in ${config.magicLinkExpiryMinutes} minutes.
          </p>
          
          <div style="text-align:center;margin:32px 0;">
            <a href="${magicLinkUrl}" 
               style="display:inline-block;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In
            </a>
          </div>
          
          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#818cf8;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
            ${magicLinkUrl}
          </p>
        </div>
        
        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          If you didn't request this email, you can safely ignore it.
        </p>
      </div>
    </body>
    </html>
  `;

  // Use Resend if API key is configured
  if (config.resendApiKey) {
    const client = getResendClient();
    const { error } = await client.emails.send({
      from: config.emailFrom,
      to: [to],
      subject,
      html,
    });

    if (error) {
      logger.error({ error, to }, 'Failed to send magic link email via Resend');
      throw new Error(`Email send failed: ${error.message}`);
    }

    logger.info({ to }, 'Magic link email sent via Resend');
    return;
  }

  // Fallback: log to console in development
  logger.warn({ to, magicLinkUrl }, 'No email provider configured — magic link logged to console');
}
