// ─── Redis Client ────────────────────────────────────────────────────────────
// Optional Redis connection for session state persistence and Socket.IO scaling.
// If Redis is unavailable, the system runs in-memory only (current behavior).
// No crash, no downtime — Redis is strictly additive.

import Redis from 'ioredis';
import config from '../../config';
import logger from '../../config/logger';

let redisClient: Redis | null = null;
let redisAvailable = false;

export function getRedisClient(): Redis | null {
  return redisAvailable ? redisClient : null;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export async function initRedis(): Promise<Redis | null> {
  const url = config.redisUrl;

  // Skip if no Redis URL configured or using default localhost (dev without Redis)
  if (!url || url === 'redis://localhost:6379') {
    logger.info('Redis URL not configured — running without Redis (in-memory only)');
    return null;
  }

  try {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) return null; // Stop retrying after 10 attempts
        return Math.min(times * 200, 5000); // 200ms, 400ms, 600ms ... up to 5s
      },
      lazyConnect: true,
      tls: url.startsWith('rediss://') ? {} : undefined, // Enable TLS for rediss:// URLs (Upstash)
    });

    redisClient.on('connect', () => {
      redisAvailable = true;
      logger.info('Redis connected');
    });

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis error — system continues with in-memory state');
      redisAvailable = false;
    });

    redisClient.on('close', () => {
      redisAvailable = false;
      logger.warn('Redis connection closed — system continues with in-memory state');
    });

    redisClient.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });

    await redisClient.connect();
    redisAvailable = true;

    // Quick health check
    await redisClient.ping();
    logger.info('Redis initialized and healthy');

    return redisClient;
  } catch (err) {
    logger.warn({ err }, 'Redis initialization failed — running without Redis (in-memory only)');
    redisClient = null;
    redisAvailable = false;
    return null;
  }
}

/**
 * Create a duplicate Redis connection (needed for Socket.IO pub/sub adapter).
 * Returns null if Redis is not available.
 */
export function duplicateClient(): Redis | null {
  if (!redisClient || !redisAvailable) return null;
  try {
    const dup = redisClient.duplicate();
    dup.on('error', (err) => {
      logger.error({ err }, 'Redis duplicate client error');
    });
    return dup;
  } catch {
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch { /* ignore */ }
    redisClient = null;
    redisAvailable = false;
    logger.info('Redis connection closed');
  }
}
