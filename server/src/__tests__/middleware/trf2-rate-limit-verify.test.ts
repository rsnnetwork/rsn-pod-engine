// TRF-2 (audit C3) — the /api limiter keys by authenticated user so a venue
// crowd behind one NAT isn't throttled as a single bucket (shipped June-14).
// SECURITY FIX: the June-14 work keyed off jwt.DECODE (no signature check), so
// a forged token could either mint unlimited fresh buckets (bypass the limiter)
// or set sub=<victim> to exhaust a victim's bucket and DoS them. The key must be
// derived from a jwt.VERIFY so only a legitimately-signed token controls a
// per-user bucket; anything else falls back to the per-IP bucket.

import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import config from '../../config';
import { userOrIpKey } from '../../middleware/rateLimit';

let supertestAvailable = true;
try { require.resolve('supertest'); } catch { supertestAvailable = false; }

function reqWith(authHeader?: string, ip = '5.5.5.5'): any {
  return { headers: authHeader ? { authorization: authHeader } : {}, ip };
}
const bearer = (payload: object, secret: string) => `Bearer ${jwt.sign(payload, secret)}`;

describe('TRF-2 — userOrIpKey verifies the token signature', () => {
  it('a validly-signed token keys to its user bucket (u:<sub>)', () => {
    expect(userOrIpKey(reqWith(bearer({ sub: 'user-1' }, config.jwtSecret)))).toBe('u:user-1');
  });

  it('a token signed with the WRONG secret falls back to the IP bucket (verify, not decode)', () => {
    // Pre-fix (jwt.decode) this returned "u:attacker" — the vulnerability.
    expect(userOrIpKey(reqWith(bearer({ sub: 'attacker' }, 'totally-wrong-secret'), '9.9.9.9')))
      .toBe('ip:9.9.9.9');
  });

  it('an expired (but correctly-signed) token falls back to the IP bucket', () => {
    const expired = jwt.sign({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 10 }, config.jwtSecret);
    expect(userOrIpKey(reqWith(`Bearer ${expired}`, '8.8.8.8'))).toBe('ip:8.8.8.8');
  });

  it('no / malformed Authorization falls back to the IP bucket', () => {
    expect(userOrIpKey(reqWith(undefined, '1.2.3.4'))).toBe('ip:1.2.3.4');
    expect(userOrIpKey(reqWith('Bearer not.a.jwt', '1.2.3.4'))).toBe('ip:1.2.3.4');
  });
});

(supertestAvailable ? describe : describe.skip)('TRF-2 — end-to-end bucket isolation', () => {
  function makeApp() {
    const app = express();
    app.set('trust proxy', true); // honour X-Forwarded-For so we can simulate IPs
    const limiter = rateLimit({
      windowMs: 60_000,
      max: 2,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: userOrIpKey,
      handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED' } }),
    });
    app.use('/api', limiter);
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('two authenticated users on the SAME IP get independent budgets', async () => {
    const app = makeApp();
    const ip = '10.0.0.1';
    const a = bearer({ sub: 'alice' }, config.jwtSecret);
    const b = bearer({ sub: 'bob' }, config.jwtSecret);
    const hit = (tok: string) => request(app).get('/api/ping').set('Authorization', tok).set('X-Forwarded-For', ip);

    expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(429);            // alice exhausted
    // bob shares the IP but his own bucket is untouched:
    expect((await hit(b)).status).toBe(200);
    expect((await hit(b)).status).toBe(200);
    expect((await hit(b)).status).toBe(429);
  });

  it('forged tokens with different subs CANNOT mint separate buckets (share the IP bucket)', async () => {
    const app = makeApp();
    const ip = '7.7.7.7';
    const f1 = bearer({ sub: 'attacker-1' }, 'wrong');
    const f2 = bearer({ sub: 'attacker-2' }, 'wrong');
    const hit = (tok: string) => request(app).get('/api/ping').set('Authorization', tok).set('X-Forwarded-For', ip);

    expect((await hit(f1)).status).toBe(200);            // -> ip:7.7.7.7
    expect((await hit(f2)).status).toBe(200);            // SAME ip bucket
    const third = await hit(f1);
    expect(third.status).toBe(429);                      // shared bucket exhausted
    expect(third.body).toEqual({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED' } });
  });
});
