// ─── Email Service ───────────────────────────────────────────────────────────
// Handles sending emails via Resend (production) or console logging (dev).

import { Resend } from 'resend';
import { v4 as uuid } from 'uuid';
import config from '../../config';
import logger from '../../config/logger';
import { generateIcsContent } from '../calendar/calendar.service';
import { query } from '../../db';

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

// ─── Shared shell (11 Sep 2026, Ali: "a border and a beautiful UI, more engaging") ──
// Every email opens on the dark brand band with the white logo and a red accent
// strip, inside a bordered card, and closes on a link back to the app. The
// words of each email are untouched; only the shell is shared.
export function emailCardOpen(): string {
  return [
    `<div style="background:#ffffff;border-radius:16px;border:1px solid #dfe3ea;overflow:hidden;box-shadow:0 10px 30px rgba(26,26,46,0.08);">`,
    `<div style="background:#1a1a2e;padding:28px 32px 22px 32px;text-align:center;">`,
    `<img src="${config.clientUrl}/rsn-logo-white.png" alt="RSN" width="150" height="auto" style="display:block;margin:0 auto;" />`,
    `<p style="color:#f3b6b2;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:14px 0 0 0;">Connect with Reason</p>`,
    `</div>`,
    `<div style="height:4px;background:#DE322E;font-size:0;line-height:0;">&nbsp;</div>`,
    `<div style="padding:36px 32px 32px 32px;">`,
  ].join("");
}
export function emailCardClose(): string {
  return [
    `</div>`,
    `<div style="border-top:1px solid #f0f2f5;padding:16px 32px;text-align:center;">`,
    `<a href="${config.clientUrl}" style="color:#DE322E;font-size:12px;font-weight:600;letter-spacing:0.5px;text-decoration:none;">app.rsn.network</a>`,
    `</div>`,
    `</div>`,
  ].join("");
}

// Centralized email sender with deliverability best-practices headers
async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** `contentType` matters for calendar invites: `text/calendar; method=REQUEST`
   *  is what makes Gmail/Outlook/Apple render an inline Accept/Decline invite
   *  instead of a bare .ics download (Stefan, 9 Sep 2026). */
  attachments?: { filename: string; content: string; contentType?: string }[];
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
      ...(a.contentType ? { contentType: a.contentType } : {}),
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Click the button below to sign in to your account. This link expires in ${config.magicLinkExpiryMinutes} minutes.
          </p>
          
          <div style="text-align:center;margin:32px 0;">
            <a href="${magicLinkUrl}" 
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In
            </a>
          </div>
          
          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#DE322E;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
            ${magicLinkUrl}
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 32px 0;text-align:center;">Event Recap</p>

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">
            Hey ${displayName},
          </p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thanks for joining <strong>${data.sessionTitle}</strong>! Here's your event recap:
          </p>

          <!-- Phase 6 (29 April 2026 spec) — labels aligned with Stefan's
               clarification: "Mutual matches" = distinct people met,
               "Want to meet again" = both-said-yes subset. The data fields
               keep their original property names (peopleMet, mutualConnections)
               for backwards compatibility; only the rendered labels changed. -->
          <div style="display:flex;gap:12px;margin:0 0 24px 0;">
            <div style="flex:1;text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;">
              <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.peopleMet}</p>
              <p style="color:#6b7280;font-size:12px;margin:4px 0 0 0;">Mutual Matches</p>
            </div>
            <div style="flex:1;text-align:center;background:rgba(16,185,129,0.1);border-radius:10px;padding:16px 8px;">
              <p style="color:#10b981;font-size:24px;font-weight:700;margin:0;">${data.mutualConnections}</p>
              <p style="color:#6b7280;font-size:12px;margin:4px 0 0 0;">Want to Meet Again</p>
            </div>
            <div style="flex:1;text-align:center;background:rgba(245,158,11,0.1);border-radius:10px;padding:16px 8px;">
              <p style="color:#f59e0b;font-size:24px;font-weight:700;margin:0;">${data.avgRating.toFixed(1)}</p>
              <p style="color:#6b7280;font-size:12px;margin:4px 0 0 0;">Avg Rating</p>
            </div>
          </div>

          <div style="text-align:center;margin:32px 0;">
            <a href="${data.recapUrl}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Full Recap
            </a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hey ${displayName},\n\nThanks for joining ${data.sessionTitle}! Here's your event recap:\n\nMutual Matches: ${data.peopleMet}\nWant to Meet Again: ${data.mutualConnections}\nAvg Rating: ${data.avgRating.toFixed(1)}\n\nView Full Recap: ${data.recapUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, sessionTitle: data.sessionTitle }, 'No email provider — recap email skipped');
}

// ─── DM Notification Email (Phase D of chat-fix-and-dm-system, 1 May 2026) ─

interface DmNotificationEmailData {
  senderName: string;
  snippet: string;
  threadUrl: string;
}

/**
 * Sent when a user receives a DM while offline. Debounced one-per-hour
 * per (sender, recipient) pair by the caller (dm-handlers.ts).
 */
export async function sendDmNotificationEmail(
  to: string,
  recipientDisplayName: string,
  data: DmNotificationEmailData,
): Promise<void> {
  const subject = `${data.senderName} sent you a message on RSN`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">New message</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${recipientDisplayName},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${data.senderName}</strong> sent you a message on RSN.
          </p>
          <div style="background:#f8f9fa;border-left:3px solid #DE322E;border-radius:6px;padding:12px 16px;margin:0 0 24px 0;">
            <p style="color:#374151;font-size:14px;line-height:1.5;margin:0;">${data.snippet}</p>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="${data.threadUrl}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View Message</a>
          ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
            You're receiving this because someone messaged you on RSN.
            You can change your notification preferences in Settings.
          </p>
        ${emailCardClose()}
      </div>
    </body></html>`;

  if (config.resendApiKey) {
    const text = `Hey ${recipientDisplayName},\n\n${data.senderName} sent you a message on RSN:\n\n"${data.snippet}"\n\nView the conversation: ${data.threadUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, senderName: data.senderName }, 'No email provider — DM notification email skipped');
}

// ─── Host Event Recap Email ─────────────────────────────────────────────────

interface HostRecapEmailData {
  sessionTitle: string;
  totalParticipants: number;
  totalRounds: number;
  /**
   * Phase 6 (29 April 2026 spec) — `totalMatches` is now the SUCCESSFUL
   * (status='completed') match count. Optional `matchesCreated` carries
   * the all-statuses tally so the host recap can show "Matches created:
   * X / Successful: Y" per the user's option C. When `matchesCreated`
   * is omitted, the email falls back to a single "Matches" number for
   * back-compat with older callers.
   */
  totalMatches: number;
  matchesCreated?: number;
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 32px 0;text-align:center;">Host Event Recap</p>

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">
            Hey ${displayName},
          </p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Here's the full recap for <strong>${data.sessionTitle}</strong>:
          </p>

          <table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
            <tr>
              <td style="text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;width:33%;">
                <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.totalParticipants}</p>
                <p style="color:#6b7280;font-size:11px;margin:4px 0 0 0;">Participants</p>
              </td>
              <td style="width:8px;"></td>
              <td style="text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;width:33%;">
                <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.totalRounds}</p>
                <p style="color:#6b7280;font-size:11px;margin:4px 0 0 0;">Rounds</p>
              </td>
              <td style="width:8px;"></td>
              <td style="text-align:center;background:rgba(222,50,46,0.08);border-radius:10px;padding:16px 8px;width:33%;">
                <p style="color:#DE322E;font-size:24px;font-weight:700;margin:0;">${data.matchesCreated != null ? `${data.matchesCreated} / ${data.totalMatches}` : data.totalMatches}</p>
                <p style="color:#6b7280;font-size:11px;margin:4px 0 0 0;">${data.matchesCreated != null ? 'Matches Created / Successful' : 'Matches'}</p>
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
            <tr>
              <td style="text-align:center;background:rgba(245,158,11,0.1);border-radius:10px;padding:16px 8px;width:50%;">
                <p style="color:#f59e0b;font-size:24px;font-weight:700;margin:0;">${data.avgEventRating > 0 ? data.avgEventRating.toFixed(1) : '—'}</p>
                <p style="color:#6b7280;font-size:11px;margin:4px 0 0 0;">Avg Rating</p>
              </td>
              <td style="width:8px;"></td>
              <td style="text-align:center;background:rgba(16,185,129,0.1);border-radius:10px;padding:16px 8px;width:50%;">
                <p style="color:#10b981;font-size:24px;font-weight:700;margin:0;">${data.mutualConnectionsCount}</p>
                <p style="color:#6b7280;font-size:11px;margin:4px 0 0 0;">Mutual Connections</p>
              </td>
            </tr>
          </table>

          <div style="text-align:center;margin:32px 0;">
            <a href="${data.recapUrl}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Full Recap
            </a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const matchesLine = data.matchesCreated != null
      ? `Matches Created / Successful: ${data.matchesCreated} / ${data.totalMatches}`
      : `Matches: ${data.totalMatches}`;
    const text = `Hey ${displayName},\n\nHere's the full recap for ${data.sessionTitle}:\n\nParticipants: ${data.totalParticipants}\nRounds: ${data.totalRounds}\n${matchesLine}\nAvg Rating: ${data.avgEventRating > 0 ? data.avgEventRating.toFixed(1) : 'N/A'}\nMutual Connections: ${data.mutualConnectionsCount}\n\nView Full Recap: ${data.recapUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, sessionTitle: data.sessionTitle }, 'No email provider — host recap email skipped');
}

// ─── Invite Email ───────────────────────────────────────────────────────────

interface InviteEmailData {
  inviterName: string;
  type: 'pod' | 'session' | 'platform' | 'circle';
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

/**
 * 13 Aug 2026: "New user has no idea what RSN is when landing after clicking
 * an invite link." Claus preferred fixing this in the email rather than
 * building an on-platform explainer, so the invite now says what Reason is
 * and what happens next, in plain prose, before it asks anyone to join.
 * A pure builder, so the copy is testable without an email provider.
 */
export function buildInviteEmail(data: InviteEmailData): { subject: string; html: string; text: string } {
  const typeLabel = data.type === 'pod' ? 'a pod' : data.type === 'session' ? 'an event' : data.type === 'circle' ? 'a circle' : 'the platform';
  const targetLine = data.targetName ? ` — <strong>${data.targetName}</strong>` : '';
  const targetText = data.targetName ? ` — ${data.targetName}` : '';

  const subject = `${data.inviterName} invited you to ${data.targetName || 'Reason'}`;

  const openingHtml = data.type === 'platform'
    ? `<strong>${data.inviterName}</strong> invited you to Reason.`
    : `<strong>${data.inviterName}</strong> has invited you to join ${typeLabel}${targetLine} on Reason.`;
  const openingText = data.type === 'platform'
    ? `${data.inviterName} invited you to Reason.`
    : `${data.inviterName} has invited you to join ${typeLabel}${targetText} on Reason.`;

  const whatItIs =
    'Reason is a private network where people meet for a stated reason rather than by browsing profiles. ' +
    'You say who you are looking for, and it keeps looking, including as new people join.';
  // A pod or event invite may reach someone who is already a member, so only a
  // platform invite promises them the sign-up conversation.
  const whatHappensNext = data.type === 'platform'
    ? 'Joining takes a few minutes: a short conversation about who you want to meet, and you are in.'
    : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            ${openingHtml}
          </p>
          <p style="color:#1a1a2e;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            ${whatItIs}
          </p>
          ${whatHappensNext ? `<p style="color:#1a1a2e;font-size:15px;line-height:1.6;margin:0 0 24px 0;">${whatHappensNext}</p>` : ''}

          <div style="text-align:center;margin:32px 0;">
            <a href="${data.inviteUrl}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Accept Invite
            </a>
          </div>

          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#DE322E;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
            ${data.inviteUrl}
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  const text = [openingText, '', whatItIs, whatHappensNext, '', `Accept Invite: ${data.inviteUrl}`, '', 'RSN — Connect with Reason']
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');

  return { subject, html, text };
}

export async function sendInviteEmail(
  to: string,
  data: InviteEmailData
): Promise<void> {
  const { subject, html, text } = buildInviteEmail(data);

  if (config.resendApiKey) {
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

// ─── Session Registration Confirmation Email ─────────────────────────────────
// Sent when a user SELF-registers for an event (no host invite). Mirrors the
// invite email's calendar attachment so a self-signup also lands the event on
// the user's calendar with a 15-minute reminder.

interface RegistrationConfirmationData {
  recipientName?: string;
  sessionTitle: string;
  sessionUrl: string;
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

export async function sendSessionRegistrationConfirmationEmail(
  to: string,
  data: RegistrationConfirmationData,
): Promise<void> {
  const greetingName = data.recipientName ? ` ${data.recipientName}` : '';
  const whenLine = data.calendarEvent
    ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px 0;text-align:center;">${data.calendarEvent.startTime.toUTCString()}</p>`
    : '';
  const calendarNote = data.calendarEvent
    ? `<p style="color:#64748b;font-size:13px;line-height:1.5;margin:20px 0 0 0;text-align:center;">A calendar invite is attached — add it to get a reminder 15 minutes before.</p>`
    : '';
  const subject = `You're registered — ${data.sessionTitle}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <h1 style="color:#1a1a2e;font-size:22px;font-weight:700;margin:0 0 16px 0;text-align:center;">You're registered${greetingName}!</h1>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;text-align:center;">
            You're all set for <strong>${data.sessionTitle}</strong>.
          </p>
          ${whenLine}
          <div style="text-align:center;margin:32px 0;">
            <a href="${data.sessionUrl}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Event
            </a>
          </div>
          ${calendarNote}
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          RSN — Connect with Reason
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `You're registered for ${data.sessionTitle}.${data.calendarEvent ? ' A calendar invite is attached.' : ''}\n\nView event: ${data.sessionUrl}\n\nRSN — Connect with Reason`;
    const attachments: { filename: string; content: string }[] = [];

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

  logger.warn({ to, sessionTitle: data.sessionTitle }, 'No email provider — registration confirmation skipped');
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for requesting to join RSN. We've received your application and our team will review it shortly.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            RSN is an invite-only community for founders, leaders, and company owners who value honesty over hype. We review every application carefully to maintain the quality of our community.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 0 0;">
            You'll hear from us within 1-3 business days.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Great news — your request to join RSN has been <strong style="color:#1a1a2e;">approved</strong>!
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            You're now part of a community of founders, leaders, and company owners who connect with honesty and purpose. No pitching. No selling. Just real conversations.
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${loginUrl}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In to RSN
            </a>
          </div>

          <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">
            Your first step: sign up for an event and meet five people in focused 8-minute conversations.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for your interest in RSN. After reviewing your application, we're unable to offer access at this time.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            RSN is a curated community, and we carefully consider each application. This decision is based on our current community composition and needs.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 0 0;">
            If your circumstances change or you receive an invite from a current member, you're welcome to reapply.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${fullName},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            ${mainMessage}
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${loginUrl}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Complete Your Signup
            </a>
          </div>

          <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">
            Once you're in, join an event and meet five people in focused 8-minute conversations. No pitching. No selling. Just real talk.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
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
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${recipientName},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 0 0;white-space:pre-wrap;">${data.body}</p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
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

// ─── Join Request — Admin Review Email (one-click approve / reject) ────────

export interface JoinRequestAdminReviewData {
  adminDisplayName: string;
  applicantName: string;
  applicantEmail: string;
  applicantLinkedinUrl: string | null;
  applicantReason: string | null;
  approveUrl: string;
  rejectUrl: string;
  dashboardUrl: string;
  expiresInHours: number;
}

export async function sendJoinRequestAdminReviewEmail(
  to: string,
  data: JoinRequestAdminReviewData,
): Promise<void> {
  const subject = `New RSN join request — ${data.applicantName}`;
  const reasonBlock = data.applicantReason
    ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">Why RSN</td>
         <td style="padding:8px 0;color:#374151;font-size:14px;line-height:1.5;">${escapeHtml(data.applicantReason)}</td></tr>`
    : '';
  const linkedinBlock = data.applicantLinkedinUrl
    ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">LinkedIn</td>
         <td style="padding:8px 0;font-size:14px;"><a href="${escapeAttr(data.applicantLinkedinUrl)}" style="color:#DE322E;text-decoration:none;">${escapeHtml(data.applicantLinkedinUrl)}</a></td></tr>`
    : '';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="referrer" content="no-referrer">
    </head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}

          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Hi ${escapeHtml(data.adminDisplayName)},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            A new request to join RSN just came in. You can approve or decline below — no need to open the dashboard.
          </p>

          <div style="background:#f8f9fa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin:0 0 28px 0;">
            <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">Name</td>
                  <td style="padding:8px 0;color:#1a1a2e;font-size:15px;font-weight:600;">${escapeHtml(data.applicantName)}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Email</td>
                  <td style="padding:8px 0;color:#374151;font-size:14px;">${escapeHtml(data.applicantEmail)}</td></tr>
              ${linkedinBlock}
              ${reasonBlock}
            </table>
          </div>

          <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
            <tr>
              <td style="padding:0 6px 12px 0;width:50%;">
                <a href="${escapeAttr(data.approveUrl)}"
                   style="display:block;text-align:center;background:#DE322E;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 0;border-radius:10px;">
                  Approve
                </a>
              </td>
              <td style="padding:0 0 12px 6px;width:50%;">
                <a href="${escapeAttr(data.rejectUrl)}"
                   style="display:block;text-align:center;background:#ffffff;color:#1a1a2e;font-size:16px;font-weight:600;text-decoration:none;padding:13px 0;border-radius:10px;border:1px solid #d1d5db;">
                  Decline
                </a>
              </td>
            </tr>
          </table>

          <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 8px 0;">
            Each link takes you to a confirmation page so nothing is acted on until you click again. Links expire in ${data.expiresInHours} hours.
          </p>
          <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0;">
            Prefer the dashboard? <a href="${escapeAttr(data.dashboardUrl)}" style="color:#DE322E;text-decoration:none;">Open it here</a>.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          RSN — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const linkedin = data.applicantLinkedinUrl ? `\nLinkedIn: ${data.applicantLinkedinUrl}` : '';
    const reason = data.applicantReason ? `\nWhy RSN: ${data.applicantReason}` : '';
    const text =
      `Hi ${data.adminDisplayName},\n\n` +
      `A new request to join RSN just came in.\n\n` +
      `Name: ${data.applicantName}\nEmail: ${data.applicantEmail}${linkedin}${reason}\n\n` +
      `Approve: ${data.approveUrl}\nDecline: ${data.rejectUrl}\n\n` +
      `Each link opens a confirmation page so nothing happens until you click again. Links expire in ${data.expiresInHours} hours.\n\n` +
      `Prefer the dashboard: ${data.dashboardUrl}\n\nRSN — Fast, focused, and human.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, applicantEmail: data.applicantEmail }, 'No email provider — admin review email skipped');
}

// ─── Poke Received Email (Task F2, 23 Jul 2026) ─────────────────────────────
// The truthful-loop audit found the poke request was in-app-only — a
// logged-out (or just not-currently-online) member never learned someone
// wanted to meet them, which stalled the whole founder test. This mirrors
// sendDmNotificationEmail's shape (offline-notification pattern). Gating
// (recipient's notify_email toggle + the email_config kill-switch) is the
// caller's job (poke.service.ts) — this function only renders and sends.

interface PokeReceivedEmailData {
  senderName: string;
  introMessage: string | null;
  messagesUrl: string;
}

export async function sendPokeReceivedEmail(
  to: string,
  recipientDisplayName: string,
  data: PokeReceivedEmailData,
): Promise<void> {
  const subject = `${data.senderName} wants to meet you on RSN`;
  const introBlock = data.introMessage
    ? `<div style="background:#f8f9fa;border-left:3px solid #DE322E;border-radius:6px;padding:12px 16px;margin:0 0 24px 0;">
         <p style="color:#374151;font-size:14px;line-height:1.5;margin:0;">${escapeHtml(data.introMessage)}</p>
       </div>`
    : '';
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Meeting request</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${recipientDisplayName},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.senderName)}</strong> wants to meet you on RSN.
          </p>
          ${introBlock}
          <div style="text-align:center;margin:24px 0;">
            <a href="${data.messagesUrl}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View Request</a>
          ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
            You're receiving this because someone wants to meet you on RSN.
            You can change your notification preferences in Settings.
          </p>
        </div>
      </div>
    </body></html>`;

  if (config.resendApiKey) {
    const text = `Hey ${recipientDisplayName},\n\n${data.senderName} wants to meet you on RSN.${data.introMessage ? `\n\n"${data.introMessage}"` : ''}\n\nView it: ${data.messagesUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, senderName: data.senderName }, 'No email provider — poke received email skipped');
}

// ─── Poke Accepted Email (Task F2, 23 Jul 2026) ─────────────────────────────
// Mirrors the in-app 'poke_accepted' bell notification (F1) with an email so
// the original sender learns about the acceptance even when offline.

interface PokeAcceptedEmailData {
  accepterName: string;
  messagesUrl: string;
}

export async function sendPokeAcceptedEmail(
  to: string,
  recipientDisplayName: string,
  data: PokeAcceptedEmailData,
): Promise<void> {
  const subject = `${data.accepterName} accepted your meeting request`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Meeting request accepted</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${recipientDisplayName},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.accepterName)}</strong> accepted your meeting request. You're connected — start the conversation.
          </p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${data.messagesUrl}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">Open Conversation</a>
          ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
            You're receiving this because your meeting request was accepted on RSN.
            You can change your notification preferences in Settings.
          </p>
        </div>
      </div>
    </body></html>`;

  if (config.resendApiKey) {
    const text = `Hey ${recipientDisplayName},\n\n${data.accepterName} accepted your meeting request on RSN. You're connected — start the conversation.\n\nOpen conversation: ${data.messagesUrl}\n\nRSN — Connect with Reason`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, accepterName: data.accepterName }, 'No email provider — poke accepted email skipped');
}

// ─── Email Admin Kill-Switch (Task F2, 23 Jul 2026) ─────────────────────────
// `email_config` (migration 020) already backs the admin dashboard's
// per-type enable/disable toggle (routes/admin.ts L542-576), but nothing
// ever actually consulted it before send — the admin switch was decorative.
// Callers that want to honor it (poke.service.ts) check this first.
export async function isEmailTypeEnabled(emailType: string): Promise<boolean> {
  try {
    const result = await query<{ enabled: boolean }>(
      `SELECT enabled FROM email_config WHERE email_type = $1`,
      [emailType],
    );
    // Fail open — an email type with no seeded row yet, or a DB hiccup on
    // this lookup, must never silently block a notification the product
    // wants live.
    return result.rows.length === 0 ? true : result.rows[0].enabled;
  } catch (err) {
    logger.warn({ err, emailType }, 'email_config lookup failed — defaulting to enabled');
    return true;
  }
}

/**
 * 7 Sep 2026: the prepaid Anthropic balance is empty. Sent by
 * llm-balance-alert.ts at most once an hour while Anthropic keeps refusing.
 */
export async function sendLlmBalanceAlertEmail(opts: { to: string; where: string; at: string }): Promise<{ sent: boolean }> {
  const subject = 'RSN: Anthropic balance is empty, onboarding chat and LinkedIn fill are down';
  const text = [
    `At ${opts.at} the Anthropic API refused a call (${opts.where}) with "Your credit balance is too low".`,
    'Until the balance is topped up, the onboarding chat falls back to the plain form, the LinkedIn gap fill and the extras pass return nothing, and every LLM-backed test fails.',
    'Top up at console.anthropic.com under Plans & Billing (50 dollars covers a busy week; switch on auto reload so this does not repeat).',
    'This alert is sent at most once an hour while the failures continue.',
  ].join('\n\n');
  const html = `<p>At <strong>${escapeHtml(opts.at)}</strong> the Anthropic API refused a call (${escapeHtml(opts.where)}) with <em>"Your credit balance is too low"</em>.</p>
<p>Until the balance is topped up, the onboarding chat falls back to the plain form, the LinkedIn gap fill and the extras pass return nothing, and every LLM-backed test fails.</p>
<p>Top up at <a href="https://console.anthropic.com/settings/billing">console.anthropic.com</a> under Plans &amp; Billing (50 dollars covers a busy week; switch on auto reload so this does not repeat).</p>
<p style="color:#666">This alert is sent at most once an hour while the failures continue.</p>`;
  return sendEmail({ to: opts.to, subject, html, text });
}

// ─── Meeting-confirmed email (W6, 7 Sep 2026) ───────────────────────────────
// Sent to BOTH people when a 1:1 meeting time is confirmed. Carries a real .ics
// invite (attendees + RSVP) and an "Add to Google Calendar" link. The time is
// rendered in the RECIPIENT's timezone so each person sees their own local time.
export interface MeetingConfirmedEmailData {
  partnerName: string;
  startAt: Date;
  durationMin: number;
  recipientTimezone?: string | null;
  threadUrl: string;
  googleCalendarUrl: string;
  icsContent: string;
  /** W-meet: the RSN call link + kind, so they can join from the email. */
  joinUrl?: string;
  kind?: 'audio' | 'video';
}

export async function sendMeetingConfirmedEmail(
  to: string,
  recipientDisplayName: string,
  data: MeetingConfirmedEmailData,
): Promise<void> {
  const tz = data.recipientTimezone || undefined;
  const when = data.startAt.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...(tz ? { timeZone: tz } : {}),
  });
  const subject = `Meeting confirmed with ${data.partnerName}`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Meeting confirmed</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Your meeting with <strong>${escapeHtml(data.partnerName)}</strong> is confirmed.
          </p>
          <div style="background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;padding:12px 16px;margin:0 0 20px 0;">
            <p style="color:#166534;font-size:15px;line-height:1.5;margin:0;"><strong>${when}</strong></p>
            <p style="color:#374151;font-size:13px;line-height:1.5;margin:6px 0 0 0;">${data.kind === 'audio' ? 'Audio call' : 'Video call'} · ${data.durationMin} minutes</p>
          </div>
          ${data.joinUrl ? `<div style="text-align:center;margin:20px 0 8px 0;">
            <a href="${data.joinUrl}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">Join the call</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin:0 0 16px 0;">The Join link opens the call on RSN at meeting time.</p>` : ''}
          <div style="text-align:center;margin:12px 0;">
            <a href="${data.googleCalendarUrl}" style="display:inline-block;color:#DE322E;font-size:14px;font-weight:600;text-decoration:none;">Add to Google Calendar</a>
          </div>
          <p style="color:#9ca3af;font-size:13px;text-align:center;margin:0 0 16px 0;">The calendar invite is attached (.ics) — open it to add the meeting to any calendar.</p>
          <div style="text-align:center;margin:8px 0;">
            <a href="${data.threadUrl}" style="color:#DE322E;font-size:14px;">Open the conversation</a>
          </div>
        </div>
      </div>
    </body></html>`;
  const text = `Hey ${recipientDisplayName},\n\nYour meeting with ${data.partnerName} is confirmed.\n\n${when}\nDuration: ${data.durationMin} minutes\n\nAdd to Google Calendar: ${data.googleCalendarUrl}\nOpen the conversation: ${data.threadUrl}\n\n(The .ics invite is attached.)\n\nRSN — Connect with Reason`;

  if (config.resendApiKey) {
    await sendEmail({ to, subject, html, text, attachments: [{ filename: 'meeting.ics', content: data.icsContent, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }] });
    return;
  }
  logger.warn({ to, partnerName: data.partnerName }, 'No email provider — meeting-confirmed email skipped');
}

// HTML-escape helpers for the admin review email. Other templates render
// trusted internal copy; this one renders applicant-supplied free-text
// (name + reason + linkedin URL) into HTML, so we escape every interpolation.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
