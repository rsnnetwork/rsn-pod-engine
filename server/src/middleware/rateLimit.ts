// ─── Rate Limiting Middleware ─────────────────────────────────────────────────
import rateLimit, { Options as RateLimitOptions } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';
import logger from '../config/logger';
import { getRedisClient } from '../services/redis/redis.client';
import { ApiResponse, normaliseCallCode } from '@rsn/shared';

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
 * The signed-out routes that hold their own venue-sized bucket (11 Nov 2026, Part 3 Task 1 fix round 1). The general
 * limiter below counts everyone signed out behind one address as one person, 100 a minute in production, and it runs
 * before every router, so a room behind one venue's Wi-Fi would be refused there long before these routes' own wider
 * buckets were reached. Exactly these, by method and shape, and nothing else under their prefixes:
 *   GET  /api/sessions/:id/image          an event's image (eventImageReadLimiter, 600 a minute per client)
 *   GET  /api/call-links/:code            the RSN Call link's landing (callLinkReadLimiter, with callLinkMissLimiter)
 *   POST /api/call-links/:code/email      a code by email (callLinkEmailLimiter, callLinkEmailTargetLimiter)
 *   POST /api/call-links/:code/verify     the code back (callLinkVerifyLimiter, the code's own tries)
 * Everything else, /api/call-links/me/events and /:code/entry and /:code/enter included, stays under the general one.
 * `path` is the request's path from /api on, without the query; a HEAD is a GET (Express answers it with the GET route).
 */
export const OWN_BUCKET_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/api\/sessions\/[^/]+\/image\/?$/ },
  { method: 'GET', pattern: /^\/api\/call-links\/[^/]+\/?$/ },
  { method: 'POST', pattern: /^\/api\/call-links\/[^/]+\/email\/?$/ },
  { method: 'POST', pattern: /^\/api\/call-links\/[^/]+\/verify\/?$/ },
];

/** Whether a request is one of OWN_BUCKET_ROUTES, so the general limiter leaves it to its own buckets. */
export function hasOwnBucket(method: string, path: string): boolean {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  // A path is short (Express caps a URL long before a pattern could struggle), and it is read without its query.
  const bare = path.split('?')[0];
  return OWN_BUCKET_ROUTES.some((r) => r.method === verb && r.pattern.test(bare));
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
  // The routes with a venue-sized bucket of their own are left to it (hasOwnBucket above).
  skip: (req: Request) => hasOwnBucket(req.method, req.originalUrl ?? `${req.baseUrl}${req.path}`),
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
 * Typing the 6-digit sign-in code (1 Nov 2026). Ten tries per address per 15 minutes, on top of the five wrong
 * tries a single code allows before it dies with its link: a million codes cannot be walked through from one
 * place. Development keeps a wider bucket, as authLimiter does, so local runs of the sign-in spec do not lock
 * each other out.
 */
const SIGN_IN_CODE_WINDOW_MS = 15 * 60 * 1000;
const SIGN_IN_CODE_MAX = config.env === 'development' ? 100 : 10;
const signInCodeLimited = (_req: Request, res: Response) => {
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many codes tried. Please wait 15 minutes, then try again.',
    },
  };
  res.status(429).json(response);
};

export const signInCodeLimiter = rateLimit({
  windowMs: SIGN_IN_CODE_WINDOW_MS,
  max: SIGN_IN_CODE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `ip:${clientIp(req)}`,
  store: buildStore('signin-code'),
  handler: signInCodeLimited,
});

/**
 * The per-email bucket for the sign-in code (1 Nov 2026, T4 review). clientIp() trusts cf-connecting-ip as sent,
 * so a request that reaches the server without Cloudflare in front can name a new address on every try and never
 * fill the bucket above. Ten tries per email per 15 minutes caps guessing at any one member whatever the address.
 * The key is a hash of the normalised address (no email in the store), and the refusal is the same sentence for
 * every address, with or without an account. It runs after validation, so req.body.email is a trimmed string.
 */
export function signInCodeEmailKey(email: string): string {
  return `email:${crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

export const signInCodeEmailLimiter = rateLimit({
  windowMs: SIGN_IN_CODE_WINDOW_MS,
  max: SIGN_IN_CODE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => signInCodeEmailKey(typeof req.body?.email === 'string' ? req.body.email : ''),
  store: buildStore('signin-code-email'),
  handler: signInCodeLimited,
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

// Group chats (26 Oct 2026). Every limit is per signed-in member (the routes sign in first). Messages are
// held to 30 a minute, faster than anyone types. Read marks, leaving, adding and removing share a write
// allowance. Starting a group has a small hourly one, and only a group that was started uses it: a refusal
// (too few people, an event not yet over) started nothing.
//
// Reads are sized for a group of 50 in a busy minute (H2b item 22, 26 Oct 2026). Every message that arrives
// makes a member's open thread read the group three times (the thread, the group's details, the Messages
// list); a busy minute carries about 60 messages (two a second is fast typing for fifty people), so 180
// reads, and twice that as headroom for a member with two tabs open. The reader's own read marks no longer
// cost a read (fanoutGroupReadMark). The limit used to be 120, and a group of twenty messages a minute hit
// it: the thread then stopped updating until the minute passed.
export const GROUP_READS_A_MINUTE = 400;
export const groupReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: GROUP_READS_A_MINUTE,
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
// Reads are 120 a minute per member since 2 Nov 2026 (T15): since claims wait for approval, every answer an admin
// gives makes each of their entity screens read again (measured: 4 reads per approval with the page, the list and
// their profile open), and at 60 the 15th approval in a row met a 429 and froze the Requests panel.
export const entityReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
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

// Circles (1 Nov 2026). Reading a circle's list or page is limited like entities, because any circle can be
// asked for by id. Making, editing, archiving, attaching a pod, joining and leaving share a write allowance,
// as entities do. The wall's own writes keep wallWriteLimiter.
// Since 2 Nov 2026 (final fix wave SM4) the wall's reads (its feed, one post, a post's comments) count here too, so the
// allowance is 120 a minute, as the entity reads are: the wall reads every loaded page again every 30 s, and a phone
// that comes back to the tab reads the page, the feed and each open comment thread again.
export const circleReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('circle-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const circleWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('circle-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// Pods (Shirley pilot S2, 11 Nov 2026). Every route under /api/pods had only the general limiter. Any pod can be asked
// for by id, so its reads get their own allowance: a pod page reads the pod, its members, counts, events count and
// circles at once, and again on every change it is told of, so the allowance is twice the circles'. Every write (make,
// edit, archive, join, ask, leave, add, remove, approve, change a role, rules) shares one allowance.
export const podReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('pod-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const podWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('pod-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
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

// Withdrawing a meeting request (10 Nov 2026). A withdrawn request may be sent again, and every send rings the other
// person's bell and may email them, so withdraw-and-ask-again is held to 20 withdrawals an hour per member. Only a
// withdrawal that happened counts: a refusal (not theirs, already answered) changed nothing.
export const requestWithdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('request-withdraw'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have withdrawn a lot of requests this hour. Try again later.' } },
});

// Ringing someone for a call (1 Nov 2026, L12). Each ring is a bell, a banner on every screen the other person
// has open and a line in the thread, so a member rings at most 10 calls in 10 minutes, whether from a profile
// (POST /calls/user/:userId) or a thread (POST /dm/conversations/:id/call/request): one limiter, one bucket.
// Only a ring counts: a refusal (offline, not a connection, one already ringing) rang nobody.
export const callRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('call-request'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have rung a lot of calls in the last few minutes. Try again in a little while.' } },
});

// Leaving a 1:1 call (2 Nov 2026, leave fix): one request per leave, so 30 a minute is far more than anyone leaves.
export const callLeaveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('call-leave'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The call ringing me, or the one I rang (1 Nov 2026): read when the app opens, after a refresh and when the
// connection comes back, and again when a call changes. A minute's worth is far more than a member's screens ask.
export const callReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('call-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// Feedback after a meeting (30 Oct 2026). Each person answers once per meeting and may change the answer, so 30 an hour
// is far more than anyone needs; each save tells every admin's feedback list. Keyed per member: the route signs in first.
// Only a save that happened counts: a refusal (not your meeting, not started yet) changed nothing.
export const meetingFeedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('meeting-feedback'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have sent a lot of feedback this hour. Try again later.' } },
});

// The admin feedback list (30 Oct 2026): a page is read whenever an answer arrives, so 120 a minute per admin.
export const adminFeedbackReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('admin-feedback-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The admin feedback CSV (30 Oct 2026): every row at once, and each download is written to the audit log, so 10 in
// 10 minutes per admin.
export const adminFeedbackExportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('admin-feedback-export'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have downloaded the feedback a lot just now. Try again in a few minutes.' } },
});

// The admin onboarding answers CSV (30 Oct review, 2.3): every active member at once, and each download is written to
// the audit log, so 10 in 10 minutes per admin.
export const adminOnboardingExportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('admin-onboarding-export'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'You have downloaded the onboarding answers a lot just now. Try again in a few minutes.' } },
});

// A meeting's calendar file (1 Nov 2026, T7): one press of "Add to calendar" is one read, so 20 a minute per member
// is far more than a person needs, and keeps a script from reading every meeting's file in a loop.
export const meetingCalendarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('meeting-calendar'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The speed-networking presets (30 Oct 2026, T12): read once when an event form opens and again when a preset
// changes, so 60 a minute per member leaves room for a busy organiser and none for a loop.
export const matchingPresetsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('matching-presets'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The banner picture itself. It is public (an <img> sends no token), so it is counted per network address.
// Each banner's URL is versioned and cached for a day, so one person opening profiles asks for each only once,
// and a refused picture only means the page draws the default banner in its place.
// The member's photo, placed with the pencil (30 Oct review, T3a). Each save opens and cuts a picture of up to 3 MB on
// the server, so a member is held to 10 a minute, as the banner is. Keyed per member: the route signs in first.
export const avatarWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('avatar-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// The picture the editor opens on (30 Oct review, T3a): up to 3 MB a time, only ever the member's own, read once each
// time they open the editor. 30 a minute is far past any real use.
export const pictureSourceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('picture-source'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// An event's image (10 Nov 2026 spec, Part 3 Task 1): public, because an <img> sends no token, and opened by the event
// page, the lists and the call landing. At an in-person event a whole room behind one venue's Wi-Fi opens the landing
// at once, so the image has its own bucket, five times the banner's: 600 reads a minute per client (a signed-in reader
// by their account, everyone else by their network address). Each device then keeps it for a day (?v= changes the
// address when the image does).
export const EVENT_IMAGE_READS_PER_CLIENT = 600;
export const eventImageReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: EVENT_IMAGE_READS_PER_CLIENT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-image-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

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
// Since 2 Nov 2026 (final fix wave SM4) the event's Requests list (GET /sessions/:id/requests) shares the read
// allowance: it too can be asked for by id, and the organisers' card reads it once per change. So does an event's
// groups read (GET /sessions/:id/groups, 10 Nov 2026 spec, Part 2 Task 5), for the same reasons.
export const eventChatReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-chat-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// An event's audit trail (Part 2, 10 Nov 2026): organisers read a page of 50 rows; 60 a minute per member is far more than
// anyone scrolls it. Keyed per member: the route signs in first.
export const eventAuditReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-audit-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// An event's lifecycle steps (Part 2, Task 2): publish, unpublish, cancel, archive, unarchive, delete for good. An organiser
// takes a handful in a sitting; 20 a minute per member leaves room for a busy one and none for a loop. Keyed per member:
// the routes sign in first.
export const lifecycleWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-lifecycle-write'),
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

// The notifications page (30 Oct 2026): each "Load more" and each change to the list reads a page. Sixty a minute per
// member is far more than anyone scrolls, while a runaway client is stopped. The bell's own read (no query string) is
// never counted here: production's bell polls it every 30 seconds and refreshes on every change, as it always has.
export const notificationPageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  skip: (req) => req.query.before === undefined && req.query.limit === undefined,
  store: buildStore('notification-page'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// T11 (1 Nov 2026): requests to join an event that asks the host to approve each place, and the host's answers.
export const eventRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,                   // 60 request writes per hour per person (asking, withdrawing, approving, declining)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-request'),
  handler: (_req, res) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'You have done that a lot this hour. Please try again later.',
      },
    };
    res.status(429).json(response);
  },
});

// Matching groups (10 Nov 2026 spec, Part 2 Task 5): an organiser saving an event's groups and round rules, or
// putting a person in a group. Thirty a minute per person is far more than anyone edits by hand, while a runaway
// client is stopped. The groups read shares eventChatReadLimiter, the per-event read allowance.
export const groupsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-groups-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// ─── Admission per event (Part 2, Task 4, 10 Nov 2026) ───────────────────────
// The organisers' admission screens: reads like the event's other organiser lists, and every change (mode, an import
// of allowed emails, a revoke, a batch of codes) in a smaller allowance of its own. Keyed per member: they sign in first.
export const admissionReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('admission-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const admissionWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('admission-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// Redeeming an admission code (Review Focus 4: brute force). A code is 60 bits, so guessing is hopeless already; these
// cap it anyway. Only a refused try counts (skipSuccessfulRequests): ten wrong tries an hour per person per event, and
// thirty an hour per network address across every person and event behind it, so one script cannot spread its guesses
// over many accounts. The refusal reads the same for both.
const ADMISSION_REDEEM_WINDOW_MS = 60 * 60 * 1000;
const admissionRedeemLimited = (_req: Request, res: Response) => {
  const response: ApiResponse = {
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many codes tried. Please wait an hour, then try again.' },
  };
  res.status(429).json(response);
};

/** The per-person, per-event bucket: the verified sign-in (or the address, unsigned) and the event in the path. */
export function admissionRedeemKey(req: Request): string {
  return `${userOrIpKey(req)}:e:${String(req.params?.id ?? '').toLowerCase()}`;
}

export const admissionRedeemLimiter = rateLimit({
  windowMs: ADMISSION_REDEEM_WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: admissionRedeemKey,
  store: buildStore('admission-redeem'),
  handler: admissionRedeemLimited,
});

export const admissionRedeemIpLimiter = rateLimit({
  windowMs: ADMISSION_REDEEM_WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => `ip:${clientIp(req)}`,
  store: buildStore('admission-redeem-ip'),
  handler: admissionRedeemLimited,
});

// ─── The RSN Call link (Part 2 foundation, Task 6, 11 Nov 2026; Review Focus 4; fix round 2; venue NAT 11 Nov) ──────
// An event's link is opened by people who are not signed in, so its per-client buckets are keyed by network address the
// one way every signed-out limiter here is (clientIp, 7 Sep 2026: the real person behind Cloudflare, never the shared
// edge address), and nothing on the link is keyed on a value many real people share, so nobody can fill a bucket to
// keep others out of an event.
//
// The link's buckets are its own, never sign-in's: at an in-person event everyone on the venue's Wi-Fi shares one public
// address, and a whole room has to be able to enter by code at once (spec 02, minimum friction). So the per-client caps
// are wide (300 codes emailed and 300 codes tried per network address in 15 minutes, 300 landing reads a minute) and only
// blunt mass spraying; sign-in keeps its own narrow ones, and neither spends the other's.
//
// What stops guessing is per target, and unchanged: a code is bound to one address and one event and dies after five
// wrong tries (spendSignInCode), the sign-in code's per-address bucket (signInCodeEmailLimiter, shared on purpose so the
// link adds no guessing budget against anyone's address), and five code emails per link and address here. A call code is
// 50 bits, and callLinkMissLimiter counts only the answers that found no event (404). Every address asking for a code
// gets the same answer, so running a list of addresses through a link tells nothing.
const callLinkLimited = (message: string) => (_req: Request, res: Response) => {
  const response: ApiResponse = { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message } };
  res.status(429).json(response);
};
const SLOW_DOWN = 'Slow down a moment, then try again.';
const ipKey = (req: Request) => `ip:${clientIp(req)}`;
/** The link a request names, in its stored spelling (o→0, i/l→1, separators dropped), so spellings share one bucket. */
const linkOf = (req: Request) => {
  const raw = String(req.params?.code ?? '');
  return normaliseCallCode(raw) ?? raw.toLowerCase().replace(/[\s-]/g, '');
};
const CALL_LINK_ENTRY_WINDOW_MS = 15 * 60 * 1000;

/** The landing: a whole room behind one address opens it within a minute. */
export const CALL_LINK_READS_PER_CLIENT = 300;
export const callLinkReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CALL_LINK_READS_PER_CLIENT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  store: buildStore('call-link-read'),
  handler: callLinkLimited(SLOW_DOWN),
});

export const CALL_LINK_MISSES_MAX = 20;
export const callLinkMissLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: CALL_LINK_MISSES_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // Only a link that leads nowhere counts: every other answer, a refusal included, is "successful" here.
  requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 404,
  keyGenerator: ipKey,
  store: buildStore('call-link-miss'),
  handler: callLinkLimited('Too many links tried. Please wait 10 minutes, then try again.'),
});

/** Codes emailed: three hundred per network address in 15 minutes (a room behind one address). */
export const CALL_LINK_EMAILS_PER_CLIENT = 300;
export const callLinkEmailLimiter = rateLimit({
  windowMs: CALL_LINK_ENTRY_WINDOW_MS,
  max: CALL_LINK_EMAILS_PER_CLIENT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  store: buildStore('call-link-email'),
  handler: callLinkLimited('Too many codes asked for. Please wait 15 minutes, then try again.'),
});

/**
 * Codes tried (the 6-digit code, or the email's button): three hundred per network address in 15 minutes. The link's own
 * bucket, apart from sign-in's signInCodeLimiter, so a room entering by code never uses up sign-in, nor the reverse.
 */
export const CALL_LINK_VERIFIES_PER_CLIENT = 300;
export const callLinkVerifyLimiter = rateLimit({
  windowMs: CALL_LINK_ENTRY_WINDOW_MS,
  max: CALL_LINK_VERIFIES_PER_CLIENT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  store: buildStore('call-link-verify'),
  handler: callLinkLimited('Too many codes tried. Please wait 15 minutes, then try again.'),
});

/** The per-link, per-address bucket for codes emailed: the link's stored spelling and a hash of the address. */
export function callLinkEmailTargetKey(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  return `c:${linkOf(req)}:${signInCodeEmailKey(email)}`;
}

export const callLinkEmailTargetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: callLinkEmailTargetKey,
  store: buildStore('call-link-email-target'),
  handler: callLinkLimited('Too many codes asked for this address. Please wait 15 minutes, then try again.'),
});

/** Reading and entering by the link, signed in: twenty a minute per person. */
export const callEntryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('call-entry'),
  handler: callLinkLimited(SLOW_DOWN),
});

/** The organisers' call-link card: reading it and rotating it, thirty a minute per person. */
export const callLinkManageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('call-link-manage'),
  handler: callLinkLimited(SLOW_DOWN),
});

// The matching board (10 Nov 2026 spec, Part 2 Task 8): an organiser dragging people around a board writes once per
// drop and reads the board back after every change made by anyone running the event. 120 a minute per person, each
// way, lets a quick organiser work without a pause while a runaway client is stopped. Keyed per member: the routes
// sign in first.
export const scheduleReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('schedule-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const scheduleWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('schedule-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

// ─── Confirm it's you before a sensitive change (Part 3 Task 2, 11 Nov 2026) ──────────────────────────────────────
// Every route here signs in first, so each bucket is the member's own (`u:<id>`): a crowd behind one address never
// shares one, and a member cannot spend another's. On top of these, every code allows five wrong tries (sign-in-code.ts).
// The new address's own bucket (a hash of it, no address in the store) stops anyone mail-bombing a third party.

const memberKey = (req: Request): string => (req.user ? `u:${req.user.userId}` : userOrIpKey(req));
const accountSecurityLimited = (message: string) => (_req: Request, res: Response) => {
  const response: ApiResponse = { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message } };
  res.status(429).json(response);
};
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Confirmation codes emailed to the member's current address: five per 15 minutes. */
export const REAUTH_CODES_PER_WINDOW = 5;
export const reauthCodeLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: REAUTH_CODES_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKey,
  store: buildStore('reauth-code'),
  handler: accountSecurityLimited('Too many codes asked for. Please wait 15 minutes, then try again.'),
});

/** Confirmation codes typed: ten per 15 minutes. */
export const reauthVerifyLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKey,
  store: buildStore('reauth-verify'),
  handler: accountSecurityLimited('Too many codes tried. Please wait 15 minutes, then try again.'),
});

/** Codes emailed to a new sign-in address: five an hour per member. */
export const emailChangeCodeLimiter = rateLimit({
  windowMs: ONE_HOUR_MS,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKey,
  store: buildStore('email-change-code'),
  handler: accountSecurityLimited('Too many codes asked for. Please wait an hour, then try again.'),
});

/**
 * Codes emailed to any one new address: three an hour, whoever asks. Runs after validation (body.newEmail is a string)
 * and before the proof is spent; only a request that sent a code counts, so a refused one never uses up the address.
 */
export const emailChangeTargetLimiter = rateLimit({
  windowMs: ONE_HOUR_MS,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req: Request) => signInCodeEmailKey(typeof req.body?.newEmail === 'string' ? req.body.newEmail : ''),
  store: buildStore('email-change-target'),
  handler: accountSecurityLimited('Too many codes asked for this address. Please wait an hour, then try again.'),
});

/** The new address's code typed: ten per 15 minutes. */
export const emailChangeVerifyLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKey,
  store: buildStore('email-change-verify'),
  handler: accountSecurityLimited('Too many codes tried. Please wait 15 minutes, then try again.'),
});

/** Closing one's own account: ten tries per 15 minutes (each also needs a fresh proof). */
export const closeAccountLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKey,
  store: buildStore('close-account'),
  handler: accountSecurityLimited('Too many tries. Please wait 15 minutes, then try again.'),
});

// The organisers' event report (10 Nov 2026 spec, Part 3 Task 4): reading it, thirty a minute per person (a page that
// re-reads after every rating change keeps well inside); and the CSV downloads, twenty in ten minutes per person, which
// lets an organiser take all three parts several times and stops a script copying member data out. Keyed per member:
// the route signs in first. The download limiter counts only format=csv.
export const eventReportReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('event-report-read'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});

export const EVENT_REPORT_EXPORT_LIMITED = 'You have downloaded this report a lot just now. Try again in a few minutes.';

export const eventReportExportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  skip: (req: Request) => req.query?.format !== 'csv',
  store: buildStore('event-report-export'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: EVENT_REPORT_EXPORT_LIMITED } },
});

// The waiting list (10 Nov 2026 spec, Part 3 Task 3): leaving it, and the organisers reading it, letting someone in and
// taking someone off it. Thirty a minute per person. Joining it is the registration's own (the register route, the call
// link's entry, an approval, an invite accept), under their limits.
export const waitlistLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('waitlist'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});
