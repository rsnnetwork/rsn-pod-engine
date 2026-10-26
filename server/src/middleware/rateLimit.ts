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
 * needed, and took their neighbours down with them). Anonymous requests fall
 * back to per-IP, which is the right granularity for them.
 *
 * TRF-2 (audit C3) — the bucket key MUST come from a jwt.VERIFY, not a decode.
 * Keying off an unverified `sub` IS a trust decision: a forged token lets an
 * attacker either mint unlimited fresh buckets (forge a random sub per request
 * → bypass the limiter entirely) or set sub=<victim> to exhaust that victim's
 * bucket and lock them out. Verifying the HS256 signature is microseconds and
 * `authenticate` re-verifies downstream anyway. Any verify failure (forged,
 * expired, malformed) falls through to the per-IP bucket — fail-safe.
 */
/**
 * The real client IP. 7 Sep 2026: behind Cloudflare → Render, `req.ip` (with
 * `trust proxy 1`) resolves to Render's proxy hop, so every request from the
 * whole internet arrives tagged with a handful of Cloudflare EDGE IPs — one
 * shared rate-limit bucket for unrelated people, and the reason logs showed
 * 162.158.* / 172.70.* instead of members. Cloudflare puts the true client IP
 * in `cf-connecting-ip`; prefer it, then Akamai-style `true-client-ip`, then
 * `req.ip`. A spoofed header only ever gives the sender their OWN unique bucket
 * (never lets them drain a victim's), same fail-safe posture as the JWT path.
 */
export function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;
  const tci = req.headers['true-client-ip'];
  if (typeof tci === 'string' && tci.length > 0) return tci;
  return req.ip ?? 'unknown';
}

export function userOrIpKey(req: Request): string {
  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), config.jwtSecret) as { sub?: string };
      if (payload?.sub) return `u:${payload.sub}`;
    } catch { /* forged / expired / malformed — fall through to IP */ }
  }
  return `ip:${clientIp(req)}`;
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
  // Key by the REAL client IP (not Cloudflare's shared edge IP), so one venue's
  // crowd doesn't share a single auth bucket. 7 Sep 2026.
  keyGenerator: (req: Request) => `ip:${clientIp(req)}`,
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

// Group chats (26 Oct 2026). Every limit is per signed-in member (the routes sign in first). Reads are
// generous: a busy group of 50 refetches the thread and the list on every message. Messages are held to
// 30 a minute, faster than anyone types. Read marks, leaving, adding and removing share a write allowance.
// Starting a group has a small hourly one, and only a group that was started uses it: a refusal (too few
// people, an event not yet over) started nothing.
export const groupReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('group-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const groupMessageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('group-message'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You are sending messages very quickly. Wait a moment, then try again.' } },
});

export const groupWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('group-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const groupCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('group-create'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have started a lot of group chats this hour. Try again later.' } },
});

/**
 * Inviting many people in one call (26 Oct 2026, POST /invites/batch). One batch can send 50 emails and 50 bells,
 * so a member is held to 20 batches an hour: far more than anyone organising events needs, and well short of a
 * runaway client. Keyed per member, because the route signs in first; the daily per-member invite allowance still
 * counts every person invited.
 */
export const inviteBatchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,                   // 20 batches per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('invite-batch'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'You have sent a lot of invitations this hour. Please try again later.',
      },
    };
    res.status(429).json(response);
  },
});

/**
 * Invite reminders (26 Oct 2026, POST /invites/:id/remind and /invites/remind-all/:sessionId). A reminder is an email to
 * someone who has already been written to, and neither route had any limit, so a stuck or hostile client could write
 * to an invitee all day. 60 an hour per member, a request being one whichever route it is: Remind All counts as one
 * however many people it reminds. The number is roomy on purpose: production's pod page sends one request per pending
 * invite for its own Remind All (and says "Sent 20 reminders, 5 failed" when some are refused), so it has to cover a pod
 * with a few dozen invites waiting. Keyed per member, because both routes sign in first.
 */
export const INVITE_REMINDERS_PER_HOUR = 60;

export const inviteReminderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: INVITE_REMINDERS_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('invite-reminder'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'You have sent a lot of reminders this hour. Please try again later.',
      },
    };
    res.status(429).json(response);
  },
});

/**
 * Onboarding chatbot limiter — bounds LLM cost/abuse on the chat + confirm
 * endpoints. Keyed per authenticated user (these routes require auth). 30
 * turns/min is generous for a 4–7 message flow while capping a runaway client.
 */
/**
 * Saving a draft as you move through the tick-box flow. Generous, because it
 * is one save per step and a member may go back and forth; the global per-user
 * limiter sits in front of this anyway.
 */
export const onboardingAnswersLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('onboarding-answers'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

/** Finishing onboarding. Rare by nature; the row lock makes it idempotent. */
export const onboardingConfirmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('onboarding-confirm'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

/**
 * Onboarding v2, "Continue with LinkedIn" (21 Oct 2026). Each new address can
 * start a paid ScrapingDog lookup, so this is the tightest onboarding bucket: a
 * member types their address once or twice, and ten in ten minutes is far more
 * than anyone needs. The service never pays twice for the same address anyway.
 */
export const onboardingLinkedinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('onboarding-linkedin'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Please wait a few minutes before trying another LinkedIn link.' } },
});

export const onboardingChatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('onboarding'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many messages. Please slow down for a moment.',
      },
    };
    res.status(429).json(response);
  },
});

// REASON milestone 1 (29 Sep 2026): Save / Pass / "what happened" writes.
export const peopleWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('people-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The pod wall (26 Oct 2026). Every write to a pod's wall (a post, a comment or reply, a reaction, a like, a
// delete, a pin) is counted per member, on top of the service's own caps of 6 posts and 20 comments a minute.
// Each write tells every active member's open screen and may ring bells, so a runaway client is stopped at 60 a
// minute. Reads are not counted here: the API limiter in front of every route covers them, and a screen that
// refetches whenever the wall changes must not be locked out of the wall it is drawing.
export const wallWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('wall-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// Entities (21 Oct 2026). Reads are limited like the person brief, because any entity, and any member's
// entities, can be asked for by id. Edits, joins and leaves share a write allowance. Creating has a small
// hourly one of its own, because every new entity claims a name that nobody else can then take. Only an
// entity that was made uses it: a refusal (a name already taken, a name too short) claims no name, and
// counting it told a member trying the name-clash flow they had added a lot of entities when they had
// added none. The API limiter in front of every route still counts every request.
export const entityReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('entity-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const entityWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('entity-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const entityCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('entity-create'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have added a lot of entities this hour. Try again later.' } },
});

// REASON milestone 1 (7 Oct 2026): opening a person's brief and listing recent connections. The brief can
// be aimed at any member by id, so without a limit one member could read it for the whole member list as
// fast as the server answers. Reads have their own bucket: reading never uses up a member's Saves.
export const peopleReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('people-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The member banner (21 Oct 2026). Changing or removing it is a few presses at most; each change stores a
// picture of up to 3 MB, so a runaway client is stopped early. Keyed per member: the routes sign in first.
export const bannerWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('banner-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// Cancelling a meeting (26 Oct 2026). Each cancel rings the other person, emails both and posts a card in
// their thread, so a runaway client is stopped at 10 an hour. Keyed per member: the route signs in first.
// Only a cancel that happened counts: a refusal (a meeting not found, or already over) changed nothing.
export const meetingCancelLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('meeting-cancel'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have cancelled a lot of meetings this hour. Try again later.' } },
});

// The banner picture itself. It is public (an <img> sends no token), so it is counted per network address.
// Each banner's URL is versioned and cached for a day, so one person opening profiles asks for each only once,
// and a refused picture only means the page draws the default banner in its place.
export const bannerReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('banner-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// "Message all participants" (26 Oct 2026). One send writes a private message to everyone who took part, so
// the route holds a person to 10 sends an hour across all their events, on top of the rule that decides
// the real limit (3 per event per sender per 24 hours). Counted per signed-in person and not per network
// address: the people who run events often share one office. Every attempt counts, so a script cannot
// probe the rule for free.
export const postEventMessageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('post-event-message'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'You have sent a lot of messages this hour. Please try again later.',
      },
    };
    res.status(429).json(response);
  },
});

// Event chat (26 Oct 2026). Any event's chat can be asked for by id, so reads are limited like the entity
// reads; a page is 50 messages, so 60 a minute is far more than a person scrolling back reads. Taking a
// message down has a smaller allowance of its own. Keyed per member: the routes sign in first.
export const eventChatReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-chat-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const eventChatWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-chat-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});
