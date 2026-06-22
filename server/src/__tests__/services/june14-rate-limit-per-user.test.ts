// ─── June-14 — global API rate limiter is keyed PER USER, not per IP ─────────
//
// The stuck-after-round incident had a second amplifier: the /api limiter was
// keyed by IP (100/min). RSN networking events routinely put many attendees on
// ONE venue/office/VPN network, so an IP quota throttles a legitimate crowd as a
// single bucket — and one stranded client's reconnect retries 429'd the /token +
// /state calls that everyone sharing its IP needed to recover ("refresh doesn't
// help"). Fix: key the limiter by the authenticated user (VERIFIED from the
// bearer token — see TRF-2 below; the limiter runs before `authenticate`), with
// a per-IP fallback for anonymous requests.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('June-14 — API rate limiter keys by user', () => {
  const mw = () => readServer('middleware/rateLimit.ts');

  it('apiLimiter uses a user/IP keyGenerator (VERIFIES the bearer sub)', () => {
    const src = mw();
    expect(src).toMatch(/function userOrIpKey/);
    // TRF-2 (audit C3): the key MUST come from jwt.verify, not jwt.decode —
    // an unverified sub is forgeable (mint unlimited buckets / DoS a victim's
    // bucket). Pin verify present AND decode absent so it can't regress.
    expect(src).toMatch(/jwt\.verify\(/);
    expect(src).not.toMatch(/jwt\.decode/);
    expect(src).toMatch(/return `u:\$\{payload\.sub\}`/);
    expect(src).toMatch(/return `ip:\$\{req\.ip\}`/);
    // …and it is wired into the global apiLimiter.
    const limiterIdx = src.indexOf('export const apiLimiter');
    const keyGenIdx = src.indexOf('keyGenerator: userOrIpKey');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(keyGenIdx).toBeGreaterThan(limiterIdx);
  });

  it('the default per-user quota gives reconnect headroom (240/min)', () => {
    expect(readServer('config/index.ts')).toMatch(/RATE_LIMIT_MAX_REQUESTS \|\| '240'/);
  });
});
