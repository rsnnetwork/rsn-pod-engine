// F5 (21 May Ali) — pin the rating-window default + minimum so a future
// refactor can't silently drop it back to 10 s. Live test (21 May)
// showed users repeatedly missing the rating form because the previous
// 10 s default left no headroom to read the form, pick stars + connect
// toggle, and submit. The early-exit-when-all-rated safety net still
// fires, so 30 s is a ceiling that rarely runs to completion in practice.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readShared(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../shared', rel), 'utf8');
}
function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('F5 (21 May Ali) — ratingWindowSeconds default 30, min 20', () => {
  it('DEFAULT_SESSION_CONFIG.ratingWindowSeconds is 30', () => {
    const src = readShared('src/types/session.ts');
    // Match the DEFAULT_SESSION_CONFIG block specifically (not the
    // SessionConfig interface above it, which has no default value).
    const idx = src.indexOf('DEFAULT_SESSION_CONFIG: SessionConfig');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 1000);
    expect(body).toMatch(/ratingWindowSeconds:\s*30\b/);
    expect(body).not.toMatch(/ratingWindowSeconds:\s*10\b/);
  });

  it('routes/sessions.ts enforces min(20) for both create and update', () => {
    const src = readServer('routes/sessions.ts');
    const occurrences = src.match(/ratingWindowSeconds:\s*z\.number\(\)\.int\(\)\.min\((\d+)\)/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    // Both must be min(20); no min(10) allowed.
    for (const occ of occurrences) {
      expect(occ).toMatch(/\.min\(20\)/);
      expect(occ).not.toMatch(/\.min\(10\)/);
    }
  });

  it('round-lifecycle.ts fallback values for ratingWindowSeconds are aligned at 30', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');
    // Pre-fix some fallbacks used `|| 10` and others `|| 30`. They MUST
    // all be 30 now (or some other consistent value ≥ 30). 10 is banned.
    // Ship C removed the inline token-mint TTL fallback, so only the rating
    // window's own fallback remains (was ≥2 occurrences pre-cutover).
    const fallbacks = src.match(/ratingWindowSeconds\s*\|\|\s*(\d+)/g) || [];
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    for (const f of fallbacks) {
      expect(f).not.toMatch(/\|\|\s*10\b/);
    }
  });

  it('session.service.ts fallback is at least 30', () => {
    const src = readServer('services/session/session.service.ts');
    const fallback = src.match(/ratingWindowSeconds\s*\|\|\s*(\d+)/);
    expect(fallback).toBeTruthy();
    const value = Number(fallback![1]);
    expect(value).toBeGreaterThanOrEqual(30);
  });

  it('invite.service.ts fallback is at least 30', () => {
    const src = readServer('services/invite/invite.service.ts');
    const fallback = src.match(/ratingWindowSeconds\s*\|\|\s*(\d+)/);
    expect(fallback).toBeTruthy();
    const value = Number(fallback![1]);
    expect(value).toBeGreaterThanOrEqual(30);
  });
});
