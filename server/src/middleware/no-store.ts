import type { Request, Response, NextFunction } from 'express';

/**
 * API answers are not to be kept: every one of them is live state. Without a Cache-Control header a browser is free
 * to answer from its cache on its own terms, and WebKit did, for a state read made while stepping back through the
 * tab's history (21 Oct 2026): a member who had just saved an answer was shown the state from before the save, so the
 * tour that was due did not open. A route that sets its own Cache-Control afterwards (a profile photo, a banner)
 * keeps it: the header is set here, before the route runs.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
