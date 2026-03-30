// ─── Email Service ───────────────────────────────────────────────────────────
// Handles sending emails via Resend (production) or console logging (dev).

import { Resend } from 'resend';
import { v4 as uuid } from 'uuid';
import config from '../../config';
import logger from '../../config/logger';
import { generateIcsContent } from '../calendar/calendar.service';

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

// Centralized email sender with deliverability best-practices headers
async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: { filename: string; content: string }[];
}): Promise<{ sent: boolean }> {
  if (!config.resendApiKey) {
    logger.warn({ to: opts.to, subject: opts.subject }, 'No email provider — email skipped');
    return { sent: false };
  }

  const senderName = 'RSN';
  const fromRaw = config.emailFrom; // e.g. noreply@rsn.network
  const from = fromRaw.includes('<') ? fromRaw : `${senderName} <${fromRaw}>`;

  const client = getResendClient();
  const emailPayload: any = {
    from,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyTo || fromRaw.replace(/.*<|>.*/g, ''),
    headers: {
      'X-Entity-Ref-ID': uuid(), // unique per email — prevents Gmail grouping into one thread
    },
  };

  if (opts.attachments && opts.attachments.length > 0) {
    emailPayload.attachments = opts.attachments.map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content).toString('base64'),
    }));
  }

  // Retry with exponential backoff for rate-limit and transient errors
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { error } = await client.emails.send(emailPayload);

    if (!error) {
      if (attempt > 0) logger.warn({ to: opts.to, attempt }, `Email sent after ${attempt} retries: ${opts.subject}`);
      else logger.info({ to: opts.to }, `Email sent: ${opts.subject}`);
      return { sent: true };
    }

    const statusCode = (error as any).statusCode;
    const isRetryable = statusCode === 429 || statusCode === 500 || statusCode === 503;

    if (!isRetryable || attempt === MAX_RETRIES) {
      logger.error({ error, to: opts.to, attempts: attempt + 1 }, `Failed to send email: ${opts.subject}`);
      return { sent: false };
    }

    // Exponential backoff: 1s, 2s, 4s
    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
  }

  return { sent: false };
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
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>
          
          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Click the button below to sign in to your account. This link expires in ${config.magicLinkExpiryMinutes} minutes.
          </p>
          
          <div style="text-align:center;margin:32px 0;">
            <a href="${magicLinkUrl}" 
               style="display:inline-block;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In
            </a>
          </div>
          
          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#DE322E;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
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
    const text = `Sign in to RSN\n\nClick the link below to sign in to your account. This link expires in ${config.magicLinkExpiryMinutes} minutes.\n\n${magicLinkUrl}\n\nIf you didn't request this email, you can safely ignore it.`;
    const result = await sendEmail({ to, subject, html, text });
    if (!result.sent) {
      throw new Error('Email send failed');
    }
    return;
  }

  // Fallback: log to console in development
  logger.warn({ to, magicLinkUrl }, 'No email provider configured — magic link logged to console');
}

// ─── Session Recap Email ────────────────────────────────────────────────────

interface RecapEmailData {
  sessionTitle: string;
  peopleMet: number;
  mutualConnections: number;
  avgRating: number;
  recapUrl: string;
}

export async function sendSessionRecapEmail(
  to: string,
  displayName: string,
  data: RecapEmailData
): Promise<void> {
  const subject = `Your RSN Recap — ${data.sessionTitle}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Event Recap</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 8px 0;">
            Hey ${displayName},
          </p>
          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thanks for joining <strong>${data.sessionTitle}</strong>! Here's your event recap:
          </p>

          <div style="display:flex;gap:12px;margin:0 0 24px 0;">
            <div style="flex:1;text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;">
              <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.peopleMet}</p>
              <p style="color:#94a3b8;font-size:12px;margin:4px 0 0 0;">People Met</p>
            </div>
            <div style="flex:1;text-align:center;background:rgba(16,185,129,0.1);border-radius:10px;padding:16px 8px;">
              <p style="color:#10b981;font-size:24px;font-weight:700;margin:0;">${data.mutualConnections}</p>
              <p style="color:#94a3b8;font-size:12px;margin:4px 0 0 0;">Mutual Matches</p>
            </div>
            <div style="flex:1;text-align:center;background:rgba(245,158,11,0.1);border-radius:10px;padding:16px 8px;">
              <p style="color:#f59e0b;font-size:24px;font-weight:700;margin:0;">${data.avgRating.toFixed(1)}</p>
              <p style="color:#94a3b8;font-size:12px;margin:4px 0 0 0;">Avg Rating</p>
            </div>
          </div>

          <div style="text-align:center;margin:32px 0;">
            <a href="${data.recapUrl}"
               style="display:inline-block;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Full Recap
            </a>
          </div>
        </div>

        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hey ${displayName},\n\nThanks for joining ${data.sessionTitle}! Here's your event recap:\n\nPeople Met: ${data.peopleMet}\nMutual Matches: ${data.mutualConnections}\nAvg Rating: ${data.avgRating.toFixed(1)}\n\nView Full Recap: ${data.recapUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, sessionTitle: data.sessionTitle }, 'No email provider — recap email skipped');
}

// ─── Host Event Recap Email ─────────────────────────────────────────────────

interface HostRecapEmailData {
  sessionTitle: string;
  totalParticipants: number;
  totalRounds: number;
  totalMatches: number;
  avgEventRating: number;
  mutualConnectionsCount: number;
  recapUrl: string;
}

export async function sendHostRecapEmail(
  to: string,
  displayName: string,
  data: HostRecapEmailData
): Promise<void> {
  const subject = `Host Recap — ${data.sessionTitle}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Host Event Recap</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 8px 0;">
            Hey ${displayName},
          </p>
          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Here's the full recap for <strong>${data.sessionTitle}</strong>:
          </p>

          <table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
            <tr>
              <td style="text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;width:33%;">
                <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.totalParticipants}</p>
                <p style="color:#94a3b8;font-size:11px;margin:4px 0 0 0;">Participants</p>
              </td>
              <td style="width:8px;"></td>
              <td style="text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;width:33%;">
                <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.totalRounds}</p>
                <p style="color:#94a3b8;font-size:11px;margin:4px 0 0 0;">Rounds</p>
              </td>
              <td style="width:8px;"></td>
              <td style="text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;width:33%;">
                <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.totalMatches}</p>
                <p style="color:#94a3b8;font-size:11px;margin:4px 0 0 0;">Matches</p>
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
            <tr>
              <td style="text-align:center;background:rgba(245,158,11,0.1);border-radius:10px;padding:16px 8px;width:50%;">
                <p style="color:#f59e0b;font-size:24px;font-weight:700;margin:0;">${data.avgEventRating > 0 ? data.avgEventRating.toFixed(1) : '—'}</p>
                <p style="color:#94a3b8;font-size:11px;margin:4px 0 0 0;">Avg Rating</p>
              </td>
              <td style="width:8px;"></td>
              <td style="text-align:center;background:rgba(16,185,129,0.1);border-radius:10px;padding:16px 8px;width:50%;">
                <p style="color:#10b981;font-size:24px;font-weight:700;margin:0;">${data.mutualConnectionsCount}</p>
                <p style="color:#94a3b8;font-size:11px;margin:4px 0 0 0;">Mutual Connections</p>
              </td>
            </tr>
          </table>

          <div style="text-align:center;margin:32px 0;">
            <a href="${data.recapUrl}"
               style="display:inline-block;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Full Recap
            </a>
          </div>
        </div>

        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hey ${displayName},\n\nHere's the full recap for ${data.sessionTitle}:\n\nParticipants: ${data.totalParticipants}\nRounds: ${data.totalRounds}\nMatches: ${data.totalMatches}\nAvg Rating: ${data.avgEventRating > 0 ? data.avgEventRating.toFixed(1) : 'N/A'}\nMutual Connections: ${data.mutualConnectionsCount}\n\nView Full Recap: ${data.recapUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, sessionTitle: data.sessionTitle }, 'No email provider — host recap email skipped');
}

// ─── Invite Email ───────────────────────────────────────────────────────────

interface InviteEmailData {
  inviterName: string;
  type: 'pod' | 'session' | 'platform';
  targetName?: string; // pod or session name
  inviteUrl: string;
  calendarEvent?: {
    title: string;
    description?: string;
    startTime: Date;
    durationMinutes: number;
    organizerName?: string;
    organizerEmail?: string;
    sessionId?: string;
  };
}

export async function sendInviteEmail(
  to: string,
  data: InviteEmailData
): Promise<void> {
  const typeLabel = data.type === 'pod' ? 'a pod' : data.type === 'session' ? 'an event' : 'the platform';
  const targetLine = data.targetName ? ` — <strong>${data.targetName}</strong>` : '';

  const subject = `${data.inviterName} invited you to RSN`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            <strong>${data.inviterName}</strong> has invited you to join ${typeLabel}${targetLine} on RSN.
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${data.inviteUrl}"
               style="display:inline-block;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Accept Invite
            </a>
          </div>

          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#DE322E;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
            ${data.inviteUrl}
          </p>
        </div>

        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `${data.inviterName} has invited you to join ${typeLabel}${data.targetName ? ` — ${data.targetName}` : ''} on RSN.\n\nAccept Invite: ${data.inviteUrl}\n\nRSN — Connect with Reason`;
    const attachments: { filename: string; content: string }[] = [];

    // Attach .ics calendar invite for session invites with scheduled time
    if (data.calendarEvent) {
      const icsContent = generateIcsContent({
        title: data.calendarEvent.title,
        description: data.calendarEvent.description || `RSN Event — ${data.calendarEvent.title}`,
        startTime: data.calendarEvent.startTime,
        durationMinutes: data.calendarEvent.durationMinutes,
        organizerName: data.calendarEvent.organizerName,
        organizerEmail: data.calendarEvent.organizerEmail,
        location: data.calendarEvent.sessionId
          ? `${config.clientUrl}/sessions/${data.calendarEvent.sessionId}`
          : undefined,
      });
      attachments.push({ filename: 'event.ics', content: icsContent });
    }

    await sendEmail({ to, subject, html, text, attachments: attachments.length > 0 ? attachments : undefined });
    return;
  }

  logger.warn({ to, type: data.type }, 'No email provider — invite email skipped');
}

// ─── Join Request Confirmation Email ────────────────────────────────────────

export async function sendJoinRequestConfirmationEmail(
  to: string,
  fullName: string
): Promise<void> {
  const subject = 'RSN — We received your request';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for requesting to join RSN. We've received your application and our team will review it shortly.
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            RSN is an invite-only community for founders, leaders, and company owners who value honesty over hype. We review every application carefully to maintain the quality of our community.
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 0 0;">
            You'll hear from us within 1-3 business days.
          </p>
        </div>
        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\nThank you for requesting to join RSN. We've received your application and our team will review it shortly.\n\nRSN is an invite-only community for founders, leaders, and company owners who value honesty over hype. We review every application carefully to maintain the quality of our community.\n\nYou'll hear from us within 1-3 business days.\n\nRSN — Fast, focused, and human.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to }, 'No email provider — join request confirmation email skipped');
}

// ─── Join Request Welcome Email (Approved) ──────────────────────────────────

export async function sendJoinRequestWelcomeEmail(
  to: string,
  fullName: string,
  loginUrl: string
): Promise<void> {
  const subject = 'Welcome to RSN — You\'re in!';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Great news — your request to join RSN has been <strong style="color:#e2e8f0;">approved</strong>!
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            You're now part of a community of founders, leaders, and company owners who connect with honesty and purpose. No pitching. No selling. Just real conversations.
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${loginUrl}"
               style="display:inline-block;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In to RSN
            </a>
          </div>

          <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0;">
            Your first step: sign up for an event and meet five people in focused 8-minute conversations.
          </p>
        </div>
        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\nGreat news — your request to join RSN has been approved!\n\nYou're now part of a community of founders, leaders, and company owners who connect with honesty and purpose. No pitching. No selling. Just real conversations.\n\nSign In to RSN: ${loginUrl}\n\nYour first step: sign up for an event and meet five people in focused 8-minute conversations.\n\nRSN — Fast, focused, and human.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to }, 'No email provider — welcome email skipped');
}

// ─── Join Request Decline Email ─────────────────────────────────────────────

export async function sendJoinRequestDeclineEmail(
  to: string,
  fullName: string
): Promise<void> {
  const subject = 'RSN — Update on your request';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for your interest in RSN. After reviewing your application, we're unable to offer access at this time.
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            RSN is a curated community, and we carefully consider each application. This decision is based on our current community composition and needs.
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 0 0;">
            If your circumstances change or you receive an invite from a current member, you're welcome to reapply.
          </p>
        </div>
        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\nThank you for your interest in RSN. After reviewing your application, we're unable to offer access at this time.\n\nRSN is a curated community, and we carefully consider each application. This decision is based on our current community composition and needs.\n\nIf your circumstances change or you receive an invite from a current member, you're welcome to reapply.\n\nRSN — Fast, focused, and human.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to }, 'No email provider — decline email skipped');
}

// ─── Join Request Reminder Email (Nudge / Poke) ─────────────────────────────

export async function sendJoinRequestReminderEmail(
  to: string,
  fullName: string,
  loginUrl: string,
  reminderCount: number
): Promise<void> {
  const isSecondReminder = reminderCount >= 2;
  const subject = isSecondReminder
    ? 'RSN — Your spot is still waiting'
    : 'RSN — Don\'t forget to complete your signup!';

  const mainMessage = isSecondReminder
    ? 'We noticed you haven\'t completed your signup yet. Your approved spot at RSN is still reserved — but it won\'t last forever.'
    : 'You were approved to join RSN! We\'d love to see you at our next event. Complete your signup in under a minute.';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>

          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            ${mainMessage}
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${loginUrl}"
               style="display:inline-block;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Complete Your Signup
            </a>
          </div>

          <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0;">
            Once you're in, join an event and meet five people in focused 8-minute conversations. No pitching. No selling. Just real talk.
          </p>
        </div>
        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\n${mainMessage}\n\nComplete Your Signup: ${loginUrl}\n\nOnce you're in, join an event and meet five people in focused 8-minute conversations. No pitching. No selling. Just real talk.\n\nRSN — Fast, focused, and human.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to }, 'No email provider — reminder email skipped');
}

// ─── Generic Message Email (admin → applicant) ─────────────────────────────

export async function sendGenericEmail(
  to: string,
  recipientName: string,
  data: { subject: string; body: string }
): Promise<void> {
  const subject = data.subject;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:40px 32px;border:1px solid rgba(222,50,46,0.15);">
          <h1 style="color:#DE322E;font-size:28px;font-weight:700;margin:0 0 8px 0;text-align:center;">RSN</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0;text-align:center;">Connect with Reason</p>
          <p style="color:#e2e8f0;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${recipientName},
          </p>
          <p style="color:#cbd5e1;font-size:16px;line-height:1.6;margin:0 0 0 0;white-space:pre-wrap;">${data.body}</p>
        </div>
        <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
          RSN — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${recipientName},\n\n${data.body}\n\nRSN — Fast, focused, and human.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to }, 'No email provider — generic email skipped');
}
