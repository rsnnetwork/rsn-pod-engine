// ─── Server Configuration ────────────────────────────────────────────────────
import dotenv from 'dotenv';
import path from 'path';

// Load .env from server directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3001',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://rsn_dev:rsn_dev_password@localhost:5432/rsn_dev',
  dbPoolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-not-for-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',

  // Magic Link
  magicLinkSecret: process.env.MAGIC_LINK_SECRET || 'dev-magic-link-secret-not-for-production',
  magicLinkExpiryMinutes: parseInt(process.env.MAGIC_LINK_EXPIRY_MINUTES || '60', 10),

  // Email
  emailProvider: process.env.EMAIL_PROVIDER || 'resend',
  resendApiKey: process.env.RESEND_API_KEY || '',
  smtpHost: process.env.SMTP_HOST || 'smtp.ethereal.email',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  emailFrom: process.env.EMAIL_FROM || 'onboarding@resend.dev',

  // LiveKit
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  livekitUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // Rate Limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',

  // LiveKit (structured)
  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    host: process.env.LIVEKIT_URL || 'ws://localhost:7880',
  },

  // Computed
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
} as const;

export type Config = typeof config;
export default config;
