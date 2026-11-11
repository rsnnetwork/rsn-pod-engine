// ─── Calendar free/busy (Shirley pilot S8, 12 Nov 2026; brief RSN 10; plan decision D7) ───────────────────────────────
//
// Mounted at /api/calendar. While calendar free/busy is off (CALENDAR_SYNC is not 'on', or its key or every provider's
// credentials are missing: services/calendar-sync/settings.ts) EVERY route here answers the same 404 as a route that
// does not exist. GET /api/public/config says whether it is on.
//
//   POST   /connect/:provider               signed in: the start address for this member        calendarConnectLimiter
//   GET    /:provider/start?t=              the browser, on the API's host: nonce cookie, then
//                                           the provider's consent screen (PKCE, sealed state)  calendarOauthLimiter
//   GET    /:provider/callback              the provider sends the browser back here; it goes on
//                                           to the app with a sealed ticket, or with why not    calendarOauthLimiter
//   POST   /connections/:provider/finish    signed in: the code is exchanged, for the member
//                                           who started only, and the grant is kept sealed      calendarFinishLimiter
//   GET    /connections                     the member's connected calendars (never a token)    calendarReadLimiter
//   DELETE /connections/:provider           disconnect (revoked at the provider where it can be) calendarWriteLimiter
//   GET    /busy?from=&to=&tz=              the member's OWN busy times in the range             calendarReadLimiter
//
// Members only: none of these is in GUEST_ROUTES, so an event guest gets 403 from `authenticate` on the signed-in ones
// (the start and the callback do nothing for anyone without a ticket the signed-in finish accepts).
// Connect and disconnect tell the member's other screens (user:<id>:calendars) and are written to the audit log with
// the provider only.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ApiResponse } from '@rsn/shared';
import config from '../config';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { recordAudit } from '../middleware/audit';
import {
  calendarConnectLimiter, calendarFinishLimiter, calendarOauthLimiter, calendarReadLimiter, calendarWriteLimiter,
} from '../middleware/rateLimit';
import { fanoutUserCalendars } from '../realtime/fanout';
import { readCookieValues } from '../services/identity/oauth-browser-binding';
import * as calendar from '../services/calendar-sync/calendar-sync.service';
import { ENVELOPE_LIFETIME_MS } from '../services/calendar-sync/oauth-envelope';
import { calendarSyncState, CALENDAR_PROVIDERS } from '../services/calendar-sync/settings';
import type { CalendarProvider } from '@rsn/shared';

const router = Router();

/** Off means absent: the same 404, word for word, as a route that does not exist. */
router.use((req: Request, res: Response, next: NextFunction) => {
  if (calendarSyncState().enabled) { next(); return; }
  const response: ApiResponse = {
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.baseUrl}${req.path} not found` },
  };
  res.status(404).json(response);
});

// ─── The browser's nonce cookie (the calendar's own, beside the sign-in one) ──
// In production `__Host-` keeps it to this host, Secure, Path=/ (oauth-browser-binding.ts says why); in development the
// API is plain http, where neither applies, and the cookie keeps to the calendar routes.
export const CALENDAR_NONCE_COOKIE_PRODUCTION = '__Host-rsn_cal_nonce';
export const CALENDAR_NONCE_COOKIE_DEVELOPMENT = 'rsn_cal_nonce';
const nonceCookieName = () => (config.isDev ? CALENDAR_NONCE_COOKIE_DEVELOPMENT : CALENDAR_NONCE_COOKIE_PRODUCTION);
const nonceCookieOptions = () => ({
  httpOnly: true,
  secure: !config.isDev,
  sameSite: 'lax' as const,
  path: config.isDev ? '/api/calendar' : '/',
  maxAge: ENVELOPE_LIFETIME_MS,
});

const providerParams = z.object({ provider: z.enum(CALENDAR_PROVIDERS as [CalendarProvider, ...CalendarProvider[]]) });
const connectBody = z.object({ returnTo: z.string().max(300).optional() }).strict();
const finishBody = z.object({ ticket: z.string().min(1).max(4096) }).strict();
const busyQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  tz: z.string().max(64).optional(),
});

const providerOf = (req: Request) => req.params.provider as CalendarProvider;

router.post('/connect/:provider', authenticate, calendarConnectLimiter, validate(providerParams, 'params'), validate(connectBody),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = calendar.beginConnect(req.user!.userId, providerOf(req), req.get('origin') ?? '', req.body.returnTo);
      res.json({ success: true, data: { url } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.get('/:provider/start', calendarOauthLimiter, validate(providerParams, 'params'),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const answer = calendar.startAuthorization(providerOf(req), req.query.t);
      if (answer.kind === 'redirect') res.cookie(nonceCookieName(), answer.nonce, nonceCookieOptions());
      res.redirect(answer.location);
    } catch (err) {
      next(err);
    }
  });

router.get('/:provider/callback', calendarOauthLimiter, validate(providerParams, 'params'),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      // The cookie has done its job whatever happens next: cleared on every outcome, so a callback works once per browser.
      const nonces = readCookieValues(req.headers.cookie, nonceCookieName());
      res.cookie(nonceCookieName(), '', { ...nonceCookieOptions(), maxAge: 0 });
      res.redirect(calendar.callbackLocation(providerOf(req), req.query as calendar.CallbackQuery, nonces));
    } catch (err) {
      next(err);
    }
  });

router.post('/connections/:provider/finish', authenticate, calendarFinishLimiter, validate(providerParams, 'params'), validate(finishBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const provider = providerOf(req);
      const data = await calendar.finishConnect(userId, provider, req.body.ticket);
      res.json({ success: true, data } satisfies ApiResponse);
      void fanoutUserCalendars(userId);
      void recordAudit({ actorId: userId, action: 'calendar.connected', entityType: 'user', entityId: userId, details: { provider }, ipAddress: req.ip });
    } catch (err) {
      next(err);
    }
  });

router.get('/connections', authenticate, calendarReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await calendar.listConnections(req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});

router.delete('/connections/:provider', authenticate, calendarWriteLimiter, validate(providerParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const provider = providerOf(req);
      const data = await calendar.disconnect(userId, provider);
      res.json({ success: true, data } satisfies ApiResponse);
      void fanoutUserCalendars(userId);
      void recordAudit({
        actorId: userId, action: 'calendar.disconnected', entityType: 'user', entityId: userId,
        details: { provider, revokedAtProvider: data.revokedAtProvider }, ipAddress: req.ip,
      });
    } catch (err) {
      next(err);
    }
  });

router.get('/busy', authenticate, calendarReadLimiter, validate(busyQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as z.infer<typeof busyQuery>;
      const data = await calendar.busyFor(req.user!.userId, { from: q.from, to: q.to, zone: q.tz });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
