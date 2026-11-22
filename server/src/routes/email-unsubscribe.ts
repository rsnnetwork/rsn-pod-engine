// ─── One-click unsubscribe from the weekly email (22 Nov 2026) ───────────────────────────────────────────────
//
// The weekly "Your week on REASON" carries a signed link (notification-digest.service.ts, mintUnsubscribeToken) in its
// footer and in its List-Unsubscribe header, with List-Unsubscribe-Post (RFC 8058), so a mail app can offer its own
// Unsubscribe button.
//   GET  /api/email/unsubscribe/weekly?token=…  a small page with one button; opening the link changes nothing, so a
//                                               mail scanner that follows links cannot unsubscribe anyone
//   POST /api/email/unsubscribe/weekly?token=…  turns the member's "Weekly digest" off (the page's button, or the mail
//                                               app's one-click POST) and tells their open Settings
// Signed out by design: the token is the proof, it names one member, does one thing and expires. Rate limited per
// address. Anything wrong with the token gets the same calm page.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { emailUnsubscribeLimiter } from '../middleware/rateLimit';
import { readUnsubscribeToken } from '../services/notification-email/notification-digest.service';
import * as prefsService from '../services/notification-prefs/notification-prefs.service';
import { emitEntities, getRealtimeIo } from '../realtime/emit';
import { E } from '../realtime/entities';
import config from '../config';
import logger from '../config/logger';

const router = Router();

const tokenQuery = z.object({ token: z.string().min(1).max(2000) });

const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The page every answer is: a heading, a line, and either the button or a way into Settings. */
export function unsubscribePage(opts: { title: string; line: string; formAction?: string }): string {
  const action = opts.formAction
    ? `<form method="post" action="${escapeHtml(opts.formAction)}"><button type="submit" style="min-height:48px;width:100%;background:#DE322E;color:#fff;border:0;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;">Stop the weekly email</button></form>`
    : `<a href="${escapeHtml(`${config.clientUrl}/settings`)}" style="display:block;min-height:48px;line-height:48px;text-align:center;background:#DE322E;color:#fff;border-radius:10px;font-size:16px;font-weight:600;text-decoration:none;">Open email settings</a>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:max(24px, env(safe-area-inset-top)) 16px 24px 16px;background:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<main style="max-width:420px;margin:40px auto;background:#fff;border:1px solid #dfe3ea;border-radius:16px;padding:28px 24px;">
<p style="margin:0 0 4px 0;color:#6b7280;font-size:12px;letter-spacing:2px;text-transform:uppercase;">REASON</p>
<h1 style="margin:0 0 12px 0;color:#1a1a2e;font-size:22px;line-height:1.3;">${escapeHtml(opts.title)}</h1>
<p style="margin:0 0 24px 0;color:#374151;font-size:16px;line-height:1.6;">${escapeHtml(opts.line)}</p>
${action}
</main></body></html>`;
}

const LINK_NOT_VALID = {
  title: 'This link has expired',
  line: 'You can switch the weekly email off in your email settings on REASON.',
};

router.get(
  '/unsubscribe/weekly',
  emailUnsubscribeLimiter,
  validate(tokenQuery, 'query'),
  (req: Request, res: Response) => {
    const token = String(req.query.token);
    res.type('html');
    if (!readUnsubscribeToken(token)) {
      res.status(400).send(unsubscribePage(LINK_NOT_VALID));
      return;
    }
    res.send(unsubscribePage({
      title: 'Stop the weekly email?',
      line: 'You will no longer get "Your week on REASON" on Monday mornings. Your other emails stay as they are.',
      formAction: `${config.apiBaseUrl}/api/email/unsubscribe/weekly?token=${encodeURIComponent(token)}`,
    }));
  },
);

router.post(
  '/unsubscribe/weekly',
  emailUnsubscribeLimiter,
  validate(tokenQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = readUnsubscribeToken(String(req.query.token));
      res.type('html');
      if (!userId) {
        res.status(400).send(unsubscribePage(LINK_NOT_VALID));
        return;
      }
      await prefsService.updatePrefs(userId, { weekly_digest: false });
      res.send(unsubscribePage({
        title: 'Done',
        line: 'You will no longer get the weekly email. You can turn it back on any time in your email settings.',
      }));
      emitEntities(getRealtimeIo(), [userId], [E.userNotificationPrefs(userId)])
        .catch((err) => logger.warn({ err, userId }, 'unsubscribe entity emit failed (non-fatal)'));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
