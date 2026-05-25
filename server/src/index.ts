// ─── RSN Server Entry Point ──────────────────────────────────────────────────
// Express + Socket.IO application with all middleware, routes, and services.

import * as Sentry from '@sentry/node';

// Initialize Sentry BEFORE everything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2, // 20% of transactions for performance monitoring
    beforeSend(event) {
      // Don't send health check noise
      if (event.request?.url?.includes('/health')) return null;
      return event;
    },
  });
}

import express from 'express';
import http from 'http';
import { randomUUID } from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from './config';
import logger from './config/logger';
import { testConnection, closePool, pool } from './db';
import { runMigrations } from './db/migrate';

// Middleware
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimit';
import { isUserActive } from './middleware/auth';

// Services
import { processAutoReminders } from './services/join-request/join-request.service';

// Routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import podRoutes from './routes/pods';
import sessionRoutes from './routes/sessions';
import inviteRoutes from './routes/invites';
import ratingRoutes from './routes/ratings';
import hostRoutes from './routes/host';
import joinRequestRoutes from './routes/join-requests';
import adminRoutes from './routes/admin';
import adminActionRoutes from './routes/admin-actions';
import notificationRoutes from './routes/notifications';
import dmRoutes from './routes/dm';
import pokeRoutes from './routes/pokes';
import reportRoutes from './routes/reports';
import groupRoutes from './routes/groups';
import notificationPrefsRoutes from './routes/notification-prefs';
import { webhooksRouter } from './routes/webhooks';

// Services
import { initOrchestration } from './services/orchestration/orchestration.service';

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// ─── Socket.IO ──────────────────────────────────────────────────────────────

// Tier-1 A6: pin transport to WebSocket by default.
// Long-polling fallback is a foot-gun at scale: corporate proxies that block
// WS silently degrade to ~6 HTTP requests/min per client, which hit the
// global rate limiter and lock users out. Our real users are Vercel +
// LiveKit clients that already require WebSocket, so constraining the
// transport is safe. An env override exists for edge cases (set
// SOCKET_IO_TRANSPORTS=websocket,polling to restore the old behaviour).
// pingTimeout bumped from 30 s to 45 s for mobile tolerance — iOS Safari
// can background a tab for >30 s, triggering churn in the disconnect
// timeout + reassign flow that this value mitigates.
const SOCKET_IO_TRANSPORTS = (process.env.SOCKET_IO_TRANSPORTS?.split(',').map(t => t.trim()).filter(Boolean) as ('websocket' | 'polling')[] | undefined) || ['websocket'];

const io = new SocketServer(server, {
  cors: {
    origin: function(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return callback(null, true);
      const allowedOrigins = [config.clientUrl];
      if (config.isDev) allowedOrigins.push('http://localhost:5173', 'http://localhost:3000');
      // Allow Vercel preview/production domains and rsn.network subdomains
      try {
        const hostname = new URL(origin).hostname;
        if (/\.vercel\.app$/i.test(hostname) || /(\.|^)rsn\.network$/i.test(hostname)) return callback(null, true);
      } catch {}
      callback(null, allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 45_000,
  pingInterval: 10_000,
  transports: SOCKET_IO_TRANSPORTS,
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; email: string; role: string; displayName?: string };

    // Block deactivated users from socket connections. Tier-1 A4: share the
    // 60-second cache with the HTTP auth middleware. Previously this ran a
    // fresh DB SELECT on every handshake — during a lobby surge (200 users
    // reconnecting after a deploy) the pool would saturate and legitimate
    // sockets would see "Invalid token" errors that were actually timeouts.
    const active = await isUserActive(payload.sub);
    if (!active) {
      return next(new Error('Account is deactivated'));
    }

    socket.data.userId = payload.sub;
    socket.data.email = payload.email;
    socket.data.role = payload.role;
    socket.data.displayName = payload.displayName || payload.email;
    next();
  } catch (err) {
    if (err instanceof Error && err.message === 'Account is deactivated') {
      return next(err);
    }
    next(new Error('Invalid token'));
  }
});

// ─── Global Middleware ──────────────────────────────────────────────────────

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    const allowedOrigins = [config.clientUrl];
    if (config.isDev) {
      allowedOrigins.push('http://localhost:5173', 'http://localhost:3000');
    }

    // Allow Vercel preview/production domains and rsn.network subdomains
    try {
      const hostname = new URL(origin).hostname;
      if (/\.vercel\.app$/i.test(hostname) || /(\.|^)rsn\.network$/i.test(hostname)) return callback(null, true);
    } catch {}

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust first proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Expose Socket.IO server to route handlers via app.get('io').
// Standard Express pattern; no module-level state, no circular imports.
// Used by T0-3 GET /api/sessions/:id/state to compute live socket presence.
app.set('io', io);

// Global rate limiter — applies to /api/* only.
// Tier-1 A6: /socket.io/* is deliberately excluded. Long-polling fallback
// emits ~6 HTTP requests/min per client, which with 20+ users behind a
// single NAT gateway would trip the 100/min quota and cause false lockouts.
// Since we now pin transports to WebSocket by default (see above), this
// exemption is belt-and-braces for edge cases where polling is re-enabled.
app.use('/api', apiLimiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = (req.headers['x-request-id'] as string | undefined) || randomUUID();

  res.setHeader('x-request-id', requestId);

  logger.debug(
    {
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
    },
    'Incoming request'
  );

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const payload = {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
    };

    if (res.statusCode >= 500) {
      logger.error(payload, 'Request completed with server error');
      return;
    }

    if (res.statusCode >= 400) {
      logger.warn(payload, 'Request completed with client error');
      return;
    }

    logger.info(payload, 'Request completed');
  });

  next();
});

// ─── Health Check ───────────────────────────────────────────────────────────

// Tier-1 A5: cache the DB-ping result for 30 s so Render's ~10 s health
// probe doesn't run SELECT 1 six times per minute. Render only needs a
// liveness signal; correctness of the cache is enforced by our own error
// handling if the DB ever falls over (we flip to degraded and the next
// check refreshes). /health/deep bypasses the cache for manual diagnostic
// use (e.g. during an outage, don't trust stale "ok").
const HEALTH_CACHE_TTL_MS = 30_000;
let healthCache: { result: { ok: boolean; latencyMs: number }; cachedAt: number } | null = null;

async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - dbStart };
  } catch {
    return { ok: false, latencyMs: Date.now() - dbStart };
  }
}

app.get('/health', async (_req, res) => {
  const now = Date.now();
  if (!healthCache || now - healthCache.cachedAt >= HEALTH_CACHE_TTL_MS) {
    const result = await pingDatabase();
    healthCache = { result, cachedAt: now };
  }
  const { ok, latencyMs } = healthCache.result;
  if (!ok) {
    logger.warn('Health check reporting degraded — DB unreachable (cached)');
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      db: { connected: false, latencyMs, cached: true },
    });
    return;
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.env,
    db: { connected: true, latencyMs, cached: now - healthCache.cachedAt > 0 },
  });
});

/**
 * Deep health probe — bypasses the 30 s cache. Use when diagnosing an
 * incident and you need an authoritative read of DB reachability. Do NOT
 * wire this into Render's healthCheckPath (it would defeat the cache).
 */
app.get('/health/deep', async (_req, res) => {
  try {
    const { ok, latencyMs } = await pingDatabase();
    // Refresh the shared cache with the fresh result so subsequent /health
    // calls see the current truth, not the old cached value.
    healthCache = { result: { ok, latencyMs }, cachedAt: Date.now() };
    if (!ok) {
      res.status(503).json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        db: { connected: false, latencyMs, cached: false },
      });
      return;
    }
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: config.env,
      db: { connected: true, latencyMs, cached: false },
    });
  } catch (err) {
    logger.error({ err }, 'Deep health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── API Routes ─────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/sessions', hostRoutes); // Host controls under /api/sessions/:id/host/*
app.use('/api/join-requests', joinRequestRoutes);
app.use('/api/admin', adminRoutes);
// Admin email-action routes — unauthenticated by design (the token IS the auth).
app.use('/api/admin/join-request-action', adminActionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dm', dmRoutes);
app.use('/api/pokes', pokeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/notification-prefs', notificationPrefsRoutes);
// Phase 4 — LiveKit webhook receiver (raw body; must come before error handlers).
// express.json() only processes application/json so application/webhook+json is
// still raw when this per-route raw() middleware runs.
app.use('/api/webhooks', webhooksRouter);

// ─── Error Handling ─────────────────────────────────────────────────────────

// Sentry captures errors before our handler processes them
Sentry.setupExpressErrorHandler(app);

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Server ───────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    // Test database connection
    const dbReady = await testConnection();
    if (!dbReady) {
      logger.fatal('Database connection failed — aborting startup');
      process.exit(1);
    }

    // Run migrations (safe in production — skips already-applied ones)
    await runMigrations();

    // Initialize Redis (optional — system runs without it)
    const { initRedis, duplicateClient } = await import('./services/redis/redis.client');
    const redisClient = await initRedis();
    if (redisClient) {
      try {
        const { createAdapter } = await import('@socket.io/redis-adapter');
        const pubClient = duplicateClient();
        const subClient = duplicateClient();
        if (pubClient && subClient) {
          io.adapter(createAdapter(pubClient, subClient));
          logger.info('Socket.IO Redis adapter enabled — multi-instance broadcasting ready');
        }
      } catch (err) {
        logger.warn({ err }, 'Socket.IO Redis adapter failed — using in-memory adapter');
      }
    }

    // Initialise orchestration with Socket.IO
    initOrchestration(io);

    // Start auto-reminder engine for join requests (runs every 6 hours)
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      processAutoReminders().catch(err =>
        logger.error({ err }, 'Auto-reminder cycle failed')
      );
    }, SIX_HOURS);
    // Run once on startup (after a short delay to let migrations settle)
    setTimeout(() => {
      processAutoReminders().catch(err =>
        logger.error({ err }, 'Initial auto-reminder cycle failed')
      );
    }, 30_000);

    // Start listening
    server.listen(config.port, () => {
      logger.info(
        { port: config.port, env: config.env },
        `RSN server running at http://localhost:${config.port}`
      );
    });
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');

  // Close Socket.IO connections
  io.close(() => {
    logger.info('Socket.IO connections closed');
  });

  // Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close database pool
  await closePool();

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

// ─── Start ──────────────────────────────────────────────────────────────────

start();

export { app, server, io };
