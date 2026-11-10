// ─── Email Service ───────────────────────────────────────────────────────────
// Handles sending emails via Resend (production) or console logging (dev).

import { Resend } from 'resend';
import { v4 as uuid } from 'uuid';
import config from '../../config';
import logger from '../../config/logger';
import { generateIcsContent, eventCalendarEntry } from '../calendar/calendar.service';
import { meetingTime } from '../meetings/meeting-time';
import { query } from '../../db';
import { isReservedTestAddress, maskAddress } from '../identity/reserved-address';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SIGN_IN_CODE_TTL_MINUTES } from '../identity/sign-in-code';

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
// Every email opens on the brand band with the logo and a red accent strip,
// inside a bordered card, and closes on a link back to the app. The words of
// each email are untouched; only the shell is shared.
//
// 22 Sep 2026 (Shradha): the mark was a white silhouette on a navy band. The
// brand mark is the BLACK sheep, which cannot be read on navy, so the band went
// light and carried one lockup image rather than an image plus a text wordmark,
// which also stops the two drifting apart.
//
// 21 Oct 2026 (the client, 19 Oct: "the whole email header should be white" and
// "call it REASON everywhere"): the band is white and the lockup is the REASON
// one, reason-logo.png (1056 by 228, so 160 by 35 here). The old rsn-logo.png
// stays on the client's site because emails already delivered still point at it.
// The red strip and the bordered card are unchanged.
export function emailCardOpen(): string {
  return [
    `<div style="background:#ffffff;border-radius:16px;border:1px solid #dfe3ea;overflow:hidden;box-shadow:0 10px 30px rgba(26,26,46,0.08);">`,
    `<div style="background:#ffffff;padding:28px 32px 22px 32px;text-align:center;">`,
    `<img src="${config.clientUrl}/reason-logo.png" alt="REASON" width="160" height="35" style="display:block;margin:0 auto;" />`,
    `<p style="color:#6b7280;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:14px 0 0 0;">Connect with Reason</p>`,
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

/** A burst of emails refused for the day's quota is logged once: the first as an error, the rest within this at debug. */
const DAILY_QUOTA_NOTICE_MS = 60_000;
let dailyQuotaNoticedAt = 0;

/** The provider's "daily sending quota used up" refusal (429 `daily_quota_exceeded`), which no retry can get past. */
function isDailyQuotaRefusal(error: unknown): boolean {
  const e = error as { statusCode?: unknown; name?: unknown; message?: unknown } | null;
  return !!e && e.statusCode === 429 && /daily_quota/i.test(`${String(e.name ?? '')} ${String(e.message ?? '')}`);
}

/** Tests only: the next daily-quota refusal is logged as an error again. */
export function __resetDailyQuotaNoticeForTests(): void {
  dailyQuotaNoticedAt = 0;
}

/**
 * What sendEmail answers. `sent` is true for an email the provider took, and also for one to an address reserved for
 * testing, which is never offered to the provider and says so in `skipped`.
 */
export interface SendEmailResult {
  sent: boolean;
  skipped?: 'reserved-test-address';
}

// Centralized email sender with deliverability best-practices headers.
//
// It is also the one place that decides whether an email is offered to the provider at all (26 Oct 2026). That day the
// production account's daily sending quota ran out at 06:51 UTC and every email after it, real members' sign-in links
// and meeting confirmations included, was refused. The platform's own end-to-end runs and production smokes had used
// it up: their throwaway members sit on addresses reserved for testing (…@rsn-e2e.invalid, …@example.com) and every
// email to them went to the provider. Nobody has a mailbox on a domain that RFC 2606 and RFC 6761 reserve, so the
// provider is not asked. The answer is the one a delivered email gets, marked `skipped`: a reminder keeps its hour, a
// batch counts the email as sent and nothing is tried again. The provider's own test sink (delivered+label@resend.dev)
// is an address like any other here and goes as before. A call to the provider from anywhere else would get round this;
// email-provider-single-door.test.ts fails if one appears.

// ─── One pace for every email (H2b item 7, 26 Oct 2026) ──────────────────────────────────────────────────────
// The provider takes two sends a second. Every email — a bulk invite, Remind all's one-at-a-time sends, a job's
// burst, a member's single email — reaches it through one process-wide gate that releases a provider call every
// SEND_GAP_MS at most, retries included. A burst runs its sends inside asBulkEmail(); a single email is released ahead
// of the burst waiting behind the gate, so the answer to a member's press waits for one slot at most, never for the
// burst. A waiter is released in its turn whatever became of the one before, so nothing is lost.
export const SEND_GAP_MS = 500;
export interface SendPace { now(): number; pause(ms: number): Promise<void> }
// A clock that only goes forward: the wall clock set back (an NTP step) would hold every email for the size of the step.
const REAL_SEND_PACE: SendPace = { now: () => performance.now(), pause: (ms) => new Promise((r) => setTimeout(r, ms)) };
let sendPace: SendPace = REAL_SEND_PACE;
let lastReleaseAt = Number.NEGATIVE_INFINITY;
const waitingToSend: Array<{ release: () => void; bulk: boolean }> = [];
let releasing = false;
const bulkLane = new AsyncLocalStorage<boolean>();

/** Runs `send` with every email it sends in the bulk lane: behind any single email waiting its turn. */
export function asBulkEmail<T>(send: () => Promise<T>): Promise<T> {
  return bulkLane.run(true, send);
}

/** Resolves when this email may be offered to the provider: single emails go in ahead of the bulk lane. */
function awaitSendTurn(bulk: boolean): Promise<void> {
  return new Promise<void>((release) => {
    const waiter = { release, bulk };
    const firstBulk = bulk ? -1 : waitingToSend.findIndex((w) => w.bulk);
    if (firstBulk === -1) waitingToSend.push(waiter);
    else waitingToSend.splice(firstBulk, 0, waiter);
    void releaseInTurn();
  });
}

async function releaseInTurn(): Promise<void> {
  if (releasing) return;
  releasing = true;
  try {
    while (waitingToSend.length > 0) {
      const wait = lastReleaseAt + SEND_GAP_MS - sendPace.now();
      if (wait > 0) await sendPace.pause(wait);
      lastReleaseAt = sendPace.now();
      waitingToSend.shift()?.release();
    }
  } finally {
    releasing = false;
  }
}

/** Tests run the gate on a clock of their own; `null` puts the real one back. Either way the queue starts empty. */
export function __setSendPaceForTests(pace: SendPace | null): void {
  sendPace = pace ?? REAL_SEND_PACE;
  lastReleaseAt = Number.NEGATIVE_INFINITY;
  waitingToSend.length = 0;
  releasing = false;
}

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
}): Promise<SendEmailResult> {
  if (!config.resendApiKey) {
    logger.warn({ to: opts.to, subject: opts.subject }, 'No email provider — email skipped');
    return { sent: false };
  }

  if (isReservedTestAddress(opts.to)) {
    logger.debug({ subject: opts.subject, to: maskAddress(opts.to) }, 'email to a reserved test address not sent');
    return { sent: true, skipped: 'reserved-test-address' };
  }

  const senderName = 'REASON';
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
    await awaitSendTurn(bulkLane.getStore() === true);
    const { error } = await client.emails.send(emailPayload);

    if (!error) {
      if (attempt > 0) logger.warn({ to: opts.to, attempt }, `Email sent after ${attempt} retries: ${opts.subject}`);
      else logger.info({ to: opts.to }, `Email sent: ${opts.subject}`);
      return { sent: true };
    }

    // The day's sending quota is used up (H2b item 8b, 26 Oct 2026): nothing goes until it resets, so this is not
    // tried again (it used to be, three more times and seven seconds per email), and a burst of refused emails is
    // logged as an error once, the rest at debug.
    if (isDailyQuotaRefusal(error)) {
      const now = Date.now();
      if (now - dailyQuotaNoticedAt > DAILY_QUOTA_NOTICE_MS) {
        dailyQuotaNoticedAt = now;
        logger.error({ error, to: opts.to }, `The mail provider's daily quota is used up; emails are not sent until it resets: ${opts.subject}`);
      } else {
        logger.debug({ to: opts.to }, `Not sent: the mail provider's daily quota is used up: ${opts.subject}`);
      }
      return { sent: false };
    }

    const statusCode = (error as any).statusCode;
    const isRetryable = statusCode === 429 || statusCode === 500 || statusCode === 503;

    if (!isRetryable || attempt === MAX_RETRIES) {
      logger.error({ error, to: opts.to, attempts: attempt + 1 }, `Failed to send email: ${opts.subject}`);
      return { sent: false };
    }

    // Exponential backoff: 1s, 2s, 4s
    await sendPace.pause(1000 * Math.pow(2, attempt));
  }

  return { sent: false };
}

// 1 Nov 2026 (30 Oct review: Stefan expected a password): the email says no password is needed, and carries the
// 6-digit code from services/identity/sign-in-code.ts, large, for a member who reads it on another device or in a
// mail app's own browser and types it on the waiting screen instead.
function signInCodeHtml(code: string): string {
  return `
          <div style="text-align:center;margin:28px 0 8px 0;">
            <p style="color:#64748b;font-size:14px;line-height:1.5;margin:0 0 10px 0;">Or type this code on the sign-in page:</p>
            <p data-sign-in-code style="display:inline-block;color:#1a1a2e;background:#f4f5f7;border:1px solid #dfe3ea;border-radius:12px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:8px;padding:14px 18px 14px 26px;margin:0;">${escapeHtml(code)}</p>
            <p style="color:#64748b;font-size:13px;line-height:1.5;margin:10px 0 0 0;">The code works for ${SIGN_IN_CODE_TTL_MINUTES} minutes.</p>
          </div>`;
}

export async function sendMagicLinkEmail(
  to: string,
  magicLinkUrl: string,
  code?: string
): Promise<void> {
  const subject = 'Sign in to REASON';
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
            No password needed. Click the button below to sign in to your account. This link expires in ${config.magicLinkExpiryMinutes} minutes.
          </p>
          
          <div style="text-align:center;margin:32px 0;">
            <a href="${escapeAttr(magicLinkUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In
            </a>
          </div>
          ${code ? signInCodeHtml(code) : ''}
          
          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#DE322E;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
            ${escapeHtml(magicLinkUrl)}
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
    const codeText = code
      ? `\n\nOr type this code on the sign-in page: ${code}\nThe code works for ${SIGN_IN_CODE_TTL_MINUTES} minutes.`
      : '';
    const text = `Sign in to REASON\n\nNo password needed. Click the link below to sign in to your account. This link expires in ${config.magicLinkExpiryMinutes} minutes.\n\n${magicLinkUrl}${codeText}\n\nIf you didn't request this email, you can safely ignore it.`;
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
  const subject = `Your REASON Recap — ${data.sessionTitle}`;
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
            Hey ${escapeHtml(displayName)},
          </p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thanks for joining <strong>${escapeHtml(data.sessionTitle)}</strong>! Here's your event recap:
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
            <a href="${escapeAttr(data.recapUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Full Recap
            </a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Meet people you have a reason to know.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hey ${displayName},\n\nThanks for joining ${data.sessionTitle}! Here's your event recap:\n\nMutual Matches: ${data.peopleMet}\nWant to Meet Again: ${data.mutualConnections}\nAvg Rating: ${data.avgRating.toFixed(1)}\n\nView Full Recap: ${data.recapUrl}\n\nREASON — Meet people you have a reason to know.`;
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
  const subject = `${data.senderName} sent you a message on REASON`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">New message</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.senderName)}</strong> sent you a message on REASON.
          </p>
          <div style="background:#f8f9fa;border-left:3px solid #DE322E;border-radius:6px;padding:12px 16px;margin:0 0 24px 0;">
            <p style="color:#374151;font-size:14px;line-height:1.5;margin:0;">${escapeHtml(data.snippet)}</p>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="${escapeAttr(data.threadUrl)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View Message</a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          You're receiving this because someone messaged you on REASON.
          You can change your notification preferences in Settings.
        </p>
      </div>
    </body></html>`;

  if (config.resendApiKey) {
    const text = `Hey ${recipientDisplayName},\n\n${data.senderName} sent you a message on REASON:\n\n"${data.snippet}"\n\nView the conversation: ${data.threadUrl}\n\nREASON — Meet people you have a reason to know.`;
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
            Hey ${escapeHtml(displayName)},
          </p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Here's the full recap for <strong>${escapeHtml(data.sessionTitle)}</strong>:
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
            <a href="${escapeAttr(data.recapUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Full Recap
            </a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Meet people you have a reason to know.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const matchesLine = data.matchesCreated != null
      ? `Matches Created / Successful: ${data.matchesCreated} / ${data.totalMatches}`
      : `Matches: ${data.totalMatches}`;
    const text = `Hey ${displayName},\n\nHere's the full recap for ${data.sessionTitle}:\n\nParticipants: ${data.totalParticipants}\nRounds: ${data.totalRounds}\n${matchesLine}\nAvg Rating: ${data.avgEventRating > 0 ? data.avgEventRating.toFixed(1) : 'N/A'}\nMutual Connections: ${data.mutualConnectionsCount}\n\nView Full Recap: ${data.recapUrl}\n\nREASON — Meet people you have a reason to know.`;
    await sendEmail({ to, subject, html, text });
    return;
  }

  logger.warn({ to, sessionTitle: data.sessionTitle }, 'No email provider — host recap email skipped');
}

// ─── An in-person event's place, in an event email (30 Oct 2026) ───────────────────────────────

/**
 * The lines an in-person event's invite and registration emails add: "In person, at {place}." and its Google
 * Calendar and Outlook.com links, which carry the place. Empty for an event online, whose emails are unchanged.
 */
function inPersonLines(calendarEvent: InviteEmailData['calendarEvent']): { html: string; text: string } {
  if (!calendarEvent?.place) return { html: '', text: '' };
  const { links } = eventCalendarEntry(calendarEvent, config.clientUrl);
  const linkStyle = 'display:inline-block;color:#DE322E;font-size:14px;font-weight:600;text-decoration:none;';
  const html = `<p data-place style="color:#1a1a2e;font-size:15px;line-height:1.6;margin:0 0 16px 0;text-align:center;">In person, at <strong>${escapeHtml(calendarEvent.place)}</strong>.</p>`
    + (links
      ? `<p style="text-align:center;margin:0 0 16px 0;"><a href="${escapeAttr(links.google)}" style="${linkStyle}">Add to Google Calendar</a>`
        + ` &nbsp;·&nbsp; <a href="${escapeAttr(links.outlook)}" style="${linkStyle}">Add to Outlook.com</a></p>`
      : '');
  const text = `In person, at ${calendarEvent.place}.`
    + (links ? `\nAdd to Google Calendar: ${links.google}\nAdd to Outlook.com: ${links.outlook}` : '');
  return { html, text };
}

/** The emailed .ics of an event: an in-person event's place as LOCATION, else the event's page as before. */
function eventIcs(calendarEvent: NonNullable<InviteEmailData['calendarEvent']>): string {
  const entry = eventCalendarEntry(calendarEvent, config.clientUrl);
  return generateIcsContent({
    title: calendarEvent.title,
    description: entry.description,
    startTime: calendarEvent.startTime,
    durationMinutes: calendarEvent.durationMinutes,
    organizerName: calendarEvent.organizerName,
    organizerEmail: calendarEvent.organizerEmail,
    location: entry.location,
  });
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
    /** Where an in-person event happens (30 Oct 2026); absent for an event online. */
    place?: string;
  };
}

/**
 * 13 Aug 2026: "New user has no idea what RSN is when landing after clicking
 * an invite link." Claus preferred fixing this in the email rather than
 * building an on-platform explainer, so the invite now says what REASON is
 * and what happens next, in plain prose, before it asks anyone to join.
 * A pure builder, so the copy is testable without an email provider.
 * 21 Oct 2026 (the client, 19 Oct: "call it REASON everywhere"): the subject,
 * the opening and the description say REASON; the tagline stays as it is.
 */
export function buildInviteEmail(data: InviteEmailData): { subject: string; html: string; text: string } {
  const typeLabel = data.type === 'pod' ? 'a pod' : data.type === 'session' ? 'an event' : data.type === 'circle' ? 'a circle' : 'the platform';
  const targetLine = data.targetName ? ` — <strong>${escapeHtml(data.targetName)}</strong>` : '';
  const targetText = data.targetName ? ` — ${data.targetName}` : '';

  const subject = `${data.inviterName} invited you to ${data.targetName || 'REASON'}`;

  const openingHtml = data.type === 'platform'
    ? `<strong>${escapeHtml(data.inviterName)}</strong> invited you to REASON.`
    : `<strong>${escapeHtml(data.inviterName)}</strong> has invited you to join ${typeLabel}${targetLine} on REASON.`;
  const openingText = data.type === 'platform'
    ? `${data.inviterName} invited you to REASON.`
    : `${data.inviterName} has invited you to join ${typeLabel}${targetText} on REASON.`;

  const whatItIs =
    'REASON is a private network where people meet for a stated reason rather than by browsing profiles. ' +
    'You say who you are looking for, and it keeps looking, including as new people join.';
  // A pod or event invite may reach someone who is already a member, so only a
  // platform invite promises them the sign-up conversation.
  const whatHappensNext = data.type === 'platform'
    ? 'Joining takes a few minutes: a short conversation about who you want to meet, and you are in.'
    : '';
  const place = inPersonLines(data.calendarEvent);

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
          ${place.html}

          <div style="text-align:center;margin:32px 0;">
            <a href="${escapeAttr(data.inviteUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Accept Invite
            </a>
          </div>

          <p style="color:#64748b;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#DE322E;font-size:12px;word-break:break-all;margin:8px 0 0 0;">
            ${escapeHtml(data.inviteUrl)}
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Meet people you have a reason to know.
        </p>
      </div>
    </body>
    </html>
  `;

  const text = [openingText, '', whatItIs, whatHappensNext, ...(place.text ? ['', place.text] : []), '', `Accept Invite: ${data.inviteUrl}`, '', 'REASON — Meet people you have a reason to know.']
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');

  return { subject, html, text };
}

/**
 * Sends an invite email and says whether it went. The mail provider answers a refusal (a bad address, its rate limit
 * after the retries, an outage, the network) rather than throwing, so `sent` is false for those, and with no provider
 * configured nothing goes either (26 Oct 2026: a reminder keeps an invite's hour only for an email that went). An
 * address reserved for testing is not offered to the provider and counts as sent (see sendEmail).
 */
export async function sendInviteEmail(
  to: string,
  data: InviteEmailData
): Promise<SendEmailResult> {
  const { subject, html, text } = buildInviteEmail(data);

  if (config.resendApiKey) {
    const attachments: { filename: string; content: string }[] = [];

    // Attach .ics calendar invite for session invites with scheduled time
    if (data.calendarEvent) {
      const icsContent = eventIcs(data.calendarEvent);
      attachments.push({ filename: 'event.ics', content: icsContent });
    }

    return sendEmail({ to, subject, html, text, attachments: attachments.length > 0 ? attachments : undefined });
  }

  logger.warn({ to, type: data.type }, 'No email provider — invite email skipped');
  return { sent: false };
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
    /** Where an in-person event happens (30 Oct 2026); absent for an event online. */
    place?: string;
  };
}

export async function sendSessionRegistrationConfirmationEmail(
  to: string,
  data: RegistrationConfirmationData,
): Promise<void> {
  const greetingName = data.recipientName ? ` ${escapeHtml(data.recipientName)}` : '';
  const whenLine = data.calendarEvent
    ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px 0;text-align:center;">${escapeHtml(data.calendarEvent.startTime.toUTCString())}</p>`
    : '';
  const calendarNote = data.calendarEvent
    ? `<p style="color:#64748b;font-size:13px;line-height:1.5;margin:20px 0 0 0;text-align:center;">A calendar invite is attached — add it to get a reminder 15 minutes before.</p>`
    : '';
  const place = inPersonLines(data.calendarEvent);
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
            You're all set for <strong>${escapeHtml(data.sessionTitle)}</strong>.
          </p>
          ${whenLine}
          ${place.html}
          <div style="text-align:center;margin:32px 0;">
            <a href="${escapeAttr(data.sessionUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              View Event
            </a>
          </div>
          ${calendarNote}
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Meet people you have a reason to know.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const placeText = place.text ? `\n\n${place.text}` : '';
    const text = `You're registered for ${data.sessionTitle}.${data.calendarEvent ? ' A calendar invite is attached.' : ''}${placeText}\n\nView event: ${data.sessionUrl}\n\nREASON — Meet people you have a reason to know.`;
    const attachments: { filename: string; content: string }[] = [];

    if (data.calendarEvent) {
      const icsContent = eventIcs(data.calendarEvent);
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
  const subject = 'REASON — We received your request';
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
            Hi ${escapeHtml(fullName)},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for requesting to join REASON. We've received your application and our team will review it shortly.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            REASON is an invite-only community for professionals of every kind, from founders to employees, investors and advisors, who value honesty over hype. We review every application carefully to maintain the quality of our community.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 0 0;">
            You'll hear from us within 1-3 business days.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\nThank you for requesting to join REASON. We've received your application and our team will review it shortly.\n\nREASON is an invite-only community for professionals of every kind, from founders to employees, investors and advisors, who value honesty over hype. We review every application carefully to maintain the quality of our community.\n\nYou'll hear from us within 1-3 business days.\n\nREASON — Fast, focused, and human.`;
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
  const subject = 'Welcome to REASON — You\'re in!';
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
            Hi ${escapeHtml(fullName)},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Great news — your request to join REASON has been <strong style="color:#1a1a2e;">approved</strong>!
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            You're now part of a community of professionals of every kind, from founders to employees, investors and advisors, who connect with honesty and purpose. No pitching. No selling. Just real conversations.
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${escapeAttr(loginUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Sign In to REASON
            </a>
          </div>

          <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">
            Your first step: sign up for an event and meet five people in focused 8-minute conversations.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\nGreat news — your request to join REASON has been approved!\n\nYou're now part of a community of professionals of every kind, from founders to employees, investors and advisors, who connect with honesty and purpose. No pitching. No selling. Just real conversations.\n\nSign In to REASON: ${loginUrl}\n\nYour first step: sign up for an event and meet five people in focused 8-minute conversations.\n\nREASON — Fast, focused, and human.`;
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
  const subject = 'REASON — Update on your request';
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
            Hi ${escapeHtml(fullName)},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for your interest in REASON. After reviewing your application, we're unable to offer access at this time.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            REASON is a curated community, and we carefully consider each application. This decision is based on our current community composition and needs.
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 0 0;">
            If your circumstances change or you receive an invite from a current member, you're welcome to reapply.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\nThank you for your interest in REASON. After reviewing your application, we're unable to offer access at this time.\n\nREASON is a curated community, and we carefully consider each application. This decision is based on our current community composition and needs.\n\nIf your circumstances change or you receive an invite from a current member, you're welcome to reapply.\n\nREASON — Fast, focused, and human.`;
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
    ? 'REASON — Your spot is still waiting'
    : 'REASON — Don\'t forget to complete your signup!';

  const mainMessage = isSecondReminder
    ? 'We noticed you haven\'t completed your signup yet. Your approved spot at REASON is still reserved — but it won\'t last forever.'
    : 'You were approved to join REASON! We\'d love to see you at our next event. Complete your signup in under a minute.';

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
            Hi ${escapeHtml(fullName)},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            ${mainMessage}
          </p>

          <div style="text-align:center;margin:32px 0;">
            <a href="${escapeAttr(loginUrl)}"
               style="display:inline-block;background:#DE322E;border:1px solid #c22a26;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 40px;border-radius:10px;">
              Complete Your Signup
            </a>
          </div>

          <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">
            Once you're in, join an event and meet five people in focused 8-minute conversations. No pitching. No selling. Just real talk.
          </p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${fullName},\n\n${mainMessage}\n\nComplete Your Signup: ${loginUrl}\n\nOnce you're in, join an event and meet five people in focused 8-minute conversations. No pitching. No selling. Just real talk.\n\nREASON — Fast, focused, and human.`;
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
            Hi ${escapeHtml(recipientName)},
          </p>
          <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 0 0;white-space:pre-wrap;">${escapeHtml(data.body)}</p>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          REASON — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const text = `Hi ${recipientName},\n\n${data.body}\n\nREASON — Fast, focused, and human.`;
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
  const subject = `New REASON join request — ${data.applicantName}`;
  const reasonBlock = data.applicantReason
    ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">Why REASON</td>
         <td style="padding:8px 0;color:#374151;font-size:14px;line-height:1.5;">${escapeHtml(data.applicantReason)}</td></tr>`
    : '';
  // LinkedIn is optional on the join form. With no address the row stays and says so,
  // plainly and without a link, so the admin can tell "not given" from "not shown".
  const linkedinUrl = data.applicantLinkedinUrl?.trim();
  const linkedinBlock = linkedinUrl
    ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">LinkedIn</td>
         <td style="padding:8px 0;font-size:14px;word-break:break-all;"><a href="${escapeAttr(linkedinUrl)}" style="color:#DE322E;text-decoration:none;">${escapeHtml(linkedinUrl)}</a></td></tr>`
    : `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">LinkedIn</td>
         <td style="padding:8px 0;color:#6b7280;font-size:14px;">Not given</td></tr>`;
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
            A new request to join REASON just came in. You can approve or decline below — no need to open the dashboard.
          </p>

          <div style="background:#f8f9fa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin:0 0 28px 0;">
            <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:90px;">Name</td>
                  <td style="padding:8px 0;color:#1a1a2e;font-size:15px;font-weight:600;">${escapeHtml(data.applicantName)}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Email</td>
                  <td style="padding:8px 0;color:#374151;font-size:14px;word-break:break-all;">${escapeHtml(data.applicantEmail)}</td></tr>
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
          REASON — Fast, focused, and human.
        </p>
      </div>
    </body>
    </html>
  `;

  if (config.resendApiKey) {
    const linkedin = `\nLinkedIn: ${linkedinUrl || 'Not given'}`;
    const reason = data.applicantReason ? `\nWhy REASON: ${data.applicantReason}` : '';
    const text =
      `Hi ${data.adminDisplayName},\n\n` +
      `A new request to join REASON just came in.\n\n` +
      `Name: ${data.applicantName}\nEmail: ${data.applicantEmail}${linkedin}${reason}\n\n` +
      `Approve: ${data.approveUrl}\nDecline: ${data.rejectUrl}\n\n` +
      `Each link opens a confirmation page so nothing happens until you click again. Links expire in ${data.expiresInHours} hours.\n\n` +
      `Prefer the dashboard: ${data.dashboardUrl}\n\nREASON — Fast, focused, and human.`;
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
  /** What the member wrote, if anything. */
  note: string | null;
  /** REASON's own line on why it suggested the two, if it has one (30 Oct 2026). */
  reasonLine: string | null;
  messagesUrl: string;
}

export async function sendPokeReceivedEmail(
  to: string,
  recipientDisplayName: string,
  data: PokeReceivedEmailData,
): Promise<void> {
  const subject = `${data.senderName} wants to meet you on REASON`;
  // 30 Oct 2026 (Stefan: "It looks like the sender wrote it"): the quote holds only what the
  // member wrote, and REASON's line is its own plain paragraph under its own heading, outside
  // the quote. HTML collapses a raw line break to a space, so the breaks in the note become
  // <br>, and only AFTER escaping: a <br> the sender typed is then shown as text instead of
  // being run.
  const introBlock = data.note
    ? `<div style="background:#f8f9fa;border-left:3px solid #DE322E;border-radius:6px;padding:12px 16px;margin:0 0 24px 0;">
         <p style="color:#374151;font-size:14px;line-height:1.5;margin:0;">${escapeHtml(data.note).replace(/\r?\n/g, '<br>')}</p>
       </div>`
    : '';
  const reasonBlock = data.reasonLine
    ? `<p style="color:#6b7280;font-size:12px;font-weight:600;line-height:1.5;margin:0 0 4px 0;">Why REASON suggested this</p>
       <p style="color:#374151;font-size:14px;line-height:1.5;margin:0 0 24px 0;">${escapeHtml(data.reasonLine)}</p>`
    : '';
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Meeting request</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.senderName)}</strong> wants to meet you on REASON.
          </p>
          ${introBlock}
          ${reasonBlock}
          <div style="text-align:center;margin:24px 0;">
            <a href="${escapeAttr(data.messagesUrl)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View Request</a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          You're receiving this because someone wants to meet you on REASON.
          You can change your notification preferences in Settings.
        </p>
      </div>
    </body></html>`;

  if (config.resendApiKey) {
    const text = `Hey ${recipientDisplayName},\n\n${data.senderName} wants to meet you on REASON.${data.note ? `\n\n"${data.note}"` : ''}${data.reasonLine ? `\n\nWhy REASON suggested this\n${data.reasonLine}` : ''}\n\nView it: ${data.messagesUrl}\n\nREASON — Meet people you have a reason to know.`;
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
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.accepterName)}</strong> accepted your meeting request. You're connected — start the conversation.
          </p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${escapeAttr(data.messagesUrl)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">Open Conversation</a>
          </div>
        ${emailCardClose()}
        <p style="color:#6b7280;font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0 0;">
          You're receiving this because your meeting request was accepted on REASON.
          You can change your notification preferences in Settings.
        </p>
      </div>
    </body></html>`;

  if (config.resendApiKey) {
    const text = `Hey ${recipientDisplayName},\n\n${data.accepterName} accepted your meeting request on REASON. You're connected — start the conversation.\n\nOpen conversation: ${data.messagesUrl}\n\nREASON — Meet people you have a reason to know.`;
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
export async function sendLlmBalanceAlertEmail(opts: { to: string; where: string; at: string }): Promise<SendEmailResult> {
  const subject = 'REASON: Anthropic balance is empty, onboarding chat and LinkedIn fill are down';
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
  /** 1 Nov 2026 (T7, L10): "Add to Outlook.com", beside the Google link. */
  outlookCalendarUrl?: string;
  icsContent: string;
  /** W-meet: the REASON call link + kind, so they can join from the email. */
  joinUrl?: string;
  kind?: 'audio' | 'video';
  /** 26 Oct 2026: "See it in Events", where every meeting is listed. */
  eventsUrl?: string;
  /** The meeting moved to this time from another (the subject and first line say so). */
  moved?: boolean;
}

export async function sendMeetingConfirmedEmail(
  to: string,
  recipientDisplayName: string,
  data: MeetingConfirmedEmailData,
): Promise<void> {
  // 26 Oct 2026: the time goes in the subject, in the recipient's own zone, with the zone named.
  const t = meetingTime(data.startAt, data.recipientTimezone);
  const when = `${t.long} (${t.zone})`;
  const heading = data.moved ? 'Meeting moved' : 'Meeting confirmed';
  const subject = `${heading}: ${data.partnerName} on ${t.short} (${t.zone})`;
  const firstLine = data.moved ? 'has moved.' : 'is confirmed.';
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">${heading}</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Your meeting with <strong>${escapeHtml(data.partnerName)}</strong> ${firstLine}
          </p>
          <div style="background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;padding:12px 16px;margin:0 0 20px 0;">
            <p style="color:#166534;font-size:15px;line-height:1.5;margin:0;"><strong>${escapeHtml(when)}</strong></p>
            <p style="color:#374151;font-size:13px;line-height:1.5;margin:6px 0 0 0;">${data.kind === 'audio' ? 'Audio call' : 'Video call'} · ${data.durationMin} minutes</p>
          </div>
          ${data.joinUrl ? `<div style="text-align:center;margin:20px 0 8px 0;">
            <a href="${escapeAttr(data.joinUrl)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">Join the call</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin:0 0 16px 0;">The Join link opens the call on REASON at meeting time.</p>` : ''}
          <div style="text-align:center;margin:12px 0;">
            <a href="${escapeAttr(data.googleCalendarUrl)}" style="display:inline-block;color:#DE322E;font-size:14px;font-weight:600;text-decoration:none;">Add to Google Calendar</a>
          </div>
          ${data.outlookCalendarUrl ? `<div style="text-align:center;margin:12px 0;">
            <a href="${escapeAttr(data.outlookCalendarUrl)}" style="display:inline-block;color:#DE322E;font-size:14px;font-weight:600;text-decoration:none;">Add to Outlook.com</a>
          </div>` : ''}
          <p style="color:#9ca3af;font-size:13px;text-align:center;margin:0 0 16px 0;">The calendar invite is attached (.ics) — open it to add the meeting to any calendar.</p>
          ${data.eventsUrl ? `<div style="text-align:center;margin:8px 0;">
            <a href="${escapeAttr(data.eventsUrl)}" style="color:#DE322E;font-size:14px;font-weight:600;">See it in Events</a>
          </div>` : ''}
          <div style="text-align:center;margin:8px 0;">
            <a href="${escapeAttr(data.threadUrl)}" style="color:#DE322E;font-size:14px;">Open the conversation</a>
          </div>
        ${emailCardClose()}
      </div>
    </body></html>`;
  const eventsLine = data.eventsUrl ? `See it in Events: ${data.eventsUrl}\n` : '';
  const outlookLine = data.outlookCalendarUrl ? `Add to Outlook.com: ${data.outlookCalendarUrl}\n` : '';
  const text = `Hey ${recipientDisplayName},\n\nYour meeting with ${data.partnerName} ${firstLine}\n\n${when}\nDuration: ${data.durationMin} minutes\n\nAdd to Google Calendar: ${data.googleCalendarUrl}\n${outlookLine}${eventsLine}Open the conversation: ${data.threadUrl}\n\n(The .ics invite is attached.)\n\nREASON — Meet people you have a reason to know.`;

  if (config.resendApiKey) {
    await sendEmail({ to, subject, html, text, attachments: [{ filename: 'meeting.ics', content: data.icsContent, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }] });
    return;
  }
  logger.warn({ to, partnerName: data.partnerName }, 'No email provider — meeting-confirmed email skipped');
}

// ─── Meeting-cancelled email (26 Oct 2026) ──────────────────────────────────
// Sent to BOTH people when either cancels. The attached calendar file is a METHOD:CANCEL with the
// meeting's own UID and the next SEQUENCE, so the entry the confirmation added leaves every calendar.
// Like the confirmation, it is not held back by notify_email or email_config: the confirmation always
// put the entry in the calendar, so the cancellation must always be able to take it out.
export interface MeetingCancelledEmailData {
  /** The other person. */
  partnerName: string;
  /** Who cancelled: the recipient themselves, or the other person. */
  cancellerName: string;
  cancelledByMe: boolean;
  startAt: Date;
  durationMin: number;
  kind: 'audio' | 'video';
  recipientTimezone?: string | null;
  threadUrl: string;
  icsContent: string;
}

export async function sendMeetingCancelledEmail(
  to: string,
  recipientDisplayName: string,
  data: MeetingCancelledEmailData,
): Promise<void> {
  const t = meetingTime(data.startAt, data.recipientTimezone);
  const when = `${t.long} (${t.zone})`;
  const subject = `Meeting cancelled: ${data.partnerName} on ${t.short} (${t.zone})`;
  const whoHtml = data.cancelledByMe
    ? `You cancelled your meeting with <strong>${escapeHtml(data.partnerName)}</strong>.`
    : `<strong>${escapeHtml(data.cancellerName)}</strong> cancelled your meeting.`;
  const whoText = data.cancelledByMe
    ? `You cancelled your meeting with ${data.partnerName}.`
    : `${data.cancellerName} cancelled your meeting.`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Meeting cancelled</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">${whoHtml}</p>
          <div style="background:#f8f9fa;border-left:3px solid #9ca3af;border-radius:6px;padding:12px 16px;margin:0 0 20px 0;">
            <p style="color:#374151;font-size:15px;line-height:1.5;margin:0;"><strong>${escapeHtml(when)}</strong></p>
            <p style="color:#6b7280;font-size:13px;line-height:1.5;margin:6px 0 0 0;">${data.kind === 'audio' ? 'Audio call' : 'Video call'} · ${data.durationMin} minutes</p>
          </div>
          <p style="color:#9ca3af;font-size:13px;text-align:center;margin:0 0 16px 0;">The attached calendar file (.ics) removes the meeting from your calendar.</p>
          <div style="text-align:center;margin:8px 0;">
            <a href="${escapeAttr(data.threadUrl)}" style="color:#DE322E;font-size:14px;font-weight:600;">Open the conversation</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin:0;">You can pick a new time there.</p>
        ${emailCardClose()}
      </div>
    </body></html>`;
  const text = `Hey ${recipientDisplayName},\n\n${whoText}\n\n${when}\n${data.kind === 'audio' ? 'Audio call' : 'Video call'} · ${data.durationMin} minutes\n\nOpen the conversation to pick a new time: ${data.threadUrl}\n\n(The attached .ics file removes the meeting from your calendar.)\n\nREASON — Meet people you have a reason to know.`;

  if (config.resendApiKey) {
    await sendEmail({ to, subject, html, text, attachments: [{ filename: 'meeting.ics', content: data.icsContent, contentType: 'text/calendar; charset=utf-8; method=CANCEL' }] });
    return;
  }
  logger.warn({ to, partnerName: data.partnerName }, 'No email provider — meeting-cancelled email skipped');
}

// ─── Meeting-reminder email (26 Oct 2026) ───────────────────────────────────
// Sent to each person 10 minutes before a meeting by meeting-reminder.worker.ts, which checks the
// recipient's notify_email switch and the admin email_config switch first. This only renders and sends.
export interface MeetingReminderEmailData {
  partnerName: string;
  startAt: Date;
  durationMin: number;
  kind: 'audio' | 'video';
  recipientTimezone?: string | null;
  /** 10 when the reminder goes out on time; fewer when it is late (the server was restarting). */
  minutesToGo: number;
  joinUrl: string;
  eventsUrl: string;
}

export async function sendMeetingReminderEmail(
  to: string,
  recipientDisplayName: string,
  data: MeetingReminderEmailData,
): Promise<void> {
  const t = meetingTime(data.startAt, data.recipientTimezone);
  const when = `${t.long} (${t.zone})`;
  const subject = `Your meeting with ${data.partnerName} starts in ${data.minutesToGo === 1 ? '1 minute' : `${data.minutesToGo} minutes`}`;
  const callLine = `${data.kind === 'audio' ? 'Audio call' : 'Video call'} · ${data.durationMin} minutes`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Meeting reminder</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 8px 0;">Hey ${escapeHtml(recipientDisplayName)},</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">${escapeHtml(subject)}.</p>
          <div style="background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;padding:12px 16px;margin:0 0 20px 0;">
            <p style="color:#166534;font-size:15px;line-height:1.5;margin:0;"><strong>${escapeHtml(when)}</strong></p>
            <p style="color:#374151;font-size:13px;line-height:1.5;margin:6px 0 0 0;">${callLine}</p>
          </div>
          <div style="text-align:center;margin:20px 0 8px 0;">
            <a href="${escapeAttr(data.joinUrl)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">Join the call</a>
          </div>
          <div style="text-align:center;margin:12px 0 0 0;">
            <a href="${escapeAttr(data.eventsUrl)}" style="color:#DE322E;font-size:14px;">See it in Events</a>
          </div>
        ${emailCardClose()}
      </div>
    </body></html>`;
  const text = `Hey ${recipientDisplayName},\n\n${subject}.\n\n${when}\n${callLine}\n\nJoin the call: ${data.joinUrl}\nSee it in Events: ${data.eventsUrl}\n\nREASON — Meet people you have a reason to know.`;

  if (config.resendApiKey) {
    await sendEmail({ to, subject, html, text });
    return;
  }
  logger.warn({ to, partnerName: data.partnerName }, 'No email provider — meeting-reminder email skipped');
}

// ─── Event-cancelled email (Part 2 foundation, Task 2) ──────────────────────
// Sent by event-lifecycle.service.ts to each person who held a place (and each co-host) when an event is cancelled,
// only while their notify_email is on and the admin switch for 'event_cancelled' is on (email_config, seeded on by
// migration 135). This only renders and sends; `when` is already in the recipient's own zone.
export interface EventCancelledEmailData {
  eventTitle: string;
  /** Who cancelled it, as the email names them. */
  hostName: string;
  /** The event's planned start, in the recipient's own zone and named ("Tuesday 17 November, 14:00 (CET)"). */
  when: string;
  /** The organiser's own words, when they gave any. */
  reason: string | null;
  /** The event's page. */
  link: string;
}

export async function sendEventCancelledEmail(to: string, data: EventCancelledEmailData): Promise<SendEmailResult> {
  const subject = `Cancelled: ${data.eventTitle}`;
  const line = `${data.hostName} cancelled ${data.eventTitle}, planned for ${data.when}.`;
  const reasonHtml = data.reason
    ? `<div style="background:#f8f9fa;border-left:3px solid #9ca3af;border-radius:6px;padding:12px 16px;margin:0 0 20px 0;">
            <p style="color:#374151;font-size:15px;line-height:1.5;margin:0;white-space:pre-line;">${escapeHtml(data.reason)}</p>
          </div>`
    : '';
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Event cancelled</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.hostName)}</strong> cancelled <strong>${escapeHtml(data.eventTitle)}</strong>, planned for ${escapeHtml(data.when)}.
          </p>
          ${reasonHtml}
          <div style="text-align:center;margin:8px 0;">
            <a href="${escapeAttr(data.link)}" style="color:#DE322E;font-size:14px;font-weight:600;">See the event</a>
          </div>
        ${emailCardClose()}
      </div>
    </body></html>`;
  const text = `${line}\n\n${data.reason ? `${data.reason}\n\n` : ''}See the event: ${data.link}\n\nREASON — Meet people you have a reason to know.`;
  return sendEmail({ to, subject, html, text });
}

// ─── Event reminder and time-change emails (Part 2 foundation, Task 10) ─────
// Sent by the event reminder worker (24 hours and 1 hour before) and by notifyEventRescheduled (event-notices.ts), only
// while the person's notify_email is on and the admin switch for 'event_reminder' / 'event_rescheduled' is on
// (email_config, seeded on by migration 135), and only while EVENT_COMMS is 'on'. These only render and send; every
// time is already written for the recipient ("in 1 hour", "tomorrow at 18:00", or a full day and zone).
export interface EventReminderEmailData {
  eventTitle: string;
  /** How soon it starts, as the recipient reads it ("in 1 hour", "tomorrow at 18:00"). */
  when: string;
  /** The event's page. */
  link: string;
}

export async function sendEventReminderEmail(to: string, data: EventReminderEmailData): Promise<SendEmailResult> {
  const subject = `Reminder: ${data.eventTitle} starts ${data.when}`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">Event reminder</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 20px 0;">
            <strong>${escapeHtml(data.eventTitle)}</strong> starts ${escapeHtml(data.when)}.
          </p>
          <div style="text-align:center;margin:20px 0 8px 0;">
            <a href="${escapeAttr(data.link)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">Open the event</a>
          </div>
        ${emailCardClose()}
      </div>
    </body></html>`;
  const text = `${data.eventTitle} starts ${data.when}.

Open the event: ${data.link}

REASON — Meet people you have a reason to know.`;
  return sendEmail({ to, subject, html, text });
}

export interface EventRescheduledEmailData {
  eventTitle: string;
  /** Where it was, in the recipient's own zone and named ("Tuesday 17 November, 14:00 (CET)"). */
  previousWhen: string;
  /** Where it is now, written the same way. */
  when: string;
  /** The event's page. */
  link: string;
}

export async function sendEventRescheduledEmail(to: string, data: EventRescheduledEmailData): Promise<SendEmailResult> {
  const subject = `New time: ${data.eventTitle}`;
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
        ${emailCardOpen()}
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;text-align:center;">New time</p>
          <p style="color:#1a1a2e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${escapeHtml(data.eventTitle)}</strong> has moved.
          </p>
          <div style="background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;padding:12px 16px;margin:0 0 12px 0;">
            <p style="color:#166534;font-size:15px;line-height:1.5;margin:0;"><strong>Now: ${escapeHtml(data.when)}</strong></p>
          </div>
          <p style="color:#6b7280;font-size:14px;line-height:1.5;margin:0 0 20px 0;">It was ${escapeHtml(data.previousWhen)}.</p>
          <div style="text-align:center;margin:20px 0 8px 0;">
            <a href="${escapeAttr(data.link)}" style="display:inline-block;background:#DE322E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">Open the event</a>
          </div>
        ${emailCardClose()}
      </div>
    </body></html>`;
  const text = `${data.eventTitle} has moved.

Now: ${data.when}
It was ${data.previousWhen}.

Open the event: ${data.link}

REASON — Meet people you have a reason to know.`;
  return sendEmail({ to, subject, html, text });
}

// Every value an email puts into its HTML goes through one of these (21 Oct 2026). Names, event, pod and
// circle names, messages and notes are typed by people, and the request to join needs no account at all,
// so anything left as it was typed would let a stranger put their own link or picture into an email sent
// from REASON. The links the server builds go through escapeAttr too: its & is written &amp;, which every
// mail client reads back as &. Subjects and plain-text copies are not HTML and are never escaped.
// String() so a value a caller typed loosely shows as it always did instead of throwing.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
