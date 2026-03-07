// ─── RSN Server Entry Point ──────────────────────────────────────────────────
// Express + Socket.IO application with all middleware, routes, and services.

import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from './config';
import logger from './config/logger';
import { testConnection, closePool } from './db';
import { runMigrations } from './db/migrate';

// Middleware
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimit';

// Routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import podRoutes from './routes/pods';
import sessionRoutes from './routes/sessions';
import inviteRoutes from './routes/invites';
import ratingRoutes from './routes/ratings';
import hostRoutes from './routes/host';

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
      // Allow Vercel preview/production domains
      try {
        const isVercelOrigin = /\.vercel\.app$/i.test(new URL(origin).hostname);
        if (isVercelOrigin) return callback(null, true);
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
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; email: string; role: string; displayName?: string };
    socket.data.userId = payload.sub;
    socket.data.email = payload.email;
    socket.data.role = payload.role;
    socket.data.displayName = payload.displayName || payload.email;
    next();
  } catch (err) {
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

    // Allow Vercel preview/production domains during no-card deployment setup.
    try {
      const isVercelOrigin = /\.vercel\.app$/i.test(new URL(origin).hostname);
      if (isVercelOrigin) return callback(null, true);
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
app.use((req, _res, next) => {
  logger.debug({ method: req.method, url: req.url }, 'Incoming request');
  next();
});

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.env,
    version: process.env.npm_package_version || '0.1.0',
  });
});

// ─── API Routes ─────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/sessions', hostRoutes); // Host controls under /api/sessions/:id/host/*

// ─── Error Handling ─────────────────────────────────────────────────────────

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

    // Initialise orchestration with Socket.IO
    initOrchestration(io);

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
