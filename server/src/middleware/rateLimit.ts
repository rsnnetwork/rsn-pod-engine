// ─── Rate Limiting Middleware ─────────────────────────────────────────────────
import rateLimit, { Options as RateLimitOptions } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import logger from '../config/logger';
import { getRedisClient } from '../services/redis/redis.client';
import { ApiResponse } from '@rsn/shared';

/**
 * June-14 — key the global API limiter by AUTHENTICATED USER, not IP.
 *
 * IP keying throttles every attendee behind one NAT as a SINGLE bucket. RSN
 * networking events routinely run with many people on one venue / office / VPN
 * network, so an IP quota punishes a legitimate crowd. It also let ONE stuck
 * client's reconnect retries exhaust the quota for everyone sharing its IP — the
 * amplifier behind "refresh doesn't help" in the stuck-after-round incident (a
 * stranded participant 429'd the /token + /state calls their own recovery
 * needed, and took their neighbours down with them). The limiter runs before
 * `authenticate`, so we DECODE (not verify — keying needs no trust; the request
 * still has to pass auth downstream) the bearer token for its `sub`. Anonymous
 * requests fall back to per-IP, which is the right granularity for them.
 */
function userOrIpKey(req: Request): string {
  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const decoded = jwt.decode(auth.slice(7)) as { sub?: string } | null;
      if (decoded?.sub) return `u:${decoded.sub}`;
    } catch { /* malformed token — fall through to IP */ }
  }
  return `ip:${req.ip}`;
}

/**
 * Tier-1 A7 — optional Redis-backed store factory.
 *
 * Builds a RedisStore when RATE_LIMIT_STORE=redis AND Redis is healthy at
 * request time, else falls back to express-rate-limit's default MemoryStore
 * (current behaviour). This matters once we scale past 1 Render instance:
 * each instance currently has its own in-process counter, so N instances
 * allow N× the stated quota. With Redis-backed counters the quota applies
 * globally.
 *
 * Defaults to in-memory for Tier-1 safety — a misconfigured Redis would
 * otherwise degrade every request in the app. Flip the env to enable once
 * multi-instance rollout is ready.
 */
function buildStore(prefix: string): RateLimitOptions['store'] | undefined {
  if (process.env.RATE_LIMIT_STORE !== 'redis') return undefined;
  // Redis is initialised inside start() AFTER this module evaluates, so we
  // cannot grab the client here. Instead the store resolves Redis at each
  // request via sendCommand. If Redis is unavailable at request time the
  // throw bubbles into express-rate-limit, which fails open — the request
  // proceeds without rate-limit accounting, which is the safer failure
  // mode than blocking every request.
  try {
    return new RedisStore({
      prefix: `rsn:ratelimit:${prefix}:`,
      sendCommand: (...args: string[]) => {
        const redis = getRedisClient();
        if (!redis) throw new Error('Redis unavailable at request time');
        return (redis.call as any)(...args);
      },
    });
  } catch (err) {
    logger.warn({ err, prefix }, 'Failed to initialise Redis rate-limit store — using in-memory');
    return undefined;
  }
}

/**
 * General API rate limiter
 */
export const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('api'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    };
    res.status(429).json(response);
  },
});

/**
 * Strict rate limiter for auth endpoints (magic link, verify)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.env === 'development' ? 100 : 50, // 50 requests per 15 min in production
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // count all requests
  store: buildStore('auth'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts. Please wait 15 minutes before trying again.',
      },
    };
    res.status(429).json(response);
  },
});

/**
 * Invite endpoint rate limiter
 */
export const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,                   // 50 invites per hour
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('invite'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Invite limit reached. Please try again later.',
      },
    };
    res.status(429).json(response);
  },
});
