// ─── Role-Based Access Control Middleware ────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@rsn/shared';
import { ForbiddenError, UnauthorizedError } from './errors';

/**
 * Requires that req.user exists and has one of the specified roles.
 * Must be used AFTER authenticate middleware.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(new ForbiddenError(`Role '${req.user.role}' does not have access. Required: ${allowedRoles.join(', ')}`));
      return;
    }

    next();
  };
}

/**
 * Requires the user to be the resource owner OR have an admin/host role.
 * The ownerIdExtractor function gets the owner ID from the request.
 */
export function requireOwnerOrRole(
  ownerIdExtractor: (req: Request) => string | undefined,
  ...fallbackRoles: UserRole[]
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const ownerId = ownerIdExtractor(req);

    // If user is the owner, allow
    if (ownerId && req.user.userId === ownerId) {
      next();
      return;
    }

    // If user has a fallback role, allow
    if (fallbackRoles.length > 0 && fallbackRoles.includes(req.user.role)) {
      next();
      return;
    }

    next(new ForbiddenError('You do not have permission to access this resource'));
  };
}
