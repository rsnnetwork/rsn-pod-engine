// ─── JWT Authentication Middleware ───────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { UnauthorizedError } from './errors';
import { JwtPayload, UserRole } from '@rsn/shared';
import { query } from '../db';
import logger from '../config/logger';

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
        role: UserRole;
        sessionId: string;
      };
    }
  }
}

// ── User status cache ──
// At 200+ concurrent users, we don't want a DB query per request.
// Cache active status for 60s — deactivation takes effect within 1 minute.
const statusCache = new Map<string, { status: string; cachedAt: number }>();
const STATUS_CACHE_TTL_MS = 60_000;

/**
 * Check whether a user is active, with a 60-second in-process cache.
 *
 * Exported for reuse by the Socket.IO auth middleware (Tier-1 A4) so both
 * the HTTP and WebSocket layers share the same cache — previously the
 * socket handshake hit the DB on every connect, saturating the pool during
 * lobby-surge reconnects (200 users reconnecting in ~5 s after a deploy).
 */
export async function isUserActive(userId: string): Promise<boolean> {
  const cached = statusCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < STATUS_CACHE_TTL_MS) {
    return cached.status === 'active';
  }

  try {
    const result = await query<{ status: string }>(
      'SELECT status FROM users WHERE id = $1',
      [userId]
    );
    const status = result.rows[0]?.status || 'inactive';
    // Prevent unbounded cache growth — evict oldest entries if cache exceeds 5000
    if (statusCache.size > 5000) {
      const firstKey = statusCache.keys().next().value;
      if (firstKey) statusCache.delete(firstKey);
    }
    statusCache.set(userId, { status, cachedAt: Date.now() });
    return status === 'active';
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to check user status — allowing request');
    return true; // Fail open on DB errors to avoid blocking all users
  }
}

/**
 * Extracts and verifies JWT from Authorization header.
 * Sets req.user on success. Blocks deactivated users.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  (async () => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedError('Missing or invalid authorization header');
      }

      const token = authHeader.substring(7);
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;

      // Check user is still active (cached, <1ms for repeat calls)
      const active = await isUserActive(payload.sub);
      if (!active) {
        throw new UnauthorizedError('Account is deactivated');
      }

      req.user = {
        userId: payload.sub,
        email: payload.email,
        role: payload.role as UserRole,
        sessionId: payload.sessionId,
      };

      next();
    } catch (err: any) {
      if (err instanceof UnauthorizedError || err?.statusCode === 401) {
        next(err);
        return;
      }

      if (err instanceof jwt.TokenExpiredError) {
        next(new UnauthorizedError('Token expired'));
        return;
      }

      if (err instanceof jwt.JsonWebTokenError) {
        next(new UnauthorizedError('Invalid token'));
        return;
      }

      logger.error({ err }, 'Authentication error');
      next(new UnauthorizedError('Authentication failed'));
    }
  })();
}

/**
 * Optional auth — sets req.user if token present, but doesn't fail if missing.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }

    const token = authHeader.substring(7);
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;

    req.user = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role as UserRole,
      sessionId: payload.sessionId,
    };
  } catch {
    // Token invalid — proceed without user
  }

  next();
}

/**
 * Invalidate cached status for a user (call on deactivation/reactivation).
 */
export function invalidateUserStatusCache(userId: string): void {
  statusCache.delete(userId);
}

// ── Test-only helpers ──
// Internal exports used by auth-cache.test.ts — do not call from app code.
export const __test__ = {
  hasCached(userId: string): boolean {
    return statusCache.has(userId);
  },
  getCached(userId: string): { status: string; cachedAt: number } | undefined {
    return statusCache.get(userId);
  },
  clearAll(): void {
    statusCache.clear();
  },
  isUserActive,
};
