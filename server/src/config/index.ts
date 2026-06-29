// ─── Server Configuration ────────────────────────────────────────────────────
import dotenv from 'dotenv';
import path from 'path';

// Load .env — Render secret file first, then local server directory
dotenv.config({ path: '/etc/secrets/.env' });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3001',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://rsn_dev:rsn_dev_password@localhost:5432/rsn_dev',
  dbPoolMin: parseInt(process.env.DB_POOL_MIN || '5', 10),
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '25', 10),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-not-for-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '7d',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',

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
  emailFrom: process.env.EMAIL_FROM || 'noreply@rsn.network',

  // LiveKit
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  livekitUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  // Anthropic — onboarding chatbot (REASON intent capture). An empty key means
  // the LLM is disabled and onboarding falls back to the minimal form, so
  // signup is never blocked. Model IDs live here so swapping the model or adding
  // streaming later is a one-line change.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  onboardingChatModel: process.env.ONBOARDING_CHAT_MODEL || 'claude-haiku-4-5',
  onboardingExtractModel: process.env.ONBOARDING_EXTRACT_MODEL || 'claude-haiku-4-5',
  // Profile enrichment — web_search needs Sonnet 4.6+ (validated in e2e/spike-enrich.mjs).
  onboardingEnrichModel: process.env.ONBOARDING_ENRICH_MODEL || 'claude-haiku-4-5',

  // Rate Limiting
  // Now keyed PER USER (see middleware/rateLimit.ts userOrIpKey), so the quota
  // is per-person, not per-NAT. 240/min gives a single client comfortable
  // headroom for a reconnect/refresh burst (token + state + resync rails) while
  // staying far below anything abusive for one authenticated user.
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '240', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',

  // LiveKit (structured)
  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    host: process.env.LIVEKIT_URL || 'ws://localhost:7880',
  },

  // Phase 4 — server-side room eviction (G1). Dark by default; enable per env.
  roomEvictionEnabled: process.env.ROOM_EVICTION_ENABLED === 'true',

  // Phase 5 — emit versioned state:snapshot to clients. Dark by default.
  snapshotEmitEnabled: process.env.SNAPSHOT_EMIT_ENABLED === 'true',

  // Computed
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
} as const;

export type Config = typeof config;
export default config;
