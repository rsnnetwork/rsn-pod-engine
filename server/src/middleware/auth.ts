// ─── JWT Authentication Middleware ───────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { UnauthorizedError } from './errors';
import { JwtPayload, UserRole } from '@rsn/shared';
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

/**
 * Extracts and verifies JWT from Authorization header.
 * Sets req.user on success.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;

    req.user = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role as UserRole,
      sessionId: payload.sessionId,
    };

    next();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
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
