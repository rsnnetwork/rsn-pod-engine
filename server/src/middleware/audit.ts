// ─── Audit Logging Middleware ─────────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import { query } from '../db';
import logger from '../config/logger';

interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Records an audit log entry for host/admin actions.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId,
        JSON.stringify(entry.details || {}),
        entry.ipAddress || null,
      ]
    );
  } catch (err) {
    logger.error({ err, entry }, 'Failed to record audit log');
  }
}

/**
 * Middleware that auto-records audit for specific route patterns (host/admin actions).
 */
export function auditMiddleware(action: string, entityType: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Hook into response finish to log after success
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const entityId = (req.params.id || req.params.sessionId || null) as string | null;
        recordAudit({
          actorId: req.user?.userId || null,
          action,
          entityType,
          entityId,
          details: { method: req.method, path: req.path },
          ipAddress: req.ip,
        }).catch(() => {}); // fire-and-forget
      }
      return originalJson(body);
    };
    next();
  };
}
