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
import { testConnection, closePool, query as dbQuery, pool } from './db';
import { runMigrations } from './db/migrate';

// Middleware
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimit';

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
import notificationRoutes from './routes/notifications';

// Services
import { initOrchestration } from './services/orchestration/orchestration.service';

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// ─── Socket.IO ──────────────────────────────────────────────────────────────

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
  pingTimeout: 30_000,
  pingInterval: 10_000,
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; email: string; role: string; displayName?: string };

    // Block deactivated users from socket connections
    const userResult = await dbQuery<{ status: string }>(
      'SELECT status FROM users WHERE id = $1', [payload.sub]
    );
    if (userResult.rows.length === 0 || userResult.rows[0].status !== 'active') {
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

// Global rate limiter
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

app.get('/health', async (_req, res) => {
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    const dbLatency = Date.now() - dbStart;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: config.env,
      db: { connected: true, latencyMs: dbLatency },
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed — DB unreachable');
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      db: { connected: false },
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
app.use('/api/notifications', notificationRoutes);

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
