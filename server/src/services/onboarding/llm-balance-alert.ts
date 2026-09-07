// ─── Anthropic low-balance alert (7 Sep 2026) ────────────────────────────────
//
// The production Anthropic key is PREPAID. When it runs dry every LLM feature
// (onboarding chat, the LinkedIn gap fill, the extras pass) fails at once with
// "Your credit balance is too low to access the Anthropic API", the routes
// answer 503 LLM_DISABLED and members land on the plain form. It happened on
// 2 Jul, 3 Sep and 7 Sep 2026 and was found each time by a red test run or by
// Ali, hours later. This module notices the exact error on ANY Anthropic call
// and emails the team, at most once an hour while it keeps failing.
//
// Both Anthropic clients (chatbot.service, enrichment.service) are wrapped
// with `withBalanceAlert`, so no call site has to remember to report.

import config from '../../config';
import logger from '../../config/logger';

const LOW_BALANCE = /credit balance is too low/i;
const ALERT_EVERY_MS = 60 * 60 * 1000;
/** When the alert email itself could not be sent, try again sooner. */
const RETRY_AFTER_FAILED_SEND_MS = 5 * 60 * 1000;

let nextAlertAt = 0;

/** The SDK wraps the API body in `error.error.message`; the Error message
 *  carries the status and the JSON body as text. Look in both. */
export function isLowBalanceError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: unknown; error?: { message?: unknown; error?: { message?: unknown } } };
  const texts = [e.message, e.error?.message, e.error?.error?.message, String(err)];
  return texts.some((t) => typeof t === 'string' && LOW_BALANCE.test(t));
}

/** Recipients: LLM_BALANCE_ALERT_TO (comma-separated), default dev@rsn.network. */
export function alertRecipients(): string[] {
  return String(config.llmBalanceAlertTo || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Report an Anthropic failure. Returns true when this failure triggered an
 * alert email (at most once an hour). Never throws: the caller is already on
 * its own error path.
 */
export function noteLlmError(err: unknown, where: string): boolean {
  if (!isLowBalanceError(err)) return false;
  const now = Date.now();
  if (now < nextAlertAt) {
    logger.warn({ where }, 'Anthropic credit balance is empty — team already alerted this hour');
    return false;
  }
  nextAlertAt = now + ALERT_EVERY_MS;
  logger.error({ where }, 'Anthropic credit balance is empty — every LLM feature is down until it is topped up');
  const at = new Date(now).toISOString();
  const to = alertRecipients();
  if (!to.length) return true;
  void (async () => {
    try {
      const { sendLlmBalanceAlertEmail } = await import('../email/email.service');
      const results = await Promise.all(to.map((rcpt) => sendLlmBalanceAlertEmail({ to: rcpt, where, at })));
      if (!results.some((r) => r.sent)) nextAlertAt = now + RETRY_AFTER_FAILED_SEND_MS;
    } catch (e) {
      logger.warn({ err: e }, 'low-balance alert email failed — will retry in five minutes');
      nextAlertAt = now + RETRY_AFTER_FAILED_SEND_MS;
    }
  })();
  return true;
}

function describeCall(req: unknown): string {
  const r = (req || {}) as { model?: unknown; tools?: unknown };
  const model = typeof r.model === 'string' ? r.model : 'unknown model';
  return Array.isArray(r.tools) && r.tools.length ? `${model} with web search` : model;
}

/** Wrap an Anthropic client so every failed `messages.create` is reported. */
export function withBalanceAlert<T extends { messages: { create: (...args: any[]) => any } }>(client: T): T {
  const messages = client.messages as { create: (...args: any[]) => any };
  const original = messages.create.bind(messages);
  messages.create = async (...args: any[]) => {
    try {
      return await original(...args);
    } catch (err) {
      noteLlmError(err, describeCall(args[0]));
      throw err;
    }
  };
  return client;
}

/** Tests only. */
export function _resetBalanceAlertForTests(): void {
  nextAlertAt = 0;
}
